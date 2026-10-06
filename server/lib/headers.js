// The headers every answer carries (server/index.js): what a page may load
// and run, which of the browser's features the app and the trailer frame may
// use, how much of an address leaves with a request, and no framing or type
// sniffing.
import crypto from 'node:crypto';
import fs from 'node:fs';

// The trailer's player (public/js/views/detail.js).
const PLAYER = 'https://www.youtube-nocookie.com';

// The two inline scripts in index.html (the start-up watchdog and the Theme
// switch; the Join and other server pages carry the second one too), allowed
// by their sha256, as a browser hashes them: the text between the tags.
// Worked out from the file at start-up, so editing a script can't leave the
// policy behind. The version placeholder sits in a meta tag, outside them.
const INDEX = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
const INLINE_SCRIPTS = [...INDEX.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter(([, attrs]) => !/\bsrc\s*=/.test(attrs))
  .map(([, , body]) => `'sha256-${crypto.createHash('sha256').update(body.replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`);

// Styles come from files only: the app sets the odd width or colour through
// element.style, which the policy doesn't cover, so no 'unsafe-inline'.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' ${INLINE_SCRIPTS.join(' ')}`,
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  // Posters and faces from TMDB; blob: is the year recap's saved image.
  "img-src 'self' https://image.tmdb.org blob:",
  `frame-src ${PLAYER}`,
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// What the app uses: the home lookup asks for the location
// (views/settings.js), the year recap opens the share sheet (year.js), the
// invite link is copied (views/settings/owner.js). The trailer frame asks for
// the rest, for the player's own origin. Everything after that is off.
const ALLOW = {
  geolocation: ['self'],
  'web-share': ['self'],
  'clipboard-write': ['self', PLAYER],
  fullscreen: ['self', PLAYER],
  accelerometer: ['self', PLAYER],
  gyroscope: ['self', PLAYER],
  'encrypted-media': ['self', PLAYER],
  'picture-in-picture': ['self', PLAYER],
  'compute-pressure': ['self', PLAYER],
};
const OFF = [
  'camera', 'microphone', 'payment', 'usb', 'serial', 'hid', 'bluetooth', 'midi', 'display-capture', 'magnetometer',
  'xr-spatial-tracking', 'screen-wake-lock', 'idle-detection', 'browsing-topics', 'clipboard-read', 'local-fonts',
  'window-management', 'autoplay',
];
const PERMISSIONS_POLICY = [
  ...Object.entries(ALLOW).map(([f, list]) => `${f}=(${list.map((o) => (o === 'self' ? o : `"${o}"`)).join(' ')})`),
  ...OFF.map((f) => `${f}=()`),
].join(', ');

export function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'Permissions-Policy': PERMISSIONS_POLICY,
    // Other sites see the origin only, never a path. Never no-referrer on the
    // app's own pages: the browser would then send Origin "null" with the
    // app's own saves, and the write check refuses that. The invite pages
    // set same-origin over this (server/index.js).
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  next();
}
