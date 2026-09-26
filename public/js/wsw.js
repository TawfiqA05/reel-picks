// "What should I watch?": three quick questions, each one tap and each
// skippable, then three films that fit (server/lib/suggest.js). Opened from
// the Picks page and from the header search sheet; owner and friends only.
//
// A session lasts as long as the sheet is open: every film shown goes into
// `shown` and is sent back with "Show me 3 more", so nothing repeats.
// Seen it (a rating), Watchlist and Not for me all work right on the card and
// teach the model the usual way.
import { api } from './api.js';
import { h, clear, toast, icon, openModal, spinner, poster, scorePill } from './ui.js';
import { starRater, watchlistButton, dayLabel } from './views/components.js';
import { serviceTag, openServicesSheet } from './views/athome.js';

const QUESTIONS = [
  { key: 'where', q: 'Where are you watching?', answers: [['theater', 'Theater'], ['home', 'At home'], ['either', 'Either']] },
  { key: 'time', q: 'How much time do you have?', answers: [['short', 'Under 2h'], ['any', 'Any length']] },
  { key: 'mood', q: 'What are you in the mood for?', answers: [['funny', 'Funny'], ['intense', 'Intense'], ['feel-good', 'Feel-good'], ['mind-bending', 'Mind-bending'], ['scary', 'Scary'], ['romantic', 'Romantic'], ['surprise', 'Surprise me']] },
];

let openNow = null;

export function openWhatToWatch(ctx) {
  if (openNow) return openNow;
  const body = h('div', { class: 'wsw' });
  const shown = new Set();
  let answers = {};
  let step = 0;
  const modal = openModal(body, { title: 'What should I watch?', cls: 'wsw-overlay', onClose: () => { openNow = null; } });
  modal.card.classList.add('wsw-card-sheet');
  openNow = modal;

  function ask() {
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
      body.append(h('p', { class: 'muted' }, e.message), h('button', { class: 'btn ghost', type: 'button', onClick: fetchSome }, 'Try again'));
      return;
    }
    if (!body.isConnected) return;
    clear(body);
    if (r.needsServices) {
      const choose = h('button', { class: 'btn', type: 'button' }, icon('tv', { size: 16 }), 'Choose your services');
      choose.addEventListener('click', () => openServicesSheet([], () => fetchSome()));
      body.append(h('p', {}, 'Tell us which streaming services you have, and the at-home suggestions come from them.'), choose, restartLink());
      return;
    }
    for (const f of r.films) shown.add(f.tmdb_id);
    const heading = h('h3', { class: 'wsw-q', tabindex: '-1' }, r.films.length ? summary() : 'Nothing else fits');
    body.append(heading);
    if (!r.films.length) {
      body.append(h('p', { class: 'muted small' }, shown.size ? 'That\'s everything that fits these answers. Try another mood, or Either.' : 'Nothing fits these answers right now. Try another mood, or Either.'));
    }
    const list = h('div', { class: 'wsw-list' });
    for (const f of r.films) list.appendChild(filmCard(f));
    body.append(list);
    const more = h('button', { class: 'btn wide', type: 'button', disabled: !r.more }, 'Show me 3 more');
    more.addEventListener('click', fetchSome);
    body.append(h('div', { class: 'wsw-foot' }, more, restartLink()));
    heading.focus({ preventScroll: true });
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
  const restartLink = () => h('button', { class: 'link-btn wsw-restart', type: 'button', onClick: () => { step = 0; answers = {}; ask(); } }, 'Change answers');

  function whereLine(f) {
    if (f.where === 'home') return serviceTag(f.service);
    const when = f.next ? `${dayLabel(f.next.date)} ${f.next.time}` : null;
    return h('span', { class: 'service-tag' }, icon('ticket', { size: 16 }), [`At ${f.theatre || 'your theater'}`, when].filter(Boolean).join(' · '));
  }

  function filmCard(f) {
    const tools = h('div', { class: 'wsw-tools' });
    const rateSlot = h('div', { class: 'wsw-rate', hidden: true });
    const cardEl = h('article', { class: 'wsw-film', 'data-id': f.tmdb_id }, h('div', { class: 'wsw-top' },
      h('a', { class: 'wsw-poster', href: `#/movie/${f.tmdb_id}`, tabindex: '-1', 'aria-hidden': 'true', onClick: () => modal.close() }, poster(f, { size: 'card', link: false })),
      h('div', { class: 'wsw-body' },
        h('div', { class: 'pick-head' },
          h('a', { class: 'pick-title', href: `#/movie/${f.tmdb_id}`, onClick: () => modal.close() }, f.title),
          scorePill(f.final)),
        h('div', { class: 'pick-meta' }, h('span', {}, [f.year, (f.genres || []).slice(0, 2).join(' · '), f.runtime ? `${Math.floor(f.runtime / 60)}h ${String(f.runtime % 60).padStart(2, '0')}m` : null].filter(Boolean).join(' · '))),
        whereLine(f),
        h('p', { class: 'pick-reason' }, f.reason))),
    tools, rateSlot);
    const seen = h('button', { class: 'chip-btn wsw-seen', type: 'button', 'aria-expanded': 'false' }, icon('check', { size: 16 }), h('span', {}, 'Seen it'));
    seen.addEventListener('click', () => {
      if (!rateSlot.childElementCount) {
        rateSlot.append(h('span', { class: 'muted small' }, 'How was it?'), starRater(f, ctx, {
          value: 0,
          onRated: (v) => { toast(v ? `Thanks. Rated ${f.title} ${v}★` : 'Rating cleared'); },
        }));
      }
      rateSlot.hidden = !rateSlot.hidden;
      seen.setAttribute('aria-expanded', String(!rateSlot.hidden));
      if (!rateSlot.hidden) rateSlot.querySelector('.stars.interactive')?.focus();
    });
    const hide = h('button', { class: 'chip-btn wsw-hide', type: 'button', 'aria-label': `Not for me, hide ${f.title}` }, icon('eyeOff', { size: 16 }), h('span', {}, 'Not for me'));
    hide.addEventListener('click', async () => {
      hide.disabled = true;
      try {
        await api.hide(f.tmdb_id, f.title);
      } catch (e) { hide.disabled = false; toast(e.message, 'error'); return; }
      cardEl.classList.add('is-hidden');
      const undo = h('button', { class: 'link-btn', type: 'button' }, 'Undo');
      const note = h('p', { class: 'wsw-hidden-note', role: 'status' }, `Hidden. You won't see ${f.title} again. `, undo);
      undo.addEventListener('click', async () => {
        try { await api.unhide(f.tmdb_id); note.remove(); cardEl.classList.remove('is-hidden'); hide.disabled = false; hide.focus(); } catch (e) { toast(e.message, 'error'); }
      });
      cardEl.append(note);
      undo.focus();
    });
    tools.append(seen, watchlistButton(f, ctx), hide);
    return cardEl;
  }

  ask();
  return modal;
}
