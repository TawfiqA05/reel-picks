// In-page probes the design suite (test/ui/design.mjs) runs on its screens,
// shared so other suites can hold what they add to the same rules (the year
// in movies cards, test/ui/year.mjs): one button system, no outlined boxes,
// plain sentence-case wording, palette colours only. Each browser-side probe
// takes the VISIBLE test (browser.mjs) as a string, as page.evaluate needs.

export function buttonsProbe(vis) {
  const visible = eval(vis);
  const S2 = (e) => getComputedStyle(e);
  const tok = (n) => { const t = document.createElement('span'); t.style.color = `var(--${n})`; document.body.appendChild(t); const c = S2(t).color; t.remove(); return c; };
  const bg = (n) => { const t = document.createElement('span'); t.style.backgroundColor = `var(--${n})`; document.body.appendChild(t); const c = S2(t).backgroundColor; t.remove(); return c; };
  const T = { accent: bg('accent'), onAccent: tok('on-accent'), soft: bg('accent-soft'), accentText: tok('accent-text'), badSoft: bg('bad-soft'), bad: tok('bad'), gold: tok('gold') };
  const out = { bad: [], n: 0 };
  const d = (e) => `${e.tagName.toLowerCase()}.${String(e.className).trim().split(/\s+/).join('.')} "${(e.getAttribute('aria-label') || e.textContent).trim().slice(0, 24)}"`;
  const radius = (e) => S2(e).borderTopLeftRadius;
  for (const e of [...document.querySelectorAll('.btn, .icon-btn, .chip, .day-btn, .cal-btn, .modal-x')].filter(visible)) {
    out.n++;
    if (radius(e) !== '12px') out.bad.push(`radius ${radius(e)}: ${d(e)}`);
    for (const k of e.querySelectorAll('.tag, .match, .badge')) out.bad.push(`a pill inside a button: ${d(e)} holds ${d(k)}`);
  }
  for (const e of [...document.querySelectorAll('.icon-btn')].filter(visible)) { const r = e.getBoundingClientRect(); if (Math.round(r.width) !== 44 || Math.round(r.height) !== 44) out.bad.push(`icon button ${Math.round(r.width)}x${Math.round(r.height)}: ${d(e)}`); }
  for (const e of [...document.querySelectorAll('button, a.btn, a.icon-btn, .chip')].filter(visible)) if (/50%|9999px|999px/.test(radius(e)) && !e.matches('.seg-item, .nav-item')) out.bad.push(`round control: ${d(e)}`);
  const is = (e, fill, text) => S2(e).backgroundColor === fill && (!text || S2(e).color === text);
  for (const e of [...document.querySelectorAll('.btn.book:not([aria-disabled="true"]), .btn:not(.soft):not(.danger):not(:disabled)')].filter(visible)) if (!is(e, T.accent, T.onAccent)) out.bad.push(`main action not filled accent: ${d(e)} ${S2(e).backgroundColor}`);
  for (const e of [...document.querySelectorAll('.btn.soft:not(.wl-btn.active):not(:disabled), .icon-btn.soft:not(.wl-btn.active)')].filter(visible)) if (!is(e, T.soft, T.accentText)) out.bad.push(`secondary not soft accent: ${d(e)} ${S2(e).backgroundColor} / ${S2(e).color}`);
  for (const e of [...document.querySelectorAll('.btn.danger:not(:disabled), .icon-btn.danger:not(:disabled)')].filter(visible)) if (!is(e, T.badSoft, T.bad)) out.bad.push(`remove/hide not soft red: ${d(e)}`);
  for (const e of [...document.querySelectorAll('.not-for-me, [aria-label^="Revoke"], [aria-label^="Stop following"], [aria-label*="from your watch log"], .ri-remove')].filter(visible)) if (!e.matches('.danger')) out.bad.push(`remove/revoke/Not for me isn't a soft red control: ${d(e)}`);
  for (const e of [...document.querySelectorAll('.wl-btn.active')].filter(visible)) if (S2(e).color !== T.gold) out.bad.push(`saved bookmark not gold: ${d(e)} ${S2(e).color}`);
  for (const e of [...document.querySelectorAll('.stars-fill')].filter(visible)) if (S2(e).color !== T.gold) out.bad.push(`filled stars not gold: ${S2(e).color}`);
  for (const e of [...document.querySelectorAll('.day-btn')].filter(visible)) {
    const on = e.classList.contains('active');
    if (on && S2(e).backgroundColor !== T.accent) out.bad.push(`chosen day not filled accent: ${d(e)}`);
    if (!on && S2(e).backgroundColor === T.accent) out.bad.push(`an unchosen day is filled: ${d(e)}`);
  }
  for (const e of [...document.querySelectorAll('.chip.active')].filter(visible)) if (S2(e).backgroundColor !== T.accent) out.bad.push(`picked choice not filled accent: ${d(e)}`);
  for (const e of [...document.querySelectorAll('.tag.accent, .tag.watch, .match')].filter(visible)) if (S2(e).backgroundColor !== T.soft) out.bad.push(`positive tag not soft accent: ${d(e)}`);
  for (const e of [...document.querySelectorAll('.tag, .match')].filter(visible)) if ((S2(e).borderTopStyle !== 'none' && parseFloat(S2(e).borderTopWidth) > 0) || /inset/.test(S2(e).boxShadow)) out.bad.push(`outlined tag: ${d(e)}`);
  for (const e of [...document.querySelectorAll('.status-dot, .key-dot')].filter(visible)) {
    if (!(e.parentElement.textContent || '').trim()) out.bad.push(`status dot with no word: ${d(e.parentElement)}`);
    const want = e.matches('.ok, .on') ? tok('good') : e.matches('.bad, .off') ? tok('bad') : e.matches('.warn') ? tok('warn') : null;
    if (want && S2(e).backgroundColor !== want) out.bad.push(`status dot colour ${S2(e).backgroundColor}: ${d(e.parentElement)}`);
  }
  return out;
}

