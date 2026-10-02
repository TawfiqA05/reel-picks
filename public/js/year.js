// Your year in movies: a run of full-screen cards about the year that's
// ending (server/lib/year.js), opened from a card on Picks and a row in You
// from December 1 through January 15, and by the owner from Settings any day
// ("Preview year in movies"). Tap the right of a card or swipe left to go on,
// the left or a swipe right to go back; the arrow keys and the Back and Next
// buttons do the same. The last card saves a 1080 x 1920 image to share,
// drawn on a canvas from this server's own poster copies (/api/year/poster),
// so the canvas stays readable.
import { api } from './api.js';
import { h, clear, openModal, toast, icon, money, poster, withStars, reduced, plural } from './ui.js';

const monthName = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long' }); };
const dayName = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }); };
// A rating as the app writes it (4.5★), and in words for a screen reader.
const stars = (r) => h('span', { class: 'yr-stars' }, h('span', { 'aria-hidden': 'true' }, withStars(`${r}★`)), h('span', { class: 'sr-only' }, `${r} star${r === 1 ? '' : 's'}`));

// Each card's colour: the opening card is a solid marquee panel (the accent,
// its text in the accent's own ink, the pair buttons use), the rest take the
// palette's soft tints in turn, their kicker and big figures in the tint's
// own colour (the pairs the palette holds to AA on every surface).
const TINTS = ['yr-tint-blue', 'yr-tint-teal', 'yr-tint-purple'];
const tintOf = (kind, i) => (kind === 'intro' ? 'yr-tint-accent' : TINTS[i % TINTS.length]);

// The entry points: the card at the top of Picks and the row in You.
export function yearEntry(ctx, where) {
  const y = ctx.getStatus?.()?.year;
  if (!y?.open || ctx.isGuest?.()) return null;
  return h('div', { class: 'banner year-entry', 'data-where': where },
    h('span', { class: 'year-entry-icon', 'aria-hidden': 'true' }, icon('reel', { size: 22 })),
    h('div', { class: 'year-entry-text' },
      h('div', { class: 'banner-title' }, `Your ${y.year} in movies`),
      h('div', { class: 'banner-sub' }, 'Your films, favorites and a card to share.'),
    ),
    h('button', { class: 'btn', type: 'button', onClick: () => openYear(ctx) }, 'Open'),
  );
}

let opening = false;
export async function openYear(ctx, { preview = false } = {}) {
  if (opening) return;
  opening = true;
  let recap;
  try {
    recap = await api.year(preview);
  } catch (e) {
    toast(e.message, 'error');
    return;
  } finally {
    opening = false;
  }
  showRecap(recap, ctx, { preview: preview || recap.preview });
}

