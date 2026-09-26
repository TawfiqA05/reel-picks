// Off-site backup: once a week, a copy of the newest nightly backup
// (lib/backup.js) goes to S3-compatible storage, Cloudflare R2 or anything
// else that speaks the S3 API. Configured entirely by environment variables:
//
//   BACKUP_S3_ENDPOINT   https://<account id>.r2.cloudflarestorage.com
//   BACKUP_S3_BUCKET     the bucket
//   BACKUP_S3_KEY_ID     access key id
//   BACKUP_S3_SECRET     secret access key
//   BACKUP_S3_REGION     optional; 'auto' (what R2 wants) unless set
//
// With any of the first four missing the feature is off: nothing is
// scheduled, Settings shows nothing, and the upload endpoint is a 404.
//
// Schedule: Sunday 4am, server time zone (an hour after the 3am nightly). A
// server that was down then uploads at its next check; the very first upload
// goes up as soon as the feature is configured. A failed upload is retried an
// hour later and raises an owner alert (lib/alerts.js); the next good one
// says it's back to normal.
//
// Objects are  reel-picks/weekly/reelpicks-YYYY-MM-DD.db  (the nightly's own
// date). The newest KEEP stay; older ones are deleted, and only objects whose
// whole key matches that pattern under that prefix are ever touched, so
// nothing else in the bucket can be.
//
// Requests are signed with AWS Signature Version 4 on node:crypto (no SDK),
// path-style, with the body's SHA-256 in the signature so the storage end
// checks the upload arrived intact. The secret never leaves this process: it
// isn't logged, stored or sent.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { getSetting, setSetting } from '../db.js';
import { listBackups, backupsDir } from './backup.js';
import { raiseLater, resolveLater } from './alerts.js';

export const KEEP = 8;
export const PREFIX = 'reel-picks/weekly/';
const OURS = /^reel-picks\/weekly\/reelpicks-(\d{4}-\d{2}-\d{2})\.db$/;
const NIGHTLY = /^reelpicks-(\d{4}-\d{2}-\d{2})\.db$/;
const WEEKDAY = 0; // Sunday
const HOUR = 4;
const CHECK_MS = 60 * 1000;
const RETRY_MS = 3600 * 1000;
const TIMEOUT_MS = 10 * 60 * 1000;

export function offsiteConfig() {
  const v = (k) => (process.env[k] || '').trim();
  const endpoint = v('BACKUP_S3_ENDPOINT').replace(/\/+$/, '');
  const bucket = v('BACKUP_S3_BUCKET');
  const keyId = v('BACKUP_S3_KEY_ID');
  const secret = v('BACKUP_S3_SECRET');
  if (!endpoint || !bucket || !keyId || !secret) return null;
  let url;
  try { url = new URL(endpoint); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  return { url, bucket, keyId, secret, region: v('BACKUP_S3_REGION') || 'auto' };
}
export const offsiteEnabled = () => Boolean(offsiteConfig());

// ---- Signature Version 4 ----------------------------------------------------

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// RFC 3986: everything but A-Z a-z 0-9 - _ . ~ is percent-encoded.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Signs and sends one request. `key` is the object key ('' for the bucket).
async function s3(cfg, method, key, { query = {}, body = null, headers: extra = {} } = {}) {
  const base = cfg.url.pathname.replace(/\/+$/, '');
  const path = `${base}/${enc(cfg.bucket)}${key ? `/${key.split('/').map(enc).join('/')}` : ''}`;
  const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(String(query[k]))}`).join('&');
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(body || '');
  const headers = { host: cfg.url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...extra };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonical = [method, path, qs, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secret}`, day), cfg.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(toSign).digest('hex');
  const { host, ...send } = headers; // fetch sets Host itself, from the URL
  send.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  let res;
  try {
    res = await fetch(`${cfg.url.origin}${path}${qs ? `?${qs}` : ''}`, {
      method, headers: send, body: body || undefined, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e.name === 'TimeoutError') throw e;
    throw new Error(`couldn't reach the storage at ${cfg.url.host} (${e.cause?.code || e.cause?.message || e.message})`);
  }
  const text = method === 'HEAD' ? '' : await res.text();
  if (!res.ok) {
    const code = text.match(/<Code>([^<]*)<\/Code>/)?.[1];
    const msg = text.match(/<Message>([^<]*)<\/Message>/)?.[1];
    throw new Error(`storage answered ${res.status}${code ? ` ${code}` : ''}${msg ? `: ${msg}` : ''} (${method} ${key || cfg.bucket})`);
  }
  return { res, text };
}

const xmlDecode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Every key under PREFIX (ListObjectsV2, following continuation tokens).
async function listKeys(cfg) {
  const keys = [];
  let token = null;
  for (let page = 0; page < 100; page++) {
    const query = { 'list-type': '2', prefix: PREFIX, ...(token ? { 'continuation-token': token } : {}) };
    const { text } = await s3(cfg, 'GET', '', { query });
    for (const m of text.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(xmlDecode(m[1]));
    token = /<IsTruncated>true<\/IsTruncated>/.test(text) ? xmlDecode(text.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)?.[1] || '') : null;
    if (!token) break;
  }
  return keys;
}

