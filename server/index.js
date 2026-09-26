// Reel Picks server: JSON API + static PWA frontend, single process.
import './env.js';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { config } from './env.js';
import router from './routes.js';
import {
  isGuest, isOwner, isLocalRequest, guestAllowed, tokenMatches, ownerCookieName, ownerCookieValue, ownerCookieMaxAgeMs, requestUser, ownerName,
} from './lib/guest.js';
import { FRIEND_COOKIE, FRIEND_TTL_MS, findInvite, redeemInvite, signFriendCookie, touchLastSeen } from './lib/accounts.js';
import { joinPage, expiredPage } from './lib/invitePage.js';
import { getSetting, db, dataDir } from './db.js';
import { refreshAll, shouldAutoRefresh, state as refreshState } from './lib/refresh.js';
import { runAs } from './lib/user.js';
import { startCreditsBackfill } from './lib/backfill.js';
import { startNightlyBackups } from './lib/backup.js';
import { pushEnabled, sendWeeklyIfDue } from './lib/push.js';

const AUTO_REFRESH_CHECK_MS = 15 * 60 * 1000;

const app = express();

// Owner unlock: ?owner=<OWNER_TOKEN> sets a signed, HttpOnly cookie and then 302s
// to a token-free URL, so the secret never lands in history, Referer, or a link
// you share. The token is compared in constant time and never logged/rendered.
app.use((req, res, next) => {
  if (!('owner' in req.query)) return next();
  const raw = req.query.owner;
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (tokenMatches(token)) {
    res.cookie(ownerCookieName(), ownerCookieValue(), {
      httpOnly: true, secure: true, sameSite: 'lax', maxAge: ownerCookieMaxAgeMs(), path: '/',
    });
  }
  const u = new URL(req.originalUrl, 'http://placeholder');
  u.searchParams.delete('owner');
  res.redirect(302, u.pathname + (u.search || ''));
});

// Friend invites, in two steps so that merely opening a link changes nothing.
// Messaging apps fetch every link they see to draw a preview card; when opening
// the link redeemed it, those fetches used invites up before the friend ever
// tapped them.
//
// GET/HEAD /?invite=<token> shows the Join page (or the expired page) and
// never redeems or sets a cookie, whatever the user agent. The Join button
// POSTs the token to /invite/join, same-origin only; that redeems the one-time
// token (only its hash is stored) into the signed, HttpOnly friend cookie and
// redirects to onboarding for someone new, Picks for someone returning with a
// re-issued link. The owner (owner cookie, or at localhost where every request
// is the owner) is sent to Settings from either step, without using the link.
const firstParam = (v) => (Array.isArray(v) ? v[0] : v);
const pageHeaders = (res) => res.set({
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer', // the token is in the URL
  'X-Robots-Tag': 'noindex, nofollow',
});

app.use((req, res, next) => {
  if (!('invite' in req.query) || !['GET', 'HEAD'].includes(req.method)) return next();
  if (isOwner(req) || isLocalRequest(req)) return res.redirect(302, '/#/settings');
  pageHeaders(res);
  const token = firstParam(req.query.invite);
  const friend = findInvite(token);
  if (!friend) return res.status(410).type('html').send(expiredPage({ owner: ownerName() }));
  res.type('html').send(joinPage({ owner: ownerName(), token }));
});

// A form POST from our own Join page: the browser marks it same-origin
// (Sec-Fetch-Site), or at least sends our own Origin. Anything else — another
// site's form, a request with no provenance at all — is refused.
function sameOriginPost(req) {
  const site = req.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const from = req.get('origin') || req.get('referer');
  if (!from) return false;
  try { return new URL(from).host === req.get('host'); } catch { return false; }
}

app.post('/invite/join', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  if (isOwner(req) || isLocalRequest(req)) return res.redirect(303, '/#/settings');
  pageHeaders(res);
  if (!sameOriginPost(req)) return res.status(403).type('text').send('This invite has to be accepted from its own page.');
  const friend = redeemInvite(firstParam(req.body?.token));
  if (!friend) return res.status(410).type('html').send(expiredPage({ owner: ownerName() }));
  res.cookie(FRIEND_COOKIE, signFriendCookie(friend), {
    httpOnly: true, secure: true, sameSite: 'lax', maxAge: FRIEND_TTL_MS, path: '/',
  });
  const onboarded = getSetting('onboardingDone', { userId: friend.id });
  res.redirect(303, onboarded ? '/' : '/#/onboarding');
});

// Read-only guard for the public tunnel: reject guest writes and owner-only
// reads BEFORE any body is parsed, so the shared link can never touch the DB.
app.use('/api', (req, res, next) => {
  if (!isGuest(req) || guestAllowed(req)) return next();
  res.status(403).json({ error: 'This shared link is read only.' });
});

app.use(express.json({ limit: '20mb' })); // large enough for CSV ratings uploads

// Every API request runs as one user (lib/user.js): the owner, a signed-in
// friend, or — for the read-only guest link — the owner's picks with guest
// set. Bound after the body parser, whose stream callbacks would otherwise run
// outside the request's context.
app.use('/api', (req, res, next) => {
  const u = requestUser(req);
  if (u.row) touchLastSeen(u.row);
  runAs(u.id, next, { guest: u.guest, isOwner: u.isOwner, name: u.name || null });
});
app.use('/api', router);

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const indexHtml = fileURLToPath(new URL('../public/index.html', import.meta.url));
app.use(express.static(publicDir, { extensions: ['html'] }));

// SPA fallback: send index.html for any non-API, non-file route.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(indexHtml);
});

app.use((err, req, res, next) => {
  console.error('[api error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.listen(config.port, () => {
  const keys = [
    config.tmdbKey ? 'TMDB✓' : 'TMDB✗',
    config.omdbKey ? 'OMDb✓' : 'OMDb✗',
    config.amcKey ? 'AMC✓' : 'AMC✗',
    pushEnabled() ? 'Push✓' : 'Push✗',
  ].join('  ');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || 'system';
  const where = process.env.NODE_ENV === 'production' ? `port ${config.port}` : `http://localhost:${config.port}`;
  console.log(`\n  🎬  Reel Picks running → ${where}`);
  console.log(`      keys: ${keys}   ·   timezone: ${tz}\n`);

  const autoRefresh = (why) => {
    console.log(`  ↻ Auto-refreshing showtimes & scores (${why})…`);
    return refreshAll({ force: false })
      .then((log) => {
        const errs = log?.errors?.length || 0;
        console.log(`  ✓ Refresh done. ${JSON.stringify(log?.counts || {})}${errs ? ` (${errs} warnings)` : ''}`);
      })
      .catch((e) => console.error(`  ✗ Refresh failed (${why}):`, e.message));
  };
  if (shouldAutoRefresh()) autoRefresh('startup');
  // Pick up any credits backfill a restart interrupted (a no-op when nothing is missing).
  startCreditsBackfill('startup');
  // Nightly database backup at 3am local time (lib/backup.js).
  startNightlyBackups(db, dataDir);

  // A long-running process (a deployed instance) would otherwise never refresh
  // again: check every 15 minutes whether the local calendar day has rolled
  // over since the last refresh and, if so, pull the new day's schedule.
  // The same tick sends Friday's "weekly picks are ready" push to anyone who
  // turned notifications on after that day's refresh (lib/push.js; once per
  // person per week).
  setInterval(() => {
    if (refreshState.running) return;
    if (shouldAutoRefresh()) autoRefresh('new day');
    else sendWeeklyIfDue().catch((e) => console.error('[push]', e.message));
  }, AUTO_REFRESH_CHECK_MS).unref();
});
