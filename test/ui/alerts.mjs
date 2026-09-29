// Watchlist alerts in the browser (public/js/views/settings.js, help.js):
//
//   switch   "Watchlist alerts" sits in the Notifications card right after
//            the weekly picks switch, off by default, and says to turn on
//            notifications first while this device's push is off (not once
//            it's on); switching it saves, stays after a reload, and is each
//            person's own; the guest has none
//   layout   the card for the owner, the 700-rating friend, the second friend
//            and the brand-new friend at 320, 390 and 1280, light and dark: no
//            console error, failed request, sideways scroll, clipped text,
//            small tap or AA contrast failure
//   help     Help has a Watchlist alerts line
//
// The page's push state comes from a stand-in service worker registration
// (no push service runs in the tests). RP_SHOTS_DIR saves a screenshot of
// each state.
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld } from '../lib/world.mjs';
import { launch, open, go, toastText, VISIBLE } from '../lib/browser.mjs';
import { measure, contrastProbe, textPalette, ROUTES } from '../lib/ui-helpers.mjs';

const S = suite('alerts');
const SHOTS = process.env.RP_SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

const w = S.world(await openWorld('alerts-ui', { push: true }));
const F = w.friends;
await w.api('PUT', '/api/settings', { as: F.jordan, body: { setupDone: true, tourDone: true, youNoteSeen: true, onboardingDone: true } });
const ROLES = { owner: 'owner', robin: F.robin, casey: F.casey, jordan: F.jordan };
const setting = async (as) => (await w.api('GET', '/api/settings', { as: as === 'owner' ? null : as })).json.watchlistAlerts;
const browser = await launch();

// The service worker registration the Settings page asks for its push
// subscription: none (push off on this device), or one the server knows.
const stub = (endpoint) => `(() => {
  const endpoint = ${JSON.stringify(endpoint)};
  const sub = endpoint ? { endpoint, options: { applicationServerKey: null }, toJSON() { return { endpoint }; }, unsubscribe: async () => true } : null;
  const reg = { pushManager: { getSubscription: async () => sub, subscribe: async () => { throw new Error('no push service in the tests'); } } };
  if (navigator.serviceWorker) Object.defineProperty(navigator.serviceWorker, 'ready', { configurable: true, get: () => Promise.resolve(reg) });
})();`;

async function openSettings(role, width, theme, { endpoint = null } = {}) {
  const o = await open(browser, w, { role, width, theme, extraCtx: endpoint ? { permissions: ['notifications'] } : {} });
  await o.ctx.addInitScript(stub(endpoint));
  await go(o.page, w, 'settings', 300, { fresh: true });
  if (role !== 'guest') {
    await o.page.waitForSelector('label.watch-alerts', { timeout: 15000 });
    // The push state has settled once the weekly switch is enabled again.
    await o.page.waitForFunction(() => { const t = document.querySelector('.settings-group label.switch-row:not(.watch-alerts) input'); return t && !t.disabled; }, null, { timeout: 15000 });
    await o.page.evaluate(() => {
      const card = document.querySelector('label.watch-alerts').closest('section');
      card.id = 'probe-notify';
      card.scrollIntoView({ block: 'center' });
    });
    await o.page.waitForTimeout(250);
  }
  return o;
}

// What the switch looks like on the page.
const state = (page) => page.evaluate((vis) => {
  const visible = new Function(`return ${vis}`)();
  const card = document.querySelector('label.watch-alerts')?.closest('section');
  const rows = card ? [...card.querySelectorAll('.group-body > *')] : [];
  const weekly = rows.findIndex((r) => r.matches('label.switch-row') && !r.classList.contains('watch-alerts'));
  const mine = rows.findIndex((r) => r.classList.contains('watch-alerts'));
  const note = card?.querySelector('.watch-alerts-note');
  return {
    title: card?.querySelector('.group-title')?.textContent || '',
    label: card?.querySelector('label.watch-alerts')?.textContent.trim() || '',
    checked: Boolean(card?.querySelector('label.watch-alerts input')?.checked),
    weeklyChecked: Boolean(rows[weekly]?.querySelector('input')?.checked),
    order: weekly >= 0 && mine > weekly && rows.slice(weekly + 1, mine).every((r) => r.matches('p')),
    note: note && visible(note) ? note.textContent.trim() : '',
  };
}, VISIBLE);

async function problems(page, phone) {
  const palette = await textPalette(page);
  const out = await page.evaluate(measure, { phone, atBottom: false, palette, routes: ROUTES, scope: '#probe-notify' });
  out.push(...(await page.evaluate(contrastProbe, { scope: '#probe-notify' })).out.map((c) => ({ ...c, kind: `contrast:${c.kind}` })));
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (sideways > 0) out.push({ kind: 'sideways', sel: 'html', detail: `${sideways}px` });
  return out;
}

