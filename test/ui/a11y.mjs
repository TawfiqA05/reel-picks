// Accessibility (old G12, real-app G18, R12, person search S11 and S16). For
// the owner, the 700-rating friend, the empty friend, a brand-new friend in
// the welcome setup and the guest, in Ticket stub (light) and Midnight
// marquee (dark), at 1280 and 390:
//   keyboard: Tab reaches every control in visual order, with a visible 2px,
//   3:1 focus ring, never hidden behind the header, tab bar or Save bar;
//   dialogs trap Tab, close on Escape and hand focus back to their trigger;
//   "/" opens search; every control, image and dialog has an accessible name;
//   one h1 per page; toasts are announced and their Undo can be reached;
//   reduced motion runs no movement; 200% zoom at 390 (a 195 CSS px wide
//   page) has no sideways scroll, clipped or overlapping text;
//   the person row and page (S11): names, headings, the Directed / Acted
//   switch, stars and Save by keyboard, 44px targets, AA text in both themes.
// Each detector is first proved against a planted problem (self-test).
import { suite } from '../lib/check.mjs';
import { openWorld, GUEST } from '../lib/world.mjs';
import { launch, open, settle } from '../lib/browser.mjs';
import { kit, motionRecorder, zoomMeasure, textContrast, controlSizes } from '../lib/a11y-helpers.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('a11y');

// ---------------------------------------------------------------- world
// A made-up person who both directed and acted (so the person page has the
// Directed / Acted switch), stored the way TMDB answers are cached. The owner
// rated two of the films they directed, so You rated shows too.
const PERSON = { id: 50099, name: 'Wren Halvorsen' };
const credit = (id, extra) => ({ ...C.light(C.film(id)), ...extra });
const personCredits = {
  id: PERSON.id,
  crew: [980005, 980007, 950002, 950004].map((id) => credit(id, { job: 'Director', department: 'Directing', credit_id: `w${id}d` })),
  cast: [990003, 950010, 950012].map((id, i) => credit(id, { character: `Role ${i + 1}`, order: i, credit_id: `w${id}a` })),
};
const personRecord = { id: PERSON.id, name: PERSON.name, known_for_department: 'Directing', profile_path: `/rp-p-${PERSON.id}.jpg`, biography: 'A made-up person for the tests.', popularity: 30, adult: false };

const w = S.world(await openWorld('a11y', {
  prepare(d) {
    const at = new Date(C.T0_MS - 3600e3).toISOString();
    const put = d.prepare('INSERT OR REPLACE INTO cache(key, value, fetched_at, ttl) VALUES(?, ?, ?, ?)');
    put.run(`tmdb:person:${PERSON.id}`, JSON.stringify(personRecord), at, 7 * 86400);
    put.run(`tmdb:person:${PERSON.id}:movie_credits`, JSON.stringify(personCredits), at, 7 * 86400);
  },
}));
const ROLES = { owner: 'owner', heavy: w.friends.robin, empty: w.friends.casey, newbie: w.friends.jordan, guest: 'guest' };
const MOVIE = 990001; // has a trailer
await w.api('PUT', '/api/settings', { as: w.friends.robin, body: { watchTogether: true } });
const inv = await w.api('POST', '/api/friends', { body: { name: 'Invitee' } });
const invitePath = inv.json?.invite || '/?invite=missing';

// ---------------------------------------------------------------- results
// Each named check collects problems while the parts run; all are reported
// at the end, so parts can run side by side.
const buckets = new Map();
const want = (name) => { if (!buckets.has(name)) buckets.set(name, []); return buckets.get(name); };
const fail = (name, msg) => want(name).push(msg);

// Waits (up to 2s) for focus to settle after a key: off the page body and the
// dialog's wrap-around stop, the player ringed, and the element scrolled into
// view in the window and in its scroller. A stop that never gets there is
// still sampled and reported.
async function settleFocus(p) {
  await p.waitForFunction(() => {
    const a = document.activeElement;
    if (!a || a === document.body || a.classList.contains('focus-wrap')) return false;
    if (a.tagName === 'IFRAME' && !a.classList.contains('kb-focus')) return false;
    const r = a.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    for (let e = a.parentElement; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth)) {
        const b = e.getBoundingClientRect();
        if (r.bottom <= b.top || r.top >= b.bottom) return false;
      }
    }
    return true;
  }, null, { timeout: 2000 }).catch(() => {});
}

// ---------------------------------------------------------------- pages
async function page(browser, role, opts = {}) {
  const p = await open(browser, w, { role: ROLES[role], ...opts, allow403: role === 'guest' });
  await p.ctx.addInitScript(kit);
  if (opts.reducedMotion === 'reduce' || opts.record) await p.ctx.addInitScript(motionRecorder);
  // A stand-in trailer player with two controls, like YouTube's own, so
  // focus behaves as it would in the real frame.
  await p.ctx.route(/youtube-nocookie\.com\/embed/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>player</title><button>Play</button><button>Full screen</button>' }));
  return p;
}

async function go(p, hash) {
  if (p.url().startsWith(w.base) && p.url().includes('#')) await p.evaluate((hh) => { location.hash = hh; }, hash);
  else await p.goto(`${w.base}/${hash}`);
  await settle(p);
  // At home and other late sections fill in after the page.
  await p.waitForFunction(() => !document.querySelector('.home-status, .sk-card'), null, { timeout: 8000 }).catch(() => {});
  await p.evaluate(() => window.scrollTo(0, 0));
}

// ---------------------------------------------------------------- measuring
async function tabWalk(p, { max = 700 } = {}) {
  await p.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
  await p.evaluate(() => { const b = document.body; b.setAttribute('tabindex', '-1'); b.focus(); b.removeAttribute('tabindex'); });
  const stops = [];
  const seen = new Set();
  let ended = 'max';
  for (let i = 0; i < max; i++) {
    await p.keyboard.press('Tab');
    await settleFocus(p);
    const s = await p.evaluate(() => window.__a11y.stop());
    if (s.body) {
      if (stops.length) { ended = 'left the page'; break; }
      if (i >= 4) { ended = 'nothing to focus'; break; }
      continue;
    }
    // The same element again straight away: Tab moving inside it (a time
    // field's parts, a frame's own controls).
    if (stops.length && s.id === stops[stops.length - 1].id) continue;
    if (seen.has(s.id)) {
      if (stops.length > 1 && s.id === stops[0].id) { ended = 'wrapped'; break; }
      stops.push({ ...s, repeat: true });
      if (stops.filter((x) => x.repeat).length > 3) { ended = 'trapped'; break; }
      continue;
    }
    seen.add(s.id);
    stops.push(s);
  }
  const all = await p.evaluate(() => window.__a11y.focusables());
  const missed = all.filter((f) => !seen.has(f.id));
  const clickOnly = await p.evaluate(() => window.__a11y.clickOnly());
  return { stops, missed, clickOnly, ended };
}

// Visual order: the next stop never jumps back up in the same column, and
// never back to the left on the same line. Fixed bars are their own group.
function orderProblems(stops) {
  const out = [];
  const flow = stops.filter((s) => !s.bar && !s.repeat);
  for (let i = 1; i < flow.length; i++) {
    const a = flow[i - 1];
    const b = flow[i];
    const sameCol = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 4;
    const above = b.bottom <= a.top - 4;
    const sameLine = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > Math.min(a.h, b.h) * 0.5;
    if (above && sameCol) out.push(`${b.desc} comes after ${a.desc} but sits ${Math.round(a.top - b.bottom)}px above it`);
    else if (sameLine && b.right <= a.left - 4) out.push(`${b.desc} comes after ${a.desc} but sits to its left on the same line`);
  }
  for (const bar of new Set(stops.filter((s) => s.bar).map((s) => s.bar))) {
    const bs = stops.filter((s) => s.bar === bar && !s.repeat);
    for (let i = 1; i < bs.length; i++) if (bs[i].vright <= bs[i - 1].vleft - 4 && Math.abs(bs[i].vtop - bs[i - 1].vtop) < 20) out.push(`${bar}: ${bs[i].desc} after ${bs[i - 1].desc} but to its left`);
  }
  return out;
}

// Accessibility tree: names for every control, image and dialog; headings.
const NAMED = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'switch', 'radio', 'slider', 'spinbutton', 'tab', 'option', 'menuitem', 'listbox', 'image', 'img', 'dialog', 'alertdialog', 'progressbar', 'meter', 'Iframe']);
async function axScan(p) {
  const cdp = await p.context().newCDPSession(p);
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const where = async (n) => {
    if (!n.backendDOMNodeId) return n.role?.value;
    try {
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: n.backendDOMNodeId });
      const r = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(){ return window.__a11y.desc(this.nodeType === 1 ? this : this.parentElement); }', returnByValue: true });
      return r.result.value;
    } catch { return n.role?.value; }
  };
  const unnamed = []; const glyphs = []; const headings = []; const dialogs = [];
  const prop = (n, k) => n.properties?.find((q) => q.name === k)?.value?.value;
  for (const n of nodes) {
    if (n.ignored) continue;
    const role = n.role?.value;
    const name = (n.name?.value || '').trim();
    if (NAMED.has(role) && !/[\p{L}\p{N}]/u.test(name)) unnamed.push({ role, name, where: await where(n) });
    if (role === 'StaticText' && /^[★☆\s]+$/.test(name)) {
      let inControl = false;
      for (let q = byId.get(n.parentId); q; q = byId.get(q.parentId)) if (['button', 'link', 'option', 'slider', 'tab', 'menuitem'].includes(q.role?.value)) { inControl = true; break; }
      if (!inControl) glyphs.push(await where(byId.get(n.parentId) || n));
    }
    if (role === 'dialog' || role === 'alertdialog') dialogs.push({ name, modal: prop(n, 'modal') === true, where: await where(n) });
  }
  // Headings in reading order: the flat node list CDP returns is not in
  // document order, so walk the tree from its root.
  const visit = (n) => {
    if (!n) return;
    if (!n.ignored && n.role?.value === 'heading') headings.push({ level: prop(n, 'level'), name: (n.name?.value || '').trim().slice(0, 40) });
    for (const c of n.childIds || []) visit(byId.get(c));
  };
  visit(nodes.find((n) => !n.parentId) || nodes[0]);
  await cdp.detach();
  return { unnamed, glyphs: [...new Set(glyphs)], headings, dialogs };
}

