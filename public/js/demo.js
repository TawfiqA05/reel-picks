// Demo mode (server/demo/): the server marks the page with data-demo. A slim
// banner says the data is made up, booking links stay on the page, and every
// place that takes typed text (notes, a note with a sent pick, invites, a
// Letterboxd name, home base, theater search) says it's off instead.
import { h, toast } from './ui.js';

export const DEMO = document.documentElement.hasAttribute('data-demo');
export const DEMO_REPO = 'https://github.com/TawfiqA05/reel-picks';
export const OFF_TEXT = 'Off in the demo.';

export const offLine = (cls = '') => h('p', { class: `muted small demo-off${cls ? ` ${cls}` : ''}` }, OFF_TEXT);

export function demoBanner() {
  return h('div', { class: 'demo-banner', role: 'note' },
    h('span', {}, 'Demo with made-up data.'), ' ',
    h('a', { href: DEMO_REPO, target: '_blank', rel: 'noopener' }, 'See the code on GitHub'));
}

// AMC's booking pages don't know the demo's made-up theaters.
export function keepBookingLinks() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href*="amctheatres.com"]');
    if (!a) return;
    e.preventDefault();
    toast('Booking is off in the demo. The theaters are made up.');
  });
}
