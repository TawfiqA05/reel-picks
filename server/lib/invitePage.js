// The two pages an invite link can land on, rendered on the server so that
// opening the link does nothing but show them: "Join Reel Picks" (a button
// that POSTs the token, the only thing that redeems it) and "This invite has
// expired". Link-preview bots (iMessage, Slack, WhatsApp, …) fetch the link to
// draw a card; they get the page, never a cookie, and the invite stays unused.
// Same stylesheet, fonts and components as the app.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// From the app's icon set (public/js/icons.js): the ticket, and the reel mark.
const TICKET = '<path d="M3 8.5V6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5v2a3.5 3.5 0 0 0 0 7v2a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-2a3.5 3.5 0 0 0 0-7z"/><path d="M14.5 5v2M14.5 11v2M14.5 17v2"/>';
const REEL = '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="7" r="1.8"/><circle cx="12" cy="17" r="1.8"/><circle cx="7" cy="12" r="1.8"/><circle cx="17" cy="12" r="1.8"/>';
const svg = (paths, size, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

function shell({ title, description, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0A0A0C" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Reel Picks" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta name="twitter:card" content="summary" />
  <link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400..700&family=Instrument+Serif&display=swap" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div class="shell">
    <header class="app-header">
      <span class="brand">${svg(REEL, 22, 'brand-mark')}<span class="brand-name">Reel Picks</span></span>
    </header>
    <main>
      <div class="page">
        ${body}
      </div>
    </main>
  </div>
</body>
</html>`;
}

export function joinPage({ owner, token }) {
  return shell({
    title: 'Join Reel Picks',
    description: `${owner} invited you to Reel Picks: what's playing at your AMC, ranked by your own taste.`,
    body: `<div class="empty">
          <div class="empty-icon">${svg(TICKET, 32)}</div>
          <h1 class="empty-title">You’re invited by ${esc(owner)}</h1>
          <p class="empty-msg">Reel Picks ranks what’s playing at your AMC by your own taste. Join, rate a few films you’ve seen, and get your four for the week.</p>
          <form method="post" action="/invite/join">
            <input type="hidden" name="token" value="${esc(token)}" />
            <button class="btn" type="submit">Join</button>
          </form>
          <p class="empty-msg small">On iPhone, open this in Safari (tap ••• then Open in Safari) so you stay signed in.</p>
        </div>`,
  });
}

export function expiredPage({ owner }) {
  return shell({
    title: 'Invite expired',
    description: 'This Reel Picks invite has expired.',
    body: `<div class="empty">
          <div class="empty-icon">${svg(TICKET, 32)}</div>
          <h1 class="empty-title">This invite has expired</h1>
          <p class="empty-msg">Ask ${esc(owner)} for a new link.</p>
        </div>`,
  });
}
