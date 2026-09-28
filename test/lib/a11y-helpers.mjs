// In-page measurements for the accessibility suite (test/ui/a11y.mjs), ported
// from the real-app run's accessibility gate. Everything is measured from
// layout and computed style. `kit` and `motionRecorder` are installed with
// addInitScript; `zoomMeasure` runs through page.evaluate.

// window.__a11y: focus stops, focus rings, reachable controls, click-only
// things.
export function kit() {
  const K = {
    ids: new WeakMap(), n: 0,
    id(el) { if (!this.ids.has(el)) this.ids.set(el, ++this.n); return this.ids.get(el); },
    desc(el) {
      if (!el || !el.tagName) return String(el);
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
      const txt = (el.getAttribute('aria-label') || el.textContent || el.value || el.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 32);
      return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''}${txt ? ` "${txt}"` : ''}`;
    },
    parse(c) {
      if (!c) return null;
      let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(c);
      if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]) };
      m = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(c);
      if (m) return { r: m[1] * 255, g: m[2] * 255, b: m[3] * 255, a: m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]) };
      if (c === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
      return null;
    },
    over(f, b) { return { r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 }; },
    lum(c) { const l = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * l(c.r) + 0.7152 * l(c.g) + 0.0722 * l(c.b); },
    contrast(a, b) { const x = this.lum(a); const y = this.lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); },
    // The colour painted behind `el`: its own background and every
    // ancestor's, composited, with the page background at the bottom.
    bgOf(el) {
      const layers = [];
      for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
        const c = this.parse(getComputedStyle(a).backgroundColor);
        if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
      }
      let base = this.parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
      if (base.a < 1) base = this.over(base, { r: 255, g: 255, b: 255, a: 1 });
      for (let i = layers.length - 1; i >= 0; i--) base = this.over(layers[i], base);
      return base;
    },
    visible(el) {
      if (!el.isConnected || el.closest('[hidden], [inert]')) return false;
      const d = el.closest('details:not([open])');
      if (d && !el.closest('summary')) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
        if (s.clipPath === 'inset(50%)') return false;
      }
      return true;
    },
    ring(el) {
      const s = getComputedStyle(el);
      let w = s.outlineStyle !== 'none' ? parseFloat(s.outlineWidth) || 0 : 0;
      let color = s.outlineColor;
      let kind = 'outline';
      const off = parseFloat(s.outlineOffset) || 0;
      if (!w && s.boxShadow && s.boxShadow !== 'none') {
        // "rgb(...) 0px 0px 0px 2px": a solid ring drawn as a shadow.
        const m = /(rgba?\([^)]*\)|color\([^)]*\))\s+0px\s+0px\s+0px\s+([\d.]+)px/.exec(s.boxShadow);
        if (m) { w = parseFloat(m[2]); color = m[1]; kind = 'shadow'; }
      }
      // A ring drawn by the control's own ::after or ::before (a link whose
      // tap area is stretched over its whole row rings the row). Counts only
      // when that box is drawn and at least as big as the control.
      if (!w) {
        for (const pseudo of ['::after', '::before']) {
          const p = getComputedStyle(el, pseudo);
          if (p.content === 'none' || p.display === 'none' || p.outlineStyle === 'none') continue;
          const pw = parseFloat(p.outlineWidth) || 0;
          if (!pw) continue;
          const box = el.getBoundingClientRect();
          const pwid = parseFloat(p.width) || 0; const phei = parseFloat(p.height) || 0;
          if (pwid + 0.5 < box.width || phei + 0.5 < box.height) continue;
          w = pw; color = p.outlineColor; kind = `outline${pseudo}`;
          break;
        }
      }
      const inside = kind === 'outline' ? off < 0 : false;
      const bg = this.bgOf(inside ? el : (el.parentElement || el));
      const c = this.parse(color);
      const ratio = c ? this.contrast(this.over(c, bg), bg) : 0;
      return { w, kind, off, color, ratio: Math.round(ratio * 100) / 100 };
    },
    // What the focused element looks like right now.
    stop() {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return { body: true };
      const r = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const dialog = el.closest('[role=dialog]');
      // Position in the page's own coordinates: undo the window's scroll and
      // every inner scroller's (a day strip that scrolled to show this).
      let sx = scrollX; let sy = scrollY;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { sx += a.scrollLeft; sy += a.scrollTop; }
      const out = {
        id: this.id(el), desc: this.desc(el), tag: el.tagName.toLowerCase(),
        top: r.top + sy, left: r.left + sx, bottom: r.bottom + sy, right: r.right + sx,
        vtop: r.top, vbottom: r.bottom, vleft: r.left, vright: r.right, w: r.width, h: r.height,
        bar: (el.closest('.app-header, .bottom-nav, .save-bar, .toast-host') || {}).className?.split?.(' ')[0] || null,
        dialog: dialog ? this.desc(dialog) : null, visible: this.visible(el), ring: this.ring(el), issues: [],
      };
      if (!out.visible) out.issues.push('focused element is not visible');
      if (out.ring.w < 2) out.issues.push(`focus ring ${out.ring.w}px (${out.ring.kind}) < 2px`);
      else if (out.ring.ratio < 3) out.issues.push(`focus ring contrast ${out.ring.ratio}:1 < 3:1`);
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) out.issues.push(`off screen at ${Math.round(r.left)},${Math.round(r.top)}`);
      // Inside a scroller that hides it?
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        const ar = a.getBoundingClientRect();
        const shown = Math.min(r.right, ar.right) - Math.max(r.left, ar.left);
        const shownY = Math.min(r.bottom, ar.bottom) - Math.max(r.top, ar.top);
        if (shown < Math.min(r.width, 8) || shownY < Math.min(r.height, 8)) { out.issues.push(`hidden inside its scroller ${this.desc(a)}`); break; }
      }
      // Behind a fixed bar (only with no dialog open: the page is under it then).
      if (!document.querySelector('.modal-overlay, .tour-layer')) {
        for (const b of document.querySelectorAll('.app-header, .bottom-nav, .save-bar')) {
          if (b.contains(el) || !this.visible(b)) continue;
          const pos = getComputedStyle(b).position;
          if (pos !== 'fixed' && pos !== 'sticky') continue;
          const br = b.getBoundingClientRect();
          const cover = Math.min(r.bottom, br.bottom) - Math.max(r.top, br.top);
          const coverX = Math.min(r.right, br.right) - Math.max(r.left, br.left);
          if (cover > 2 && coverX > 2) out.issues.push(`${Math.round(cover)}px of it behind ${b.className.split(' ')[0]}`);
        }
      }
      return out;
    },
    // Every control a keyboard should reach, on screen or scrolled away.
    focusables(root = document) {
      const sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), summary, iframe, [tabindex], [role=slider], [role=button], [role=switch], [role=checkbox], [role=tab]';
      const overlay = document.querySelector('.modal-overlay:last-of-type [role=dialog], .tour-card');
      const scope = overlay || root;
      return [...scope.querySelectorAll(sel)]
        .filter((el) => el.tabIndex >= 0 && !el.closest('[aria-hidden=true]') && this.visible(el))
        .filter((el) => overlay || !el.closest('.modal-overlay, .tour-layer'))
        .map((el) => ({ id: this.id(el), desc: this.desc(el) }));
    },
    // Things drawn as clickable (pointer cursor) that no key can reach.
    clickOnly() {
      const out = [];
      for (const el of document.querySelectorAll('.shell *, .modal-overlay *')) {
        if (!(el instanceof HTMLElement) || !this.visible(el)) continue;
        if (getComputedStyle(el).cursor !== 'pointer') continue;
        if (el.closest('a[href], button, input, select, textarea, label, summary, [tabindex], [role=slider]')) continue;
        if (el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer' && !el.parentElement.closest('a[href], button, label, summary, [tabindex]')) continue;
        out.push(this.desc(el));
      }
      return out;
    },
  };
  window.__a11y = K;
}

// window.__motion: every transition and animation that moves something
// (transform, position, size), with how long it runs.
export function motionRecorder() {
  const seen = [];
  window.__motion = seen;
  const MOVE = /^(transform|translate|scale|rotate|top|left|right|bottom|inset|width|height|margin|offset)/;
  const desc = (el) => (el && el.tagName ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')}` : '?');
  document.addEventListener('transitionrun', (e) => {
    const d = parseFloat(getComputedStyle(e.target).transitionDuration) * 1000;
    if (MOVE.test(e.propertyName)) seen.push({ kind: 'transition', prop: e.propertyName, el: desc(e.target), ms: d });
  }, true);
  const sample = () => {
    for (const a of document.getAnimations()) {
      const t = a.effect?.getComputedTiming?.();
      const kf = a.effect?.getKeyframes?.() || [];
      const props = new Set(kf.flatMap((k) => Object.keys(k)).filter((k) => !['offset', 'easing', 'composite', 'computedOffset'].includes(k)));
      if (a instanceof CSSTransition) props.add(a.transitionProperty);
      const moving = [...props].filter((p) => MOVE.test(p));
      if (moving.length && t && t.activeDuration > 20) seen.push({ kind: a.constructor.name, prop: moving.join(','), el: desc(a.effect?.target), ms: t.activeDuration, name: a.animationName || a.transitionProperty || '' });
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}

// Sideways scroll, clipped text and overlapping text (the parts of the old
// layout measure the zoom check uses). Returns [{ kind, sel, detail }].
export function zoomMeasure() {
  const out = [];
  const vw = document.documentElement.clientWidth;
  const desc = (el) => {
    if (!el || !el.tagName) return '';
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
    const txt = (el.getAttribute?.('aria-label') || el.textContent || el.value || el.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''}${txt ? ` "${txt}"` : ''}`;
  };
  const add = (kind, el, detail) => out.push({ kind, sel: desc(el), detail });
  const S = (el, p) => getComputedStyle(el, p);
  const rect = (el) => el.getBoundingClientRect();
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
    if (s.clipPath === 'inset(50%)' || (r.width <= 1 && r.height <= 1)) return false;
    return true;
  };
  const scopes = [document.querySelector('.shell') || document.body, ...document.querySelectorAll('.modal-overlay'), document.querySelector('.toast-host')].filter(Boolean);
  const overlayOpen = Boolean(document.querySelector('.modal-overlay'));
  const roots = overlayOpen ? [...document.querySelectorAll('.modal-overlay')] : scopes;
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

  // Sideways scroll.
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

  // Clipped text.
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
    const tapPseudo = ['::before', '::after'].some((p) => { const ps = S(el, p); return ps.content !== 'none' && ps.position === 'absolute'; });
    let textW = el.scrollWidth;
    if (tapPseudo) { const rg = document.createRange(); rg.selectNodeContents(el); textW = Math.ceil(rg.getBoundingClientRect().width + parseFloat(s.paddingLeft) + parseFloat(s.paddingRight)); }
    if (textW > el.clientWidth + 1 && el.clientWidth > 0 && hid && !hasFull(el)) add('clipped', el, `text cut: ${el.scrollWidth}px in ${el.clientWidth}px`);
    if (s.overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0 && !/^(auto|scroll)$/.test(s.overflowY)) add('clipped', el, `text cut vertically: ${el.scrollHeight}px in ${el.clientHeight}px`);
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const as = S(a);
      if (as.overflowX === 'visible' && as.overflowY === 'visible') continue;
      if (/^(auto|scroll)$/.test(as.overflowX) || /^(auto|scroll)$/.test(as.overflowY)) break;
      const ar = rect(a);
      if ((r.right > ar.right + 1 || r.bottom > ar.bottom + 1 || r.left < ar.left - 1 || r.top < ar.top - 1) && !hasFull(el)) add('clipped', el, `cut by ${desc(a)}`);
      break;
    }
  }

  // Overlapping text inside one card or row.
  const CONTAINERS = '.app-header, .list-row, .pick-card, .group-body, .tile, .lc-card, .lv-film, .tg-film, .modal-card, .theatre-item, .bar-row, .sheet-film, .sr-row, .recent-row, .rating-item, .search-row, .import-box, .hero-content, .toast, .bottom-nav, .big-stat, .key-row, .window-row, .rating-row, .st-row';
  for (const c of all.filter((e) => e.matches(CONTAINERS))) {
    const leaves = textyIn.filter((t) => c.contains(t) && !t.closest('.stars'));
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const a = leaves[i]; const b = leaves[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = clipRects(a); const rb = clipRects(b);
        const hit = ra.some((x) => rb.some((y) => Math.min(x.right, y.right) - Math.max(x.left, y.left) > 2 && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 3));
        if (hit) add('overlap', a, `overlaps ${desc(b)}`);
      }
    }
  }
  return out;
}

// Contrast of every text node under `sel` against what's painted behind it
// (for page.evaluate). Returns { n, bad }.
export function textContrast(sel) {
  const parse = (c) => {
    let m = c.match(/^rgba?\(([^)]+)\)/);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
    m = c.match(/^color\(srgb ([^)]+)\)/);
    if (m) { const p = m[1].split(/[ /]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1]; }
    return null;
  };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const bgOf = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    let out = parse(getComputedStyle(document.body).backgroundColor) || [255, 255, 255, 1];
    for (const l of layers.reverse()) out = over(l, out);
    return out;
  };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bad = [];
  let n = 0;
  for (const r of document.querySelectorAll(sel)) {
    const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!t.nodeValue.trim()) continue;
      const el = t.parentElement;
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (cs.visibility === 'hidden' || !box.width || !box.height || el.closest('[hidden], [aria-hidden="true"]')) continue;
      const fg = parse(cs.color);
      const bg = bgOf(el);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      const need = large ? 3 : 4.5;
      const got = ratio(over(fg, bg), bg);
      n++;
      if (got < need) bad.push(`${t.nodeValue.trim().slice(0, 24)} ${got.toFixed(2)} (${cs.color} on ${bg.map(Math.round)})`);
    }
  }
  return { n, bad };
}

// Every visible control inside `sel` and its size (for page.evaluate).
export function controlSizes(sel) {
  return [...document.querySelectorAll(sel)].flatMap((root) => [...root.querySelectorAll('a[href], button, [role="slider"], [tabindex="0"]'), ...(root.matches('a[href], button') ? [root] : [])])
    .filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.height && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[hidden]'); })
    .map((e) => { const b = e.getBoundingClientRect(); return { what: `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} "${(e.getAttribute('aria-label') || e.textContent).trim().slice(0, 30)}"`, w: Math.round(b.width), h: Math.round(b.height), name: (e.getAttribute('aria-label') || e.textContent || '').trim() }; });
}
