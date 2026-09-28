// In-page measurements shared by the browser suites (layout, design, picks,
// shell), carried over from the earlier polish and real-app sweeps. `measure`,
// `contrastProbe`, `extras` and `heroTextBoxes` run inside the page
// (page.evaluate) and return findings { kind, sel, detail }; everything is
// measured from layout, never guessed from class names, except the short
// allowlists written next to each rule with its reason.
export function measure(opts) {
  const { phone, atBottom } = opts;
  const out = [];
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const desc = (el) => {
    if (!el || !el.tagName) return '';
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
    const txt = (el.getAttribute?.('aria-label') || el.textContent || el.value || el.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''}${txt ? ` "${txt}"` : ''}`;
  };
  const add = (kind, el, detail) => out.push({ kind, sel: desc(el), detail });
  const S = (el, p) => getComputedStyle(el, p);
  const rect = (el) => el.getBoundingClientRect();
  // Screen-reader-only boxes and the insides of closed <details> aren't on screen.
  const srOnly = [...document.querySelectorAll('*')].filter((e) => getComputedStyle(e).clipPath === 'inset(50%)');
  const visible = (el) => {
    if (!el.isConnected || el.closest('[hidden]')) return false;
    const d = el.closest('details:not([open])');
    if (d && d !== el && !el.closest('summary')) return false;
    if (srOnly.some((s) => s.contains(el))) return false;
    const r = rect(el);
    if (r.width < 1 || r.height < 1) return false;
    const s = S(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
    // Visually hidden (screen-reader only) text.
    if (s.clipPath === 'inset(50%)' || (r.width <= 1 && r.height <= 1)) return false;
    return true;
  };
  const scopes = [document.querySelector('.shell') || document.body, ...document.querySelectorAll('.modal-overlay'), document.querySelector('.toast-host')].filter(Boolean);
  const overlayOpen = Boolean(document.querySelector('.modal-overlay'));
  // With a dialog open, only the dialog is measured (the page behind is inert).
  const roots = overlayOpen ? [...document.querySelectorAll('.modal-overlay')] : scopes;
  // Scrolled out of its own scroller (a dialog body, a sideways table): not on screen now.
  const inView = (el) => {
    const r = rect(el);
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const s = S(a);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const ar = rect(a);
      if (r.bottom <= ar.top + 1 || r.top >= ar.bottom - 1 || r.right <= ar.left + 1 || r.left >= ar.right - 1) return false;
    }
    return true;
  };
  // Client rects cut down to what its clipping ancestors actually show.
  const clipRects = (el) => {
    let rs = [...el.getClientRects()].map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const s = S(a);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const c = rect(a);
      rs = rs.map((r) => ({ left: Math.max(r.left, c.left), top: Math.max(r.top, c.top), right: Math.min(r.right, c.right), bottom: Math.min(r.bottom, c.bottom) })).filter((r) => r.right > r.left && r.bottom > r.top);
    }
    return rs;
  };
  const all = roots.flatMap((r) => [r, ...r.querySelectorAll('*')]).filter((e) => !(e instanceof SVGElement && e.tagName !== 'svg')).filter(visible);
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const texty = all.filter(ownText);
  const textyIn = texty.filter(inView);

  // ---------- 1. sideways scroll
  const sw = document.documentElement.scrollWidth;
  if (sw > vw) add('sideways', document.documentElement, `page scrollWidth ${sw} > ${vw}`);
  const clipAnc = (el) => { for (let a = el.parentElement; a; a = a.parentElement) { const s = S(a); if (s.overflowX !== 'visible' || s.overflowY !== 'visible') return a; } return null; };
  for (const el of all) {
    const r = rect(el);
    if (r.right > vw + 1 || r.left < -1) {
      const a = clipAnc(el);
      if (!a || a === document.documentElement || a === document.body) add('sideways', el, `spans ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
    }
  }

  // ---------- 2. clipped text
  const hasFull = (el) => {
    const t = el.textContent.replace(/\s+/g, ' ').trim();
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const lab = `${a.getAttribute('title') || ''} ${a.getAttribute('aria-label') || ''}`;
      if (t && lab.includes(t)) return true;
    }
    return false;
  };
  for (const el of texty) {
    if (el.closest('.stars')) continue; // a partial star fill is cut on purpose
    const s = S(el);
    const r = rect(el);
    const hid = s.overflowX !== 'visible' || s.textOverflow === 'ellipsis';
    // A positioned ::before/::after (a tap area) widens scrollWidth without
    // any text spilling: measure the words themselves then.
    const tapPseudo = ['::before', '::after'].some((p) => { const ps = S(el, p); return ps.content !== 'none' && ps.position === 'absolute'; });
    let textW = el.scrollWidth;
    if (tapPseudo) { const rg = document.createRange(); rg.selectNodeContents(el); textW = Math.ceil(rg.getBoundingClientRect().width + parseFloat(s.paddingLeft) + parseFloat(s.paddingRight)); }
    if (textW > el.clientWidth + 1 && el.clientWidth > 0) {
      if (hid) { if (!hasFull(el)) add('clipped', el, `text cut: ${el.scrollWidth}px in ${el.clientWidth}px`); }
      else if (s.display !== 'inline' && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) add('spill', el, `text spills: ${el.scrollWidth}px in ${el.clientWidth}px`);
    }
    if (s.overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0 && !/^(auto|scroll)$/.test(s.overflowY)) add('clipped', el, `text cut vertically: ${el.scrollHeight}px in ${el.clientHeight}px`);
    // Cut off by a clipping ancestor (a card with overflow hidden, a poster).
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const as = S(a);
      if (as.overflowX === 'visible' && as.overflowY === 'visible') continue;
      if (/^(auto|scroll)$/.test(as.overflowX) || /^(auto|scroll)$/.test(as.overflowY)) break; // scrollable: reachable
      const ar = rect(a);
      if (r.right > ar.right + 1 || r.bottom > ar.bottom + 1 || r.left < ar.left - 1 || r.top < ar.top - 1) {
        if (!hasFull(el)) add('clipped', el, `cut by ${desc(a)}`);
      }
      break;
    }
  }

  // ---------- 3. controls in a row line up
  const controls = all.filter((e) => e.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]):not([type=file]), select, textarea, .btn, .icon-btn'));
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i]; const b = controls[j];
      if (a.contains(b) || b.contains(a)) continue;
      // The header, tab bar and Save bar float over the page: a control in
      // them never shares a row with one scrolled underneath.
      const layer = (e) => e.closest('.app-header, .bottom-nav, .save-bar, .modal-overlay');
      if (layer(a) !== layer(b)) continue;
      const ra = rect(a); const rb = rect(b);
      const overlapY = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      const gapX = Math.max(rb.left - ra.right, ra.left - rb.right);
      if (overlapY < Math.min(ra.height, rb.height) * 0.5 || gapX < 0 || gapX > 24) continue;
      if (Math.abs(ra.top - rb.top) > 1 || Math.abs(ra.bottom - rb.bottom) > 1) add('misaligned', a, `vs ${desc(b)}: top ${Math.round(ra.top)}/${Math.round(rb.top)}, bottom ${Math.round(ra.bottom)}/${Math.round(rb.bottom)}`);
    }
  }
  // Fields sharing a grid row: their inputs start on the same line.
  for (const g of all.filter((e) => S(e).display === 'grid' && e.querySelector(':scope > .field'))) {
    const fields = [...g.children].filter(visible);
    for (let i = 0; i < fields.length; i++) {
      for (let j = i + 1; j < fields.length; j++) {
        const fa = rect(fields[i]); const fb = rect(fields[j]);
        if (Math.min(fa.bottom, fb.bottom) - Math.max(fa.top, fb.top) < 10) continue;
        const ia = fields[i].querySelector('input, select'); const ib = fields[j].querySelector('input, select');
        if (ia && ib && Math.abs(rect(ia).top - rect(ib).top) > 1) add('misaligned', ia, `field input vs ${desc(ib)}: ${Math.round(rect(ia).top)} / ${Math.round(rect(ib).top)}`);
      }
    }
    // Orphan: a lone field on a grid's last row that doesn't span it.
    const cols = S(g).gridTemplateColumns.split(' ').length;
    if (cols > 1 && fields.length > cols) {
      // A row is the fields sharing the last line of inputs (fields sit on their row's bottom).
      const lastBottom = Math.max(...fields.map((f) => Math.round(rect(f).bottom)));
      const last = fields.filter((f) => Math.abs(Math.round(rect(f).bottom) - lastBottom) <= 2);
      if (last.length < cols && last.reduce((w, f) => w + rect(f).width, 0) < rect(g).width * 0.75) add('orphan', last[0], `${last.length} of ${cols} columns on the last row`);
    }
  }
  // The same for stat tiles.
  for (const g of all.filter((e) => e.matches('.stat-grid, .cards-2, .import-split'))) {
    const kids = [...g.children].filter(visible);
    const cols = S(g).gridTemplateColumns.split(' ').length;
    if (cols > 1 && kids.length > cols) {
      const lastTop = Math.max(...kids.map((f) => Math.round(rect(f).top)));
      const last = kids.filter((f) => Math.abs(Math.round(rect(f).top) - lastTop) <= 2);
      if (last.length < cols && last.reduce((w, f) => w + rect(f).width, 0) < rect(g).width * 0.75) add('orphan', last[0], `${last.length} of ${cols} columns on the last row`);
    }
  }

  // ---------- 4. tokens: radii and type sizes
  // The radius tokens the stylesheet defines (--r-* on :root), and 0.
  const rootS = S(document.documentElement);
  const R = new Set([0]);
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) if (rule.selectorText === ':root') for (const prop of rule.style) if (/^--r-/.test(prop)) R.add(Math.round(parseFloat(rootS.getPropertyValue(prop))));
  }
  const RT = [...R].filter(Boolean).join('/');
  for (const el of all) {
    const s = S(el);
    const r = rect(el);
    if (r.height < 32 || r.width < 32 || el.matches('img, svg, iframe, .poster, .poster *, .sk, .sr-thumb, .sheet-thumb, .search-poster, .ri-poster, .fix-noposter, .icon-btn, .modal-x, .recent-x, .filter-clear, .spinner-ring, .hero-pick, .detail-hero, .hero-media, input[type=range], .ob-progress, .day-btn.sk')) continue;
    const painted = (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') || parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderLeftWidth) > 0;
    if (!painted) continue;
    const rad = parseFloat(s.borderTopLeftRadius) || 0;
    if (rad >= Math.min(r.height, r.width) / 2 - 1) continue; // pill or circle
    if (!R.has(Math.round(rad))) add('radius', el, `radius ${s.borderTopLeftRadius} (tokens ${RT})`);
  }
  const F = new Set([12, 13, 15, 16, 17, 22, 30, 40, 46, 64, 72]);
  for (const el of texty) {
    if (el.closest('.stars, .poster-fallback, .attn-dot, code, pre')) continue;
    const fs = parseFloat(S(el).fontSize);
    if (!F.has(Math.round(fs * 100) / 100)) add('font-size', el, `${fs}px (tokens ${[...F].join('/')})`);
  }

  // ---------- 5. text colour and contrast
  const parse = (c) => {
    if (!c || c === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    let m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
    m = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)/.exec(c);
    if (m) return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: m[4] == null ? 1 : +m[4] };
    return null;
  };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const mix = (x, y, o) => ({ r: x.r * o + y.r * (1 - o), g: x.g * o + y.g * (1 - o), b: x.b * o + y.b * (1 - o), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const BG = parse(S(document.body).backgroundColor);
  // Background(s) behind an element: composited from the root down, a
  // gradient contributing each of its stops, an opacity group fading its
  // whole content toward what was behind it.
  function behind(el) {
    const chain = [];
    for (let a = el; a; a = a.parentElement) chain.unshift(a);
    let bgs = [BG];
    const groups = [];
    for (const a of chain) {
      const s = S(a);
      const o = Number(s.opacity);
      if (o < 1) groups.push({ o, back: bgs });
      const c = parse(s.backgroundColor);
      if (c && c.a > 0) bgs = bgs.map((b) => over(c, b));
      const img = s.backgroundImage;
      if (img && img !== 'none') {
        if (img.includes('url(')) return null;
        const stops = [...img.matchAll(/(rgba?\([^)]*\)|color\(srgb[^)]*\))/g)].map((m) => parse(m[1])).filter(Boolean);
        if (stops.length) bgs = bgs.flatMap((b) => stops.map((st) => over(st, b)));
      }
    }
    return { bgs, groups };
  }
  const TEXT_COLORS = new Set(opts.palette);
  for (const el of textyIn) {
    if (el.closest('[aria-hidden="true"], .stars, .sk, .pick-poster, .tile-poster, .lv-poster, .lc-poster, .hero-media, :disabled')) continue;
    const tst = el.closest('.toast'); // a toast mid-fade isn't its final colour
    if (tst && Number(S(tst).opacity) < 1) continue;
    const s = S(el);
    const fg = parse(s.color);
    if (!fg) continue;
    const key = `${Math.round(fg.r)},${Math.round(fg.g)},${Math.round(fg.b)}`;
    if (!TEXT_COLORS.has(key)) add('color', el, `text colour rgb(${key}) is not a palette token`);
    const bh = behind(el);
    if (!bh) continue;
    const fs = parseFloat(s.fontSize); const fw = Number(s.fontWeight) || 400;
    const need = fs >= 24 || (fs >= 18.66 && fw >= 700) ? 3 : 4.5;
    let worst = 99;
    for (const b of bh.bgs) {
      let t = over(fg, b); let bb = b;
      for (const g of [...bh.groups].reverse()) { const back = g.back[0]; t = mix(t, back, g.o); bb = mix(bb, back, g.o); }
      worst = Math.min(worst, ratio(t, bb));
    }
    if (worst < need) add('contrast', el, `${worst.toFixed(2)}:1 < ${need}:1 (${fs}px ${fw})`);
  }
  // Placeholders and the empty-star track of a rater (a control: 3:1).
  for (const el of all.filter((e) => e.matches('input[placeholder], textarea[placeholder]') && !e.value)) {
    const fg = parse(S(el, '::placeholder').color); const bh = behind(el);
    if (!fg || !bh) continue;
    const worst = Math.min(...bh.bgs.map((b) => ratio(over(fg, b), b)));
    if (worst < 4.5) add('contrast', el, `placeholder ${worst.toFixed(2)}:1 < 4.5:1`);
  }
  for (const el of all.filter((e) => e.matches('.stars.interactive .stars-base'))) {
    const fg = parse(S(el).color); const bh = behind(el);
    if (!fg || !bh) continue;
    const worst = Math.min(...bh.bgs.map((b) => ratio(over(fg, b), b)));
    if (worst < 3) add('contrast', el, `empty stars of a rater ${worst.toFixed(2)}:1 < 3:1`);
  }

  // ---------- 6. empty painted boxes, double borders, odd gaps in cards
  const EMPTY_OK = 'img, .sk-card, .sk-hero, .status-dot, .sk, .skeleton, .skeleton *, .src-bar, .src-fill, .ob-progress, .ob-fill, .spinner-ring, .hero-scrim, .hero-media, .attn-dot, .key-dot, .poster, .poster *, .sheet-thumb, .search-poster, .ri-poster, .fix-noposter, .sr-thumb, .trailer, .stars, .stars *, .modal-overlay, .toast-host, .diag-scroll, .lv-poster, .tile-poster, input, textarea, select, iframe, .app-header, .bottom-nav';
  for (const el of all) {
    if (el.matches(EMPTY_OK) || el.textContent.trim() || el.querySelector('img, svg, input, iframe, canvas, video')) continue;
    const s = S(el); const r = rect(el);
    if (r.width < 8 || r.height < 8) continue;
    const bg = parse(s.backgroundColor);
    if ((bg && bg.a > 0) || parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderBottomWidth) > 0) add('empty-box', el, `${Math.round(r.width)}x${Math.round(r.height)} painted box with nothing in it`);
  }
  const bordered = all.filter((e) => parseFloat(S(e).borderBottomWidth) > 0 && S(e).borderBottomStyle !== 'none');
  const topBordered = all.filter((e) => parseFloat(S(e).borderTopWidth) > 0 && S(e).borderTopStyle !== 'none');
  const layer = (e) => e.closest('.app-header, .bottom-nav, .toast-host, .modal-card, .save-bar, #main');
  // The nearest scroller: a row scrolled flush under a dialog's header isn't a doubled border.
  const scroller = (e) => { for (let a = e.parentElement; a; a = a.parentElement) if (/(auto|scroll)/.test(S(a).overflowY)) return a; return null; };
  for (const a of bordered) {
    const ra = rect(a);
    for (const b of topBordered) {
      if (a === b || a.contains(b) || b.contains(a) || layer(a) !== layer(b) || scroller(a) !== scroller(b) || a.closest('.toast-host') || !inView(a) || !inView(b)) continue;
      const rb = rect(b);
      const ca = clipRects(a)[0]; const cb = clipRects(b)[0];
      if (!ca || !cb || Math.abs(ca.bottom - ra.bottom) > 1 || Math.abs(cb.top - rb.top) > 1) continue;
      if (Math.abs(rb.top - ra.bottom) <= 1.5 && Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left) > 20) add('double-border', a, `border meets ${desc(b)}'s`);
    }
  }
  for (const card of all.filter((e) => e.matches('.group-body, .import-box, .import-guide, .help-card, .confirm, .import-result, .unmatched-row, .modal-body > .sheet, .tg-film, .pick-card, .big-stat'))) {
    const cs = S(card);
    const gap = parseFloat(cs.rowGap) || 0;
    const kids = [...card.children].filter(visible).filter((k) => !/^(absolute|fixed)$/.test(S(k).position));
    // A child's own border sitting on the card's edge doubles the card's.
    const cr = rect(card);
    for (const k of kids) {
      const kr = rect(k); const ks = S(k);
      if (parseFloat(ks.borderTopWidth) > 0 && kr.top - cr.top <= parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth) + 1 && S(card).flexDirection === 'column') add('double-border', k, `top border at the top of ${desc(card)}`);
    }
    if (S(card).display !== 'flex' || S(card).flexDirection !== 'column') continue;
    for (let i = 1; i < kids.length; i++) {
      const g = rect(kids[i]).top - rect(kids[i - 1]).bottom;
      const pair = `${desc(kids[i - 1])} -> ${desc(kids[i])}`;
      if (g > gap + 6) add('double-gap', kids[i], `${Math.round(g)}px gap (card gap ${gap}px): ${pair}`);
      if (g < Math.max(0, gap - 5)) add('tight-gap', kids[i], `${Math.round(g)}px gap (card gap ${gap}px): ${pair}`);
    }
  }

  // ---------- 7. overlapping text inside one card or row
  const CONTAINERS = '.app-header, .list-row, .pick-card, .group-body, .tile, .lc-card, .lv-film, .tg-film, .modal-card, .theatre-item, .bar-row, .sheet-film, .sr-row, .recent-row, .rating-item, .search-row, .import-box, .hero-content, .toast, .bottom-nav, .big-stat, .key-row, .window-row, .rating-row, .st-row';
  for (const c of all.filter((e) => e.matches(CONTAINERS))) {
    const leaves = textyIn.filter((t) => c.contains(t) && !t.closest('.stars'));
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const a = leaves[i]; const b = leaves[j];
        if (a.contains(b) || b.contains(a)) continue;
        // Line boxes of inline text: use client rects so wrapped inline text isn't one big box.
        const ra = clipRects(a); const rb = clipRects(b);
        const hit = ra.some((x) => rb.some((y) => Math.min(x.right, y.right) - Math.max(x.left, y.left) > 2 && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 3));
        if (hit) add('overlap', a, `overlaps ${desc(b)}`);
      }
    }
  }

  // ---------- 8. nothing hidden behind the header, the tab bar or the Save bar
  const bars = [...document.querySelectorAll('.bottom-nav, .app-header, .save-bar')].filter(visible).map((b) => ({ b, r: rect(b), fixed: /^(fixed|sticky)$/.test(S(b).position) }));
  const nav = bars.find((x) => x.b.matches('.bottom-nav'));
  if (atBottom && !overlayOpen) {
    const leaves = all.filter((e) => e.closest('#main') && (ownText(e) || e.matches('button, a, input, select, img')) && !e.closest('.save-bar'));
    const lowest = leaves.reduce((m, e) => (rect(e).bottom > (m ? rect(m).bottom : -1e9) ? e : m), null);
    for (const e of leaves) {
      const r = rect(e);
      for (const { b, r: br } of bars) {
        if (b.matches('.app-header')) continue;
        const save = b.matches('.save-bar');
        // The Save bar's faded strip above the button is fine to pass under; its button row is not.
        const top = save ? rect(b.querySelector('.btn')).top - 8 : br.top;
        if (r.bottom > top + 1 && r.top < br.bottom) add('covered', e, `${save ? 'under the Save bar' : 'under the tab bar'} at the end of the page`);
      }
    }
    if (lowest && rect(lowest).bottom > vh + 1) add('covered', lowest, `last item ends at ${Math.round(rect(lowest).bottom)}, below the window ${vh}`);
  }
  // Toasts never sit on the tab bar.
  for (const t of [...document.querySelectorAll('.toast.show')].filter(visible)) {
    if (nav && rect(t).bottom > nav.r.top + 1) add('covered', t, 'toast over the tab bar');
    const sb = document.querySelector('.save-bar .btn');
    if (sb && visible(sb)) { const a = rect(t); const b = rect(sb); if (a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right) add('covered', t, 'toast over the Save button'); }
  }
  // A dialog fits the window.
  for (const m of [...document.querySelectorAll('.modal-card')].filter(visible)) {
    const r = rect(m);
    if (r.top < -1 || r.bottom > vh + 1 || r.left < -1 || r.right > vw + 1) add('covered', m, `dialog ${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)} outside ${vw}x${vh}`);
  }

  // ---------- 9. header items never touch
  const hdr = [...document.querySelectorAll('.app-header .brand, .app-header .seg, .app-header .header-search')].filter(visible);
  for (let i = 0; i < hdr.length; i++) {
    for (let j = i + 1; j < hdr.length; j++) {
      if (hdr[i].contains(hdr[j]) || hdr[j].contains(hdr[i])) continue;
      const a = rect(hdr[i]); const b = rect(hdr[j]);
      const gapX = Math.max(b.left - a.right, a.left - b.right);
      if (gapX < 6 && a.top < b.bottom && b.top < a.bottom) add('header', hdr[i], `${Math.round(gapX)}px from ${desc(hdr[j])}`);
    }
  }
  for (const el of [...document.querySelectorAll('.app-header .seg-item')].filter(visible)) if (el.scrollWidth > el.clientWidth + 1) add('header', el, 'tab label cut');
  const hh = document.querySelector('.app-header');
  // Its content height: the installed app pads the top by the status bar's inset.
  const hhContent = hh ? rect(hh).height - parseFloat(S(hh).paddingTop) - parseFloat(S(hh).paddingBottom) : 0;
  if (hh && visible(hh) && hhContent > 64) add('header', hh, `header content ${Math.round(hhContent)}px tall (wrapped?)`);

  // ---------- 10. bottom tab bar labels
  const items = [...document.querySelectorAll('.bottom-nav .nav-item')].filter(visible);
  for (let i = 0; i < items.length; i++) {
    const lab = items[i].querySelector('.nav-label');
    if (lab.scrollWidth > lab.clientWidth + 1) add('tabbar', items[i], `label cut ${lab.scrollWidth}/${lab.clientWidth}`);
    const r = rect(lab); const ir = rect(items[i]);
    if (r.left < ir.left - 1 || r.right > ir.right + 1) add('tabbar', items[i], 'label wider than its tab');
    if (ir.right > vw + 1 || ir.left < -1) add('tabbar', items[i], 'tab off screen');
    if (i && rect(items[i - 1].querySelector('.nav-label')).right > r.left - 2) add('tabbar', items[i], 'label touches its neighbour');
  }

  // ---------- 11. tap targets (phones)
  if (phone) {
    // An absolute ::before/::after is laid out against its containing block:
    // the element itself when it is positioned, else its nearest positioned
    // ancestor (a Book link whose ::after covers its whole showtime row).
    const ext = (el) => {
      const r = rect(el); let { left, top, right, bottom } = r;
      for (const p of ['::before', '::after']) {
        const s = S(el, p);
        if (s.content === 'none' || s.position !== 'absolute') continue;
        const px = (v) => (v.endsWith('px') ? parseFloat(v) : null);
        let cb = el; if (S(el).position === 'static') { cb = el.parentElement; while (cb && cb !== document.body && S(cb).position === 'static') cb = cb.parentElement; }
        const c = rect(cb || document.body);
        const L = px(s.left); const T = px(s.top); const Rr = px(s.right); const B = px(s.bottom);
        const pl = L != null ? c.left + L : null; const pt = T != null ? c.top + T : null;
        const pr = Rr != null ? c.right - Rr : null; const pb = B != null ? c.bottom - B : null;
        const w = parseFloat(s.width) || 0; const hh = parseFloat(s.height) || 0;
        const bl = pl ?? (pr != null ? pr - w : null); const br = pr ?? (pl != null ? pl + w : null);
        const bt = pt ?? (pb != null ? pb - hh : null); const bb = pb ?? (pt != null ? pt + hh : null);
        if (bl == null || br == null || bt == null || bb == null) continue;
        left = Math.min(left, bl); right = Math.max(right, br); top = Math.min(top, bt); bottom = Math.max(bottom, bb);
      }
      return { w: right - left, h: bottom - top };
    };
    const targets = all.filter((e) => e.matches('a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], label.switch-row'));
    for (const el of targets) {
      if (el.matches(':disabled, [aria-disabled="true"]') || S(el).pointerEvents === 'none') continue;
      if (el.matches('label.switch-row input, input[type=checkbox]') && el.closest('label')) continue;
      if (el.parentElement?.closest('a[href], button, summary')) continue;
      // Inline links inside running text are exempt (WCAG 2.5.8).
      if (S(el).display === 'inline' && el.parentElement && ownText(el.parentElement)) continue;
      const { w, h } = ext(el);
      if (w < 43.5 || h < 43.5) add('tap', el, `${Math.round(w)}x${Math.round(h)} < 44x44`);
    }
  }

  // ---------- 11b. labels that wrap where they shouldn't; placeholders cut;
  // fields in one card whose left edges almost (but don't) line up
  for (const el of all.filter((e) => e.matches('.btn, .chip, .nav-label, .seg-item, .segment, .tag, .match, .toast-action, .section-link'))) {
    const tops = new Set();
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 1) tops.add(Math.round(r.top));
    }
    if (tops.size > 1) add('wrapped', el, `label runs to ${tops.size} lines`);
  }
  const canvas = document.createElement('canvas').getContext('2d');
  for (const el of all.filter((e) => e.matches('input[placeholder]') && !e.value)) {
    const s = S(el);
    canvas.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    const room = el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
    const need = canvas.measureText(el.placeholder).width;
    if (need > room + 1) add('clipped', el, `placeholder needs ${Math.round(need)}px, has ${Math.round(room)}px`);
  }
  for (const card of all.filter((e) => e.matches('.group-body, .modal-card'))) {
    const ctl = [...card.querySelectorAll('input.input, select')].filter(visible).filter((e) => e.closest('.group-body, .modal-card') === card);
    for (let i = 0; i < ctl.length; i++) {
      for (let j = i + 1; j < ctl.length; j++) {
        const a = rect(ctl[i]); const b = rect(ctl[j]);
        if (Math.abs(a.top - b.top) < 4) continue; // same row: handled above
        const dl = Math.abs(a.left - b.left);
        if (dl > 0.5 && dl < 8) add('misaligned', ctl[i], `left edge ${Math.round(a.left)} vs ${Math.round(b.left)} (${desc(ctl[j])}) in the row below`);
      }
    }
  }

  // ---------- 12. broken images
  for (const img of all.filter((e) => e.tagName === 'IMG')) if (img.complete && img.naturalWidth === 0) add('broken-img', img, img.src.slice(0, 80));

  // ---------- 13. every control says what it is; in-app links go somewhere real
  for (const el of all.filter((e) => e.matches('a[href], button, [role=button], [role=option], input:not([type=hidden]), select'))) {
    let name = (el.getAttribute('aria-label') || '').trim();
    if (!name && el.getAttribute('aria-labelledby')) name = document.getElementById(el.getAttribute('aria-labelledby'))?.textContent.trim() || '';
    if (!name) name = el.textContent.replace(/\s+/g, ' ').trim();
    if (!name && el.matches('input, select')) name = (el.closest('label')?.textContent || el.getAttribute('placeholder') || '').trim();
    if (!name) name = (el.getAttribute('title') || el.querySelector('img[alt]')?.alt || '').trim();
    if (!/\p{L}|\p{N}/u.test(name)) add('no-name', el, `accessible name "${name}"`);
  }
  for (const a of all.filter((e) => e.matches('a[href^="#/"]'))) {
    const route = a.getAttribute('href').replace(/^#\/?/, '').split('/')[0];
    if (!opts.routes.includes(route)) add('dead-link', a, a.getAttribute('href'));
  }

  return out;
}

