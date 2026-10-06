// The headers every answer carries (server/index.js): how much of an address
// leaves with a request, and no framing or type sniffing.

export function securityHeaders(req, res, next) {
  res.set({
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