function showRecap(recap, ctx, { preview }) {
  const cards = recap.cards;
  let at = 0;
  const progress = h('div', { class: 'yr-progress', 'aria-hidden': 'true' }, ...cards.map(() => h('span', { class: 'yr-seg' })));
  // A screen reader hears each new card as it arrives.
  const stage = h('div', { class: 'yr-stage', 'aria-live': 'polite' });
  const count = h('p', { class: 'yr-count' });
  const back = h('button', { class: 'btn soft yr-back', type: 'button' }, icon('chevronLeft', { size: 20 }), h('span', {}, 'Back'));
  const next = h('button', { class: 'btn yr-next', type: 'button' });
  const body = h('div', { class: 'yr-body' }, progress, stage, h('div', { class: 'yr-nav' }, back, count, next));
  const modal = openModal(body, {
    title: `${preview ? 'Preview: ' : ''}Your ${recap.year} in movies`,
    cls: 'year-sheet',
    onClose: () => document.removeEventListener('keydown', onKey),
  });

  const show = (i, dir = 0) => {
    at = Math.max(0, Math.min(cards.length - 1, i));
    const card = buildCard(cards[at], recap, { ctx, close: modal.close, preview });
    card.classList.add(tintOf(cards[at].kind, at));
    card.setAttribute('aria-label', `${at + 1} of ${cards.length}: ${card.querySelector('h3')?.textContent || ''}`);
    if (dir && !reduced()) card.classList.add('yr-enter', dir > 0 ? 'yr-from-right' : 'yr-from-left');
    else if (dir) card.classList.add('yr-enter');
    clear(stage).appendChild(card);
    stage.scrollTop = 0;
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.remove('yr-enter', 'yr-from-right', 'yr-from-left')));
    [...progress.children].forEach((s, k) => s.classList.toggle('done', k <= at));
    count.textContent = `${at + 1} of ${cards.length}`;
    back.disabled = at === 0;
    const last = at === cards.length - 1;
    next.replaceChildren(...[h('span', {}, last ? 'Done' : 'Next'), last ? null : icon('chevronRight', { size: 20 })].filter(Boolean));
    // A screen reader hears the new card from its heading; the keyboard
    // stays where it was (a disabled Back hands it to Next).
    if (dir) {
      const heading = card.querySelector('h3');
      if (document.activeElement === back && back.disabled) next.focus({ preventScroll: true });
      else if (!body.contains(document.activeElement) || document.activeElement === stage || stage.contains(document.activeElement)) heading?.focus({ preventScroll: true });
    }
  };
  const go = (d) => {
    if (d > 0 && at === cards.length - 1) return;
    if (d < 0 && at === 0) return;
    show(at + d, d);
  };
  back.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => (at === cards.length - 1 ? modal.close() : go(1)));

  // Tap: the left third goes back, the rest goes on; a tap on anything
  // that does something of its own (a link, a button) is left to it.
  let press = null;
  stage.addEventListener('pointerdown', (e) => { press = { x: e.clientX, y: e.clientY, t: Date.now() }; });
  stage.addEventListener('pointerup', (e) => {
    if (!press) return;
    const dx = e.clientX - press.x; const dy = e.clientY - press.y;
    press = null;
    if (e.target.closest('a, button, input, textarea, select')) return;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2) { go(dx < 0 ? 1 : -1); return; }
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return; // a scroll, not a tap
    const r = stage.getBoundingClientRect();
    go(e.clientX - r.left < r.width / 3 ? -1 : 1);
  });
  stage.addEventListener('pointercancel', () => { press = null; });
  const onKey = (e) => {
    if (!document.contains(modal.overlay) || e.target.closest?.('input, textarea, select')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  };
  document.addEventListener('keydown', onKey);
  show(0);
  next.focus({ preventScroll: true });
}

// ---- the cards ---------------------------------------------------------

const big = (value, label) => h('div', { class: 'yr-big' }, h('span', { class: 'yr-figure' }, String(value)), h('span', { class: 'yr-label' }, label));
const filmLine = (label, f, extra) => h('div', { class: 'yr-film' },
  poster(f, { size: 'sm', link: false }),
  h('div', { class: 'yr-film-text' }, h('span', { class: 'yr-film-label' }, label), h('span', { class: 'yr-film-title' }, f.title), extra ? h('span', { class: 'yr-film-meta' }, extra) : null));

