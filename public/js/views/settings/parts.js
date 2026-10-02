// Settings: the pieces every card is built from.
import { h } from '../../ui.js';

// On phones, a field that takes a whole row of its grid (see .span-all).
export const spanAll = (field) => { field.classList.add('span-all'); return field; };

// One grouped list (styles.css): its heading, then its rows. Help text in it
// reads as the note under the row before it.
export function card(title, ...children) {
  return h('section', { class: 'group settings-group' },
    h('h2', { class: 'group-title' }, title),
    h('div', { class: 'group-body' }, ...children));
}