// One screen, walked and scanned; problems land in the walk's checks.
async function walkScreen(p, L, screen, { dialogOK = false } = {}) {
  const at = `${screen}`;
  const r = await tabWalk(p);
  const ax = await axScan(p);
  want(`${L}: Tab reaches every control and gets back out`);
  want(`${L}: every focus stop shows a 2px 3:1 ring, on screen, not behind a bar`);
  want(`${L}: Tab order follows the visual order`);
  want(`${L}: every control, image and dialog has an accessible name`);
  want(`${L}: one h1 per page, no skipped heading level`);
  want(`${L}: no live region holds a block of controls`);
  if (r.ended === 'trapped' || r.ended === 'max') fail(`${L}: Tab reaches every control and gets back out`, `${at}: Tab never gets back out (${r.ended}; last ${r.stops.slice(-3).map((s) => s.desc).join(', ')})`);
  for (const m of r.missed) fail(`${L}: Tab reaches every control and gets back out`, `${at}: ${m.desc} is never reached with Tab`);
  for (const c of r.clickOnly) fail(`${L}: Tab reaches every control and gets back out`, `${at}: ${c} looks clickable but no key reaches it`);
  for (const s of r.stops) for (const i of s.issues) fail(`${L}: every focus stop shows a 2px 3:1 ring, on screen, not behind a bar`, `${at}: ${s.desc}: ${i}`);
  for (const o of orderProblems(r.stops)) fail(`${L}: Tab order follows the visual order`, `${at}: ${o}`);
  for (const u of ax.unnamed) fail(`${L}: every control, image and dialog has an accessible name`, `${at}: ${u.role} ${u.where} has no name ("${u.name}")`);
  for (const g of ax.glyphs) fail(`${L}: every control, image and dialog has an accessible name`, `${at}: ${g} reads out star glyphs with no value`);
  for (const d of ax.dialogs) if (!d.name || !d.modal) fail(`${L}: every control, image and dialog has an accessible name`, `${at}: dialog ${d.where}: name "${d.name}", modal ${d.modal}`);
  const h1 = ax.headings.filter((x) => x.level === 1).length;
  if (h1 !== 1 && !dialogOK) fail(`${L}: one h1 per page, no skipped heading level`, `${at}: ${h1} h1 headings: ${ax.headings.slice(0, 4).map((x) => `h${x.level} "${x.name}"`).join(', ')}`);
  let prev = 0;
  for (const hh of ax.headings) {
    if (prev && hh.level > prev + 1) { fail(`${L}: one h1 per page, no skipped heading level`, `${at}: h${hh.level} "${hh.name}" follows h${prev}`); break; }
    prev = hh.level;
  }
  const loud = await p.evaluate(() => [...document.querySelectorAll('[aria-live]:not([aria-live=off]), [role=status], [role=alert], [role=log]')]
    .filter((x) => !x.closest('.toast-host') && window.__a11y.visible(x))
    .map((x) => ({ desc: window.__a11y.desc(x), controls: x.querySelectorAll('a[href], button, input, [role=slider]').length }))
    .filter((x) => x.controls > 2));
  for (const l of loud) fail(`${L}: no live region holds a block of controls`, `${at}: ${l.desc.slice(0, 60)} holds ${l.controls} controls`);
  // Only the current tab and segment say so (aria-current="page").
  const cur = await p.evaluate(() => {
    if (!document.querySelector('.shell #main')) return null;
    const route = location.hash.replace(/^#\/?/, '').split('/');
    const pick = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.getAttribute('aria-current') === 'page').map((e) => e.dataset.name || e.dataset.seg);
    return { route, seg: pick('.seg-item'), nav: pick('.nav-item'), sched: pick('.segment[data-seg]'), schedAny: document.querySelectorAll('.segment[data-seg]').length, youSeg: Boolean(document.querySelector('.you-seg')) };
  });
  if (cur) {
    const name = `${L}: only the current tab and segment are marked current`;
    want(name);
    const YOU = ['you', 'stats', 'together', 'settings', 'help'];
    const tab = ['home', 'schedule', 'rate', 'watchlist'].includes(cur.route[0]) ? cur.route[0] : YOU.includes(cur.route[0]) ? 'you' : null;
    for (const k of ['seg', 'nav']) if (JSON.stringify(cur[k]) !== JSON.stringify(tab ? [tab] : [])) fail(name, `${at}: ${k} tabs marked current ${JSON.stringify(cur[k])}, want ${JSON.stringify(tab ? [tab] : [])}`);
    const wantSeg = cur.youSeg ? (cur.route[0] === 'you' ? null : cur.route[0]) : cur.route[1];
    if (cur.schedAny && (cur.sched.length !== 1 || (wantSeg && cur.sched[0] !== wantSeg))) fail(name, `${at}: segments marked current ${JSON.stringify(cur.sched)}, want ["${wantSeg}"]`);
  }
  return r;
}