export function outlined(vis) {
  const v = eval(vis); const S2 = (e) => getComputedStyle(e); const out = [];
  for (const e of document.querySelectorAll('#main *, .modal-card *')) {
    if (!v(e) || e.matches('input, textarea, select, .input, iframe')) continue;
    const s = S2(e);
    const sides = ['Top', 'Right', 'Bottom', 'Left'].filter((k) => parseFloat(s[`border${k}Width`]) > 0 && s[`border${k}Style`] !== 'none' && !/rgba\(0, 0, 0, 0\)|transparent/.test(s[`border${k}Color`]));
    if (sides.length === 4) out.push(`${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}`);
    if (/inset 0px 0px 0px 1px/.test(s.boxShadow)) out.push(`${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} (ring)`);
  }
  return [...new Set(out)];
}

export const BUZZ = /\b(seamless(ly)?|effortless(ly)?|unlock (your|the power)|elevate|curated|delve|leverage|game[- ]changer|supercharge|AI[- ]powered|harness the|revolutioni[sz]e|cutting[- ]edge)\b|✨/i;
export function wordScan(vis) {
  const v = eval(vis); const S2 = (e) => getComputedStyle(e);
  const out = { caps: [], reasons: [], seats: [], matches: [], wsw: null };
  for (const e of document.querySelectorAll('body *')) {
    if (!v(e)) continue;
    const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (!own) continue;
    const s = S2(e);
    if (s.textTransform === 'uppercase' || (parseFloat(s.letterSpacing) > 0.5 && /[A-Z]{3}/.test(own))) out.caps.push(`${e.className} "${own.slice(0, 30)}"`);
  }
  for (const e of document.querySelectorAll('.reason-line')) if (v(e)) out.reasons.push({ text: e.textContent, scores: [...e.querySelectorAll('.rs-score')].map((x) => ({ t: x.textContent, cls: x.className })) });
  for (const e of document.querySelectorAll('.seat-line > span')) if (v(e)) out.seats.push(e.textContent);
  for (const e of document.querySelectorAll('.match')) if (v(e)) out.matches.push(e.textContent);
  const wsw = document.querySelector('#wsw-btn .icon, .search-wsw .icon');
  if (wsw) out.wsw = wsw.innerHTML;
  out.body = document.body.innerText;
  return out;
}
// guest: the guest link's scores are public scores ("Reviews 88"), not a match.
export function wordProblems(r, { guest = false } = {}) {
  const bad = [];
  for (const c of r.caps) bad.push(`capitals or tracked label: ${c}`);
  const body = r.body;
  if (/—/.test(body)) bad.push(`an em dash on screen: …${body.slice(Math.max(0, body.indexOf('—') - 40), body.indexOf('—') + 20).replace(/\n/g, ' ')}…`);
  const th = body.match(/[^\n]{0,30}\btheatres?\b[^\n]{0,20}/i);
  if (th) bad.push(`"theatre" on screen: ${th[0]}`);
  const bz = body.match(BUZZ); if (bz) bad.push(`buzzword "${bz[0]}"`);
  if (/Through at least/i.test(body)) bad.push('"Through at least" is still on screen');
  const oldW = body.match(/\bNO\. \d|\bMATCH\b|BACK IN THEATERS|ON WATCHLIST|IMAX available|watchlisted|Be in your seat|be there by/);
  if (oldW) bad.push(`old wording on screen: ${oldW[0]}`);
  const MATCH = guest ? /^Reviews \d+$|^No reviews yet$/ : /^\d+% match( ?early)?$|^No match yet$/;
  for (const m of r.matches) if (!MATCH.test(m.trim())) bad.push(`match reads "${m}"`);
  for (const s of r.seats) if (!/^Seat by \d{1,2}:\d\d [AP]M · out around \d{1,2}:\d\d [AP]M$|^(Seat by|Out around) \d{1,2}:\d\d [AP]M$/.test(s)) bad.push(`seat line "${s}"`);
  for (const x of r.reasons) {
    const t = x.text.trim();
    if (!/^[A-Z#0-9]/.test(t)) bad.push(`reason starts lowercase: "${t}"`);
    if (/\+/.test(t)) bad.push(`reason has a +: "${t}"`);
    if (t.split(' · ').length > 2) bad.push(`more than two reasons: "${t}"`);
    if (/watchlist|IMAX|no public scores/i.test(t)) bad.push(`reason repeats a tag: "${t}"`);
    for (const sc of x.scores) {
      const [src, raw] = sc.t.split(' '); const v = parseFloat(raw);
      const pct = /RT|Metacritic/.test(src); const n = pct ? v : v * 10;
      const want = n >= (pct ? 75 : 70) ? 'good' : n < 60 ? 'bad' : '';
      const got = /\bgood\b/.test(sc.cls) ? 'good' : /\bbad\b/.test(sc.cls) ? 'bad' : '';
      if (want !== got) bad.push(`${sc.t} coloured "${got || 'plain'}", should be "${want || 'plain'}"`);
    }
  }
  if (r.wsw != null && !/M3 8\.5V6\.5/.test(r.wsw)) bad.push('What should I watch? doesn\'t use the ticket icon');
  return bad;
}

export function paintedColours() {
  const out = [];
  const add = (c, el, what) => { if (!c || /rgba\(0, 0, 0, 0\)|transparent/.test(c)) return; out.push({ c, what, el: `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}` }); };
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
    const s = getComputedStyle(el); if (s.visibility === 'hidden' || s.display === 'none') continue;
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) add(s.color, el, 'text');
    if (!el.matches('input[type=checkbox], input[type=radio], input[type=range], input[type=file]')) add(s.backgroundColor, el, 'fill');
    if (parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none') add(s.borderTopColor, el, 'border');
  }
  return out;
}
export function paletteNow() {
  const names = ['--bg', '--raised', '--chip', '--tabbar', '--divider', '--text', '--muted', '--accent', '--on-accent', '--accent-text', '--accent-soft', '--gold', '--good', '--warn', '--bad', '--bad-soft', '--field-edge', '--focus', '--blue', '--blue-soft', '--purple', '--purple-soft', '--teal', '--teal-soft', '--amber', '--amber-soft'];
  const tmp = document.createElement('span'); document.body.appendChild(tmp);
  const out = names.map((n) => { tmp.style.color = `var(${n})`; return getComputedStyle(tmp).color; });
  tmp.remove(); return out;
}
export const rgba = (c) => { const m = c.match(/[\d.]+/g).map(Number); if (/^color\(srgb/.test(c)) return { r: m[0] * 255, g: m[1] * 255, b: m[2] * 255, a: m.length > 3 ? m[3] : 1 }; return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
export function inPalette(c, pal, surfaces) {
  const x = rgba(c);
  for (const p of pal) {
    const y = rgba(p);
    if (Math.abs(x.r - y.r) + Math.abs(x.g - y.g) + Math.abs(x.b - y.b) <= 6 && Math.abs(x.a - y.a) < 0.05) return true;
    for (const sfc of surfaces) {
      const z = rgba(sfc);
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const m = { r: z.r + (y.r - z.r) * t, g: z.g + (y.g - z.g) * t, b: z.b + (y.b - z.b) * t };
        if (Math.abs(x.r - m.r) + Math.abs(x.g - m.g) + Math.abs(x.b - m.b) <= 8 && x.a > 0.95) return true;
      }
      if (x.a < 0.95 && Math.abs(x.r - y.r) + Math.abs(x.g - y.g) + Math.abs(x.b - y.b) <= 8) return true;
    }
  }
  return false;
}
