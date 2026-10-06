// The headers every answer carries (server/index.js): which of the browser's
// features the app and the trailer frame may use, how much of an address
// leaves with a request, and no framing or type sniffing.

// The trailer's player (public/js/views/detail.js).
const PLAYER = 'https://www.youtube-nocookie.com';

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
