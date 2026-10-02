// Pull to refresh, on Picks. Pulling down from the very top of the page shows
// a small arrow under the header that turns as you pull; letting go past the
// line runs `onRefresh` (the owner's real refresh, or a plain re-fetch for
// friends and the guest, js/views/home.js) with a spinner until it's done.
// Touch only; everyone can also just reopen the page. Reduced motion: the
// arrow fades in without turning or moving.
import { h, icon, reduced } from './ui.js';

const LINE = 72; // px of pull that means "refresh"

let detachCurrent = null;

export function pullToRefresh({ onRefresh }) {
  detachCurrent?.();
  const mark = h('div', { class: 'pull', 'aria-hidden': 'true' }, icon('refresh', { size: 20 }));
  document.querySelector('.shell')?.appendChild(mark);
  let startY = null;
  let pull = 0;
  let busy = false;

  const paint = () => {
    const p = Math.min(1, pull / LINE);
    mark.classList.toggle('show', pull > 8 || busy);
    mark.classList.toggle('ready', pull >= LINE);
    mark.classList.toggle('busy', busy);
    if (!busy) {
      mark.style.opacity = String(reduced() ? (pull >= LINE ? 1 : 0) : p);
      mark.style.setProperty('--pull', reduced() ? '0px' : `${Math.round(Math.min(pull, LINE * 1.4) * 0.5)}px`);
      mark.style.setProperty('--turn', reduced() ? '0deg' : `${Math.round(p * 270)}deg`);
    } else mark.style.opacity = '1';
  };
  const atTop = () => (document.scrollingElement?.scrollTop || 0) <= 0;
  const blocked = () => Boolean(document.querySelector('.modal-overlay, .tour-layer'));

  const onStart = (e) => {
    if (busy || e.touches.length !== 1 || !atTop() || blocked()) { startY = null; return; }
    startY = e.touches[0].clientY;
    pull = 0;
  };
  const onMove = (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || !atTop()) { if (pull) { pull = 0; paint(); } return; }
    pull = dy;
    paint();
  };
  const onEnd = async () => {
    if (startY == null) return;
    startY = null;
    const go = pull >= LINE;
    pull = 0;
    if (!go) { paint(); return; }
    busy = true;
    paint();
    try { await onRefresh(); } finally { busy = false; paint(); }
  };
  window.addEventListener('touchstart', onStart, { passive: true });
  window.addEventListener('touchmove', onMove, { passive: true });
  window.addEventListener('touchend', onEnd);
  window.addEventListener('touchcancel', onEnd);
  const detach = () => {
    window.removeEventListener('touchstart', onStart);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('touchend', onEnd);
    window.removeEventListener('touchcancel', onEnd);
    window.removeEventListener('hashchange', onLeave);
    mark.remove();
    if (detachCurrent === detach) detachCurrent = null;
  };
  // Leaving Picks takes it away.
  const onLeave = () => { if (!location.hash.startsWith('#/home')) detach(); };
  window.addEventListener('hashchange', onLeave);
  detachCurrent = detach;
  return detach;
}
