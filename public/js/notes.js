// Notes on ratings (server/lib/notes.js): one line of plain text a person
// keeps with a film they rated, up to NOTE_MAX characters. Private to them.
//
// Never in the way of a quick star tap: after the stars there is only a small
// "Add a note" button, and tapping it opens a one-line field right there (no
// popup), with Save and Cancel. Enter saves, Escape cancels.
//
// noteSlot(entry, opts) is that place, in one of two modes:
//   full   the movie page: the note under the stars with Edit and Delete (a
//          Letterboxd review cut short can be opened in full), or "Add a
//          note" when the film is rated and has none.
//   after  a list or sheet: nothing until the film is rated here, then "Add a
//          note" (with `alwaysAdd`, from the start). Once saved, the note shows
//          on its own line with Edit.
// Tell it about each rating with slot.rated(value).
import { api } from './api.js';
import { h, clear, toast } from './ui.js';

export const NOTE_MAX = 280;
const LOOKS_LIKE_HTML = /<\s*(?:\/?\s*[a-z]|!)/i;
const chars = (s) => [...s].length;
let seq = 0;

// What the server would say about a note, said before sending it.
export function noteProblem(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return 'Write something first, or press Cancel.';
  if (LOOKS_LIKE_HTML.test(s)) return 'Notes are plain text. Take out the HTML tags.';
  if (chars(s) > NOTE_MAX) return `Keep the note to ${NOTE_MAX} characters.`;
  return null;
}

// A note as a short second line on a list row (Stats, a person page, Rate):
// the first SHORT characters, cut at a word; a screen reader hears it whole,
// and the film's page shows all of it.
const SHORT = 90;
export function shortLine(text) {
  const cp = [...String(text)];
  if (cp.length <= SHORT) return String(text);
  let cut = cp.slice(0, SHORT).join('');
  const space = cut.lastIndexOf(' ');
  if (space > SHORT * 0.6) cut = cut.slice(0, space);
  return `${cut.replace(/[\s.,;:!?-]+$/, '')}…`;
}
export function noteLine(text, cls = 'note-line') {
  if (!text) return null;
  const short = shortLine(text);
  return h('span', { class: cls },
    h('span', { class: 'sr-only' }, `Your note: ${short === text ? '' : text}`),
    h('span', short === text ? {} : { 'aria-hidden': 'true' }, short));
}

