// Settings: the Appearance card (the Theme switch).
import { h, icon } from '../../ui.js';
import { card } from './parts.js';

// ---- Appearance -------------------------------------------------------------
// The Theme switch: Match system, Light or Dark, as one segmented control that
// works like a radio group. Saved on this device only and applied at once by
// the script at the top of index.html (window.rpTheme), which also applies it
// before the first paint on every open. The Save bar doesn't cover it.
const THEMES = [
  { key: 'system', icon: 'monitor', name: 'Match system' },
  { key: 'light', icon: 'sun', name: 'Light' },
  { key: 'dark', icon: 'moon', name: 'Dark' },
];

export function appearanceCard() {
  const current = window.rpTheme?.get() || 'system';
  const group = h('div', { class: 'theme-switch', role: 'radiogroup', 'aria-labelledby': 'theme-label' });
  const parts = THEMES.map((t) => h('button', {
    class: 'theme-part', type: 'button', role: 'radio', 'data-theme-choice': t.key, 'aria-label': t.name, title: t.name,
  }, icon(t.icon, { size: 20 })));
  const paint = (key) => {
    for (const b of parts) {
      const on = b.dataset.themeChoice === key;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  };
  const choose = (b) => { window.rpTheme?.set(b.dataset.themeChoice); paint(b.dataset.themeChoice); };
  for (const b of parts) b.addEventListener('click', () => choose(b));
  // Arrow keys (and Home, End) move between the three and choose, as in any radio group.
  group.addEventListener('keydown', (e) => {
    const i = parts.indexOf(document.activeElement);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (i < 0 || (!step && e.key !== 'Home' && e.key !== 'End')) return;
    e.preventDefault();
    const next = e.key === 'Home' ? parts[0] : e.key === 'End' ? parts[parts.length - 1] : parts[(i + step + parts.length) % parts.length];
    next.focus();
    choose(next);
  });
  group.append(...parts);
  paint(current);
  return card('Appearance',
    h('div', { class: 'row-line theme-row' }, h('span', { class: 'theme-label', id: 'theme-label' }, 'Theme'), group),
    h('p', { class: 'muted small' }, 'Just for this device.'));
}
