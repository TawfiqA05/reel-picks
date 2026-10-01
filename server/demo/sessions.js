// Demo visitors. Each gets a private copy of the sample database on their
// first API call, named by a random id in an HttpOnly cookie. What one
// visitor does lands only in their copy: nobody else can see it, and it is
// deleted an hour after it was made, or after half an hour without a request,
// whichever comes first (or sooner when the busiest hour needs the room).
//
// The sample itself is built once at start (build.js) into the folder
// server/db.js made for this run, and again when the date changes, so the
// showtimes always run from today. A copy made from the old sample keeps it
// until it expires.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, dataDir } from '../db.js';
import { closeBase, withDb } from './scope.js';
import { buildSample } from './build.js';
import { installDemoNet } from './net.js';
import { localYMD } from '../lib/util.js';
import { readCookie } from '../lib/guest.js';

export const COOKIE = 'rp_demo';
export const MAX_AGE_MS = 60 * 60 * 1000;
export const IDLE_MS = 30 * 60 * 1000;
export const MAX_VISITORS = 150;
const SWEEP_MS = 60 * 1000;

const visitors = new Map(); // id -> { id, handle, file, created, last, busy }
const visitorDir = path.join(dataDir, 'visitors');
let empty = null;
let sample = null; // { file, day }
let building = null;
let builds = 0;

const sq = (p) => `'${p.replace(/'/g, "''")}'`;
function open(file) {
  const h = new DatabaseSync(file);
  h.exec('PRAGMA journal_mode = MEMORY;');
  h.exec('PRAGMA foreign_keys = ON;');
  return h;
}
const remove = (file) => { for (const f of [file, `${file}-journal`]) fs.rmSync(f, { force: true }); };

export const sampleReady = () => Boolean(sample);
export const visitorCount = () => visitors.size;

// Build the sample from the empty schema, then swap it in.
function rebuild() {
  if (building) return building;
  building = (async () => {
    const n = ++builds;
    const work = path.join(dataDir, `build-${n}.db`);
    fs.copyFileSync(empty, work);
    const h = open(work);
    try {
      const info = await withDb(h, `build-${n}`, () => buildSample({ log: (m) => console.log(`  [demo] ${m}`) }));
      const out = path.join(dataDir, `sample-${n}.db`);
      h.exec(`VACUUM INTO ${sq(out)}`);
      const old = sample;
      sample = { file: out, day: info.today };
      if (old) remove(old.file);
    } finally {
      h.close();
      remove(work);
    }
  })().finally(() => { building = null; });
  return building;
}

// Called once, before the server takes requests: keep a copy of the empty
// schema server/db.js just made, shut that database to everything else, and
// build the first sample.
export function startDemo() {
  installDemoNet(); // already done by index.js; never build without it
  fs.mkdirSync(visitorDir, { recursive: true });
  empty = path.join(dataDir, 'empty.db');
  db.exec(`VACUUM INTO ${sq(empty)}`);
  closeBase();
  const first = rebuild();
  setInterval(sweep, SWEEP_MS).unref();
  return first;
}

function drop(v) {
  visitors.delete(v.id);
  try { v.handle.close(); } catch { /* already closed */ }
  remove(v.file);
}

export function sweep(now = Date.now()) {
  for (const v of visitors.values()) {
    if (v.busy) continue;
    if (now - v.created > MAX_AGE_MS || now - v.last > IDLE_MS) drop(v);
  }
  if (sample && sample.day !== localYMD(new Date(now)) && !building) {
    rebuild().catch((e) => console.error('[demo] rebuilding the sample failed:', e.message));
  }
}

function newVisitor(now) {
  // Full: the one idle longest makes room.
  if (visitors.size >= MAX_VISITORS) {
    const oldest = [...visitors.values()].filter((v) => !v.busy).sort((a, b) => a.last - b.last)[0];
    if (oldest) drop(oldest);
  }
  const id = crypto.randomBytes(18).toString('base64url');
  const file = path.join(visitorDir, `${id}.db`);
  fs.copyFileSync(sample.file, file);
  const v = { id, handle: open(file), file, created: now, last: now, busy: 0 };
  visitors.set(id, v);
  return v;
}

const isHttps = (req) => req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https';

// Before the API: find or make this visitor's copy and remember it on the
// request (index.js binds it with withDb after the body parser). While the
// first sample is still being built, requests wait for it.
export async function demoVisitor(req, res, next) {
  try {
    if (!sample) await building;
    if (!sample) throw new Error('the sample database is not ready');
  } catch (e) {
    console.error('[demo]', e.message);
    return res.status(503).json({ error: 'The demo is starting up. Try again in a moment.' });
  }
  const now = Date.now();
  let v = visitors.get(readCookie(req, COOKIE) || '');
  if (v && (now - v.created > MAX_AGE_MS || now - v.last > IDLE_MS) && !v.busy) { drop(v); v = null; }
  if (!v) {
    v = newVisitor(now);
    const left = Math.round((v.created + MAX_AGE_MS - now) / 1000);
    res.cookie(COOKIE, v.id, { httpOnly: true, sameSite: 'lax', secure: isHttps(req), maxAge: left * 1000, path: '/' });
  }
  v.last = now;
  v.busy++;
  let done = false;
  const release = () => { if (!done) { done = true; v.busy--; } };
  res.on('finish', release);
  res.on('close', release);
  req.demo = { handle: v.handle, key: v.id };
  next();
}

// Shut every copy (tests, and a clean stop).
export function closeAll() {
  for (const v of [...visitors.values()]) drop(v);
}