// ---------------------------------------------------------------- 0. self-test
async function selfTest(browser) {
  const name = 'self-test: every detector fires on a planted problem';
  want(name);
  if (orderProblems([{ desc: 'a', top: 500, bottom: 540, left: 10, right: 100, h: 40, bar: null }, { desc: 'b', top: 100, bottom: 140, left: 10, right: 100, h: 40, bar: null }]).length !== 1) fail(name, 'the tab-order check misses a stop that jumps back up the same column');
  const { ctx, page: p } = await page(browser, 'owner', { width: 390 });
  try {
    await go(p, '#/watchlist');
    const r = await p.evaluate(() => {
      const K = window.__a11y;
      const out = {};
      const b1 = document.createElement('button'); b1.textContent = 'planted'; b1.style.cssText = 'outline: none !important';
      document.querySelector('#main').prepend(b1); b1.focus(); out.noRing = K.stop().issues.join('; ');
      b1.style.cssText = 'outline: 2px solid rgb(0,0,0,0.02) !important; outline-offset: 2px'; out.faint = K.stop().issues.join('; ');
      const st = document.createElement('style'); st.textContent = '#planted-p { position: relative; outline: none !important } #planted-p::after { content: ""; position: absolute; inset: -4px; outline: 2px solid currentColor } #planted-q { outline: none !important } #planted-q::after { content: ""; display: inline-block; width: 2px; height: 2px; outline: 2px solid currentColor }';
      document.head.appendChild(st);
      b1.style.cssText = 'outline: none'; b1.id = 'planted-p'; b1.focus(); out.pseudo = K.stop().issues.join('; ');
      b1.id = 'planted-q'; b1.focus(); out.tinyPseudo = K.stop().issues.join('; ');
      b1.id = ''; st.remove();
      b1.style.cssText = 'position: fixed; top: 10px; left: 120px; z-index: 1'; b1.focus(); out.behind = K.stop().issues.join('; ');
      b1.remove();
      const d = document.createElement('div'); d.style.cssText = 'cursor: pointer'; d.textContent = 'click me'; document.querySelector('#main').prepend(d);
      out.clickOnly = K.clickOnly().join('; '); d.remove();
      return out;
    });
    if (!/ring 0px/.test(r.noRing)) fail(name, `a button with no focus ring is not flagged (${r.noRing})`);
    if (/ring/.test(r.pseudo)) fail(name, `a ring drawn by ::after around the control is not counted (${r.pseudo})`);
    if (!/ring 0px/.test(r.tinyPseudo)) fail(name, `a tiny ::after outline is taken for a focus ring (${r.tinyPseudo})`);
    if (!/contrast/.test(r.faint)) fail(name, `a ring the colour of the page is not flagged (${r.faint})`);
    if (!/behind app-header/.test(r.behind)) fail(name, `a button under the header is not flagged (${r.behind})`);
    if (!/click me/.test(r.clickOnly)) fail(name, 'a pointer-cursor div no key reaches is not flagged');
    await p.evaluate(() => { const i = document.createElement('button'); i.innerHTML = '<svg aria-hidden="true" width="10" height="10"></svg>'; i.id = 'planted-unnamed'; document.querySelector('#main').prepend(i); });
    const ax = await axScan(p);
    if (!ax.unnamed.some((u) => /planted-unnamed/.test(u.where))) fail(name, 'an icon-only button with no name is not flagged');
    await p.evaluate(() => { const wide = document.createElement('div'); wide.id = 'planted-wide'; wide.style.cssText = 'width: 2000px; height: 4px'; document.querySelector('#main').append(wide); });
    const z = (await p.evaluate(zoomMeasure)).some((f) => f.kind === 'sideways');
    await p.evaluate(() => document.getElementById('planted-wide')?.remove());
    if (!z) fail(name, 'the zoom check misses a 2000px wide block');
  } finally { await ctx.close(); }
}

// ---------------------------------------------------------------- 1. walks
const THEMES = ['light', 'dark'];
function screensFor(role) {
  const common = ['#/home', '#/schedule/leaving', '#/schedule/coming', `#/movie/${MOVIE}`, `#/person/${PERSON.id}`];
  if (role === 'guest') return common;
  if (role === 'newbie') return ['#/welcome'];
  return [...common, '#/rate', '#/watchlist', '#/together', '#/stats', '#/settings', '#/help', '#/no-such-page'];
}
const walkErrors = [];

async function walk(browser, { role, theme, width }) {
  const L = `walk ${role} ${theme} ${width}`;
  const { ctx, page: p, errors } = await page(browser, role, { width, theme });
  try {
    await go(p, '#/home');
    for (const hash of screensFor(role)) {
      await go(p, hash);
      const screen = hash.replace(/\/\d+$/, '/<id>');
      await walkScreen(p, L, screen);
      if (role === 'newbie') {
        // The welcome setup's later steps (Next moves on without saving).
        const name = `${L}: each welcome step moves focus to its heading`;
        want(name);
        for (let step = 2; step <= 3; step++) {
          const next = p.locator('.welcome-card .wc-foot button:not([disabled]):not([hidden])', { hasText: /^(Next|Skip this step)$/ }).first();
          if (!(await next.count())) { fail(name, `no Next button for step ${step}`); break; }
          await next.focus();
          await p.keyboard.press('Enter');
          await p.waitForTimeout(500);
          await p.waitForFunction(() => !document.querySelector('.welcome-card .spinner'), null, { timeout: 15000 }).catch(() => {});
          const f = await p.evaluate(() => ({ tag: document.activeElement.tagName, txt: document.activeElement.textContent.slice(0, 40) }));
          if (f.tag !== 'H2') fail(name, `step ${step}: focus is on ${f.tag} "${f.txt}", not the step's heading`);
          await walkScreen(p, L, `#/welcome step ${step}`);
        }
      }
    }
    if (role === 'guest') {
      // The Join page an invite link opens, and the expired-invite page.
      await p.goto(w.base + invitePath);
      await p.waitForLoadState('load');
      await walkScreen(p, L, 'join page');
      await p.goto(`${w.base}/?invite=not-a-real-token`);
      await p.waitForLoadState('load');
      await walkScreen(p, L, 'expired-invite page');
    }
  } catch (e) {
    fail(`${L}: Tab reaches every control and gets back out`, `crashed: ${e.message.split('\n')[0]}`);
  } finally {
    // The expired page answers 410 on purpose.
    walkErrors.push(...errors.filter((e) => !(/410/.test(e) && /invite=not-a-real-token/.test(e))));
    await ctx.close();
  }
}

