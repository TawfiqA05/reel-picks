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
// file never counts as a backup. The newest 7 nightly and 3 pre-migration
// copies are kept; pruning only touches files in this folder whose names match
// those patterns, so anything else put there by hand is left alone.
//
// Room first. A copy needs about as much free space as the live database
// while it is written, and on a full volume the live database can't save
// either. So before each copy the free space on the data volume is checked:
// short of one more copy plus a margin, the copies past 7 and 3 go first,
// oldest first, then the oldest of the rest, one at a time, until there is
// room. The newest nightly and the newest pre-migration copy are never
// deleted, and nothing outside this folder is. If that still isn't enough the
// copy isn't attempted, and the failure says how much space is missing.
//
// A failed backup is logged and remembered for /api/status; it never throws.
// No import of db.js here: db.js calls in during its own startup migrations.
import fs from 'node:fs';
import path from 'node:path';
import { localYMD as ymd } from './util.js';

const KEEP_NIGHTLY = 7;
const KEEP_PRE_MIGRATION = 3;
const NIGHTLY_HOUR = 3;
const CHECK_MS = 60 * 1000;
const NIGHTLY = /^reelpicks-(\d{4}-\d{2}-\d{2})\.db$/;
const PRE_MIGRATION = /^reelpicks-pre-[a-z-]+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;
const isBackup = (name) => NIGHTLY.test(name) || PRE_MIGRATION.test(name);
// A copy left half-written by a process that died mid-VACUUM (writeBackup's
// temp name), or the journal SQLite leaves beside it when VACUUM INTO fails.
// Cleared once it is an hour old: no copy takes that long.
const TEMP = /^reelpicks-.+\.db\.\d+\.tmp(-journal)?$/;
const TEMP_STALE_MS = 60 * 60 * 1000;
// Copies the app wrote beside the database before backups/ existed
// (reelpicks.pre-users-<stamp>.db and the like). Counted, never removed.
const OLD_TOP_LEVEL = /^reelpicks\.pre-[a-z-]+-[\dT:.Z-]+\.db$/;
const DB_FILE = 'reelpicks.db';
const MB = 1024 * 1024;

const backupState = { lastError: null };


export const backupsDir = (dataDir) => path.join(dataDir, 'backups');
export const nightlyName = (now = new Date()) => `reelpicks-${ymd(now)}.db`;