export function noteSlot(entry, { note = null, full = null, source = null, rated = false, mode = 'after', alwaysAdd = false } = {}) {
  const id = ++seq;
  const title = entry.title || 'this film';
  const el = h('div', { class: `note-slot note-${mode}`, 'data-note-for': String(entry.tmdb_id) });
  let cur = note ? { note, full, source } : null;
  let isRated = Boolean(rated);
  let justRated = false; // rated in this control, so "after" shows Add a note
  let editing = false;

  const addBtn = () => h('button', {
    class: 'link-btn note-add', type: 'button', 'aria-label': `Add a note on ${title}`,
    onClick: () => open(''),
  }, 'Add a note');

  function paint({ focus = null } = {}) {
    clear(el);
    editing = false;
    if (cur) {
      const text = h('p', { class: 'note-text', id: `note-text-${id}` }, cur.note);
      const block = h('div', { class: 'note-block' },
        mode === 'full' ? h('p', { class: 'note-label' }, 'Your note', cur.source === 'letterboxd' ? h('span', { class: 'note-from' }, ' · from Letterboxd') : null) : h('span', { class: 'sr-only' }, 'Your note: '),
        text);
      if (cur.full) {
        // A Letterboxd review cut at NOTE_MAX: the whole of it, on request.
        const more = h('button', { class: 'link-btn note-more', type: 'button', 'aria-expanded': 'false', 'aria-controls': `note-text-${id}` }, 'Show the whole review');
        more.addEventListener('click', () => {
          const openNow = more.getAttribute('aria-expanded') !== 'true';
          text.textContent = openNow ? cur.full : cur.note;
          text.classList.toggle('whole', openNow);
          more.setAttribute('aria-expanded', String(openNow));
          more.textContent = openNow ? 'Show less' : 'Show the whole review';
        });
        block.append(more);
      }
      const edit = h('button', { class: 'link-btn note-edit', type: 'button', 'aria-label': `Edit your note on ${title}` }, 'Edit');
      edit.addEventListener('click', () => open(cur.note.replace(/…$/, '')));
      const acts = h('div', { class: 'note-acts' }, edit);
      if (mode === 'full') {
        const del = h('button', { class: 'link-btn note-delete', type: 'button', 'aria-label': `Delete your note on ${title}` }, 'Delete');
        del.addEventListener('click', () => remove(del));
        acts.append(del);
      }
      block.append(acts);
      el.append(block);
      if (focus === 'edit') edit.focus();
    } else if ((isRated && (mode === 'full' || justRated)) || alwaysAdd) {
      const add = addBtn();
      el.append(add);
      if (focus === 'add') add.focus();
    }
    el.hidden = !el.childElementCount;
  }

  function open(initial) {
    clear(el);
    el.hidden = false;
    editing = true;
    const inputId = `note-input-${id}`;
    const help = h('span', { class: 'note-count', id: `note-count-${id}` });
    const error = h('p', { class: 'note-error', role: 'alert', hidden: true });
    const input = h('input', {
      class: 'input note-input', id: inputId, type: 'text', maxlength: String(NOTE_MAX), value: initial,
      placeholder: 'A line to remember it by', autocomplete: 'off', enterkeyhint: 'done',
      'aria-label': `Note on ${title}`, 'aria-describedby': `note-count-${id}`,
    });
    const count = () => {
      const n = chars(input.value);
      help.textContent = `${n}/${NOTE_MAX}`;
      help.setAttribute('aria-label', `${n} of ${NOTE_MAX} characters, plain text`);
    };
    const save = h('button', { class: 'btn small note-save', type: 'submit' }, 'Save');
    const cancel = h('button', { class: 'link-btn note-cancel', type: 'button' }, 'Cancel');
    const form = h('form', { class: 'note-form', novalidate: true },
      input,
      h('div', { class: 'note-form-foot' }, help, h('span', { class: 'note-buttons' }, cancel, save)),
      error);
    const close = () => paint({ focus: cur ? 'edit' : 'add' });
    cancel.addEventListener('click', close);
    input.addEventListener('input', () => { count(); error.hidden = true; input.removeAttribute('aria-invalid'); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const bad = noteProblem(input.value);
      const fail = (msg) => { error.textContent = msg; error.hidden = false; input.setAttribute('aria-invalid', 'true'); input.focus(); };
      if (bad) { fail(bad); return; }
      save.disabled = true;
      try {
        const r = await api.saveNote(entry.tmdb_id, input.value);
        cur = r.note;
        toast('Note saved', 'success');
        paint({ focus: 'edit' });
        el.dispatchEvent(new CustomEvent('note-change', { bubbles: true, detail: cur }));
      } catch (err) {
        save.disabled = false;
        fail(err.message);
      }
    });
    el.append(form);
    count();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  async function remove(btn) {
    const was = cur;
    btn.disabled = true;
    try {
      await api.deleteNote(entry.tmdb_id);
    } catch (err) { btn.disabled = false; toast(err.message, 'error'); return; }
    cur = null;
    paint({ focus: 'add' });
    el.dispatchEvent(new CustomEvent('note-change', { bubbles: true, detail: null }));
    toast('Note deleted', '', {
      action: {
        label: 'Undo',
        onClick: async () => {
          try {
            const r = await api.saveNote(entry.tmdb_id, was.note.replace(/…$/, ''));
            cur = r.note;
            paint();
            el.dispatchEvent(new CustomEvent('note-change', { bubbles: true, detail: cur }));
          } catch (err) { toast(err.message, 'error'); }
        },
      },
    });
  }

  paint();
  return {
    el,
    // A rating given or cleared (0). Clearing a rating takes its note away.
    rated(v) {
      isRated = Boolean(v);
      if (!v) cur = null;
      else justRated = true;
      if (!editing) paint();
    },
    // Busy with a note: the field is open or has the focus.
    busy: () => editing || el.contains(document.activeElement),
    get note() { return cur; },
  };
}
