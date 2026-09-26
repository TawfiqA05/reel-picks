// An instant filter box for a list already on the page: no network, the same
// forgiving matching as the header search (fuzzy.js), a clear button, and a
// "No matches" line. Rows are shown and hidden in place, so a list keeps its
// order, numbering and state.
import { h, icon } from './ui.js';
import { prepare, query, score } from './fuzzy.js';

let seq = 0;

// set([{ el, fields }]) hands it the rows (fields[0] the title, then any
// names to match too). onChange({ query, shown, total }) runs after each pass.
export function filterBox({ label, placeholder = 'Filter', onChange = null } = {}) {
  let items = [];
  const id = `filter-${++seq}`;
  const input = h('input', {
    class: 'input filter-input', type: 'search', id, placeholder, 'aria-label': label || placeholder,
    autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'done',
  });
  const clearBtn = h('button', { class: 'filter-clear', type: 'button', 'aria-label': 'Clear filter', hidden: true }, icon('x', { size: 16 }));
  const none = h('p', { class: 'filter-none', role: 'status', hidden: true });
  const el = h('div', { class: 'filter' },
    h('div', { class: 'filter-field' }, icon('search', { size: 16, cls: 'filter-icon' }), input, clearBtn),
    none);

  const apply = () => {
    const raw = input.value;
    const q = query(raw);
    clearBtn.hidden = !raw;
    let shown = 0;
    for (const it of items) {
      const ok = !q.n || score(q, it.p) > 0;
      if (it.el.hidden === ok) it.el.hidden = !ok;
      if (ok) shown++;
    }
    none.hidden = !q.n || shown > 0;
    if (!none.hidden) none.textContent = `No matches for "${raw.trim()}"`;
    onChange?.({ query: q.n, shown, total: items.length });
  };

  input.addEventListener('input', apply);
  // Escape empties the box first; a second Escape reaches the sheet behind it.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; apply(); }
  });
  clearBtn.addEventListener('click', () => { input.value = ''; apply(); input.focus(); });

  return {
    el,
    input,
    set(list) { items = list.map(({ el: row, fields }) => ({ el: row, p: prepare(fields) })); apply(); },
    reset() { if (input.value) { input.value = ''; apply(); } },
    get active() { return Boolean(query(input.value).n); },
  };
}
