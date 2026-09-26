// Schedule: what's leaving and what's coming, under one tab as two segments.
// Each segment is the Leaving or Coming soon page, drawn unchanged into the
// panel under the switch. The segment last used is remembered on this device,
// and #/coming and #/leaving (old links) open the matching one (js/app.js).
import { h, clear } from '../ui.js';
import * as leaving from './leaving.js';
import * as coming from './coming.js';

export const SEGMENTS = [
  { key: 'leaving', label: 'Leaving soon', render: leaving.render },
  { key: 'coming', label: 'Coming soon', render: coming.render },
];
const KEY = 'rp.scheduleSegment';

export function lastSegment() {
  try { return SEGMENTS.some((s) => s.key === localStorage.getItem(KEY)) ? localStorage.getItem(KEY) : SEGMENTS[0].key; } catch { return SEGMENTS[0].key; }
}

export async function render(root, params, ctx) {
  const seg = SEGMENTS.find((s) => s.key === params[0]) || SEGMENTS.find((s) => s.key === lastSegment());
  // #/schedule on its own shows the remembered segment under its own address.
  if (params[0] !== seg.key) history.replaceState(null, '', `#/schedule/${seg.key}`);
  try { localStorage.setItem(KEY, seg.key); } catch { /* private mode: just not remembered */ }
  clear(root);
  const panel = h('div', { class: 'sched-panel' });
  root.append(
    h('nav', { class: 'sched-seg', 'aria-label': 'Schedule' },
      ...SEGMENTS.map((s) => h('a', {
        class: `sched-item${s === seg ? ' active' : ''}`, href: `#/schedule/${s.key}`, 'data-seg': s.key,
        ...(s === seg ? { 'aria-current': 'page' } : {}),
      }, s.label))),
    panel,
  );
  await seg.render(panel, [], ctx);
}
