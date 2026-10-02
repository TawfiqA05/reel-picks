// "I'm going" and Send a pick on the page (server/lib/plans.js, sends.js):
// the caller's plans, who else is going, picks sent to them, and the sheets
// and lines that show them. One copy of /api/social is kept here. Every line
// drawn from it, and every showtime row, repaints when it changes, so a plan
// made in a sheet shows at once on the hero, the movie page and that
// showtime. The guest link has none of this.
import { api } from './api.js';
import { h, clear, icon, toast, openModal, poster } from './ui.js';
import { dayLabel, formatBadge, formatName, starRater, watchlistButton } from './views/components.js';
import { noteSlot } from './notes.js';
import { DEMO, offLine } from './demo.js';

let state = null;
const live = new Set();

// Fetches /api/social (skipped for the guest). A failure keeps what was there:
// the page still draws, just without plans or sent picks.
export async function loadSocial(ctx) {
  if (ctx?.isGuest?.()) { state = null; return null; }
  try {
    state = await api.social();
  } catch { /* keep the last copy */ }
  repaint();
  return state;
}

const planFor = (id) => state?.plans?.find((p) => p.tmdb_id === id) || null;
const planForShowtime = (stId) => state?.plans?.find((p) => p.showtime_id === stId && !p.started) || null;
const goingFor = (id) => (state?.going || []).filter((g) => g.tmdb_id === id);
const sentFor = (id) => (state?.sent || []).filter((s) => s.tmdb_id === id);

function setPlan(plan, tmdbId) {
  if (!state) return;
  state.plans = (state.plans || []).filter((p) => p.tmdb_id !== tmdbId);
  if (plan) state.plans.push(plan);
  repaint();
}

// ---- words -----------------------------------------------------------------