// VACUUM INTO a temp file beside the target, then rename over it. Returns
// { name, file, bytes }, or null after logging the failure.
function writeBackup(db, dir, name) {
  const file = path.join(dir, name);
  // Per process: two servers on one database (a dev setup) never share a temp file.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(tmp, { force: true });
    fs.rmSync(`${tmp}-journal`, { force: true });
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    fs.renameSync(tmp, file);
    backupState.lastError = null;
    return { name, file, bytes: fs.statSync(file).size };
  } catch (err) {
    // A failed VACUUM INTO leaves the temp copy and its journal behind.
    for (const f of [tmp, `${tmp}-journal`]) {
      try { fs.rmSync(f, { force: true }); } catch { /* nothing more to do */ }
    }
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

// Each kind newest first: nightly copies by the date in their name,
// pre-migration copies by the timestamp in theirs.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const stampOf = (n) => n.match(/\d{4}-\d{2}-\d{2}(T[\d-]+Z)?/)[0];
function byKind(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const sorted = (re) => names.filter((n) => re.test(n)).sort((a, b) => cmp(stampOf(b), stampOf(a)) || cmp(b, a));
  return { nightly: sorted(NIGHTLY), pre: sorted(PRE_MIGRATION) };
}

// Across both kinds, oldest first: by day, then by the full stamp.
const oldestFirst = (a, b) => cmp(stampOf(a).slice(0, 10), stampOf(b).slice(0, 10)) || cmp(stampOf(a), stampOf(b)) || cmp(a, b);

function remove(dir, name) {
  try { fs.rmSync(path.join(dir, name)); return true; } catch (err) {
    console.error(`[backup] could not remove old ${name}: ${err.message}`);
    return false;
  }
}

// Keep the newest 7 nightly and 3 pre-migration copies. Oldest go first, and
// `enough` (when given) stops the pruning as soon as it says there is room.
function pruneBackups(dir, { nightly = KEEP_NIGHTLY, pre = KEEP_PRE_MIGRATION, enough = null } = {}) {
  const kinds = byKind(dir);
  if (!kinds) return [];
  const extra = [...kinds.nightly.slice(nightly), ...kinds.pre.slice(pre)].sort(oldestFirst);
  const removed = [];
  for (const name of extra) {
    if (enough?.()) break;
    if (remove(dir, name)) removed.push(name);
  }
  return removed;
}

// Half-written copies from a process that died mid-VACUUM, an hour old or more.
function clearStaleTemps(dir, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const gone = [];
  for (const name of names.filter((n) => TEMP.test(n))) {
    try {
      if (now - fs.statSync(path.join(dir, name)).mtimeMs < TEMP_STALE_MS) continue;
      fs.rmSync(path.join(dir, name));
      gone.push(name);
    } catch { /* in use or gone */ }
  }
  if (gone.length) console.log(`[backup] cleared ${gone.length} half-written cop${gone.length === 1 ? 'y' : 'ies'} left by an earlier run`);
  return gone;
}

// ---- Space on the data volume

// The volume the data folder is on, in bytes: total, free (what this process
// may still write) and used. null where the platform can't say.
export function volume(dataDir) {
  try {
    const s = fs.statfsSync(dataDir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return total > 0 ? { total, free, used: total - free } : null;
  } catch { return null; }
}

const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
// The live database with its WAL (and the WAL index), as it sits on disk.
function liveBytes(dataDir) {
  const f = path.join(dataDir, DB_FILE);
  return { db: sizeOf(f), wal: sizeOf(`${f}-wal`), shm: sizeOf(`${f}-shm`) };
}

// A copy is about the size of the live database (VACUUM INTO leaves out free
// pages, so usually a little smaller). The margin keeps room for the live
// database and its WAL to go on growing while and after the copy is written.
export function roomNeeded(dataDir) {
  const live = liveBytes(dataDir);
  const copy = live.db + live.wal;
  const margin = Math.max(64 * MB, Math.round(copy / 4));
  return { copy, margin, total: copy + margin };
}

const mbText = (n) => `${Math.round(n / MB)} MB`;
// Sizes for people: MB under a gigabyte, GB with one decimal above.
const sizeText = (n) => (n >= 1024 * MB ? `${(n / (1024 * MB)).toFixed(1)} GB` : mbText(n));

// The owner alert above 80% full (index.js), and the line it sends.
export const DISK_ALERT_PCT = 80;
export const DISK_OK_PCT = 75;
export const diskAlertLine = (d) => `The data volume is ${Math.round(d.pct)}% full: ${sizeText(d.used)} of ${sizeText(d.total)} used, ${sizeText(d.free)} free. `
  + `The database is ${sizeText(d.dbBytes)} and the backups take ${sizeText(d.backups.bytes + d.older.bytes)}.`;

// Make room for one more copy. Prunes to 7 and 3 first, oldest first, then the
// oldest remaining copies except the newest of each kind, stopping as soon as
// there is room. Returns { ok, removed, free, needed } (ok with no volume
// figures: nothing is pruned beyond the usual limits then).
function makeRoom(dataDir) {
  const dir = backupsDir(dataDir);
  clearStaleTemps(dir);
  const need = roomNeeded(dataDir);
  const freeNow = () => volume(dataDir)?.free;
  const enough = () => { const f = freeNow(); return f == null || f >= need.total; };
  if (enough()) return { ok: true, removed: [], free: freeNow(), needed: need.total };
  const removed = pruneBackups(dir, { enough });
  if (!enough()) {
    // Below the limits now, oldest first, but never the newest of either kind.
    const kinds = byKind(dir) || { nightly: [], pre: [] };
    const rest = [...kinds.nightly.slice(1), ...kinds.pre.slice(1)].sort(oldestFirst);
    for (const name of rest) {
      if (enough()) break;
      if (remove(dir, name)) removed.push(name);
    }
  }
  if (removed.length) console.log(`[backup] low on space: removed ${removed.length} older cop${removed.length === 1 ? 'y' : 'ies'} (${removed.join(', ')})`);
  return { ok: enough(), removed, free: freeNow(), needed: need.total };
}

// Room for one more copy, or a failure saying how much is missing. The
// failure is remembered like any other failed backup.
function roomOrFail(dataDir, name) {
  const r = makeRoom(dataDir);
  if (r.ok) return true;
  const message = `Not enough free space on the data volume for a backup: ${mbText(r.free)} free, and a copy needs about ${mbText(r.needed)} (the database plus a ${mbText(roomNeeded(dataDir).margin)} margin). The newest backups were kept.`;
  backupState.lastError = { at: new Date().toISOString(), name, message };
  console.error(`[backup] ✗ ${name} skipped: ${message}`);
  return false;
}

// Called by db.js right before a schema migration. Never throws: a migration
// that can't be backed up still runs, as it did before backups existed.
export function preMigrationBackup(db, dataDir, what) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = backupsDir(dataDir);
  const name = `reelpicks-pre-${what}-${stamp}.db`;
  const b = roomOrFail(dataDir, name) ? writeBackup(db, dir, name) : null;
  if (!b) return null;
  const removed = pruneBackups(dir);
  console.log(`[backup] ✓ ${b.name} (${(b.bytes / 1048576).toFixed(1)} MB)${removed.length ? `, removed ${removed.length} older` : ''}`);
  return b.file;
}

// Today's nightly copy, if it is 3am or later and there isn't one yet.
function nightlyDue(dir, now = new Date()) {
  return now.getHours() >= NIGHTLY_HOUR && !fs.existsSync(path.join(dir, nightlyName(now)));
}

function runNightlyBackup(db, dataDir, now = new Date()) {
  const dir = backupsDir(dataDir);
  const name = nightlyName(now);
  if (!roomOrFail(dataDir, name)) return null;
  const b = writeBackup(db, dir, name);
  if (!b) return null;
  const removed = pruneBackups(dir);
  console.log(`[backup] ✓ ${b.name} (${(b.bytes / 1048576).toFixed(1)} MB)${removed.length ? `, removed ${removed.length} older` : ''}`);
  return b;
}

// Checks once a minute. A failed attempt is not retried until the next hour,
// so a full disk logs once an hour rather than every minute. `onResult` hears
// about every attempt, (null) after a success or (message) after a failure
// (the owner alerts, lib/alerts.js, wired up in index.js). `onDisk` hears the
// volume's figures (diskStatus) once an hour and after every attempt.
export function startNightlyBackups(db, dataDir, { onResult = null, onDisk = null } = {}) {
  let failedHour = null;
  let diskHour = null;
  const disk = (hour) => {
    diskHour = hour;
    try { onDisk?.(diskStatus(dataDir)); } catch (err) { console.error(`[backup] disk check failed: ${err.message}`); }
  };
  const tick = () => {
    try {
      const now = new Date();
      const hour = `${ymd(now)}T${now.getHours()}`;
      if (failedHour !== hour && nightlyDue(backupsDir(dataDir), now)) {
        const ok = runNightlyBackup(db, dataDir, now);
        failedHour = ok ? null : hour;
        onResult?.(ok ? null : (backupState.lastError?.message || 'unknown error'));
        disk(hour);
      } else if (diskHour !== hour) disk(hour);
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
    keep: { nightly: KEEP_NIGHTLY, preMigration: KEEP_PRE_MIGRATION },
    lastError: err && (!last || err.at > last.at) ? err : null,
  };
}

// For the owner's Settings > Data line and the disk alert: the data volume,
// the live database, and what the backups take. Backups counts every file in
// backups/ (the ones put there by hand too, since they take space all the
// same); `older` is the copies beside the database from before backups/.
export function diskStatus(dataDir) {
  const vol = volume(dataDir);
  const live = liveBytes(dataDir);
  const dir = backupsDir(dataDir);
  let backups = { bytes: 0, count: 0 };
  try {
    for (const name of fs.readdirSync(dir)) {
      try { const st = fs.statSync(path.join(dir, name)); if (st.isFile()) { backups.bytes += st.size; if (isBackup(name)) backups.count++; } } catch { /* gone */ }
    }
  } catch { backups = { bytes: 0, count: 0 }; }
  const older = { bytes: 0, count: 0 };
  try {
    for (const name of fs.readdirSync(dataDir).filter((n) => OLD_TOP_LEVEL.test(n))) { older.bytes += sizeOf(path.join(dataDir, name)); older.count++; }
  } catch { /* unreadable */ }
  return {
    total: vol?.total ?? null,
    free: vol?.free ?? null,
    used: vol?.used ?? null,
    pct: vol ? Math.round((vol.used / vol.total) * 1000) / 10 : null,
    dbBytes: live.db + live.wal + live.shm,
    walBytes: live.wal,
    backups,
    older,
  };
}