// ---- upload -----------------------------------------------------------------

let running = null;

function latestNightly(dataDir) {
  return listBackups(backupsDir(dataDir))
    .filter((b) => NIGHTLY.test(b.name))
    .sort((a, b) => b.name.localeCompare(a.name))[0] || null;
}

async function uploadOnce(cfg, dataDir) {
  const b = latestNightly(dataDir);
  if (!b) throw new Error('the nightly backup disappeared before it could be sent');
  const body = fs.readFileSync(b.file);
  const key = `${PREFIX}${b.name}`;
  await s3(cfg, 'PUT', key, { body, headers: { 'content-type': 'application/octet-stream' } });
  // Make sure it's really there, whole.
  const head = await s3(cfg, 'HEAD', key);
  const size = Number(head.res.headers.get('content-length'));
  if (size !== body.length) throw new Error(`the stored copy is ${size} bytes, not ${body.length}`);
  // Keep the newest KEEP weekly copies. Only keys that are exactly ours.
  const ours = (await listKeys(cfg)).filter((k) => OURS.test(k)).sort((x, y) => y.localeCompare(x));
  const removed = [];
  for (const old of ours.slice(KEEP)) {
    await s3(cfg, 'DELETE', old);
    removed.push(old);
  }
  return { at: new Date().toISOString(), key, bytes: body.length, sha256: sha256(body), backup: b.name, kept: Math.min(ours.length, KEEP), removed };
}

export const hasNightly = (dataDir) => Boolean(latestNightly(dataDir));

// Upload now (the schedule, or the owner's button). Never throws: the result
// is recorded for Settings, and a failure raises the owner alert. With no
// nightly backup yet (a brand-new server before its first 3am) there is
// nothing to send; the schedule waits for one and the button says so.
export function uploadNow(dataDir, { why = 'manual' } = {}) {
  const cfg = offsiteConfig();
  if (!cfg) return Promise.resolve(null);
  if (running) return running;
  if (!hasNightly(dataDir)) return Promise.reject(Object.assign(new Error('There is no nightly backup to upload yet. The first one is taken at 3am.'), { status: 409 }));
  running = (async () => {
    try {
      const r = await uploadOnce(cfg, dataDir);
      setSetting('offsiteLast', r);
      setSetting('offsiteError', null);
      console.log(`[offsite] ✓ ${r.key} (${(r.bytes / 1048576).toFixed(1)} MB, ${why})${r.removed.length ? `, removed ${r.removed.length} older` : ''}`);
      resolveLater('offsite');
    } catch (e) {
      const message = e.name === 'TimeoutError' ? 'the storage took too long to answer' : e.message;
      setSetting('offsiteError', { at: new Date().toISOString(), message });
      console.error(`[offsite] ✗ upload failed (${why}): ${message}`);
      raiseLater('offsite', `The weekly off-site backup upload failed: ${message}`);
    } finally {
      running = null;
    }
    return offsiteStatus();
  })();
  return running;
}

// The most recent Sunday 4am (server time) at or before `now`.
export function lastSlot(now = new Date()) {
  const d = new Date(now);
  d.setHours(HOUR, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - WEEKDAY + 7) % 7));
  if (d > now) d.setDate(d.getDate() - 7);
  return d;
}

// Due when the last slot has passed with no upload since (a first upload is due at once).
export function offsiteDue(now = new Date(), last = getSetting('offsiteLast')) {
  if (!last?.at) return true;
  return Date.parse(last.at) < lastSlot(now).getTime();
}

export function nextSlot(now = new Date()) {
  const d = lastSlot(now);
  d.setDate(d.getDate() + 7);
  return d;
}

export function startWeeklyOffsite(dataDir) {
  if (!offsiteEnabled()) return null;
  let failedAt = 0;
  const tick = () => {
    if (running || Date.now() - failedAt < RETRY_MS || !offsiteDue() || !hasNightly(dataDir)) return;
    uploadNow(dataDir, { why: 'weekly' })
      .then(() => { failedAt = getSetting('offsiteError') ? Date.now() : 0; })
      .catch((e) => console.error('[offsite]', e.message));
  };
  tick();
  return setInterval(tick, CHECK_MS).unref();
}

// For the owner's Data card.
export function offsiteStatus() {
  if (!offsiteEnabled()) return { enabled: false };
  const last = getSetting('offsiteLast') || null;
  const err = getSetting('offsiteError') || null;
  return {
    enabled: true,
    keep: KEEP,
    uploading: Boolean(running),
    last: last ? { at: last.at, bytes: last.bytes, key: last.key, backup: last.backup } : null,
    lastError: err && (!last || err.at > last.at) ? err : null,
    next: nextSlot().toISOString(),
  };
}
