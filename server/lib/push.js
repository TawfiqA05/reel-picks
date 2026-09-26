// Web Push: "Your 4 for this week are ready", once per person per A-List week.
//
// Opt-in per device from Settings (owner and friends; the guest link can't
// reach any of this, lib/guest.js). Keys come from VAPID_PUBLIC_KEY and
// VAPID_PRIVATE_KEY; with either missing the feature is off and the Settings
// switch never shows.
//
// Sent right after Friday's refresh has computed the new week's four. The
// message carries only the #1 film's title and the Picks page link, never a
// rating or score. push_sent is claimed (one row per person per week) before
// anything goes out, so a restart, a redeploy or a second trigger can never
// send it twice.
//
// No web-push dependency: VAPID (RFC 8292) and aes128gcm payload encryption
// (RFC 8291) are a few calls into node:crypto.
import crypto from 'node:crypto';
import { run, all, get, getSetting } from '../db.js';
import { runAs, OWNER_ID } from './user.js';
import { getRecommendations } from './recommend.js';
import { localYMD, weekStartFriday } from './util.js';

const TITLE = 'Your 4 for this week are ready';
const PICKS_URL = '/#/home';
const TTL_SECONDS = 24 * 3600;
// Apple rejects a VAPID token without a mailto: or https: subject.
const DEFAULT_SUBJECT = 'https://github.com/TawfiqA05/reel-picks';

// The push services browsers actually use. A subscription is a URL the server
// will POST to, so anything else is refused rather than fetched.
const PUSH_HOSTS = [
  'fcm.googleapis.com', 'android.googleapis.com', 'jmt17.google.com', // Chrome, Chromium
  'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com',
];

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url');

// ---- keys -------------------------------------------------------------------

let cached = { pub: null, priv: null, keys: null };

function vapid() {
  const pub = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const priv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  if (!pub || !priv) return null;
  if (cached.pub === pub && cached.priv === priv) return cached.keys;
  let keys = null;
  try {
    const p = unb64u(pub);
    let d = unb64u(priv);
    if (d.length < 32) d = Buffer.concat([Buffer.alloc(32 - d.length), d]); // a key with leading zero bytes
    if (p.length !== 65 || p[0] !== 4 || d.length !== 32) throw new Error('wrong key length');
    const privateKey = crypto.createPrivateKey({
      key: { kty: 'EC', crv: 'P-256', x: b64u(p.subarray(1, 33)), y: b64u(p.subarray(33)), d: b64u(d) },
      format: 'jwk',
    });
    keys = { publicKey: b64u(p), privateKey };
  } catch (e) {
    console.error('[push] VAPID keys are set but unusable, so notifications are off:', e.message);
  }
  cached = { pub, priv, keys };
  return keys;
}

export const pushEnabled = () => Boolean(vapid());
export const publicKey = () => vapid()?.publicKey || null;

function vapidHeader(endpoint, keys) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: (process.env.VAPID_SUBJECT || '').trim() || DEFAULT_SUBJECT,
  }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

// ---- payload encryption (RFC 8291, aes128gcm, one record) -------------------

export function encrypt(payload, p256dh, auth) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (only) record; no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// ---- subscriptions ----------------------------------------------------------

function allowedEndpoint(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  // Test servers point subscriptions at a local fake push service.
  const testOrigin = (process.env.RP_PUSH_TEST_ORIGIN || '').trim();
  if (testOrigin && u.origin === testOrigin) return true;
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

// Validates a browser PushSubscription (its toJSON()). Returns the clean
// fields, or throws a 400.
export function parseSubscription(sub) {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  const endpoint = typeof sub?.endpoint === 'string' ? sub.endpoint : '';
  if (!endpoint || endpoint.length > 2000 || !allowedEndpoint(endpoint)) throw bad('That isn\'t a push subscription this app can use.');
  const p256dh = unb64u(sub?.keys?.p256dh);
  const auth = unb64u(sub?.keys?.auth);
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) throw bad('The push subscription\'s keys are missing or malformed.');
  return { endpoint, p256dh: b64u(p256dh), auth: b64u(auth) };
}

