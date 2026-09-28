// "What should I watch?": three quick questions, each one tap and each
// skippable, then three films that fit (server/lib/suggest.js). Opened from
// the Picks page and from the header search sheet; owner and friends only.
//
// Every film shown goes into `shown` and is sent back with "Show me 3 more",
// so nothing repeats. Seen it (a rating), Watchlist and Not for me all work
// right on the card and teach the model the usual way.
//
// Keeping the place. The answers, the results and what was done to them are
// kept in this device's storage, per person (KEY + user id), for 30 minutes
// from the last change. Opening a film from the sheet (its page, then maybe
// the trailer or a person) and coming back to the page the sheet was opened
// on (Back, the back gesture, or tapping that tab) opens it again on the same
// results: resumeWhatToWatch() runs after every page is drawn. Start over,
// the close button, Escape or a tap outside the sheet end it.
import { api } from './api.js';
import { h, clear, toast, icon, openModal, spinner, poster, matchBadge, withStars } from './ui.js';
import { starRater, watchlistButton, dayLabel, reasonLine } from './views/components.js';
import { serviceTag, openServicesSheet } from './views/athome.js';

const QUESTIONS = [
  { key: 'where', q: 'Where are you watching?', answers: [['theater', 'Theater'], ['home', 'At home'], ['either', 'Either']] },
  { key: 'time', q: 'How much time do you have?', answers: [['short', 'Under 2h'], ['any', 'Any length']] },
  { key: 'mood', q: 'What are you in the mood for?', answers: [['funny', 'Funny'], ['intense', 'Intense'], ['feel-good', 'Feel-good'], ['mind-bending', 'Mind-bending'], ['scary', 'Scary'], ['romantic', 'Romantic'], ['surprise', 'Surprise me']] },
];

const KEY = 'rp-wsw:';
const KEEP_MS = 30 * 60 * 1000;
// Pages a film trip passes through on the way back to the sheet.
const TRIP = /^#\/(movie|person)\//;

const uidOf = (ctx) => ctx.getStatus?.()?.user?.id ?? null;
const here = () => (location.hash && location.hash !== '#' ? location.hash : '#/home');

function load(uid) {
  if (uid == null) return null;
  try {
    const s = JSON.parse(localStorage.getItem(KEY + uid) || 'null');
    if (s && s.v === 1 && Date.now() - s.at < KEEP_MS) return s;
    localStorage.removeItem(KEY + uid);
  } catch { /* storage off: nothing kept */ }
  return null;
}
function save(uid, s) {
  if (uid == null) return;
  try { localStorage.setItem(KEY + uid, JSON.stringify({ ...s, v: 1, at: Date.now() })); } catch { /* storage off or full */ }
}
function forget(uid) {
  try { localStorage.removeItem(KEY + uid); } catch { /* storage off */ }
}

let openNow = null;

// After each page is drawn: back from a film opened in the sheet, on the page
// the sheet was opened on, it opens again where it was.
export function resumeWhatToWatch(ctx) {
  if (openNow || ctx.isGuest?.()) return;
  const uid = uidOf(ctx);
  const s = load(uid);
  if (!s?.returnTo) return;
  const at = here();
  const back = at === s.returnTo;
  if (!back && TRIP.test(at)) return;
  save(uid, { ...s, returnTo: null });
  if (back) openWhatToWatch(ctx);
}