// "Tonight", "Today", "Tomorrow", "Sat" or "Oct 3" for a showing still to
// come (the words the server's pushes use, lib/plans.js dayWord); "Last
// night", "Yesterday" or the weekday for one that has been.
export function whenWord(date, startLocal) {
  const t = new Date(`${date}T00:00:00`);
  const now = new Date();
  const days = Math.round((t - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  const evening = Number(String(startLocal || '').slice(11, 13)) >= 17;
  if (days === 0) return evening ? 'Tonight' : 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return evening ? 'Last night' : 'Yesterday';
  if (Math.abs(days) < 7) return t.toLocaleDateString('en-US', { weekday: 'short' });
  return t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
const whenText = (p) => `${whenWord(p.date, p.start_local)} ${p.time}`;
// Inside a sentence: "tonight at 7:10 PM", "on Sat at 7:10 PM".
function whenSentence(p) {
  const w = whenWord(p.date, p.start_local);
  return /^(Tonight|Today|Tomorrow|Last night|Yesterday)$/.test(w) ? `${w.toLowerCase()} at ${p.time}` : `on ${w} at ${p.time}`;
}
// "You're going · Tonight 7:10 PM · Maple Grove" ("You planned" once it's started).
const planText = (p) => [p.started ? 'You planned' : 'You\'re going', whenText(p), p.theatre].filter(Boolean).join(' · ');
const goingText = (g) => `${g.name} is going ${whenText(g)}${g.theatre ? ` · ${g.theatre}` : ''}`;

// ---- live lines ------------------------------------------------------------

// An element that redraws itself from the state now and on every change.
// Anything taken off the page is dropped at the next change.
function liveEl(el, paint) {
  el._paint = () => paint.call(el);
  el._born = Date.now();
  live.add(el);
  el._paint();
  return el;
}

function repaint() {
  for (const el of live) {
    if (!el.isConnected) { if (Date.now() - el._born > 10000) live.delete(el); continue; }
    el._paint();
  }
  document.querySelectorAll('.st-row[data-st]').forEach(paintRow);
}

// A showtime row (js/views/components.js showtimeRow) that is the caller's
// plan: the soft accent, and the plan's line across the row.
export function paintRow(row) {
  const p = planForShowtime(row.dataset.st);
  row.classList.toggle('planned', Boolean(p));
  let line = row.querySelector(':scope > .st-plan');
  if (!p) { line?.remove(); return; }
  if (!line) { line = h('span', { class: 'st-plan' }); row.append(line); }
  line.replaceChildren(icon('check', { size: 14 }), h('span', {}, planText(p)));
}

// A control that was pressed and then went (a card answered or dismissed)
// takes the focus with it: put it on the next control in `scope`, or on the
// page's title link, never leave it on the page itself.
function keepFocus(scope) {
  requestAnimationFrame(() => {
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    const next = scope?.isConnected ? scope.querySelector('button:not(:disabled), a[href]:not([tabindex="-1"])') : null;
    (next || document.querySelector('#main .hero-title a, #main h1 a, #main a[href]'))?.focus({ preventScroll: true });
  });
}

// ---- plans -------------------------------------------------------------------

// After a plan is made or cancelled the button pressed is gone (the line
// redraws): focus moves to what took its place in the same line.
function refocus(home) {
  if (!home) return;
  requestAnimationFrame(() => (home.querySelector('.plan-change, .plan-cancel, .change-btn, .go-btn, .send-btn'))?.focus({ preventScroll: true }));
}

async function planShowing(st, film, ctx) {
  const had = planFor(film.tmdb_id);
  try {
    const r = await api.plan(st.id);
    setPlan(r.plan, film.tmdb_id);
    const where = r.plan.theatre ? ` (${r.plan.theatre})` : '';
    toast(`${r.moved ? 'Moved. ' : ''}You're going to ${film.title} ${whenSentence(r.plan)}${where}.`, 'success', {
      action: { label: 'Undo', onClick: () => (had && !had.started ? replan(had, film, ctx) : cancel(film, ctx, { quiet: true })) },
    });
    return true;
  } catch (e) {
    toast(e.message, 'error');
    if (e.status === 409 || e.status === 404) loadSocial(ctx);
    return false;
  }
}

async function replan(p, film, ctx) {
  try { setPlan((await api.plan(p.showtime_id)).plan, film.tmdb_id); toast(`Back to ${whenSentence(p)}.`); } catch (e) { toast(e.message, 'error'); }
}

async function cancel(film, ctx, { quiet = false } = {}) {
  const had = planFor(film.tmdb_id);
  try {
    await api.cancelPlan(film.tmdb_id);
    setPlan(null, film.tmdb_id);
    if (quiet) toast('Plan taken off.');
    else {
      toast(`Plan for ${film.title} cancelled.`, '', {
        action: had && !had.started ? { label: 'Undo', onClick: () => replan(had, film, ctx) } : null,
      });
    }
  } catch (e) { toast(e.message, 'error'); }
}

// The showings a sheet offers, per theater: from a Picks entry (this week's
// days at the theater it's scored at, and each other theater's own) or from
// the movie page (every published day, per theater).
function groupsFromEntry(entry) {
  const out = [{ theatre: entry.theatre || null, days: entry.showtimesByDay || [] }];
  for (const t of entry.theatres || []) if (t.showtimesByDay) out.push({ theatre: t, days: t.showtimesByDay });
  return out;
}
const groupsFromDetail = (d) => (d.showtimesByTheatre || []).map((g) => ({ theatre: g.theatre, days: g.showtimesByDay || [] }));
const upcoming = (groups) => groups
  .map((g) => ({ ...g, days: g.days.map((d) => ({ ...d, showtimes: (d.showtimes || []).filter((s) => !s.past && s.id) })).filter((d) => d.showtimes.length) }))
  .filter((g) => g.days.length);
const hasUpcoming = (groups) => upcoming(groups).length > 0;

// "When are you going?": every showing still to come, by theater and day, as
// buttons. The one planned is pressed; picking another moves the plan.
function openPlanPicker(film, groups, ctx) {
  const home = document.activeElement?.closest?.('[data-plan-film]');
  const list = upcoming(groups);
  const multi = list.length > 1;
  const current = planFor(film.tmdb_id);
  const body = h('div', { class: 'plan-picker' },
    h('p', { class: 'muted small pp-intro' }, 'Pick the showing you\'re going to. With notifications on, you get a reminder two hours before.'));
  let modal;
  for (const g of list) {
    const block = h('div', { class: 'pp-theatre' });
    if (multi && g.theatre) block.appendChild(h('h4', { class: 'pp-where' }, g.theatre.short || g.theatre.name));
    for (const d of g.days) {
      const when = `${dayLabel(d.date)} · ${new Date(`${d.date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
      block.appendChild(h('div', { class: 'pp-day' },
        h(multi ? 'h5' : 'h4', { class: 'pp-date' }, when),
        h('div', { class: 'pp-times' }, ...d.showtimes.map((st) => {
          const on = current?.showtime_id === st.id;
          const fmt = formatName(st);
          const where = g.theatre?.short ? ` at ${g.theatre.short}` : '';
          return h('button', {
            class: `pp-time${on ? ' on' : ''}`, type: 'button', 'aria-pressed': String(on),
            'aria-label': `${st.time}${fmt ? `, ${fmt}` : ''}, ${whenWord(st.date || d.date, st.start_local)}${where}${on ? ', your plan' : ''}`,
            onClick: async (e) => {
              if (on) { modal.close(); return; }
              e.currentTarget.disabled = true;
              const btn = e.currentTarget;
              if (await planShowing({ ...st, date: st.date || d.date }, film, ctx)) { modal.close(); refocus(home); } else btn.disabled = false;
            },
          }, h('span', { class: 'pp-clock' }, on ? icon('check', { size: 14 }) : null, st.time), formatBadge(st, { short: true }));
        })),
      ));
    }
    body.appendChild(block);
  }
  if (!list.length) body.appendChild(h('p', { class: 'muted' }, 'No showings left to pick.'));
  if (current) {
    body.appendChild(h('div', { class: 'pp-foot' },
      h('button', { class: 'btn danger', type: 'button', onClick: async () => { modal.close(); await cancel(film, ctx); refocus(home); } }, 'Cancel my plan')));
  }
  modal = openModal(body, { title: `When are you going to ${film.title}?` });
  (modal.card.querySelector('.pp-time.on') || modal.card.querySelector('.pp-time'))?.focus();
  return modal;
}

// The plan as a soft accent line with Cancel (and Change when there are
// other showings to pick from), or nothing.
function planPill(p, film, ctx, { groups = null, compact = false } = {}) {
  return h('div', { class: `plan-pill${compact ? ' compact' : ''}` },
    icon('check', { size: 16, cls: 'plan-icon' }),
    h('span', { class: 'plan-text' }, planText(p)),
    h('span', { class: 'plan-acts' },
      groups && hasUpcoming(groups) ? h('button', {
        class: 'link-btn plan-change', type: 'button', 'aria-haspopup': 'dialog', 'aria-label': `Change your plan for ${film.title}`,
        onClick: () => openPlanPicker(film, groups, ctx),
      }, 'Change') : null,
      h('button', {
        class: 'link-btn plan-cancel', type: 'button', 'aria-label': `Cancel your plan for ${film.title}`,
        onClick: async (e) => {
          const home = e.currentTarget.closest('[data-plan-film]');
          e.currentTarget.disabled = true;
          await cancel(film, ctx);
          refocus(home);
        },
      }, 'Cancel')));
}

// The hero's line under the seat line: the plan, or I'm going (for the
// showing Book points at) beside Send.
export function heroPlan(entry, st, ctx) {
  const film = { tmdb_id: entry.tmdb_id, title: entry.title };
  const groups = groupsFromEntry(entry);
  return liveEl(h('div', { class: 'hero-plan', dataset: { planFilm: String(film.tmdb_id) } }), function paint() {
    const p = planFor(film.tmdb_id);
    const canGo = !p && st && !st.past && st.id;
    // Planned: the plan with Cancel, and Change time beside Send.
    const canChange = p && hasUpcoming(groups);
    clear(this);
    if (p) this.appendChild(planPill(p, film, ctx));
    this.appendChild(h('div', { class: `hero-plan-btns${canGo || canChange ? '' : ' one'}` },
      canChange ? h('button', {
        class: 'btn soft change-btn', type: 'button', 'aria-haspopup': 'dialog', 'aria-label': `Change the showing for ${film.title}`,
        onClick: () => openPlanPicker(film, groups, ctx),
      }, icon('ticket', { size: 18 }), 'Change time') : null,
      canGo ? h('button', {
        class: 'btn soft go-btn', type: 'button', 'aria-label': `I'm going to ${film.title}, ${whenWord(st.date, st.start_local)} ${st.time}`,
        onClick: async (e) => {
          const btn = e.currentTarget;
          const home = btn.closest('[data-plan-film]');
          btn.disabled = true;
          if (await planShowing(st, film, ctx)) refocus(home); else btn.disabled = false;
        },
      }, icon('ticket', { size: 18 }), 'I\'m going') : null,
      sendButton(entry, ctx, { words: true })));
    goingLines(film.tmdb_id, this);
  });
}

// The movie page's line under Showtimes: the plan, or I'm going (opens the
// sheet), and who else is going.
export function detailPlan(d, ctx) {
  const film = { tmdb_id: d.movie.tmdb_id, title: d.movie.title };
  const groups = groupsFromDetail(d);
  return liveEl(h('div', { class: 'detail-plan', dataset: { planFilm: String(film.tmdb_id) } }), function paint() {
    const p = planFor(film.tmdb_id);
    clear(this);
    if (p) this.appendChild(planPill(p, film, ctx, { groups }));
    else if (hasUpcoming(groups)) {
      this.appendChild(h('button', {
        class: 'btn soft go-btn', type: 'button', 'aria-haspopup': 'dialog',
        onClick: () => openPlanPicker(film, groups, ctx),
      }, icon('ticket', { size: 18 }), 'I\'m going'));
    }
    goingLines(film.tmdb_id, this);
    this.hidden = !this.children.length;
  });
}

// Schedule's Leaving list: a film's showings that day, I'm going or the plan.
export function leavingPlan(entry, date, ctx) {
  const film = { tmdb_id: entry.tmdb_id, title: entry.title };
  const groups = [{ theatre: entry.theatre || null, days: (entry.showtimesByDay || []).filter((x) => x.date === date) }];
  return liveEl(h('div', { class: 'lv-plan', dataset: { planFilm: String(film.tmdb_id) } }), function paint() {
    const p = planFor(film.tmdb_id);
    clear(this);
    if (p) this.appendChild(planPill(p, film, ctx, { groups, compact: true }));
    else if (hasUpcoming(groups)) {
      this.appendChild(h('button', {
        class: 'btn soft small go-btn', type: 'button', 'aria-haspopup': 'dialog', 'aria-label': `I'm going to ${film.title}: pick a showing`,
        onClick: () => openPlanPicker(film, groups, ctx),
      }, icon('ticket', { size: 16 }), 'I\'m going'));
    }
    this.hidden = !this.children.length;
  });
}

// "Robin is going Sat 7:00 PM · Maple Grove": only ever the pairs the server
// allows (the owner and a friend with Together on).
function goingLines(id, into) {
  for (const g of goingFor(id)) into.appendChild(h('p', { class: 'going-line' }, icon('users', { size: 14 }), h('span', {}, goingText(g))));
}
export function goingLine(id) {
  return liveEl(h('div', { class: 'going-lines' }), function paint() {
    clear(this);
    goingLines(id, this);
    this.hidden = !this.children.length;
  });
}

// ---- the morning question -----------------------------------------------------

// After Yes: the star rating, once, in a sheet. "Add a note" sits after the
// stars (js/notes.js): a quick tap on the stars still closes the sheet, unless
// the note field is open or in use, when Done closes it instead.
function openRateSheet(film, ctx, onDone) {
  let modal;
  const note = noteSlot(film, { alwaysAdd: true });
  const later = h('button', { class: 'btn soft', type: 'button', onClick: () => modal.close() }, 'Not now');
  const rater = starRater(film, ctx, {
    value: 0, size: 36,
    onRated: (v) => {
      note.rated(v);
      if (!v) return;
      later.textContent = 'Done';
      setTimeout(() => { if (!note.busy()) modal.close(); }, 500);
    },
  });
  const body = h('div', { class: 'rate-sheet' },
    h('p', {}, 'Logged as seen. How was it?'),
    rater,
    note.el,
    later);
  modal = openModal(body, { title: `Rate ${film.title}`, onClose: () => { onDone?.(); keepFocus(document.querySelector('.inbox')); } });
  rater.querySelector('.stars')?.focus();
}

async function answer(p, seen, ctx, onChange) {
  try {
    const r = await api.answerPlan(p.tmdb_id, seen);
    setPlan(null, p.tmdb_id);
    ctx.refreshStatus?.();
    if (!seen) { toast(`Okay, plan for ${p.title} cleared.`); keepFocus(document.querySelector('.inbox')); onChange?.(); return; }
    const day = new Date(`${r.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long' });
    toast(`${p.title} logged as seen on ${day}.`, 'success');
    openRateSheet({ tmdb_id: p.tmdb_id, title: p.title, year: p.year, poster: p.poster }, ctx, onChange);
  } catch (e) { toast(e.message, 'error'); loadSocial(ctx); }
}

// ---- Send a pick ----------------------------------------------------------------

export function sendButton(film, ctx, { words = false } = {}) {
  return h('button', {
    class: `${words ? 'btn soft' : 'icon-btn soft'} send-btn`, type: 'button', 'aria-haspopup': 'dialog',
    'aria-label': `Send ${film.title} to someone`, title: 'Send it to someone',
    onClick: () => openSendSheet(film, ctx),
  }, icon('send', { size: words ? 18 : 20 }), words ? 'Send' : null);
}

let noteSeq = 0;
// Owner: any friend (by name). Friend: the owner, the only one they can send
// to. An optional plain-text note of up to 140 characters.
async function openSendSheet(film, ctx) {
  const s = state || await loadSocial(ctx);
  const recips = s?.send?.recipients || [];
  const max = s?.send?.noteMax || 140;
  const left = s?.send?.left ?? 0;
  const n = ++noteSeq;
  const err = h('p', { class: 'form-error', role: 'alert' });
  const body = h('div', { class: 'send-sheet' },
    h('div', { class: 'send-film' }, poster(film, { size: 'sm', link: false }), h('div', { class: 'send-film-title' }, film.title, film.year ? h('span', { class: 'muted' }, ` ${film.year}`) : null)));
  let modal;
  if (!recips.length) {
    body.appendChild(h('p', { class: 'muted' }, 'There\'s nobody to send to yet. Invite a friend under You, Settings, Friends.'));
    modal = openModal(body, { title: 'Send a pick' });
    return modal;
  }
  let to = recips.length === 1 ? recips[0] : null;
  const sendBtn = h('button', { class: 'btn send-go', type: 'submit' }, icon('send', { size: 18 }), 'Send');
  const paintBtn = () => { sendBtn.disabled = !to || left <= 0; };
  if (recips.length === 1 && !ctx.isOwner()) {
    body.appendChild(h('p', { class: 'send-to-one' }, 'To ', h('strong', {}, recips[0].name)));
  } else {
    body.appendChild(h('fieldset', { class: 'send-to' },
      h('legend', { class: 'field-label' }, 'Send to'),
      ...recips.map((r) => h('label', { class: 'radio-row' },
        h('input', { type: 'radio', name: `send-to-${n}`, value: String(r.id), checked: to?.id === r.id, onChange: () => { to = r; err.textContent = ''; paintBtn(); } }),
        h('span', {}, r.name)))));
  }
  const counter = h('span', { class: 'note-count', id: `note-count-${n}` }, `0 of ${max}`);
  const note = h('textarea', { class: 'input note-input', id: `note-${n}`, rows: '3', maxlength: String(max), 'aria-describedby': `note-count-${n}`, placeholder: 'Why they\'d like it' });
  note.addEventListener('input', () => { counter.textContent = `${note.value.length} of ${max}`; });
  // Demo mode sends the pick without a note.
  body.appendChild(DEMO
    ? h('div', { class: 'field' }, h('p', { class: 'field-label' }, 'Note (optional)'), offLine())
    : h('div', { class: 'field' },
      h('label', { class: 'field-label', for: `note-${n}` }, 'Note (optional)'), note, counter));
  body.appendChild(err);
  body.appendChild(h('div', { class: 'send-foot' },
    h('p', { class: 'muted small' }, left > 0 ? `You can send ${left} more today.` : 'You\'ve sent 10 today. You can send more tomorrow.'),
    sendBtn));
  const form = h('form', { class: 'send-form', novalidate: true }, body);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!to) { err.textContent = 'Choose who to send it to.'; return; }
    sendBtn.disabled = true;
    try {
      const r = await api.sendPick({ to: to.id, tmdb_id: film.tmdb_id, note: DEMO ? '' : note.value });
      if (state?.send) state.send.left = r.left;
      modal.close();
      toast(`Sent ${film.title} to ${r.to?.name || to.name}.`, 'success');
    } catch (ex) {
      err.textContent = ex.message;
      paintBtn();
    }
  });
  paintBtn();
  modal = openModal(form, { title: `Send ${film.title}` });
  (form.querySelector('input[type="radio"]') || (DEMO ? sendBtn : note)).focus();
  return modal;
}

// "Sent by Robin" and the note, on the movie page.
export function sentBy(id, ctx) {
  return liveEl(h('div', { class: 'sent-by-list' }), function paint() {
    clear(this);
    for (const s of sentFor(id)) {
      this.appendChild(h('div', { class: 'sent-by' },
        icon('send', { size: 16, cls: 'sent-icon' }),
        h('div', { class: 'sent-words' },
          h('p', { class: 'sent-from' }, `Sent by ${s.from}`),
          s.note ? h('p', { class: 'sent-note' }, `"${s.note}"`) : null),
        dismissButton(s, ctx)));
    }
    this.hidden = !this.children.length;
  });
}

function dismissButton(s, ctx, onDone) {
  return h('button', {
    class: 'icon-btn sent-dismiss', type: 'button', 'aria-label': `Dismiss ${s.title} from ${s.from}`, title: 'Dismiss',
    onClick: async (e) => {
      const scope = e.currentTarget.closest('.inbox, .sent-by-list');
      e.currentTarget.disabled = true;
      try {
        await api.dismissSend(s.id);
        if (state) state.sent = state.sent.filter((x) => x.id !== s.id);
        repaint();
        toast('Dismissed.');
        keepFocus(scope?.isConnected && scope.children.length ? scope : document.querySelector('.inbox'));
        onDone?.();
      } catch (ex) { toast(ex.message, 'error'); loadSocial(ctx); }
    },
  }, icon('x', { size: 18 }));
}

// ---- the top of Picks --------------------------------------------------------

// "Did you see <film>?" cards (a plan's morning question, for three days) and
// "Sent to you" rows, above the hero. `onChange` runs after an answer that
// logs a film seen, when the picks may have moved.
export function inbox(ctx, { onChange } = {}) {
  return liveEl(h('section', { class: 'inbox', 'aria-label': 'For you' }), function paint() {
    const asks = (state?.plans || []).filter((p) => p.ask);
    const sent = state?.sent || [];
    clear(this);
    for (const p of asks) {
      this.appendChild(h('article', { class: 'inbox-card ask-card', 'aria-label': `Did you see ${p.title}?` },
        h('a', { class: 'inbox-poster', href: `#/movie/${p.tmdb_id}`, tabindex: '-1', 'aria-hidden': 'true' }, poster(p, { size: 'sm', link: false })),
        h('div', { class: 'inbox-body' },
          h('p', { class: 'inbox-q' }, `Did you see ${p.title}?`),
          h('p', { class: 'inbox-sub' }, `You planned the ${p.time} showing ${whenSentence(p).replace(/ at .*$/, '')}${p.theatre ? ` at ${p.theatre}` : ''}.`),
          h('div', { class: 'inbox-acts' },
            h('button', { class: 'btn ask-yes', type: 'button', onClick: (e) => { e.currentTarget.disabled = true; answer(p, true, ctx, onChange); } }, 'Yes'),
            h('button', { class: 'btn soft ask-no', type: 'button', onClick: (e) => { e.currentTarget.disabled = true; answer(p, false, ctx, null); } }, 'No')))));
    }
    for (const s of sent) {
      const title = h('a', { class: 'inbox-title', href: `#/movie/${s.tmdb_id}` }, s.title);
      this.appendChild(h('article', { class: 'inbox-card sent-card', 'aria-label': `Sent to you by ${s.from}: ${s.title}` },
        h('a', { class: 'inbox-poster', href: `#/movie/${s.tmdb_id}`, tabindex: '-1', 'aria-hidden': 'true' }, poster(s, { size: 'sm', link: false })),
        h('div', { class: 'inbox-body' },
          h('p', { class: 'inbox-from' }, icon('send', { size: 14 }), h('span', {}, `Sent to you by ${s.from}`)),
          title,
          s.note ? h('p', { class: 'sent-note' }, `"${s.note}"`) : null),
        h('div', { class: 'inbox-side' },
          watchlistButton({ tmdb_id: s.tmdb_id, title: s.title }, ctx, { onToggle: (on) => { if (on) { state.sent = state.sent.filter((x) => x.tmdb_id !== s.tmdb_id); repaint(); keepFocus(this); } } }),
          dismissButton(s, ctx))));
    }
    this.hidden = !this.children.length;
  });
}