// Tab through the page: every stop shows a focus ring and isn't hidden
// behind the header, the tab bar or the Save bar.

export function contrastProbe() {
  const out = [];
  const S = (el, p) => getComputedStyle(el, p);
  const desc = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : (el.getAttribute('class') || '').split(/\s+/).slice(0, 2).join('.');
    const txt = (el.getAttribute?.('aria-label') || el.textContent || el.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 36);
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${txt ? ` "${txt}"` : ''}`;
  };
  const srOnly = [...document.querySelectorAll('*')].filter((e) => S(e).clipPath === 'inset(50%)');
  const visible = (el) => {
    if (!el.isConnected || el.closest('[hidden]')) return false;
    const d = el.closest('details:not([open])'); if (d && !el.closest('summary')) return false;
    if (srOnly.some((s) => s.contains(el))) return false;
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    for (let a = el; a; a = a.parentElement) { const s = S(a); if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false; }
    return true;
  };
  const inScroller = (el) => {
    const r = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const s = S(a); if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const ar = a.getBoundingClientRect();
      if (r.bottom <= ar.top + 1 || r.top >= ar.bottom - 1 || r.right <= ar.left + 1 || r.left >= ar.right - 1) return false;
    }
    return true;
  };
  const parse = (c) => {
    if (!c || c === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    let m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
    m = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)/.exec(c);
    if (m) return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: m[4] == null ? 1 : +m[4] };
    return null;
  };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const mix = (x, y, o) => ({ r: x.r * o + y.r * (1 - o), g: x.g * o + y.g * (1 - o), b: x.b * o + y.b * (1 - o), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const BG = parse(S(document.body).backgroundColor);
  // `self` false: what's behind el, not counting el's own background.
  function behind(el, self = true) {
    const chain = []; for (let a = self ? el : el.parentElement; a; a = a.parentElement) chain.unshift(a);
    let bgs = [BG]; const groups = [];
    for (const a of chain) {
      const s = S(a); const o = Number(s.opacity);
      if (o < 1) groups.push({ o, back: bgs });
      const c = parse(s.backgroundColor); if (c && c.a > 0) bgs = bgs.map((b) => over(c, b));
      const img = s.backgroundImage;
      if (img && img !== 'none') {
        if (img.includes('url(')) return null;
        const stops = [...img.matchAll(/(rgba?\([^)]*\)|color\(srgb[^)]*\))/g)].map((m) => parse(m[1])).filter(Boolean);
        if (stops.length) bgs = bgs.flatMap((b) => stops.map((st) => over(st, b)));
      }
    }
    if (!self && Number(S(el).opacity) < 1) groups.push({ o: Number(S(el).opacity), back: bgs });
    return { bgs, groups };
  }
  const worstOf = (fg, bh) => {
    let worst = 99;
    for (const b of bh.bgs) {
      let t = over(fg, b); let bb = b;
      for (const g of [...bh.groups].reverse()) { const back = g.back[0]; t = mix(t, back, g.o); bb = mix(bb, back, g.o); }
      worst = Math.min(worst, ratio(t, bb));
    }
    return worst;
  };
  const roots = document.querySelector('.modal-overlay') ? [...document.querySelectorAll('.modal-overlay')] : [document.querySelector('.shell'), document.querySelector('.toast-host')].filter(Boolean);
  const all = roots.flatMap((r) => [r, ...r.querySelectorAll('*')]).filter((e) => !(e instanceof SVGElement && e.tagName !== 'svg')).filter(visible).filter(inScroller);
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  let nText = 0; let nField = 0; let nIcon = 0;

  // Text. Posters' own art and skeletons are not text on a surface; a started
  // showtime is an inactive control (WCAG 1.4.3 exempts inactive components).
  for (const el of all.filter(ownText)) {
    if (el.closest('[aria-hidden="true"], .stars, .sk, .pick-poster, .tile-poster, .lv-poster, .lc-poster, .hero-media, :disabled, .st-row.past')) continue;
    const tst = el.closest('.toast'); if (tst && Number(S(tst).opacity) < 1) continue;
    const s = S(el); const fg = parse(s.color); if (!fg) continue;
    const bh = behind(el); if (!bh) continue;
    const fs = parseFloat(s.fontSize); const fw = Number(s.fontWeight) || 400;
    const need = fs >= 24 || (fs >= 18.66 && fw >= 700) ? 3 : 4.5;
    const w = worstOf(fg, bh); nText++;
    if (w < need) out.push({ kind: 'text', sel: desc(el), detail: `${w.toFixed(2)}:1 < ${need}:1 (${fs}px ${fw})` });
  }
  for (const el of all.filter((e) => e.matches('input[placeholder], textarea[placeholder]') && !e.value)) {
    const fg = parse(S(el, '::placeholder').color); const bh = behind(el); if (!fg || !bh) continue;
    const w = worstOf(fg, bh); nText++;
    if (w < 4.5) out.push({ kind: 'text', sel: desc(el), detail: `placeholder ${w.toFixed(2)}:1 < 4.5:1` });
  }
  for (const el of all.filter((e) => e.matches('.stars.interactive .stars-base'))) {
    const fg = parse(S(el).color); const bh = behind(el); if (!fg || !bh) continue;
    const w = worstOf(fg, bh); nIcon++;
    if (w < 3) out.push({ kind: 'icon', sel: desc(el), detail: `empty stars ${w.toFixed(2)}:1 < 3:1` });
  }
  // Field edges: the border against what the field sits on (3:1), unless the
  // field's own fill already stands 3:1 off it.
  for (const el of all.filter((e) => e.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]), select, textarea'))) {
    if (el.getAttribute('aria-invalid') === 'true') continue;
    const s = S(el); const bh = behind(el, false); if (!bh) continue;
    const edge = parse(s.borderTopColor); const bw = parseFloat(s.borderTopWidth);
    const fill = parse(s.backgroundColor);
    const e = bw >= 1 && edge ? worstOf(edge, bh) : 0;
    const f = fill && fill.a > 0 ? worstOf(fill, bh) : 0;
    nField++;
    if (Math.max(e, f) < 3) out.push({ kind: 'field', sel: desc(el), detail: `edge ${e.toFixed(2)}:1, fill ${f.toFixed(2)}:1 < 3:1` });
  }
  // Icons: an svg's colour (currentColor) against what's behind it.
  for (const el of all.filter((e) => e.tagName === 'svg')) {
    if (el.closest('.hero-media, .poster, .pick-poster, .tile-poster, .lv-poster, .lc-poster, :disabled, .st-row.past')) continue;
    const r = el.getBoundingClientRect(); if (r.width < 8 || r.height < 8) continue;
    const fg = parse(S(el).color); const bh = behind(el); if (!fg || !bh) continue;
    const w = worstOf(fg, bh); nIcon++;
    if (w < 3) out.push({ kind: 'icon', sel: desc(el), detail: `${w.toFixed(2)}:1 < 3:1` });
  }
  return { out, counts: { text: nText, field: nField, icon: nIcon } };
}

// Hero text over artwork: marks each text element in a hero that sits straight
// on the art (no fill of its own between it and the hero), returns their boxes
// and colours, and hides their glyphs so a screenshot shows only what's behind.
export function heroTextBoxes() {
  const boxes = [];
  for (const hero of document.querySelectorAll('.hero-pick, .detail-hero')) {
    const content = hero.querySelector('.hero-content'); if (!content) continue;
    for (const el of content.querySelectorAll('*')) {
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      let filled = false;
      for (let a = el; a && a !== content; a = a.parentElement) { const bg = getComputedStyle(a).backgroundColor; if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') { filled = true; break; } }
      if (filled) continue;
      if (el.closest('[aria-hidden="true"]')) continue; // decoration, as in the DOM check
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || Number(s.opacity) === 0) continue;
      const fs = parseFloat(s.fontSize); const fw = Number(s.fontWeight) || 400;
      el.dataset.pxchk = '1';
      // The glyphs' own line boxes (a block's box can run far past its words),
      // 1px in from each side.
      for (const n of el.childNodes) {
        if (n.nodeType !== 3 || !n.textContent.trim()) continue;
        const rg = document.createRange(); rg.selectNodeContents(n);
        for (const r of rg.getClientRects()) {
          if (r.width < 3 || r.height < 3) continue;
          boxes.push({ sel: `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} "${n.textContent.trim().slice(0, 30)}"`, x: r.left + scrollX + 1, y: r.top + scrollY + 1, w: r.width - 2, h: r.height - 2, color: s.color, need: fs >= 24 || (fs >= 18.66 && fw >= 700) ? 3 : 4.5 });
        }
      }
    }
  }
  const st = document.createElement('style');
  st.textContent = '[data-pxchk] { color: transparent !important; text-shadow: none !important; -webkit-text-fill-color: transparent !important; }';
  document.head.appendChild(st);
  return boxes;
}

// Only the active tab is highlighted, wrapped lines step evenly, and the
// type in use (size / weight / line-height / family).
export function extras() {
  const out = []; const S = (e) => getComputedStyle(e);
  const desc = (el) => `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} "${(el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30)}"`;
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; for (let a = el; a; a = a.parentElement) { const s = S(a); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false; } return !el.closest('[hidden]'); };
  // Only the active tab is highlighted: every inactive tab looks like every other inactive tab.
  for (const sel of ['.bottom-nav .nav-item', '.app-header .seg-item']) {
    const items = [...document.querySelectorAll(sel)].filter(vis);
    const inactive = items.filter((e) => !e.classList.contains('active'));
    const look = (e) => { const s = S(e); return [s.color, s.backgroundColor, s.boxShadow, s.outlineStyle === 'none' ? 'none' : `${s.outlineStyle} ${s.outlineColor}`, S(e.querySelector('.nav-icon') || e).color].join('|'); };
    const counts = {}; for (const e of inactive) { const k = look(e); counts[k] = (counts[k] || 0) + 1; }
    const common = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    for (const e of inactive) if (look(e) !== common) out.push({ kind: 'tab-glow', sel: desc(e), detail: `inactive tab looks different: ${look(e)} vs ${common}` });
    if (items.filter((e) => e.classList.contains('active')).length > 1) out.push({ kind: 'tab-glow', sel: sel, detail: 'more than one active tab' });
  }
  // Wrapped text: line tops step evenly.
  const blocks = [...document.querySelectorAll('#main *, .modal-card *, .tour-card *, body > *:not(#app) *')].filter((e) => vis(e) && ['block', 'flex', 'list-item', 'grid', 'inline-block', '-webkit-box'].includes(S(e).display));
  for (const b of blocks) {
    const rects = [];
    const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      // Only text whose nearest block ancestor is b.
      let p = n.parentElement; let ok = true;
      for (; p && p !== b; p = p.parentElement) { const d = S(p).display; if (!d.startsWith('inline') || d === 'inline-block' || d === 'inline-flex' || d === 'inline-grid') { ok = false; break; } }
      if (!ok) continue;
      const rg = document.createRange(); rg.selectNodeContents(n);
      for (const r of rg.getClientRects()) if (r.width > 1) rects.push(r);
    }
    if (rects.length < 2) continue;
    const tops = [...new Set(rects.map((r) => Math.round((r.top + r.bottom) / 2)))].sort((a, b) => a - b);
    const lines = []; for (const t of tops) if (!lines.length || t - lines[lines.length - 1] > 4) lines.push(t);
    if (lines.length < 2) continue;
    const gaps = lines.slice(1).map((t, i) => t - lines[i]);
    const lh = parseFloat(S(b).lineHeight) || parseFloat(S(b).fontSize) * 1.2;
    if (Math.max(...gaps) - Math.min(...gaps) > 3 || Math.max(...gaps) > lh * 1.35 + 2) out.push({ kind: 'uneven-lines', sel: desc(b), detail: `line steps ${gaps.join('/')} for line-height ${Math.round(lh)}` });
  }
  // Type inventory (size / weight / line-height / family) of text-bearing elements.
  const inv = {};
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el) || !([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))) continue;
    if (el.closest('.stars, svg, script, style')) continue;
    const s = S(el);
    const k = `${parseFloat(s.fontSize)}|${s.fontWeight}|${s.lineHeight === 'normal' ? 'normal' : Math.round(parseFloat(s.lineHeight) * 100) / 100}|${s.fontFamily.split(',')[0].replace(/"/g, '').trim()}`;
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : el.tagName.toLowerCase();
    (inv[k] ||= new Set()).add(cls);
  }
  return { out, inv: Object.fromEntries(Object.entries(inv).map(([k, v]) => [k, [...v].slice(0, 12)])) };
}

