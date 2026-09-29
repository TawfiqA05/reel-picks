// Reel Picks server: JSON API + static PWA frontend, single process.
import './env.js';
import express from 'express';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import { config, onRailway } from './env.js';
import router from './routes.js';
import {
  isGuest, isOwner, isLocalRequest, guestAllowed, guestModeEnabled, hostIsLocal, viaCloudflare, tokenMatches, ownerCookieName, ownerCookieValue, ownerCookieMaxAgeMs, requestUser, ownerName,
} from './lib/guest.js';
import { FRIEND_COOKIE, FRIEND_TTL_MS, findInvite, redeemInvite, signFriendCookie, touchLastSeen } from './lib/accounts.js';
import { joinPage, expiredPage } from './lib/invitePage.js';
import { getSetting, db, dataDir } from './db.js';
import { refreshAll, shouldAutoRefresh, retryIfDue, state as refreshState } from './lib/refresh.js';
import { runAs } from './lib/user.js';
import { startCreditsBackfill } from './lib/backfill.js';
import { startNightlyBackups } from './lib/backup.js';
import { pushEnabled, sendWeeklyIfDue } from './lib/push.js';
import { syncAllDue as syncLetterboxdDue } from './lib/letterboxd.js';
import { raiseLater, resolveLater, raiseEveryStart } from './lib/alerts.js';
import { startWeeklyOffsite, offsiteEnabled } from './lib/offsite.js';
import { warmHomePicks } from './lib/home.js';
import { activeUserIds } from './lib/theatres.js';
import { initLockWeek } from './lib/lock.js';
import { afterNightlyBackup } from './lib/housekeeping.js';
import { sendIndex } from './lib/version.js';
import { backfillPosterColors } from './lib/posterColor.js';
import { warmPeople } from './lib/people.js';
import { runPlanJobs } from './lib/plans.js';
import { sendDueLater as sendWatchlistAlerts } from './lib/watchalerts.js';

const AUTO_REFRESH_CHECK_MS = 15 * 60 * 1000;
const RETRY_CHECK_MS = 60 * 1000;
const PLAN_CHECK_MS = 60 * 1000;

const app = express();
app.disable('x-powered-by');

// Off Railway, only requests addressed to this machine are answered: a page
// on another site can point its own hostname at 127.0.0.1 (DNS rebinding) and
// would otherwise reach the app as the owner. RP_ALLOW_LAN opens it to other
// devices on the network. The share tunnel's requests (Cloudflare's edge
// headers) still get through, as the read-only guest they always were.
const lanAllowed = () => ['1', 'true', 'yes', 'on'].includes((process.env.RP_ALLOW_LAN || '').trim().toLowerCase());
app.use((req, res, next) => {
  if (onRailway() || lanAllowed() || hostIsLocal(req) || viaCloudflare(req)) return next();
  res.status(403).type('text').send('Reel Picks only answers at localhost here. Set RP_ALLOW_LAN to 1 to open it to your network.');
});
// Gzip or Brotli for anything worth it: the Picks list alone is ~900 KB of
// JSON and ~70 KB compressed.
app.use(compression({ threshold: 1024 }));
// Nothing here is meant to be framed or sniffed as another type.
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' }); next(); });

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
  // One leading slash only: "//evil.example" would send the browser off-site.
  res.redirect(302, u.pathname.replace(/^\/+/, '/') + (u.search || ''));
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

// A change from another site's page is refused before it's read: at
// localhost every request is the owner,
// so a page elsewhere could otherwise post to this one. The browser marks
// where a request came from; our own pages are same-origin.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const site = req.get('sec-fetch-site');
  const origin = req.get('origin');
  let foreign = site === 'cross-site' || site === 'same-site';
  if (!foreign && origin && origin !== 'null') { try { foreign = new URL(origin).host !== req.get('host'); } catch { foreign = true; } }
  if (foreign) return res.status(403).json({ error: 'Changes have to come from Reel Picks itself.' });
  next();
});

// Big bodies only where a file comes in (a ratings CSV, a full-setup file).
app.use(['/api/ratings/import', '/api/state'], express.json({ limit: '20mb' }));
app.use(express.json({ limit: '200kb' }));

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
// The page itself carries the app version (lib/version.js), so it is never
// served as a plain file.
app.get(['/', '/index.html'], sendIndex);
app.use(express.static(publicDir, { extensions: ['html'], index: false }));

// SPA fallback: send index.html for any non-API, non-file route.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  sendIndex(req, res);
});