function buildCard(c, recap, { ctx, close, preview }) {
  const Y = recap.year;
  const heading = (text) => h('h3', { class: 'yr-title', tabindex: '-1' }, text);
  const sec = (...kids) => h('section', { class: 'yr-card', 'data-kind': c.kind, 'aria-roledescription': 'card' }, ...kids);
  const kicker = (text) => h('p', { class: 'yr-kicker' }, text);
  switch (c.kind) {
    case 'intro':
      return sec(kicker(`${recap.name}, this was`),
        h('h3', { class: 'yr-title yr-stack', tabindex: '-1' }, h('span', {}, 'Your '), h('span', { class: 'yr-year' }, String(Y)), h('span', {}, ' in movies')),
        h('p', { class: 'yr-text' }, !c.films
          ? 'Nothing logged yet this year, and that\'s fine. Here\'s how to fill it in.'
          : recap.short ? `A short one: ${plural(c.films, 'film')} so far. Here's what you logged.`
            : `${plural(c.films, 'film')} seen or rated. Tap or use the arrow keys to flip through.`));
    case 'start':
      return sec(heading('Your year starts here'),
        h('p', { class: 'yr-text' }, 'Rate a few films you\'ve seen, or tap I\'m going on a showing, and next time this fills in with your numbers and favorites.'),
        h('a', { class: 'btn yr-cta', href: '#/rate', onClick: () => close() }, 'Rate films'));
    case 'numbers':
      return sec(kicker(`In ${Y}`), heading(c.seen ? `${plural(c.seen, 'film')} in theaters` : `${plural(c.rated, 'film')} rated`),
        h('div', { class: 'yr-bigs' }, big(c.seen, 'seen in theaters'), big(c.rated, c.rated === 1 ? 'film rated' : 'films rated')),
        h('p', { class: 'yr-text' }, c.seen && c.rated ? `${plural(c.films, 'film')} in all, seen or rated.`
          : c.seen ? 'Rate them and your recap knows your favorites too.' : 'Mark seen after a showing and those count here too.'));
    case 'tops': {
      const rows = [['Director', c.director], ['Actor', c.actor], ['Genre', c.genre]].filter(([, v]) => v);
      return sec(kicker('You kept coming back to'), heading(rows[0][1].name),
        h('ul', { class: 'yr-list' }, ...rows.map(([k, v]) => h('li', { class: 'yr-list-row' },
          h('span', { class: 'yr-list-key' }, `Top ${k.toLowerCase()}`), h('span', { class: 'yr-list-name' }, v.name), h('span', { class: 'yr-list-n' }, plural(v.n, 'film'))))),
        h('p', { class: 'yr-text' }, `By films you saw or rated in ${Y}, the way Stats ranks them.`));
    }
    case 'theater':
      return sec(kicker('Your theater'), heading(c.name),
        h('p', { class: 'yr-text' }, `${plural(c.showings, 'showing')} you said you were going to.`));
    case 'months':
      return sec(kicker('Your busiest month'), heading(monthName(c.busiest.month)),
        h('p', { class: 'yr-text' }, `${plural(c.busiest.films, 'film')} that month.`),
        h('div', { class: 'yr-films' }, filmLine('First of the year', c.first, dayName(c.first.date)), filmLine('Latest', c.last, dayName(c.last.date))));
    case 'plan': {
      const span = c.months.length === 1 ? monthName(c.months[0].month) : `${monthName(c.months[0].month)} to ${monthName(c.months.at(-1).month)}`;
      return sec(kicker(c.subscription ? c.planName : 'Tickets'),
        heading(`${plural(c.tickets, c.subscription ? c.units.replace(/s$/, '') : 'ticket')} used`),
        h('div', { class: 'yr-bigs' }, c.subscription
          ? big(money(Math.abs(c.saved)), c.saved >= 0 ? 'saved' : 'more in fees than the tickets')
          : big(money(c.value), 'spent on tickets')),
        h('p', { class: 'yr-text' }, c.subscription
          ? `${money(c.value)} of tickets for ${money(c.fees)} in fees, ${span}.`
          : `At your ticket prices, ${span}.`));
    }
    case 'picks':
      return sec(kicker('Your weekly four'), heading(`You saw ${plural(c.seen, 'weekly pick')}`),
        c.best ? h('div', { class: 'yr-films' }, filmLine('Best of them', c.best, stars(c.best.rating))) : h('p', { class: 'yr-text' }, 'Rate them to see which one landed best.'));
    case 'best':
      return sec(kicker('Your highest rated'), heading(c.film.title),
        h('div', { class: 'yr-hero' }, poster(c.film, { size: 'grid', link: false }),
          h('div', { class: 'yr-hero-text' }, stars(c.film.rating),
            c.film.note ? h('blockquote', { class: 'yr-note' }, h('p', {}, c.film.note)) : null)));
    case 'summary':
      return summaryCard(c, recap, { sec, heading, kicker, preview });
    default:
      return sec(heading(`Your ${Y} in movies`));
  }
}

function summaryCard(c, recap, { sec, heading, kicker, preview }) {
  // A zero isn't a fact worth sharing: someone who only rated gets just that.
  const facts = [
    c.seen ? [String(c.seen), 'seen in theaters'] : null,
    c.rated ? [String(c.rated), c.rated === 1 ? 'film rated' : 'films rated'] : null,
    c.genre ? [c.genre, 'top genre'] : null,
    c.director ? [c.director, 'top director'] : null,
  ].filter(Boolean);
  const save = h('button', { class: 'btn yr-save', type: 'button' }, icon('download', { size: 18 }), 'Save image');
  const status = h('p', { class: 'yr-save-status', role: 'status' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    status.textContent = 'Making your image…';
    try {
      const how = await saveImage(c, recap, { preview });
      status.textContent = how === 'shared' ? 'Shared.' : how === 'cancelled' ? '' : 'Image saved.';
    } catch (e) {
      status.textContent = '';
      toast(`Couldn't make the image: ${e.message}`, 'error');
    } finally { save.disabled = false; }
  });
  return sec(kicker(`${recap.name}'s ${recap.year}`), heading(recap.short ? 'A good start' : 'That was your year'),
    h('dl', { class: 'yr-facts' }, ...facts.map(([v, k]) => h('div', { class: 'yr-fact' }, h('dt', {}, k), h('dd', {}, v)))),
    c.posters.length ? h('div', { class: 'yr-posters' }, ...c.posters.map((p) => poster(p, { size: 'grid', link: false }))) : null,
    recap.short ? h('p', { class: 'yr-text' }, 'Rate a few more films and next December has more to show.') : null,
    h('div', { class: 'yr-actions' }, save), status);
}