// WCAG contrast helpers for Node-side colour maths.
export function parse(c) {
  c = c.trim();
  if (c.startsWith('#')) { const h = c.length === 4 ? c.slice(1).split('').map((x) => x + x).join('') : c.slice(1); return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length > 6 ? parseInt(h.slice(6, 8), 16) / 255 : 1 }; }
  const m = c.match(/[\d.]+/g).map(Number);
  if (/^color\(srgb/.test(c)) return { r: m[0] * 255, g: m[1] * 255, b: m[2] * 255, a: m.length > 3 ? m[3] : 1 };
  return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 };
}
export const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
export function ratio(fg, bg) { const a = lum(fg); const b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }

// ---------------------------------------------------------------- page steps
export async function toBottom(page) {
  for (let i = 0; i < 40; i++) {
    const done = await page.evaluate(() => { const y = scrollY; window.scrollTo(0, document.documentElement.scrollHeight); return Math.abs(scrollY - y) < 2; });
    await page.waitForTimeout(120);
    if (done) break;
  }
  await page.waitForTimeout(300);
}
export async function loadImages(page) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < Math.min(h, 12000); y += 700) { await page.evaluate((v) => window.scrollTo(0, v), y); await page.waitForTimeout(40); }
  await page.waitForFunction(() => [...document.images].filter((i) => i.getBoundingClientRect().width > 0 && i.loading !== 'lazy').every((i) => i.complete), null, { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
}
export async function waitDialog(page) { await page.waitForSelector('.modal-overlay.show .modal-card', { timeout: 15000 }); await page.waitForTimeout(450); }
// The resolved colour of a CSS custom property (as color or background-color).
export const token = (page, name, prop = 'color') => page.evaluate(({ name, prop }) => { const t = document.createElement('span'); t.style[prop] = `var(--${name})`; document.body.appendChild(t); const c = getComputedStyle(t)[prop]; t.remove(); return c; }, { name, prop });
// The palette colours text may use (measure()'s `palette` option).
export const textPalette = (page) => page.evaluate(() => {
  const s = getComputedStyle(document.documentElement); const tmp = document.createElement('span'); document.body.appendChild(tmp);
  const out = [];
  for (const t of ['--text', '--muted', '--accent-text', '--accent', '--on-accent', '--good', '--bad', '--warn', '--gold', '--blue', '--purple', '--teal', '--amber', '--raised', '--chip', '--bg']) {
    tmp.style.color = s.getPropertyValue(t); const c = getComputedStyle(tmp).color.match(/[\d.]+/g); if (c) out.push(c.slice(0, 3).map((v) => Math.round(+v)).join(','));
  }
  tmp.remove(); return out;
});
export const ROUTES = ['home', 'movie', 'person', 'coming', 'leaving', 'schedule', 'welcome', 'rate', 'watchlist', 'you', 'stats', 'together', 'settings', 'help', 'onboarding'];

// ---------------------------------------------------------------- screenshots
// A small PNG reader for screenshots: 8-bit RGB or RGBA, not interlaced.
import zlib from 'node:zlib';
export const PNG = {
  read(buf) {
    let pos = 8; let width = 0; let height = 0; let type = 0; const idat = [];
    while (pos < buf.length) {
      const len = buf.readUInt32BE(pos); const kind = buf.toString('ascii', pos + 4, pos + 8);
      const body = buf.subarray(pos + 8, pos + 8 + len);
      if (kind === 'IHDR') {
        width = body.readUInt32BE(0); height = body.readUInt32BE(4);
        if (body[8] !== 8 || body[12] !== 0) throw new Error('only 8-bit, non-interlaced PNGs');
        type = body[9];
      } else if (kind === 'IDAT') idat.push(body);
      else if (kind === 'IEND') break;
      pos += 12 + len;
    }
    const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
    if (!bpp) throw new Error(`PNG colour type ${type} not handled`);
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * bpp; const out = Buffer.alloc(width * height * 4);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
      const f = raw[y * (stride + 1)]; const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp] : 0; const b = prev[i]; const c = i >= bpp ? prev[i - bpp] : 0;
        let v = line[i];
        if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        line[i] = v & 255;
      }
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4; const s = x * bpp;
        out[o] = line[s]; out[o + 1] = line[s + 1]; out[o + 2] = line[s + 2]; out[o + 3] = bpp === 4 ? line[s + 3] : 255;
      }
      prev = line;
    }
    return { width, height, data: out };
  },
};