// ---------------------------------------------------------------- 2. dialogs
// Opens a dialog from `trigger` with the keyboard, then: focus lands inside,
// it is a labelled modal dialog, Tab and Shift+Tab stay inside, every stop
// shows its ring, Escape closes it and focus is back on the trigger.
async function dialogCheck(p, name, trigger, { key = 'Enter', expectInput = false, tabs = 20, sel = '[role=dialog]', sameAs = null } = {}) {
  want(name);
  const bad = (m) => fail(name, m);
  const t = typeof trigger === 'string' ? p.locator(trigger).first() : trigger;
  if (!(await t.count())) { bad(`trigger ${trigger} not found`); return; }
  await p.keyboard.press('Shift'); // keyboard modality, so :focus-visible applies
  await t.focus();
  await p.evaluate(() => { window.__trig = document.activeElement; });
  await p.keyboard.press(key);
  const dlg = p.locator(sel).last();
  try { await dlg.waitFor({ state: 'visible', timeout: 5000 }); } catch { bad('no dialog opened'); return; }
  await p.waitForTimeout(350);
  // Some sheets open at once and fill in on their own (Stats: the films you
  // rated, then more films, stream lines and a filter box on top). The walk
  // starts once nothing is loading and the sheet has stopped growing.
  await p.waitForFunction((q) => {
    const d = [...document.querySelectorAll(q)].pop();
    if (!d) return true;
    const loading = d.querySelector('.spinner') || [...d.querySelectorAll('.sheet-status')].some((s) => !s.hidden && /Loading|Checking/.test(s.textContent));
    const hgt = d.scrollHeight;
    const same = window.__dlgH === hgt;
    window.__dlgH = hgt;
    return !loading && same;
  }, sel, { timeout: 8000, polling: 400 }).catch(() => {});
  const info = await p.evaluate((s) => {
    const d = [...document.querySelectorAll(s)].pop();
    const lab = d.getAttribute('aria-label') || document.getElementById(d.getAttribute('aria-labelledby') || '')?.textContent || '';
    return { inside: d.contains(document.activeElement), active: window.__a11y.desc(document.activeElement), modal: d.getAttribute('aria-modal'), role: d.getAttribute('role'), name: lab.trim() };
  }, sel);
  if (!info.inside) bad(`focus did not move into the dialog (on ${info.active})`);
  if (info.role !== 'dialog' || info.modal !== 'true' || !info.name) bad(`dialog semantics: role ${info.role}, aria-modal ${info.modal}, name "${info.name}"`);
  if (expectInput && !/input/.test(info.active)) bad(`focus on ${info.active}, not the search field`);
  for (const dir of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < tabs; i++) {
      await p.keyboard.press(dir);
      // The app rings the player a moment after focus lands in it; wait for
      // that rather than sampling once (a busy machine can be slow).
      await settleFocus(p);
      const s = await p.evaluate((q) => {
        const d = [...document.querySelectorAll(q)].pop();
        return { ...window.__a11y.stop(), inside: Boolean(d && d.contains(document.activeElement)) };
      }, sel);
      if (!s.inside) { bad(`${dir} #${i + 1} left the dialog (focus on ${s.desc || 'body'})`); break; }
      for (const iss of s.issues || []) if (!/behind/.test(iss)) bad(`${s.desc}: ${iss}`);
    }
  }
  // Keys pressed inside a cross-origin player never reach the page, so
  // Escape is pressed from the dialog's own Close button in that case.
  if (await p.evaluate(() => document.activeElement?.tagName === 'IFRAME')) await p.evaluate((q) => [...document.querySelectorAll(q)].pop().querySelector('.modal-x')?.focus(), sel);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
  if (sameAs) await p.waitForTimeout(1200);
  await p.waitForFunction((q) => ![...document.querySelectorAll(q)].some((d) => d.isConnected && window.__a11y.visible(d)) && (document.activeElement === window.__trig || !window.__trig?.isConnected), sel, { timeout: 3000 }).catch(() => {});
  const after = await p.evaluate(([q, same]) => ({
    open: [...document.querySelectorAll(q)].some((d) => d.isConnected && window.__a11y.visible(d)),
    back: document.activeElement === window.__trig || Boolean(same && !window.__trig?.isConnected && document.activeElement?.matches(same)),
    trigConnected: Boolean(window.__trig?.isConnected),
    active: window.__a11y.desc(document.activeElement),
  }), [sel, sameAs]);
  if (after.open) bad('Escape did not close it');
  else if (!after.back) bad(`focus did not return to the trigger (on ${after.active}${after.trigConnected ? '' : '; trigger was removed'})`);
}

