// You: Stats, Together, Settings and Help under one tab, as four segments
// (the Schedule tab works the same way). Each segment keeps its own address,
// so #/stats, #/together, #/settings and #/help open here; #/you on its own
// opens the segment last used on this device. The guest link has no You.
import { h, clear } from '../ui.js';
import { stateWith } from '../place.js';
import * as stats from './stats.js';
import * as together from './together.js';
import * as settings from './settings.js';
import * as help from './help.js';
import { yearEntry } from '../year.js';

export const SEGMENTS = [
  { key: 'stats', label: 'Stats', render: stats.render },
  { key: 'together', label: 'Together', render: together.render },
  { key: 'settings', label: 'Settings', render: settings.render },
  { key: 'help', label: 'Help', render: help.render },
];
const KEY = 'rp.youSegment';

function lastSegment() {
  try { const k = localStorage.getItem(KEY); return SEGMENTS.some((s) => s.key === k) ? k : 'stats'; } catch { return 'stats'; }
}

export async function render(root, params, ctx) {
  const seg = SEGMENTS.find((s) => s.key === params[0]) || SEGMENTS.find((s) => s.key === lastSegment());
  if (!params[0]) history.replaceState(stateWith(), '', `#/${seg.key}`);
  try { localStorage.setItem(KEY, seg.key); } catch { /* private mode: just not remembered */ }
  const status = ctx.getStatus();
  const name = status?.user?.name || (status?.user?.isOwner !== false ? status?.ownerName : '') || '';
  clear(root);
  const panel = h('div', { class: 'you-panel' });
  root.append(
    h('div', { class: 'section-title page-head' },
      h('h1', {}, 'You'),
      name ? h('span', { class: 'section-sub' }, `Signed in as ${name}`) : null),
    // Your year in movies, Dec 1 to Jan 15 (js/year.js), above every segment.
    yearEntry(ctx, 'you'),
    h('nav', { class: 'segmented you-seg', 'aria-label': 'You' },
      ...SEGMENTS.map((s) => h('a', {
        class: `segment${s === seg ? ' active' : ''}`, href: `#/${s.key}`, 'data-seg': s.key,
        ...(s === seg ? { 'aria-current': 'page' } : {}),
      }, s.label))),
    panel,
  );
  await seg.render(panel, params.slice(1), { ...ctx, inYou: true });
}
