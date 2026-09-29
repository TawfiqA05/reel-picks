// The database layout on start-up (server/db.js), on throwaway copies only.
// A new empty database starts at the current layout with no migration
// backups; the oldest layout on record (test/fixtures/legacy-schema.sql)
// still migrates step by step, each step after its own backup, to the same
// tables, columns and indexes, keeping its rows; opening either again changes
// nothing.
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { suite } from '../lib/check.mjs';
import { copyApp, tempDir, PRELOAD, HERE } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('migrations');
const { check, step } = S;
const dir = tempDir('migrations');
const app = copyApp(dir);

// Opens the database the way the server does on start-up (importing db.js
// runs every pending step), then exits.
function open(dataDir) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', `--import=${PRELOAD}`, '--input-type=module', '-e', "await import('./server/db.js')"], {
    cwd: app, encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TZ: C.TZ, DATA_DIR: dataDir, RP_FAKE_NOW: C.T0, OWNER_NAME: C.OWNER_NAME },
  });
  if (r.status !== 0) throw new Error(`opening the database failed (${r.status}): ${(r.stderr || r.stdout || '').slice(-800)}`);
  return r.stdout;
}
const backups = (dataDir) => { const b = path.join(dataDir, 'backups'); return fs.existsSync(b) ? fs.readdirSync(b).filter((f) => f.startsWith('reelpicks-pre-')).sort() : []; };
const tag = (f) => f.replace(/^reelpicks-pre-/, '').replace(/-\d{4}-\d\d-\d\dT.*$/, '');
function layout(file) {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = {};
    for (const { name } of d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      tables[name] = d.prepare(`PRAGMA table_info("${name}")`).all().map((c) => `${c.name} ${c.type}${c.notnull ? ' not null' : ''}${c.dflt_value != null ? ` default ${c.dflt_value}` : ''}${c.pk ? ` pk${c.pk}` : ''}`).sort();
    }
    const indexes = d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    return { tables, indexes };
  } finally { d.close(); }
}
function dump(file) {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    const h = crypto.createHash('sha256');
    for (const { name, sql } of d.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all()) {
      h.update(sql);
      if (!/^CREATE TABLE/.test(sql)) continue;
      h.update(JSON.stringify(d.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()));
    }
    return h.digest('hex');
  } finally { d.close(); }
}
const diffLayout = (a, b) => {
  const out = [];
  for (const t of new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])) {
    const x = a.tables[t] || []; const y = b.tables[t] || [];
    if (!a.tables[t] || !b.tables[t]) { out.push(`table ${t} only in ${a.tables[t] ? 'the first' : 'the second'}`); continue; }
    for (const c of x) if (!y.includes(c)) out.push(`${t}: ${c} only in the first`);
    for (const c of y) if (!x.includes(c)) out.push(`${t}: ${c} only in the second`);
  }
  for (const i of a.indexes) if (!b.indexes.includes(i)) out.push(`index ${i} only in the first`);
  for (const i of b.indexes) if (!a.indexes.includes(i)) out.push(`index ${i} only in the second`);
  return out;
};

const fresh = path.join(dir, 'fresh');
const legacy = path.join(dir, 'legacy');
fs.mkdirSync(fresh);
fs.mkdirSync(legacy);
{
  const d = new DatabaseSync(path.join(legacy, 'reelpicks.db'));
  d.exec(fs.readFileSync(path.join(HERE, '..', 'fixtures', 'legacy-schema.sql'), 'utf8'));
  d.close();
}

await step('fresh: a new empty database', async () => {
  open(fresh);
  const file = path.join(fresh, 'reelpicks.db');
  check('fresh: a new database writes no migration backup', backups(fresh).length === 0, backups(fresh).join(', '));
  const d = new DatabaseSync(file, { readOnly: true });
  const owner = d.prepare('SELECT id, name FROM users').all();
  d.close();
  check('fresh: the owner is there', owner.length === 1 && owner[0].id === 1 && owner[0].name === C.OWNER_NAME, JSON.stringify(owner));
  const before = dump(file);
  open(fresh);
  check('fresh: opening it again changes nothing and backs nothing up', dump(file) === before && backups(fresh).length === 0);
});

await step('legacy: the oldest layout on record', async () => {
  open(legacy);
  const file = path.join(legacy, 'reelpicks.db');
  const tags = backups(legacy).map(tag);
  const want = ['theatres', 'matches-review', 'cache-keys', 'watched-daily', 'users', 'votes', 'details-missing', 'person-ids', 'watched-source', 'poster-color'];
  check('legacy: every step still runs, each after its own backup', want.every((t) => tags.includes(t)) && tags.length === want.length, tags.join(', '));
  const d = new DatabaseSync(file, { readOnly: true });
  const q = (sql) => d.prepare(sql).all();
  check('legacy: ratings are kept and are the owner\'s', JSON.stringify(q('SELECT user_id, tmdb_id, rating FROM ratings ORDER BY tmdb_id')) === JSON.stringify([
    { user_id: 1, tmdb_id: 970101, rating: 4.5 }, { user_id: 1, tmdb_id: 970102, rating: 3 }, { user_id: 1, tmdb_id: 990001, rating: 4 }]));
  const watched = q('SELECT tmdb_id, watched_date, in_weekly4, user_id FROM watched ORDER BY id');
  check('legacy: same-day duplicates in the watch log collapse to one, keeping the weekly-4 flag', watched.length === 2 && watched[0].tmdb_id === 990001 && watched[0].in_weekly4 === 1 && watched[0].watched_date === '2026-08-17' && watched.every((w) => w.user_id === 1), JSON.stringify(watched));
  check('legacy: old showtimes get the theater', q('SELECT theatre_id FROM showtimes')[0]?.theatre_id === '9101');
  check('legacy: old AMC cache days are re-keyed by local date', q("SELECT key FROM cache WHERE key LIKE 'amc:%'").map((r) => r.key).join() === 'amc:showtimes:v2:9101:2026-08-21');
  const m = q('SELECT tmdb_votes, us_release_date, director_id, cast_ids FROM movies WHERE tmdb_id = 990001')[0];
  check('legacy: votes, US release and person ids are filled from the cached answer', m?.tmdb_votes === 1840 && m.us_release_date === '2026-08-11' && m.director_id === 50001 && m.cast_ids === '[60001,60002]', JSON.stringify(m));
  check('legacy: departures and snapshots get the theater', q('SELECT theatre_id FROM departures')[0]?.theatre_id === '9101' && q('SELECT theatre_id FROM lineup_snapshots')[0]?.theatre_id === '9101');
  check('legacy: the owner\'s settings are copied to their own', q("SELECT value FROM user_settings WHERE user_id = 1 AND key = 'avgTicketPrice'")[0]?.value === '13.5');
  d.close();
  const diff = diffLayout(layout(path.join(fresh, 'reelpicks.db')), layout(file));
  check('fresh: it starts at the current layout, the same tables, columns and indexes as a fully migrated old database', diff.length === 0, diff.join('; '));
  const before = dump(file);
  const n = backups(legacy).length;
  open(legacy);
  check('legacy: opening it again changes nothing and backs nothing up', dump(file) === before && backups(legacy).length === n);
});

if (!process.env.RP_KEEP_TEMP) fs.rmSync(dir, { recursive: true, force: true });
S.finish();