export function openWhatToWatch(ctx) {
  if (openNow) return openNow;
  const uid = uidOf(ctx);
  const kept = load(uid);
  const body = h('div', { class: 'wsw' });
  const shown = new Set(kept?.shown || []);
  let answers = kept?.answers || {};
  let step = kept?.step || 0;
  let result = kept?.result || null; // the last answer from the server
  let cards = kept?.cards || {}; // id -> { hidden, rated, watchlisted } done here
  const origin = here();
  // A film hidden, rated or watchlisted here changes the Picks page behind the
  // sheet; it's drawn again when the sheet closes.
  let changed = false;
  let leaving = false; // closing to open a film: the place is kept
  const keep = () => save(uid, { answers, step, result, shown: [...shown], cards, returnTo: null });
  const modal = openModal(body, {
    title: 'What should I watch?', cls: 'wsw-overlay',
    onClose: () => {
      openNow = null;
      if (leaving) save(uid, { answers, step, result, shown: [...shown], cards, returnTo: origin });
      else forget(uid);
      if (changed && !leaving && /^#\/home/.test(location.hash || '#/home')) ctx.rerender?.();
    },
  });
  modal.card.classList.add('wsw-card-sheet');
  openNow = modal;
  // Any link in the sheet (a poster, a title, a film in a reason) leaves for
  // that page and keeps the place.
  body.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="#/"]');
    if (!a || !body.contains(a)) return;
    leaving = true;
    modal.close();
  });

  function ask() {
    result = null;
    keep();
    clear(body);
    const q = QUESTIONS[step];
    const heading = h('h3', { class: 'wsw-q', tabindex: '-1' }, q.q);
    const picked = answers[q.key];
    body.append(
      h('p', { class: 'wsw-step' }, `${step + 1} of ${QUESTIONS.length}`),
      heading,
      h('div', { class: 'chips wsw-answers', role: 'group', 'aria-label': q.q },
        ...q.answers.map(([value, label]) => h('button', {
          class: `chip${picked === value ? ' active' : ''}`, type: 'button', 'data-answer': value,
          onClick: () => { answers[q.key] = value; next(); },
        }, label))),
      h('div', { class: 'wsw-nav' },
        step ? h('button', { class: 'link-btn', type: 'button', onClick: () => { step--; ask(); } }, 'Back') : h('span'),
        h('button', { class: 'link-btn wsw-skip', type: 'button', onClick: () => { delete answers[q.key]; next(); } }, 'Skip')),
    );
    heading.focus({ preventScroll: true });
  }
  const next = () => { if (step < QUESTIONS.length - 1) { step++; ask(); } else fetchSome(); };

  async function fetchSome() {
    clear(body);
    body.append(spinner('Finding three films…'));
    let r;
    try {
      r = await api.suggest({ ...answers, exclude: [...shown] });
    } catch (e) {
      clear(body);
      body.append(h('p', { class: 'muted' }, e.message), h('button', { class: 'btn soft', type: 'button', onClick: fetchSome }, 'Try again'));
      return;
    }
    if (!body.isConnected) return;
    if (r.needsServices) {
      clear(body);
      const choose = h('button', { class: 'btn', type: 'button' }, icon('tv', { size: 16 }), 'Choose your services');
      choose.addEventListener('click', () => openServicesSheet([], () => fetchSome()));
      body.append(h('p', {}, 'Tell us which streaming services you have, and the at-home suggestions come from them.'), choose, restartLink());
      return;
    }
    for (const f of r.films) shown.add(f.tmdb_id);
    result = r;
    cards = {};
    keep();
    showResults();
  }

  function showResults({ restored = false } = {}) {
    clear(body);
    const r = result;
    const heading = h('h3', { class: 'wsw-q', tabindex: '-1' }, r.films.length ? summary() : 'Nothing else fits');
    body.append(heading);
    if (r.note) body.append(h('p', { class: `wsw-note${r.films.length ? '' : ' muted'}`, role: r.films.length ? null : 'status' }, r.note));
    const list = h('div', { class: 'wsw-list' });
    for (const f of r.films) list.appendChild(filmCard(f));
    body.append(list);
    const more = h('button', { class: 'btn wide', type: 'button', disabled: !r.more }, 'Show me 3 more');
    more.addEventListener('click', fetchSome);
    body.append(h('div', { class: 'wsw-foot' }, more, restartLink()));
    heading.focus({ preventScroll: true });
    if (restored) recheck(r.films.map((f) => f.tmdb_id));
  }

  // Back from a film's page: what was done to the films there (a rating, a
  // save, Not for me) shows on their cards.
  async function recheck(ids) {
    let now;
    try { now = (await api.suggestState(ids)).films; } catch { return; }
    if (!body.isConnected || result?.films.map((f) => f.tmdb_id).join() !== ids.join()) return;
    let differs = false;
    for (const s of now) {
      const f = result.films.find((x) => x.tmdb_id === s.tmdb_id);
      const c = cards[s.tmdb_id] || {};
      if (!f) continue;
      if (f.watchlisted !== s.watchlisted || Boolean(c.hidden) !== s.hidden || (c.rated || 0) !== (s.rating || 0)) differs = true;
      f.watchlisted = s.watchlisted;
      cards[s.tmdb_id] = { ...c, hidden: s.hidden, rated: s.rating || 0 };
    }
    keep();
    if (differs) showResults();
  }

  const summary = () => {
    const bits = [];
    if (answers.where === 'theater') bits.push('at the theater');
    if (answers.where === 'home') bits.push('at home');
    if (answers.time === 'short') bits.push('under 2 hours');
    const mood = QUESTIONS[2].answers.find(([v]) => v === answers.mood);
    const lead = mood && answers.mood !== 'surprise' ? `${mood[1]} picks` : 'Three picks';
    return bits.length ? `${lead}, ${bits.join(', ')}` : `${lead} for you`;
  };
  const restartLink = () => h('button', {
    class: 'link-btn wsw-restart', type: 'button',
    onClick: () => { step = 0; answers = {}; shown.clear(); cards = {}; ask(); },
  }, 'Start over');

  function whereLine(f) {
    if (f.where === 'home') return serviceTag(f.service);
    const when = f.next ? `${dayLabel(f.next.date)} ${f.next.time}` : null;
    return h('span', { class: 'service-tag' }, icon('ticket', { size: 16 }), [`At ${f.theatre || 'your theater'}`, when].filter(Boolean).join(' · '));
  }

  function filmCard(f) {
    const mark = (patch) => { cards[f.tmdb_id] = { ...cards[f.tmdb_id], ...patch }; keep(); };
    const tools = h('div', { class: 'wsw-tools' });
    const rateSlot = h('div', { class: 'wsw-rate', hidden: true });
    const cardEl = h('article', { class: 'wsw-film', 'data-id': f.tmdb_id }, h('div', { class: 'wsw-top' },
      h('a', { class: 'wsw-poster', href: `#/movie/${f.tmdb_id}`, tabindex: '-1', 'aria-hidden': 'true' }, poster(f, { size: 'card', link: false })),
      h('div', { class: 'wsw-body' },
        h('h4', { class: 'pick-head' },
          h('a', { class: 'pick-title', href: `#/movie/${f.tmdb_id}` }, f.title)),
        // The match pill, then the public score that cleared the bar.
        h('p', { class: 'wsw-score' }, matchBadge(f.final), ...(f.publicLine ? [' ', h('span', { class: 'wsw-public' }, `· ${f.publicLine}`)] : [])),
        h('p', { class: 'pick-meta' }, [f.year, (f.genres || []).slice(0, 2).join(' · '), f.runtime ? `${Math.floor(f.runtime / 60)}h ${String(f.runtime % 60).padStart(2, '0')}m` : null].filter(Boolean).join(' · ')),
        whereLine(f),
        reasonLine(f, ctx))),
    tools, rateSlot);
    const rated = cards[f.tmdb_id]?.rated || 0;
    const seen = h('button', { class: 'btn soft wsw-seen', type: 'button', 'aria-expanded': 'false' }, icon('check', { size: 16 }), h('span', {}, 'Seen it'));
    const openRater = () => {
      if (!rateSlot.childElementCount) {
        rateSlot.append(h('span', { class: 'muted small' }, 'How was it?'), starRater(f, ctx, {
          value: cards[f.tmdb_id]?.rated || 0,
          onRated: (v) => { changed = true; mark({ rated: v || 0 }); toast(v ? withStars(`Thanks. Rated ${f.title} ${v}★`) : 'Rating cleared'); },
        }));
      }
      rateSlot.hidden = !rateSlot.hidden;
      seen.setAttribute('aria-expanded', String(!rateSlot.hidden));
    };
    seen.addEventListener('click', () => {
      openRater();
      if (!rateSlot.hidden) rateSlot.querySelector('.stars.interactive')?.focus();
    });
    // Rated earlier (here, or on the film's page): the stars show it.
    if (rated) openRater();
    const hide = h('button', { class: 'btn danger wsw-hide', type: 'button', 'aria-label': `Not for me, hide ${f.title}` }, icon('eyeOff', { size: 16 }), h('span', {}, 'Not for me'));
    const hiddenNote = () => {
      cardEl.classList.add('is-hidden');
      hide.disabled = true;
      const undo = h('button', { class: 'link-btn', type: 'button' }, 'Undo');
      const note = h('p', { class: 'wsw-hidden-note', role: 'status' }, icon('eyeOff', { size: 14, cls: 'hidden-icon' }), ` Hidden. You won't see ${f.title} again. `, undo);
      undo.addEventListener('click', async () => {
        try {
          await api.unhide(f.tmdb_id);
          note.remove(); cardEl.classList.remove('is-hidden'); hide.disabled = false; hide.focus();
          changed = true;
          mark({ hidden: false });
        } catch (e) { toast(e.message, 'error'); }
      });
      cardEl.append(note);
      return undo;
    };
    hide.addEventListener('click', async () => {
      changed = true;
      hide.disabled = true;
      try {
        await api.hide(f.tmdb_id, f.title);
      } catch (e) { hide.disabled = false; toast(e.message, 'error'); return; }
      mark({ hidden: true });
      hiddenNote().focus();
    });
    tools.append(seen, watchlistButton(f, ctx, { words: true, onToggle: (on) => { changed = true; f.watchlisted = on; keep(); } }), hide);
    if (cards[f.tmdb_id]?.hidden) hiddenNote();
    return cardEl;
  }

  if (kept?.result) showResults({ restored: true });
  else ask();
  return modal;
}
