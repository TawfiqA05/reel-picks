// Reel Picks server: JSON API + static PWA frontend, single process.
import './env.js';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { config } from './env.js';
import router from './routes.js';
import {
  isGuest, isOwner, isLocalRequest, guestAllowed, tokenMatches, ownerCookieName, ownerCookieValue, ownerCookieMaxAgeMs, requestUser,
} from './lib/guest.js';
import { FRIEND_COOKIE, FRIEND_TTL_MS, redeemInvite, signFriendCookie, touchLastSeen } from './lib/accounts.js';
import { getSetting } from './db.js';
import { refreshAll, shouldAutoRefresh, state as refreshState } from './lib/refresh.js';
import { runAs } from './lib/user.js';

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

// Friend invite: /?invite=<token> redeems a one-time token (only its hash is
// stored) into a signed, HttpOnly friend cookie — never the token itself —
// then redirects to a token-free URL: onboarding for someone new, Picks for
// someone returning with a re-issued link. The owner opening a link (owner
// cookie, or at localhost where every request is the owner) doesn't burn it
// and is sent to Settings, where the friend list is. A used or unknown token
// just lands on the app with no cookie.
app.use((req, res, next) => {
  if (!('invite' in req.query)) return next();
  if (isOwner(req) || isLocalRequest(req)) return res.redirect(302, '/#/settings');
  const raw = req.query.invite;
  const friend = redeemInvite(Array.isArray(raw) ? raw[0] : raw);
  if (!friend) return res.redirect(302, '/');
  res.cookie(FRIEND_COOKIE, signFriendCookie(friend), {
    httpOnly: true, secure: true, sameSite: 'lax', maxAge: FRIEND_TTL_MS, path: '/',
  });
  const onboarded = getSetting('onboardingDone', { userId: friend.id });
  res.redirect(302, onboarded ? '/' : '/#/onboarding');
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

  // A long-running process (a deployed instance) would otherwise never refresh
  // again: check every 15 minutes whether the local calendar day has rolled
  // over since the last refresh and, if so, pull the new day's schedule.
  setInterval(() => {
    if (!refreshState.running && shouldAutoRefresh()) autoRefresh('new day');
  }, AUTO_REFRESH_CHECK_MS).unref();
});