async function dialogs(browser, { role, theme, width }) {
  const L = (x) => `dialog ${role} ${theme} ${width}: ${x}`;
  const { ctx, page: p } = await page(browser, role, { width, theme });
  try {
    await go(p, '#/home');
    await dialogCheck(p, L('search opened by its button traps focus and returns it'), '#search-btn', { expectInput: true });
    const slashName = L('"/" opens search with the field focused, also from a focused link');
    want(slashName);
    await p.evaluate(() => { document.activeElement?.blur(); });
    await p.keyboard.press('/');
    await p.waitForTimeout(400);
    const slash = await p.evaluate(() => ({ open: Boolean(document.querySelector('.search-overlay')), field: document.activeElement.classList.contains('search-input') }));
    if (!slash.open || !slash.field) fail(slashName, `"/" did not open search with the field focused (${JSON.stringify(slash)})`);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    await p.locator('#main a[href]').first().focus();
    await p.keyboard.press('/');
    await p.waitForTimeout(400);
    if (!(await p.evaluate(() => Boolean(document.querySelector('.search-overlay'))))) fail(slashName, '"/" with a page link focused did not open search');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    const resName = L('search results are named options the arrow keys move through');
    want(resName);
    await p.locator('#search-btn').click();
    await p.keyboard.type('the', { delay: 30 });
    await p.waitForSelector('.search-body [role=option]', { timeout: 10000 }).catch(() => {});
    for (const u of (await axScan(p)).unnamed) fail(resName, `${u.role} ${u.where} has no accessible name`);
    await p.keyboard.press('ArrowDown');
    const ad = await p.evaluate(() => { const i = document.querySelector('.search-input'); const id = i.getAttribute('aria-activedescendant'); return { id, ok: Boolean(id && document.getElementById(id)?.getAttribute('role') === 'option') }; });
    if (!ad.ok) fail(resName, `ArrowDown gives no aria-activedescendant option (${ad.id})`);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);

    // What should I watch?: the first question, each step, then the results.
    await dialogCheck(p, L('What should I watch? traps focus and returns it'), '#wsw-btn', { tabs: 12 });
    const wswName = L('What should I watch? puts focus on each question, results named and ringed');
    want(wswName);
    await p.locator('#wsw-btn').focus();
    await p.keyboard.press('Enter');
    await p.waitForSelector('.wsw [data-answer]');
    for (let q = 0; q < 3; q++) {
      const fq = await p.evaluate(() => window.__a11y.desc(document.activeElement));
      if (!/wsw-q/.test(fq)) fail(wswName, `step ${q + 1}: focus is on ${fq}, not the question`);
      await p.locator('.wsw [data-answer]').first().focus();
      await p.keyboard.press('Enter');
      await p.waitForTimeout(250);
    }
    await p.waitForSelector('.wsw-list, .wsw .muted', { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(300);
    const axr = await axScan(p);
    for (const u of axr.unnamed) fail(wswName, `results: ${u.role} ${u.where} has no accessible name`);
    for (const g of axr.glyphs) fail(wswName, `results: ${g} reads out star glyphs with no value`);
    for (let i = 0; i < 25; i++) {
      await p.keyboard.press('Tab');
      await settleFocus(p);
      const s = await p.evaluate(() => ({ ...window.__a11y.stop(), inside: Boolean(document.activeElement.closest('[role=dialog]')) }));
      if (!s.inside) { fail(wswName, `results: Tab left the dialog (${s.desc})`); break; }
      for (const iss of s.issues || []) if (!/behind/.test(iss)) fail(wswName, `results: ${s.desc}: ${iss}`);
    }
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);

    if (role === 'heavy') {
      await p.waitForSelector('#at-home .home-change:not([hidden])', { timeout: 30000 }).catch(() => {});
      await dialogCheck(p, L('At home services sheet traps focus and returns it'), '#at-home .home-change:not([hidden])');
    }
    await go(p, '#/settings');
    if (role === 'owner') {
      await dialogCheck(p, L('hidden films list traps focus and returns it'), p.locator('button:not([hidden])', { hasText: 'Show hidden films' }).first());
      await dialogCheck(p, L('Revoke confirm traps focus and returns it'), p.locator('button[aria-label^="Revoke "]').first(), { tabs: 4 });
    }
    await go(p, `#/movie/${MOVIE}`);
    if (role === 'owner') await dialogCheck(p, L('Fix match dialog traps focus and returns it'), p.locator('#main button.match-fix').first(), { tabs: 4 });
    await dialogCheck(p, L('trailer dialog traps focus and returns it'), p.locator('.detail-actions button, button', { hasText: /trailer/i }).first(), { tabs: 6 });
    await go(p, '#/stats');
    await dialogCheck(p, L('Stats drill-down traps focus and returns it'), p.locator('.bar-row').first(), { tabs: 15 });

    // The guided tour, from Replay tour under You, Help.
    await go(p, '#/help');
    const help = p.locator('.tour-replay');
    await dialogCheck(p, L('the tour traps focus and returns it'), help, { sel: '.tour-card', tabs: 5, sameAs: '.tour-replay' });
    await go(p, '#/help');
    const annName = L('a new tour step is announced');
    want(annName);
    await help.focus();
    await p.keyboard.press('Enter');
    await p.waitForSelector('.tour-card');
    await p.waitForFunction(() => !document.querySelector('.tour-layer.moving'), null, { timeout: 12000 }).catch(() => {});
    await p.evaluate(() => { window.__tourFocus = 0; document.addEventListener('focusin', (e) => { if (e.target.closest?.('.tour-card')) window.__tourFocus++; }, true); });
    await p.keyboard.press('Enter');
    await p.waitForFunction(() => document.querySelector('.tour-count')?.textContent.startsWith('2'), null, { timeout: 12000 }).catch(() => {});
    await p.waitForFunction(() => !document.querySelector('.tour-layer.moving'), null, { timeout: 12000 }).catch(() => {});
    const ann = await p.evaluate(() => {
      const c = document.querySelector('.tour-card');
      const live = c?.closest('[aria-live], [role=status], [role=alert]') || c?.querySelector('[aria-live] #tour-text, [role=status] #tour-text, [aria-live]#tour-text, [role=status]#tour-text');
      return { live: Boolean(live), refocused: window.__tourFocus > 0, count: c?.querySelector('.tour-count')?.textContent };
    });
    if (!ann.live && !ann.refocused) fail(annName, `moving to step ${ann.count} announces nothing`);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(1200);
    const stepName = L('every tour step keeps focus in the card, ringed');
    want(stepName);
    await help.focus();
    await p.keyboard.press('Enter');
    await p.waitForSelector('.tour-card');
    for (let i = 0; i < 14; i++) {
      await p.waitForFunction(() => !document.querySelector('.tour-layer.moving'), null, { timeout: 12000 }).catch(() => {});
      const st = await p.evaluate(() => {
        const c = document.querySelector('.tour-card');
        if (!c) return null;
        return { active: window.__a11y.desc(document.activeElement), inCard: c.contains(document.activeElement), count: c.querySelector('.tour-count')?.textContent, stop: window.__a11y.stop() };
      });
      if (!st) break;
      if (!st.inCard) fail(stepName, `step ${st.count}: focus is on ${st.active}, outside the tour card`);
      for (const iss of st.stop.issues || []) if (!/behind/.test(iss)) fail(stepName, `step ${st.count}: ${st.stop.desc}: ${iss}`);
      await p.keyboard.press('Enter');
      await p.waitForTimeout(150);
    }
    await p.evaluate(() => fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tourDone: true }) }));
  } catch (e) {
    fail(L('search opened by its button traps focus and returns it'), `crashed: ${e.message.split('\n')[0]}`);
  } finally { await ctx.close(); }
}

// Nested sheets for the brand-new friend: What should I watch? > At home >
// Choose your services. Escape closes only the top one; the one under it
// keeps focus.
async function nested(browser) {
  const name = 'dialog newbie light 390: Escape in a nested sheet closes only that sheet';
  want(name);
  const { ctx, page: p } = await page(browser, 'newbie', { width: 390, theme: 'light' });
  try {
    await w.api('PUT', '/api/settings', { as: ROLES.newbie, body: { setupDone: true, tourDone: true, youNoteSeen: true } });
    await go(p, '#/home');
    await p.locator('#wsw-btn').focus();
    await p.keyboard.press('Enter');
    await p.locator('.wsw [data-answer=home]').waitFor({ timeout: 5000 });
    await p.locator('.wsw [data-answer=home]').click();
    for (let i = 0; i < 2; i++) { await p.locator('.wsw .wsw-skip').click(); await p.waitForTimeout(150); }
    const choose = p.locator('.wsw button', { hasText: 'Choose your services' });
    await choose.waitFor({ timeout: 8000 });
    await choose.focus();
    await p.keyboard.press('Enter');
    await p.waitForTimeout(400);
    const n1 = await p.locator('.modal-overlay').count();
    await p.keyboard.press('Escape');
    await p.waitForTimeout(400);
    const st = await p.evaluate(() => ({ n: document.querySelectorAll('.modal-overlay').length, active: window.__a11y.desc(document.activeElement), inWsw: Boolean(document.activeElement.closest('.wsw')) }));
    if (n1 !== 2) fail(name, `expected 2 open sheets, saw ${n1}`);
    else if (st.n !== 1) fail(name, `Escape closed ${n1 - st.n} dialogs, not 1; focus on ${st.active}`);
    else if (!st.inWsw) fail(name, `after closing the services sheet focus is on ${st.active}, not back in What should I watch?`);
  } catch (e) { fail(name, `crashed: ${e.message.split('\n')[0]}`); } finally {
    await w.api('PUT', '/api/settings', { as: ROLES.newbie, body: { setupDone: false, tourDone: false, youNoteSeen: false } });
    await ctx.close();
  }
}