app.use((err, req, res, next) => {
  console.error('[api error]', err.message);
  // A thrown error with a status was written for the reader; anything else is
  // internal (a database message, say) and stays in the log.
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status < 500 || err.status ? err.message || 'Server error' : 'Something went wrong on the server. Try again.' });
});

app.listen(config.port, () => {
  const keys = [
    config.tmdbKey ? 'TMDB✓' : 'TMDB✗',
    config.omdbKey ? 'OMDb✓' : 'OMDb✗',
    config.amcKey ? 'AMC✓' : 'AMC✗',
    pushEnabled() ? 'Push✓' : 'Push✗',
    offsiteEnabled() ? 'Off-site✓' : 'Off-site✗',
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
  // On Railway without GUEST_MODE every visitor is the guest (lib/guest.js):
  // say so to the owner, once per start.
  if (onRailway() && !guestModeEnabled()) {
    console.warn('  ⚠ GUEST_MODE is not on, so every visitor gets the read-only guest view. Set GUEST_MODE to 1 in Railway.');
    raiseEveryStart('guestmode', 'GUEST_MODE isn\'t set to 1 on Railway, so everyone who opens the site gets the read-only guest view. Your owner link and friends\' logins still work.')
      .catch((e) => console.error('[alerts]', e.message));
  } else if (onRailway()) resolveLater('guestmode');

  initLockWeek();
  if (shouldAutoRefresh()) autoRefresh('startup');
  // Pick up any credits backfill a restart interrupted (a no-op when nothing is missing).
  startCreditsBackfill('startup');
  // The names the header search can correct a typo to (lib/people.js):
  // cached a week, so a restart reads them from the cache.
  warmPeople();
  // Poster colours for the dark-mode glow, for any playing film still without one.
  backfillPosterColors().catch((e) => console.error('[poster colours]', e.message));
  // Nightly database backup at 3am local time (lib/backup.js); a failure
  // alerts the owner, and the next good one says it's back to normal. Only
  // after a good one, expired cache rows are cleared (lib/housekeeping.js).
  startNightlyBackups(db, dataDir, {
    onResult: (err) => {
      if (err) return raiseLater('backup', `The nightly backup failed: ${err}`);
      resolveLater('backup');
      afterNightlyBackup();
    },
  });
  // Off-site copy of the newest nightly, Sunday 4am, when BACKUP_S3_* is set (lib/offsite.js).
  startWeeklyOffsite(dataDir);
  // Letterboxd: everyone who linked a username, once a day (lib/letterboxd.js).
  const letterboxd = () => syncLetterboxdDue().catch((e) => console.error('[letterboxd]', e.message));
  letterboxd();

  // A long-running process (a deployed instance) would otherwise never refresh
  // again: check every 15 minutes whether the local calendar day has rolled
  // over since the last refresh and, if so, pull the new day's schedule.
  // The same tick syncs Letterboxd for anyone not synced yet today, and
  // sends Friday's "weekly picks are ready" push to anyone who turned
  // notifications on after that day's refresh (lib/push.js; once per person
  // per week).
  setInterval(() => {
    letterboxd();
    // This week's "At home" picks, ready before anyone opens Picks (lib/home.js).
    warmHomePicks(activeUserIds()).catch((e) => console.error('[home]', e.message));
    warmPeople(); // once a week
    if (refreshState.running) return;
    if (shouldAutoRefresh()) autoRefresh('new day');
    else sendWeeklyIfDue().catch((e) => console.error('[push]', e.message));
  }, AUTO_REFRESH_CHECK_MS).unref();

  // "I'm going" (lib/plans.js): the reminder two hours before a showing, the
  // next morning's "Did you see it?", and plans left unanswered three days,
  // every minute and once now. What's due lives in the database, so a
  // restart picks up where the last run left off.
  const plans = () => runPlanJobs().catch((e) => console.error('[plans]', e.message));
  plans();
  setInterval(plans, PLAN_CHECK_MS).unref();
  // Watchlist alerts (lib/watchalerts.js) the last refresh found: whatever is
  // due, every minute and once now, so ones held overnight go at 9am and a
  // restart sends what it missed.
  sendWatchlistAlerts();
  setInterval(sendWatchlistAlerts, PLAN_CHECK_MS).unref();

  // A failed refresh is retried hourly, up to six times (lib/refresh.js).
  setInterval(() => {
    const r = retryIfDue();
    if (r) r.catch((e) => console.error('  ✗ Refresh retry failed:', e.message));
  }, RETRY_CHECK_MS).unref();
});