// ---------------------------------------------------------------- fonts
// Rendered (platform) fonts of every visible text-bearing element, via CDP.
export async function platformFonts(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: false });
  await page.evaluate(() => {
    let i = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('svg, script, style, [hidden]')) continue;
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      if (r.width < 1 || r.height < 1 || s.visibility === 'hidden' || s.display === 'none') continue;
      el.setAttribute('data-pf', String(i++));
    }
  });
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-pf]' });
  const byFamily = {};
  for (const nodeId of nodeIds.slice(0, 600)) {
    let fonts;
    try { ({ fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })); } catch { continue; }
    if (!fonts.length) continue;
    const { attributes } = await cdp.send('DOM.getAttributes', { nodeId });
    const idx = attributes[attributes.indexOf('data-pf') + 1];
    for (const f of fonts) {
      (byFamily[f.familyName] ||= { glyphs: 0, els: [] }).glyphs += f.glyphCount;
      if (byFamily[f.familyName].els.length < 4) byFamily[f.familyName].els.push(idx);
    }
  }
  const out = {};
  for (const [fam, v] of Object.entries(byFamily)) {
    out[fam] = { glyphs: v.glyphs, samples: await page.evaluate((ids) => ids.map((id) => {
      const el = document.querySelector(`[data-pf="${id}"]`);
      const t = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim();
      const odd = [...new Set([...t].filter((c) => c.codePointAt(0) > 0x24f))].join('');
      return `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} "${t.slice(0, 30)}"${odd ? ` [${odd}]` : ''}`;
    }), v.els) };
  }
  await page.evaluate(() => document.querySelectorAll('[data-pf]').forEach((e) => e.removeAttribute('data-pf')));
  await cdp.detach();
  return out;
}

// ---------------------------------------------------------------- posters
// A solid PNG of any size (zlib, no dependency).
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function solidPng(width, height, [r, g, b]) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3); for (let x = 0; x < width; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// Posters and backdrops at their real sizes, so an image described in a
// srcset as 780w has a real width (the shared 1x1 stand-in reads as a broken
// 0px image there). Added after open(): a later context route wins.
const pngCache = new Map();
export async function realSizePosters(ctx) {
  await ctx.route(/^https:\/\/image\.tmdb\.org\//, (r) => {
    const m = r.request().url().match(/\/w(\d+)\//);
    const wd = Math.min(Number(m?.[1] || 342), 1280);
    const backdrop = /rp-bd-|\/w(780|1280)\//.test(r.request().url());
    const ht = Math.round(backdrop ? wd * 9 / 16 : wd * 1.5);
    const key = `${wd}x${ht}`;
    if (!pngCache.has(key)) pngCache.set(key, solidPng(wd, ht, [74, 70, 82]));
    return r.fulfill({ status: 200, contentType: 'image/png', body: pngCache.get(key) });
  });
}