// ---------------------------------------------------------------- 3. toasts
async function toasts(browser) {
  for (const width of [390, 1280]) {
    const L = (x) => `toast heavy light ${width}: ${x}`;
    const { ctx, page: p } = await page(browser, 'heavy', { width });
    try {
      await go(p, '#/home');
      const pre = await p.evaluate(() => Boolean(document.querySelector('[aria-live], [role=status], [role=alert]') && document.querySelector('.toast-host')));
      want(L('the toast live region is on the page before the first toast'));
      if (!pre) fail(L('the toast live region is on the page before the first toast'), 'no .toast-host live region before the first toast');
      if (width === 390) {
        const n = L('At home is not one big live region');
        want(n);
        await p.waitForFunction(() => document.querySelector('#at-home .home-body a[href]'), null, { timeout: 60000 }).catch(() => {});
        const home = await p.evaluate(() => { const b = document.querySelector('#at-home .home-body'); return b ? { live: b.getAttribute('aria-live'), controls: b.querySelectorAll('a[href], button, [role=slider]').length } : null; });
        if (!home || !home.controls) fail(n, 'At home never filled in, so its live region could not be checked');
        else if (home.live && home.live !== 'off') fail(n, `At home's list sits in an aria-live="${home.live}" region with ${home.controls} controls`);
      }
      const btn = p.locator('.pick-card .not-for-me, .hero-pick .not-for-me').first();
      await p.keyboard.press('Shift');
      await btn.focus();
      await p.keyboard.press('Enter');
      await p.waitForSelector('.toast.has-action', { timeout: 8000 });
      const onBody = await p.evaluate(() => document.activeElement === document.body);
      want(L('after Not for me by keyboard, focus stays on the page'));
      if (onBody) fail(L('after Not for me by keyboard, focus stays on the page'), 'focus falls to <body> (the card it was on is gone)');
      const reachName = L('Undo is reachable within 3 Tabs');
      want(reachName);
      let n = 0;
      let reached = await p.evaluate(() => Boolean(document.activeElement?.closest('.toast')));
      let gone = false;
      for (; !reached && n < 80; n++) {
        await p.keyboard.press('Tab');
        if (await p.evaluate(() => Boolean(document.activeElement?.closest('.toast')))) { reached = true; break; }
        if (!(await p.locator('.toast.has-action').count())) { gone = true; break; }
      }
      if (!reached) fail(reachName, gone ? `the toast went after ${n + 1} Tabs without reaching Undo` : `not reached in ${n + 1} Tabs`);
      else if (n + 1 > 3) fail(reachName, `Undo is ${n + 1} Tabs away`);
      const stayName = L('the toast stays while its Undo has focus');
      want(stayName);
      if (reached) {
        await p.waitForTimeout(6500);
        if (!(await p.evaluate(() => Boolean(document.activeElement?.closest('.toast'))))) fail(stayName, 'the toast times out and is removed while Undo has keyboard focus');
      } else fail(stayName, 'Undo was never reached');
    } catch (e) {
      fail(L('Undo is reachable within 3 Tabs'), `crashed: ${e.message.split('\n')[0]}`);
    } finally {
      const hidden = (await w.api('GET', '/api/hidden', { as: ROLES.heavy })).json?.movies || [];
      for (const m of hidden) await w.api('DELETE', `/api/hidden/${m.tmdb_id}`, { as: ROLES.heavy });
      await ctx.close();
    }
  }
}

// ---------------------------------------------------------------- 4. reduced motion
async function motion(browser) {
  // The first pass runs with reduced motion off, as the control: the
  // recorder must see movement there, or its silence proves nothing.
  for (const [width, rm] of [[390, 'control'], [390, 'reduce'], [1280, 'reduce']]) {
    const name = rm === 'control' ? 'motion: the recorder sees movement with reduced motion off' : `motion owner ${width}: nothing moves with reduced motion on`;
    want(name);
    const { ctx, page: p } = await page(browser, 'owner', { width, reducedMotion: rm === 'control' ? 'no-preference' : 'reduce', record: true });
    try {
      await go(p, '#/home');
      for (const hsh of ['#/schedule', '#/rate', '#/watchlist', '#/together', '#/stats', '#/settings', '#/help', `#/movie/${MOVIE}`, `#/person/${PERSON.id}`, '#/home']) await go(p, hsh);
      await p.locator('#search-btn').hover();
      await p.mouse.down(); await p.waitForTimeout(120); await p.mouse.up();
      await p.keyboard.press('Escape');
      await p.locator('#wsw-btn').click(); await p.waitForTimeout(400); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
      await p.locator('#search-btn').click(); await p.waitForTimeout(400); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
      await p.evaluate(() => import('/js/ui.js').then((m) => m.toast('Motion test', '', { action: { label: 'Undo', onClick() {} } })));
      await p.waitForTimeout(500);
      await go(p, '#/help');
      await p.locator('.tour-replay').click();
      for (let i = 0; i < 6; i++) { await p.waitForTimeout(700); await p.keyboard.press('ArrowRight'); }
      await p.waitForTimeout(700);
      await p.keyboard.press('Escape');
      await p.waitForTimeout(300);
      const seen = await p.evaluate(() => window.__motion);
      const uniq = [...new Map(seen.map((s) => [`${s.kind} ${s.prop} ${s.el}`, s])).values()];
      if (rm === 'control') { if (!uniq.length) fail(name, 'the recorder saw no movement: the check is blind'); continue; }
      for (const s of uniq) if (s.ms > 20) fail(name, `${s.kind} of ${s.prop} on ${s.el} for ${Math.round(s.ms)}ms`);
    } catch (e) { fail(name, `crashed: ${e.message.split('\n')[0]}`); } finally { await ctx.close(); }
  }
  await w.api('PUT', '/api/settings', { body: { tourDone: true } });
}

// ---------------------------------------------------------------- 5. 200% zoom
async function zoom(browser, role) {
  const L = `zoom 200% ${role} 390`;
  const tabName = `${L}: every tab bar item is on screen with its whole label`;
  const screenName = (screen) => `${L} ${screen}: no sideways scroll, clipped or overlapping text`;
  const { ctx, page: p } = await page(browser, role, { width: 195, height: 422, extraCtx: { deviceScaleFactor: 2 } });
  try {
    await go(p, '#/home');
    for (const hash of screensFor(role)) {
      await go(p, hash);
      const screen = hash.replace(/\/\d+$/, '/<id>');
      const name = screenName(screen);
      want(name);
      if (hash === '#/home' && role !== 'guest') {
        want(tabName);
        const tabs = await p.evaluate(() => {
          const vw = window.visualViewport ? window.visualViewport.width : document.documentElement.clientWidth;
          return [...document.querySelectorAll('.bottom-nav .nav-item')].map((it) => {
            const r = it.getBoundingClientRect();
            const lab = it.querySelector('.nav-label') || it;
            const lr = lab.getBoundingClientRect();
            return { name: it.textContent.trim(), onScreen: r.left >= -1 && r.right <= vw + 1, cut: lab.scrollWidth > lab.clientWidth + 1 || lr.left < r.left - 1 || lr.right > r.right + 1 };
          }).filter((t) => !t.onScreen || t.cut);
        });
        for (const t of tabs) fail(tabName, `${t.name} ${t.onScreen ? 'label cut' : 'off screen'}`);
      }
      const found = await p.evaluate(zoomMeasure);
      const sw = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      if (sw[0] > sw[1]) fail(name, `page scrolls sideways: ${sw[0]}px wide in ${sw[1]}px`);
      for (const f of found.filter((x) => x.kind === 'sideways' && !/^html/.test(x.sel)).slice(0, 3)) fail(name, `${f.sel} ${f.detail}`);
      // A placeholder cut short at 200% keeps its field's name: not counted.
      for (const f of found.filter((x) => x.kind !== 'sideways' && !/^placeholder/.test(x.detail)).slice(0, 3)) fail(name, `${f.kind}: ${f.sel} ${f.detail}`);
    }
    if (role === 'guest') {
      const name = screenName('join page');
      want(name);
      await p.goto(w.base + invitePath);
      const sw = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      if (sw[0] > sw[1]) fail(name, `page scrolls sideways: ${sw[0]}px in ${sw[1]}px`);
    }
  } catch (e) { fail(screenName('#/home'), `crashed: ${e.message.split('\n')[0]}`); } finally { await ctx.close(); }
}