for (const [who, role] of Object.entries(ROLES)) {
  await S.step(`${who}: the switch at 320, 390 and 1280, light and dark`, async () => {
    const seen = []; const bad = []; const errs = [];
    for (const width of [320, 390, 1280]) {
      for (const theme of ['light', 'dark']) {
        const o = await openSettings(role, width, theme);
        try {
          seen.push({ at: `${width} ${theme}`, ...(await state(o.page)) });
          for (const p of await problems(o.page, o.phone)) bad.push(`${width} ${theme} ${p.kind} ${p.sel} ${p.detail}`);
          await shot(o.page, `settings-${who}-${width}-${theme}`);
          errs.push(...o.errors, ...o.outside);
        } finally { await o.ctx.close(); }
      }
    }
    S.check(`ui: ${who}: the Watchlist alerts switch is in Notifications, right after the weekly picks switch`, seen.length === 6 && seen.every((s) => s.title === 'Notifications' && s.label === 'Watchlist alerts' && s.order), JSON.stringify(seen));
    S.check(`ui: ${who}: it is off by default`, seen.every((s) => !s.checked) && (await setting(role)) === false);
    S.check(`ui: ${who}: with push off on this device it says to turn on notifications first`, seen.every((s) => !s.weeklyChecked && /^Turn on notifications first\./.test(s.note)), JSON.stringify(seen.map((s) => s.note)));
    S.check(`ui: ${who}: no console error, failed request, sideways scroll, clipped text, small tap or contrast failure`, !bad.length && !errs.length, [...bad, ...errs].slice(0, 6).join(' | '));
  });
}

await S.step('owner: push on, and switching it', async () => {
  const sub = w.push.newSub('owner-ui');
  const r = await w.api('POST', '/api/push/subscribe', { body: { subscription: sub } });
  if (r.status !== 200) throw new Error(`subscribe ${r.status} ${r.text}`);
  let o = await openSettings('owner', 390, 'light', { endpoint: sub.endpoint });
  try {
    const s = await state(o.page);
    S.check('ui: with push on for this device the note is gone', s.weeklyChecked && s.note === '', JSON.stringify(s));
    await shot(o.page, 'settings-owner-390-light-push-on');
    await o.page.locator('label.watch-alerts').click();
    const t = await toastText(o.page, /watchlist/i);
    S.check('ui: switching it on saves it', /starts showing/.test(t) && (await setting('owner')) === true, t);
    S.check('ui: one person\'s switch leaves everyone else\'s off', (await setting(F.robin)) === false && (await setting(F.casey)) === false && (await setting(F.jordan)) === false);
    S.check('ui: no console error or failed request while switching', !o.errors.length && !o.outside.length, o.errors.join(' | '));
  } finally { await o.ctx.close(); }
  o = await openSettings('owner', 390, 'light', { endpoint: sub.endpoint });
  try {
    S.check('ui: it stays on after a reload', (await state(o.page)).checked);
    await shot(o.page, 'settings-owner-390-light-switch-on');
    await o.page.locator('label.watch-alerts').click();
    const t = await toastText(o.page, /watchlist/i);
    S.check('ui: switching it off saves it', /off/.test(t) && (await setting('owner')) === false, t);
  } finally { await o.ctx.close(); }
});

await S.step('guest and Help', async () => {
  const g = await openSettings('guest', 390, 'light');
  try {
    await g.page.waitForTimeout(400);
    S.check('ui: the guest has no Watchlist alerts switch', (await g.page.locator('label.watch-alerts').count()) === 0 && (await g.page.locator('text=Watchlist alerts').count()) === 0);
    await shot(g.page, 'guest-390-light');
  } finally { await g.ctx.close(); }
  for (const theme of ['light', 'dark']) {
    const o = await open(browser, w, { role: 'owner', width: 390, theme });
    try {
      await go(o.page, w, 'help');
      const line = await o.page.evaluate(() => { const dt = [...document.querySelectorAll('.guide dt')].find((d) => d.textContent === 'Watchlist alerts'); return dt ? dt.nextElementSibling?.textContent || '' : null; });
      await o.page.evaluate(() => [...document.querySelectorAll('.guide dt')].find((d) => d.textContent === 'Watchlist alerts')?.scrollIntoView({ block: 'center' }));
      await o.page.waitForTimeout(200);
      await shot(o.page, `help-390-${theme}`);
      S.check(`ui: Help has a Watchlist alerts line (${theme})`, Boolean(line) && /Settings/.test(line) && /9\sAM/.test(line) && !o.errors.length, `${line} ${o.errors.join(' | ')}`);
    } finally { await o.ctx.close(); }
  }
});

await browser.close();
await w.close();
S.finish();