// A device belongs to whoever subscribed it last (a shared phone that
// switches accounts moves with them).
export function saveSubscription(userId, sub) {
  const s = parseSubscription(sub);
  run(`INSERT INTO push_subs(endpoint, user_id, p256dh, auth, created_at) VALUES(?,?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  s.endpoint, userId, s.p256dh, s.auth, new Date().toISOString());
}

export function removeSubscription(userId, endpoint) {
  run('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?', userId, String(endpoint || ''));
}

export function hasSubscription(userId, endpoint) {
  return Boolean(get('SELECT 1 AS x FROM push_subs WHERE user_id = ? AND endpoint = ?', userId, String(endpoint || '')));
}

// ---- sending ----------------------------------------------------------------

// 'ok', 'gone' (404/410: the subscription is dead and has been deleted),
// 'rejected' (the push service said no, so nothing was shown) or 'unknown'
// (a network error or timeout: it may have been delivered).
async function sendOne(sub, payload, keys) {
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidHeader(sub.endpoint, keys),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(TTL_SECONDS),
        Urgency: 'normal',
        Topic: 'weekly-picks',
      },
      body: encrypt(payload, sub.p256dh, sub.auth),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return 'ok';
    if (res.status === 404 || res.status === 410) {
      run('DELETE FROM push_subs WHERE endpoint = ?', sub.endpoint);
      return 'gone';
    }
    console.error(`[push] ${new URL(sub.endpoint).host} answered ${res.status}`);
    return 'rejected';
  } catch (e) {
    console.error('[push] send failed:', e.message);
    return 'unknown';
  }
}

let sending = false;

// Sends this week's push to everyone with a subscribed device who hasn't had
// it yet. Each person's week is claimed in push_sent before anything is sent.
// The claim is only released when every device definitely didn't get it (the
// push service rejected them all), so a later run can try again; after a
// timeout or a partial success it stands, because a second push is worse than
// a missed one.
export async function sendWeekly({ now = new Date() } = {}) {
  const keys = vapid();
  if (!keys) return { enabled: false, users: 0, sent: 0 };
  if (sending) return { enabled: true, busy: true, users: 0, sent: 0 };
  sending = true;
  const week = weekStartFriday(now);
  const summary = { enabled: true, week, users: 0, sent: 0, removed: 0, failed: 0 };
  try {
    const users = all(`SELECT DISTINCT s.user_id AS id FROM push_subs s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE (s.user_id = ? OR (u.id IS NOT NULL AND u.revoked_at IS NULL))
        AND NOT EXISTS (SELECT 1 FROM push_sent p WHERE p.user_id = s.user_id AND p.week_start = ?)
      ORDER BY s.user_id`, OWNER_ID, week).map((r) => r.id);
    for (const uid of users) {
      const top = runAs(uid, () => getRecommendations().weekly4[0]);
      if (!top) continue; // no picks yet: try again after the next refresh
      const claimed = run('INSERT INTO push_sent(user_id, week_start, sent_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',
        uid, week, new Date().toISOString()).changes;
      if (!claimed) continue;
      summary.users++;
      const payload = JSON.stringify({ title: TITLE, body: `#1 is ${top.title}`, url: PICKS_URL, tag: 'weekly-picks' });
      const subs = all('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?', uid);
      const results = await Promise.all(subs.map((s) => sendOne(s, payload, keys)));
      summary.sent += results.filter((r) => r === 'ok').length;
      summary.removed += results.filter((r) => r === 'gone').length;
      summary.failed += results.filter((r) => r === 'rejected' || r === 'unknown').length;
      if (results.every((r) => r === 'rejected' || r === 'gone')) {
        run('DELETE FROM push_sent WHERE user_id = ? AND week_start = ?', uid, week);
      }
    }
    if (summary.users) console.log(`  🔔 Weekly picks push for ${week}: ${summary.sent} sent to ${summary.users} ${summary.users === 1 ? 'person' : 'people'}${summary.removed ? `, ${summary.removed} dead device(s) removed` : ''}${summary.failed ? `, ${summary.failed} failed` : ''}.`);
    return summary;
  } finally {
    sending = false;
  }
}

// The automatic path: only on a Friday, once that day's refresh has put the
// new week's lineup in place. Called after every refresh and on the server's
// 15-minute tick (which catches someone who turns notifications on later that
// Friday). The caller makes sure no refresh is mid-run.
export function sendWeeklyIfDue(now = new Date()) {
  if (!pushEnabled()) return Promise.resolve(null);
  const today = localYMD(now);
  if (today !== weekStartFriday(now)) return Promise.resolve(null);
  const last = getSetting('lastRefresh');
  if (!last || localYMD(new Date(last)) !== today) return Promise.resolve(null);
  return sendWeekly({ now });
}