// ---- the image -------------------------------------------------------------

const W = 1080;
const H = 1920;

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Fits text on one line from `size` down, in the given face.
function fit(g, text, face, weight, size, maxW, min = 40) {
  let s = size;
  for (; s > min; s -= 4) { g.font = `${weight} ${s}px ${face}`; if (g.measureText(text).width <= maxW) break; }
  let t = text;
  while (g.measureText(t).width > maxW && t.length > 2) t = `${t.slice(0, -2)}…`;
  return t;
}

async function drawShare(c, recap, { preview = false } = {}) {
  const css = getComputedStyle(document.documentElement);
  const v = (k) => css.getPropertyValue(k).trim();
  const display = v('--font-display');
  const bodyFace = v('--font-body');
  await Promise.all([
    document.fonts.load(`700 120px ${display}`), document.fonts.load(`600 40px ${bodyFace}`), document.fonts.load(`400 40px ${bodyFace}`),
  ].map((p) => p.catch(() => null)));
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  // A solid marquee band on top (the accent and its ink), the page colour below.
  g.fillStyle = v('--bg'); g.fillRect(0, 0, W, H);
  g.fillStyle = v('--accent'); g.fillRect(0, 0, W, 800);
  const ink = v('--on-accent');
  g.fillStyle = ink; g.fillRect(96, 128, 120, 12);
  g.textBaseline = 'alphabetic';
  g.font = `600 40px ${bodyFace}`;
  g.fillText('Reel Picks', 96, 230);
  g.fillText(fit(g, `${recap.name}'s`, bodyFace, 600, 64, W - 192), 96, 340);
  g.font = `700 220px ${display}`;
  g.fillText(String(recap.year), 90, 560);
  g.font = `700 104px ${display}`;
  g.fillText('in movies', 96, 690);

  // The numbers.
  const facts = [c.seen ? [String(c.seen), 'seen in theaters'] : null, c.rated ? [String(c.rated), c.rated === 1 ? 'film rated' : 'films rated'] : null].filter(Boolean);
  facts.forEach(([n, label], i) => {
    const x = 96 + i * 460;
    g.fillStyle = v('--text'); g.font = `700 150px ${display}`; g.fillText(n, x, 1000);
    g.fillStyle = v('--muted'); g.font = `600 40px ${bodyFace}`; g.fillText(label, x, 1060);
  });
  let y = 1160;
  for (const [k, val] of [['Top genre', c.genre], ['Top director', c.director]]) {
    if (!val) continue;
    g.fillStyle = v('--muted'); g.font = `600 36px ${bodyFace}`; g.fillText(k, 96, y);
    g.fillStyle = v('--text'); g.fillText(fit(g, val, bodyFace, 600, 52, W - 192 - 330), 96 + 330, y);
    y += 76;
  }

  // Up to four posters in a row, from this server (same origin).
  const posters = (await Promise.all(c.posters.slice(0, 4).map((p) => loadImage(api.yearPosterUrl(p.tmdb_id, preview))))).filter(Boolean);
  if (posters.length) {
    // Right under the facts, whatever their count, with the bottom margin to spare.
    const gap = 24; const pw = (W - 192 - gap * 3) / 4; const ph = pw * 1.5; const top = Math.min(y + 40, H - 112 - ph);
    posters.forEach((img, i) => {
      const x = 96 + i * (pw + gap);
      g.save();
      g.beginPath(); if (g.roundRect) g.roundRect(x, top, pw, ph, 16); else g.rect(x, top, pw, ph); g.clip();
      // Cover the box, cropping the long side.
      const s = Math.max(pw / img.naturalWidth, ph / img.naturalHeight);
      const dw = img.naturalWidth * s; const dh = img.naturalHeight * s;
      g.drawImage(img, x + (pw - dw) / 2, top + (ph - dh) / 2, dw, dh);
      g.restore();
    });
  }
  return canvas;
}

async function saveImage(c, recap, { preview }) {
  const canvas = await drawShare(c, recap, { preview });
  const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the canvas gave no image'))), 'image/png'));
  const name = `reel-picks-${recap.year}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `My ${recap.year} in movies` });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      // Sharing refused: fall through to a download.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'saved';
}
