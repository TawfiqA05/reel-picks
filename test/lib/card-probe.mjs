// Card insets, for test/ui/spacing.mjs: every card surface on the page (the
// Settings groups, the Stats and Help cards) with where its first row starts
// (row: down through plain wrappers to the first box with padding, a fill or
// text), how close any content comes to the top edge (top: text by its
// rendered line, controls and filled boxes by their box), how far content
// sits from the left edge (side) and, for a card that opens with a note, the
// gap from the note to the divider under it (note), and where the last row
// ends above the bottom edge (bottom).
//
// Content is text (measured from the top of the block it sits in, so a line's
// own leading doesn't count) and controls, images and icons (their box). Run
// in the page: page.evaluate(cardProbe).
export function cardProbe() {
  const raised = getComputedStyle(document.documentElement).getPropertyValue('--raised').trim();
  const probeEl = document.createElement('div');
  probeEl.style.background = raised;
  document.body.appendChild(probeEl);
  const raisedRgb = getComputedStyle(probeEl).backgroundColor;
  probeEl.remove();
  const visible = (el) => {
    if (!el || el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let a = el; a; a = a.parentElement) { const s = getComputedStyle(a); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false; }
    return true;
  };
  const main = document.querySelector('#main');
  const CONTROL = 'input, select, textarea, button, img, svg, canvas, video, [role="radio"], [role="switch"], .chip, .btn, .status-dot, .poster';
  const cards = [...main.querySelectorAll('*')].filter((el) => {
    if (!visible(el) || el.closest('button, a, .chip, .btn, input, select, textarea, .segmented, [role="dialog"]')) return false;
    const s = getComputedStyle(el);
    return s.backgroundColor === raisedRgb && parseFloat(s.borderTopLeftRadius) >= 8 && el.getBoundingClientRect().width >= 200;
  });
  const blockOf = (n) => { let e = n.parentElement; while (e && getComputedStyle(e).display.startsWith('inline')) e = e.parentElement; return e; };
  const contentTop = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return { top: r.top + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop), left: r.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft), bottom: r.bottom - parseFloat(s.borderBottomWidth) - parseFloat(s.paddingBottom) }; };
  const nameOf = (card) => {
    const g = card.closest('.group');
    const t = g?.querySelector('.group-title')?.textContent || card.querySelector('h2, h3, .card-title, strong, b')?.textContent || card.className;
    return String(t).trim().slice(0, 40);
  };
  const out = [];
  const bgOf = (e) => getComputedStyle(e).backgroundColor;
  // A box of its own: a control, or a fill that differs from the card's (a
  // divider line on one or two sides doesn't make one).
  const isBox = (e, card) => e !== card && (e.matches(CONTROL) || (bgOf(e) !== 'rgba(0, 0, 0, 0)' && bgOf(e) !== bgOf(card)));
  const kidsOf = (e) => [...e.children].filter(visible);
  const hasText = (e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  for (const card of cards) {
    const cr = card.getBoundingClientRect();
    const cs = getComputedStyle(card);
    const top0 = cr.top + parseFloat(cs.borderTopWidth);
    const left0 = cr.left + parseFloat(cs.borderLeftWidth);
    // The first row: down through wrappers with no padding, border or fill
    // of their own, to the first box that has them (or holds text).
    let e = card;
    for (;;) {
      const s2 = getComputedStyle(e);
      if (e !== card && (isBox(e, card) || parseFloat(s2.paddingTop) > 0 || hasText(e))) break;
      if (e === card && parseFloat(s2.paddingTop) > 0) break;
      const k = kidsOf(e)[0];
      if (!k) break;
      e = k;
    }
    // A whole row that is a button or link (a Stats list) counts from its
    // content, since its tap area runs to the card's edge.
    const tapRow = e.matches('button, a') && e.getBoundingClientRect().width >= cr.width * 0.6;
    const rowTop = (isBox(e, card) && !tapRow ? e.getBoundingClientRect().top : contentTop(e).top) - top0;
    // The last row, the same way up from the bottom edge.
    let z = card;
    for (;;) {
      const s2 = getComputedStyle(z);
      if (z !== card && (isBox(z, card) || parseFloat(s2.paddingBottom) > 0 || hasText(z))) break;
      if (z === card && parseFloat(s2.paddingBottom) > 0) break;
      const k = kidsOf(z).at(-1);
      if (!k) break;
      z = k;
    }
    const zTap = z.matches('button, a') && z.getBoundingClientRect().width >= cr.width * 0.6;
    const bottom0 = cr.bottom - parseFloat(cs.borderBottomWidth);
    const rowBottom = bottom0 - (isBox(z, card) && !zTap ? z.getBoundingClientRect().bottom : contentTop(z).bottom);
    // The closest any content comes to the top, and the left edge of it all.
    let top = Infinity; let left = Infinity;
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const inner = cards.some((c) => c !== card && card.contains(c) && c.contains(n));
      if (inner) continue;
      if (n.nodeType === 1) {
        if (!(n.matches(CONTROL) || isBox(n, card)) || !visible(n) || n.parentElement.closest(CONTROL)) continue;
        const r = n.getBoundingClientRect();
        // A whole row that is a button or link (a Stats list) is not a
        // control box here; what is inside it is.
        if (r.width >= cr.width * 0.6 && n.matches('button, a')) continue;
        top = Math.min(top, r.top); left = Math.min(left, r.left);
      } else if (n.textContent.trim()) {
        const be = blockOf(n);
        const ctl = n.parentElement.closest(CONTROL);
        if (!be || !visible(n.parentElement) || (ctl && !(ctl.getBoundingClientRect().width >= cr.width * 0.6 && ctl.matches('button, a')))) continue;
        const range = document.createRange(); range.selectNodeContents(n);
        const rr = range.getClientRects()[0];
        if (rr) { top = Math.min(top, rr.top); left = Math.min(left, rr.left); }
      }
    }
    if (!Number.isFinite(left)) continue;
    const r1 = (v) => Math.round(v * 10) / 10;
    left = Math.min(left, contentTop(e).left);
    const entry = { name: nameOf(card), row: r1(rowTop), bottom: r1(rowBottom), tapRow, top: r1(top - top0), side: r1(left - left0) };
    // An opening note: the card's first visible child is a muted note and a
    // divider (the next child's top border) comes under it.
    const kids = kidsOf(card);
    const first = kids[0];
    if (first && first.matches('p.muted.small, .muted.small:not([role="status"])') && kids[1]) {
      const bt = parseFloat(getComputedStyle(kids[1]).borderTopWidth);
      if (bt > 0) entry.note = r1(kids[1].getBoundingClientRect().top - contentTop(first).bottom);
    }
    out.push(entry);
  }
  return out;
}