// ---------------------------------------------------------------- 6. offline, error, not found
async function states(browser, theme) {
  const { ctx, page: p } = await page(browser, 'owner', { width: 390, theme });
  const L = `walk owner ${theme} 390 states`;
  try {
    await go(p, '#/home');
    const off = `states owner ${theme} 390: the offline state is reached`;
    want(off);
    await p.route(/\/api\/stats/, (r) => r.abort('internetdisconnected'));
    await go(p, '#/stats');
    if (!(await p.locator('.empty-title', { hasText: /offline/i }).count())) fail(off, 'the offline state did not show');
    await walkScreen(p, L, 'offline state');
    await p.unroute(/\/api\/stats/);
    const err = `states owner ${theme} 390: the error state is reached`;
    want(err);
    await p.route(/\/api\/watchlist/, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Boom"}' }));
    await go(p, '#/watchlist');
    if (!(await p.locator('.empty-title', { hasText: /went wrong/i }).count())) fail(err, 'the error state did not show');
    await walkScreen(p, L, 'error state');
    await p.unroute(/\/api\/watchlist/);
    await go(p, '#/movie/1');
    await walkScreen(p, L, 'movie not found');
  } catch (e) { fail(`states owner ${theme} 390: the offline state is reached`, `crashed: ${e.message.split('\n')[0]}`); } finally { await ctx.close(); }
}

// ---------------------------------------------------------------- 7. person search and page (S11)
async function typeSearch(p, q) {
  if (!(await p.locator('.search-input').count())) await p.locator('#search-btn').click();
  await p.locator('.search-input').fill(q);
  await p.waitForFunction((qq) => {
    const s = document.querySelector('.search-status')?.textContent || '';
    return document.querySelector('.search-input')?.value === qq && /\d+ results?|No matches|\d+ (person|people)/.test(s) && !/Searching/.test(s);
  }, q, { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(150);
}
async function closeSearch(p) {
  await p.keyboard.press('Escape');
  await p.waitForTimeout(250);
  if (await p.locator('.search-overlay').count()) await p.locator('.search-overlay .modal-x').click().catch(() => {});
  await p.waitForTimeout(200);
}

async function personNames(browser) {
  const { page: p, ctx, errors } = await page(browser, 'owner', { width: 1280, theme: 'light' });
  try {
    await go(p, '#/home');
    await typeSearch(p, 'ada lindqvist');
    const row = p.locator('.search-body > .sr-person').first();
    const id = await row.getAttribute('id').catch(() => null);
    const label = await row.getAttribute('aria-label').catch(() => null);
    S.check('person: the person row is an option named "<name>, <role>. Known for ..."', (await row.getAttribute('role').catch(() => null)) === 'option' && /^Ada Lindqvist, Director\. Known for .+/.test(label || ''), label);
    S.check('person: with no films the status line counts only the people', (await p.locator('.search-status').textContent()) === '1 person', await p.locator('.search-status').textContent());
    await typeSearch(p, 'tarantino');
    S.check('person: with films the status line counts people and results', /^1 person · [1-9]\d* results?$/.test(await p.locator('.search-status').textContent()), await p.locator('.search-status').textContent());
    await typeSearch(p, 'ada lindqvist');
    await p.keyboard.press('ArrowDown');
    S.check('person: ArrowDown lands on the person row first', Boolean(id) && (await p.locator('.search-input').getAttribute('aria-activedescendant')) === id);
    await p.keyboard.press('Enter');
    await p.waitForFunction((pid) => location.hash === `#/person/${pid}` && document.querySelector('.person h1'), C.PEOPLE.ada.id, { timeout: 30000 }).catch(() => {});
    S.check('person: Enter opens the person page', new URL(p.url()).hash === `#/person/${C.PEOPLE.ada.id}`, p.url());

    await go(p, `#/person/${PERSON.id}`);
    const s = await p.evaluate(() => ({
      h1: [...document.querySelectorAll('h1')].map((e) => e.textContent),
      h2: [...document.querySelectorAll('.person h2')].map((e) => e.textContent),
      sections: [...document.querySelectorAll('.person section')].map((sec) => document.getElementById(sec.getAttribute('aria-labelledby'))?.tagName),
      lists: [...document.querySelectorAll('.person ul')].map((u) => u.getAttribute('aria-label')),
      group: `${document.querySelector('.person-toggle')?.getAttribute('role')}|${document.querySelector('.person-toggle')?.getAttribute('aria-label')}`,
      photoAlt: document.querySelector('.person-photo')?.getAttribute('alt'),
    }));
    S.check('person: one h1 on the page, the name', s.h1.length === 1 && s.h1[0] === PERSON.name, s.h1.join('|'));
    S.check('person: an h2 per section: Playing now, You rated, Films', JSON.stringify(s.h2) === JSON.stringify(['Playing now', 'You rated', 'Films']), s.h2.join('>'));
    S.check('person: every section is named by its h2', s.sections.length === 3 && s.sections.every((t) => t === 'H2'), s.sections.join(','));
    S.check('person: every list is named', s.lists.length >= 3 && s.lists.every(Boolean), s.lists.join(' | '));
    S.check('person: the Directed / Acted switch is a named group', s.group === `group|${PERSON.name}'s films`, s.group);
    S.check('person: the photo is decorative (the name is the h1)', s.photoAlt === '');
    await p.locator('body').click({ position: { x: 5, y: 300 } });
    let at = '';
    for (let i = 0; i < 80 && !/^Acted/.test(at); i++) { await p.keyboard.press('Tab'); at = await p.evaluate(() => document.activeElement?.textContent || ''); }
    S.check('person: Tab reaches the Acted button', /^Acted/.test(at), at);
    await p.keyboard.press('Enter');
    S.check('person: Enter switches to Acted', await p.locator('.person-toggle button', { hasText: 'Acted' }).getAttribute('aria-pressed') === 'true');
    await p.keyboard.press('Shift+Tab');
    await p.keyboard.press(' ');
    S.check('person: Space on Directed switches back', await p.locator('.person-toggle button', { hasText: 'Directed' }).getAttribute('aria-pressed') === 'true');
    const firstRow = p.locator('section[aria-labelledby=person-films] .person-films > li').first();
    const title = (await firstRow.locator('.sheet-title').textContent()).replace(/\s\d{4}$/, '');
    const stars = firstRow.locator('.stars.interactive');
    S.check('person: the stars are a named slider you can Tab to', (await stars.getAttribute('role')) === 'slider' && (await stars.getAttribute('tabindex')) === '0' && (await stars.getAttribute('aria-label')) === `Your rating of ${title}`, await stars.getAttribute('aria-label'));
    const save = firstRow.locator('.wl-btn');
    S.check('person: Save is a named toggle', (await save.getAttribute('aria-pressed')) === 'false' && (await save.getAttribute('aria-label')) === `Save to your watchlist: ${title}`, await save.getAttribute('aria-label'));
    const names = await p.evaluate(controlSizes, '.person');
    S.check('person: every control on the page has a name', names.length > 5 && names.every((c) => c.name.length > 0), names.filter((c) => !c.name).map((c) => c.what).join(', '));
    S.check('person: no console errors or failed requests (names and keyboard)', !errors.length, errors.slice(0, 4).join(' || '));
  } finally { await ctx.close(); }
}

async function personSizes(browser, width, theme) {
  const touch = width <= 430;
  const L = `person ${width} ${theme}`;
  const { page: p, ctx, errors } = await page(browser, 'owner', { width, theme });
  try {
    await go(p, '#/home');
    await typeSearch(p, 'ada lindqvist');
    await p.keyboard.press('ArrowDown');
    const sr = await p.evaluate(controlSizes, '.sr-person');
    const cs = await p.evaluate(textContrast, '.sr-person');
    S.check(`${L}: the person row is at least 44px`, sr.length === 1 && sr.every((c) => c.h >= 44 && c.w >= 44), JSON.stringify(sr));
    S.check(`${L}: search person row text meets AA, active row included`, cs.n >= 3 && !cs.bad.length, `${cs.n} texts; ${cs.bad.join(' | ')}`);
    await p.locator('.search-body > .sr-person').first().click();
    await p.waitForFunction(() => document.querySelector('.person h1'), null, { timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(300);
    await p.locator('#search-btn').click();
    await p.waitForSelector('.recent-person', { timeout: 8000 }).catch(() => {});
    const rp = await p.evaluate(controlSizes, '.recent-row:has(.recent-person)');
    const rc = await p.evaluate(textContrast, '.recent-person');
    S.check(`${L}: the recent person row and its remove button are at least 44px`, rp.length >= 2 && rp.length % 2 === 0 && rp.every((c) => c.h >= 44 && c.w >= 44), JSON.stringify(rp));
    S.check(`${L}: the recent person row meets AA`, rc.n >= 1 && !rc.bad.length, rc.bad.join(' | '));
    await closeSearch(p);
    await go(p, `#/person/${PERSON.id}`);
    const all = await p.evaluate(controlSizes, '.person');
    const small = all.filter((c) => (touch || /segment|show-all/.test(c.what)) && (c.h < 44 || c.w < 44));
    S.check(`${L}: ${touch ? 'every control on the person page' : 'the person page switch'} is at least 44px`, all.length > 10 && !small.length, `${all.length} controls; ${small.slice(0, 5).map((c) => `${c.what} ${c.w}x${c.h}`).join(' | ')}`);
    await p.locator('.person-toggle button', { hasText: 'Acted' }).click();
    const pc = await p.evaluate(textContrast, '.person');
    S.check(`${L}: all text on the person page meets AA`, pc.n > 20 && !pc.bad.length, `${pc.n} texts; ${pc.bad.slice(0, 5).join(' | ')}`);
    await go(p, `#/movie/${MOVIE}`);
    const ml = await p.evaluate(controlSizes, '.about .credit-line');
    const mc = await p.evaluate(textContrast, '.about .credit-line');
    S.check(`${L}: every director and cast name on the movie page is at least 44px`, ml.length >= 3 && ml.every((c) => c.h >= 44 && c.w >= 44), JSON.stringify(ml.filter((c) => c.h < 44 || c.w < 44)));
    S.check(`${L}: the names on the movie page meet AA`, mc.n >= 3 && !mc.bad.length, mc.bad.join(' | '));
    S.check(`${L}: no console errors or failed requests`, !errors.length, errors.slice(0, 4).join(' || '));
  } finally { await ctx.close(); }
}

async function personMotion(browser) {
  const { page: p, ctx } = await page(browser, 'owner', { width: 390, reducedMotion: 'reduce' });
  try {
    await go(p, `#/person/${PERSON.id}`);
    await p.waitForSelector('.person h1', { timeout: 30000 });
    const moving = await p.evaluate(() => [...document.querySelectorAll('.person *, .person')].filter((e) => {
      const cs = getComputedStyle(e);
      const anim = cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.001;
      const tr = /transform|all/.test(cs.transitionProperty) && cs.transitionDuration.split(',').some((d) => parseFloat(d) > 0);
      return anim || tr;
    }).map((e) => e.className).slice(0, 5));
    S.check('person reduced motion: nothing on the person page animates or transitions movement', !moving.length, moving.join(' | '));
    const btn = p.locator('.person-toggle button', { hasText: 'Acted' });
    const b = await btn.boundingBox();
    await p.mouse.move(b.x + 10, b.y + 10);
    await p.mouse.down();
    const t = await btn.evaluate((e) => getComputedStyle(e).transform);
    await p.mouse.up();
    S.check('person reduced motion: a pressed switch button does not shrink', t === 'none', t);
    await go(p, '#/home');
    await p.locator('#search-btn').click();
    await p.locator('.search-input').fill('ada lindqvist');
    await p.waitForSelector('.sr-person', { timeout: 30000 });
    const srMoving = await p.evaluate(() => [...document.querySelectorAll('.sr-person, .sr-person *')].filter((e) => { const cs = getComputedStyle(e); return (cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.001) || /transform|all/.test(cs.transitionProperty); }).length);
    S.check('person reduced motion: the person row does not move either', srMoving === 0, String(srMoving));
  } finally { await ctx.close(); }
}

// ---------------------------------------------------------------- 8. Book links
// A showtime's Book link has no outline of its own: its ::after covers the
// whole row (the row is the tap target) and the ring is drawn there. The old
// gate read only the link's own outline and reported these as missing.
async function bookRings(browser, theme) {
  const name = `Book link ${theme} 390: its focus ring, drawn around the row, is 2px and 3:1`;
  const { ctx, page: p } = await page(browser, 'owner', { width: 390, theme });
  try {
    await go(p, '#/home');
    await p.keyboard.press('Shift');
    const n = await p.locator('a.st-book').count();
    const bad = [];
    for (let i = 0; i < Math.min(n, 6); i++) {
      await p.locator('a.st-book').nth(i).focus();
      const st = await p.evaluate(() => window.__a11y.stop());
      if (!/::after/.test(st.ring.kind) || st.ring.w < 2 || st.ring.ratio < 3) bad.push(`${st.desc}: ${JSON.stringify(st.ring)}`);
    }
    S.check(name, n > 0 && !bad.length, n ? bad.join(' | ') : 'no Book link on Picks');
  } finally { await ctx.close(); }
}

// ---------------------------------------------------------------- run
async function pool(jobs, n, fn) {
  const q = [...jobs];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await fn(q.shift()); }));
}

const browser = await launch();
try {
  await S.step('self-test', () => selfTest(browser));
  const walks = [];
  for (const role of ['owner', 'heavy', 'guest', 'newbie']) for (const theme of THEMES) for (const width of [1280, 390]) walks.push({ role, theme, width });
  walks.push({ role: 'empty', theme: 'light', width: 390 }, { role: 'empty', theme: 'dark', width: 1280 });
  await S.step('keyboard walks and names, every screen', () => pool(walks, 4, (j) => walk(browser, j)));
  S.check('walks: no console errors or failed requests', !walkErrors.length, walkErrors.slice(0, 5).join(' || '));
  await S.step('Book link focus rings', () => pool(THEMES, 2, (t) => bookRings(browser, t)));
  await S.step('person search and person page (S11)', async () => {
    await personNames(browser);
    await pool([[320, 'light'], [390, 'dark'], [1280, 'dark'], [1280, 'light']], 2, ([width, theme]) => personSizes(browser, width, theme));
    await personMotion(browser);
  });
  // The owner hides one film so the hidden films list has something in it.
  await w.api('POST', '/api/hidden', { body: { tmdb_id: 990008 } });
  const dj = [];
  for (const theme of THEMES) for (const width of [1280, 390]) dj.push({ role: 'owner', theme, width }, { role: 'heavy', theme, width });
  await S.step('dialogs', () => pool(dj, 3, (j) => dialogs(browser, j)));
  await w.api('DELETE', '/api/hidden/990008');
  await S.step('nested sheets', () => nested(browser));
  await S.step('toasts', () => toasts(browser));
  await S.step('reduced motion', () => motion(browser));
  await S.step('200% zoom', () => pool(['owner', 'heavy', 'guest'], 3, (r) => zoom(browser, r)));
  await S.step('offline, error and not-found states', () => pool(THEMES, 2, (t) => states(browser, t)));
} finally {
  await browser.close();
}
for (const name of [...buckets.keys()].sort()) {
  const list = buckets.get(name);
  S.check(name, !list.length, `${list.length} problem(s): ${list.slice(0, 6).join(' | ')}`);
}
void GUEST;
await w.close();
S.finish();
