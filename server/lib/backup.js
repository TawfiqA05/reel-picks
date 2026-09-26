// Automatic database backups, in <DATA_DIR>/backups (/data/backups deployed).
//
//   nightly         reelpicks-YYYY-MM-DD.db, the first check at or after 3am
//                   local time (the process TZ, the clock /api/status reports)
//                   each day. A server that was down at 3am takes the day's
//                   copy as soon as it is back up.
//   pre-migration   reelpicks-pre-<what>-<ISO stamp>.db, written by db.js right
//                   before it alters the schema.
//
// Each copy is VACUUM INTO, a consistent snapshot of the live database (WAL
// included) rather than a raw copy of a file that may be mid-write. It is
// written under a temporary name and renamed into place, so a half-written
// file never counts as a backup. The newest 14 of each kind are kept; pruning
// only touches files in this folder whose names match those patterns, so
// anything else put there by hand is left alone.
//
// A failed backup is logged and remembered for /api/status; it never throws.
// No import of db.js here: db.js calls in during its own startup migrations.
import fs from 'node:fs';
import path from 'node:path';

export const KEEP = 14;
const NIGHTLY_HOUR = 3;
const CHECK_MS = 60 * 1000;
const NIGHTLY = /^reelpicks-(\d{4}-\d{2}-\d{2})\.db$/;
const PRE_MIGRATION = /^reelpicks-pre-[a-z-]+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;
const isBackup = (name) => NIGHTLY.test(name) || PRE_MIGRATION.test(name);

export const backupState = { lastError: null };

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const backupsDir = (dataDir) => path.join(dataDir, 'backups');
export const nightlyName = (now = new Date()) => `reelpicks-${ymd(now)}.db`;

// VACUUM INTO a temp file beside the target, then rename over it. Returns
// { name, file, bytes }, or null after logging the failure.
export function writeBackup(db, dir, name) {
  const file = path.join(dir, name);
  // Per process: two servers on one database (a dev setup) never share a temp file.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(tmp, { force: true });
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    fs.renameSync(tmp, file);
    backupState.lastError = null;
    return { name, file, bytes: fs.statSync(file).size };
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
    backupState.lastError = { at: new Date().toISOString(), name, message: err.message };
    console.error(`[backup] ✗ ${name} failed: ${err.message}`);
    return null;
  }
}

// Newest first, by modification time (then name). Only our own backup files.
export function listBackups(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!isBackup(name)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) out.push({ name, file: path.join(dir, name), bytes: st.size, at: st.mtime.toISOString(), mtimeMs: st.mtimeMs });
    } catch { /* deleted underfoot */ }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
}

export const latestBackup = (dir) => listBackups(dir)[0] || null;

// Keep the newest KEEP of each kind. Nightly copies sort by the date in their
// name, pre-migration copies by the timestamp in theirs.
export function pruneBackups(dir, keep = KEEP) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const removed = [];
  const stampOf = (n) => n.match(/\d{4}-\d{2}-\d{2}(T[\d-]+Z)?/)[0];
  for (const re of [NIGHTLY, PRE_MIGRATION]) {
    const kind = names.filter((n) => re.test(n)).sort((a, b) => stampOf(b).localeCompare(stampOf(a)) || b.localeCompare(a));
    for (const name of kind.slice(keep)) {
      try { fs.rmSync(path.join(dir, name)); removed.push(name); } catch (err) {
        console.error(`[backup] could not remove old ${name}: ${err.message}`);
      }
    }
  }
  return removed;
}

// Called by db.js right before a schema migration. Never throws: a migration
// that can't be backed up still runs, as it did before backups existed.
export function preMigrationBackup(db, dataDir, what) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = backupsDir(dataDir);
  const b = writeBackup(db, dir, `reelpicks-pre-${what}-${stamp}.db`);
  if (b) pruneBackups(dir);
  return b ? b.file : null;
}

// Today's nightly copy, if it is 3am or later and there isn't one yet.
export function nightlyDue(dir, now = new Date()) {
  return now.getHours() >= NIGHTLY_HOUR && !fs.existsSync(path.join(dir, nightlyName(now)));
}

export function runNightlyBackup(db, dataDir, now = new Date()) {
  const dir = backupsDir(dataDir);
  const b = writeBackup(db, dir, nightlyName(now));
  if (!b) return null;
  const removed = pruneBackups(dir);
  console.log(`[backup] ✓ ${b.name} (${(b.bytes / 1048576).toFixed(1)} MB)${removed.length ? `, removed ${removed.length} older` : ''}`);
  return b;
}

// Checks once a minute. A failed attempt is not retried until the next hour,
// so a full disk logs once an hour rather than every minute.
export function startNightlyBackups(db, dataDir) {
  let failedHour = null;
  const tick = () => {
    try {
      const now = new Date();
      const hour = `${ymd(now)}T${now.getHours()}`;
      if (failedHour === hour || !nightlyDue(backupsDir(dataDir), now)) return;
      failedHour = runNightlyBackup(db, dataDir, now) ? null : hour;
    } catch (err) {
      console.error(`[backup] nightly check failed: ${err.message}`);
    }
  };
  tick();
  return setInterval(tick, CHECK_MS).unref();
}

// For /api/status: the newest backup of either kind, and the last failure if
// it came after it.
export function backupStatus(dataDir) {
  const last = latestBackup(backupsDir(dataDir));
  const err = backupState.lastError;
  return {
    dir: backupsDir(dataDir),
    last: last ? { name: last.name, at: last.at, bytes: last.bytes } : null,
    count: listBackups(backupsDir(dataDir)).length,
    lastError: err && (!last || err.at > last.at) ? err : null,
  };
}
