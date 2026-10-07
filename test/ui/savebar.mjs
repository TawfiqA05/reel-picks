// The Save settings bar (public/js/views/settings.js): it shows whenever the
// Settings fields differ from what is saved, however they changed, and not
// when nothing differs.
//
//   lookup    a look-up with one match fills Home base and the bar shows,
//             with no other tap or key
//   location  Use my location fills Home base and the bar shows
//   save      after that look-up, a normal click on the bar's Save settings
//             stores the place, and it is still there after a reload
//   clear     Clear home base alone leaves the bar down, a tap elsewhere
//             doesn't bring it up, and the saved snapshot's home is blank
//             while the rest of it is as it was
//   edited    with another field changed, the bar stays up through a
//             look-up of the place already saved and through Clear home
//             base, and Save stores that field
//   keep      several matches and Use; nothing found; a failed look-up; a
//             look-up of the place already saved
//   enter     a real Enter in the look-up box: with one match or several the
//             focus leaves the box (so a phone's keyboard closes) for a
//             ringed element on screen and clear of the bar; with nothing
//             found or a failed look-up it stays in the box to retype; a tap
//             on Look up leaves the focus where the tap put it
//
// Two things would hide the fault in the test world. The sample home base is
// the place the stand-in gives for every one-match and reverse look-up
// (catalog.mjs HOME), so each step starts from another saved home base
// (OTHER) and a position away from it. And an answer that lands before the
// page's next animation frame shows the bar by luck, so look-ups, Clear and
// the position are held back about 300 ms.
import { suite } from '../lib/check.mjs';
import { openWorld, sleep } from '../lib/world.mjs';
import { launch, open, go, toastText } from '../lib/browser.mjs';
import { kit } from '../lib/a11y-helpers.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('savebar');
const w = S.world(await openWorld('savebar'));
const browser = await launch();
const HOLD = 300;
const OTHER = { label: 'Otherton, OH', lat: 40.1, lng: -83.2 };
// A pretend position away from both OTHER and HOME.
const SPOT = { latitude: 41.03, longitude: -81.92 };

const getSettings = async () => (await w.api('GET', '/api/settings')).json;
const saveHome = async (home) => {
  const r = await w.api('PUT', '/api/settings', { body: { home } });
  if (r.status !== 200) throw new Error(`could not save the starting home base: ${r.status}`);
};

const card = (page, title) => page.locator('.settings-group', { has: page.locator('.group-title', { hasText: new RegExp(`^${title}$`) }) });
const field = (page, label) => page.locator('.field', { has: page.locator('.field-label', { hasText: label }) }).locator('input, select').first();
const homeFields = (page) => page.evaluate(() => ({
  label: document.querySelector('.settings-group input[placeholder^="Label"]')?.value,
  lat: document.querySelector('input[placeholder="lat"]')?.value,
  lng: document.querySelector('input[placeholder="lng"]')?.value,
}));
const geoStatus = (page) => page.locator('.geo-status').textContent();
// The bar is up when it has .show and isn't hidden from screen readers.
const barUp = (page) => page.evaluate(() => {
  const b = document.querySelector('.save-bar');
  return Boolean(b && b.classList.contains('show') && b.getAttribute('aria-hidden') === 'false' && document.body.classList.contains('has-save'));
});
const statusIs = (page, re, timeout = 8000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.geo-status')?.textContent || ''), re.source, { timeout });
// Long enough for a queued frame and the bar's slide.
const calm = (page) => page.waitForTimeout(600);

async function settings({ geo = false } = {}) {
  const p = await open(browser, w, { width: 390 });
  // The a11y suite's focus measures (window.__a11y.stop()).
  await p.ctx.addInitScript(kit);
  if (geo) {
    await p.ctx.grantPermissions(['geolocation'], { origin: w.base });
    await p.ctx.setGeolocation(SPOT);
    // The position arrives late, after the click's frame has come and gone.
    await p.ctx.addInitScript((ms) => {
      const real = Geolocation.prototype.getCurrentPosition;
      Geolocation.prototype.getCurrentPosition = function (ok, fail, o) {
        return real.call(this, (pos) => setTimeout(() => ok(pos), ms), fail && ((e) => setTimeout(() => fail(e), ms)), o);
      };
    }, HOLD);
  }
  // Every look-up and Clear answers late too.
  await p.page.route((u) => u.pathname.startsWith('/api/geocode') || u.pathname === '/api/home', async (r) => {
    await sleep(HOLD);
    await r.continue();
  });
  await go(p.page, w, 'settings', 600);
  return p;
}

async function lookUp(page, q) {
  const hb = card(page, 'Home base');
  await hb.locator('input[type=search]').fill(q);
  await hb.locator('button', { hasText: 'Look up' }).click();
}

async function clearHome(page) {
  await card(page, 'Home base').locator('button', { hasText: 'Clear home base' }).click();
  const t = await toastText(page, /Home base cleared/);
  await calm(page);
  return t;
}

// Types a place into the look-up box and presses a real Enter there, with the
// box sitting just above the bottom of the screen (where a phone's keyboard
// leaves it, and where the bar comes up). Says whether the box had the focus.
async function enterLookUp(page, q) {
  const box = card(page, 'Home base').locator('input[type=search]');
  await box.fill(q);
  await box.evaluate((el) => window.scrollTo({ top: scrollY + el.getBoundingClientRect().bottom - (innerHeight - 90), behavior: 'instant' }));
  const inBox = await box.evaluate((el) => document.activeElement === el);
  await page.keyboard.press('Enter');
  return inBox;
}
// Where the focus is, and the a11y suite's measure of it.
const focusNow = (page) => page.evaluate(() => {
  const a = document.activeElement;
  const body = !a || a === document.body || a === document.documentElement;
  return {
    body, field: Boolean(a?.matches('input, select, textarea')), inBox: Boolean(a?.matches('.geo-row input[type=search]')),
    visible: !body && window.__a11y.visible(a), desc: window.__a11y.desc(a), stop: window.__a11y.stop(),
  };
});
const leftBox = (f) => !f.body && !f.field && f.visible;
const stopOk = (f) => !f.stop.body && f.stop.issues.length === 0;
const say = (f) => `${f.desc}${f.stop.issues?.length ? `: ${f.stop.issues.join('; ')}` : ''}`;

// A normal click on the visible button, then the server's answer to the save.
async function pressSave(page) {
  const btn = page.locator('.save-bar button', { hasText: 'Save settings' });
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/settings' && r.request().method() === 'PUT', { timeout: 6000 });
  try {
    await btn.click({ timeout: 5000 });
  } catch (e) {
    answer.catch(() => {});
    return { clicked: false, why: e.message.split('\n')[0] };
  }
  const r = await answer;
  return { clicked: true, status: r.status(), body: await r.json() };
}

const ERR_OK = [/ 502 GET \/api\/geocode/, /status of 502/];
const noErrors = (label, p) => {
  const extra = p.errors.filter((e) => !ERR_OK.some((re) => re.test(e)));
  S.check(`${label}: no console errors, page errors or unexpected 4xx/5xx`, !extra.length, extra.slice(0, 4).join(' || '));
};

// ------------------------------------------------------------------ lookup, save
await S.step('lookup and save: one match, then Save settings', async () => {
  await saveHome(OTHER);
  const p = await settings();
  try {
    S.check('lookup: the bar is down before the look-up', !(await barUp(p.page)));
    await lookUp(p.page, 'Testville');
    await statusIs(p.page, /^Found /);
    await calm(p.page);
    const f = await homeFields(p.page);
    S.check('lookup: the fields hold the place it found', f.label === C.HOME.label && f.lat === String(C.HOME.lat) && f.lng === String(C.HOME.lng), JSON.stringify(f));
    S.check('lookup: the Save bar is showing', await barUp(p.page), `${await geoStatus(p.page)} / bar down`);

    const r = await pressSave(p.page);
    const h = r.body?.home || {};
    S.check('save: a normal click on the visible Save settings saves', r.clicked && r.status === 200, r.why || r.status);
    S.check('save: the settings the server returns hold the place', h.label === C.HOME.label && h.lat === C.HOME.lat && h.lng === C.HOME.lng, JSON.stringify(h));
    await calm(p.page);
    S.check('save: the bar goes down once saved', !(await barUp(p.page)));
    await go(p.page, w, 'settings', 600);
    const g = await homeFields(p.page);
    const s = (await getSettings()).home || {};
    S.check('save: the place is still there after a reload', g.label === C.HOME.label && g.lat === String(C.HOME.lat) && g.lng === String(C.HOME.lng) && s.label === C.HOME.label && s.lat === C.HOME.lat && s.lng === C.HOME.lng, `${JSON.stringify(g)} ${JSON.stringify(s)}`);
    S.check('save: the bar is down after the reload', !(await barUp(p.page)));
    noErrors('lookup and save', p);
  } finally { await p.ctx.close(); }
});

// ------------------------------------------------------------------ location
await S.step('location: Use my location', async () => {
  await saveHome(OTHER);
  const p = await settings({ geo: true });
  try {
    S.check('location: the bar is down before the tap', !(await barUp(p.page)));
    await p.page.locator('button', { hasText: 'Use my location' }).click();
    await statusIs(p.page, /^(Found|Coordinates set)/, 10000);
    await calm(p.page);
    const f = await homeFields(p.page);
    S.check('location: the fields hold the position and its place', /^Found /.test(await geoStatus(p.page)) && f.label === C.HOME.label && f.lat === String(SPOT.latitude) && f.lng === String(SPOT.longitude), `${await geoStatus(p.page)} ${JSON.stringify(f)}`);
    S.check('location: the Save bar is showing', await barUp(p.page));
    noErrors('location', p);
  } finally { await p.ctx.close(); }

  // The reverse look-up fails: the coordinates become the label.
  await saveHome(OTHER);
  const q = await settings({ geo: true });
  try {
    await q.page.route((u) => u.pathname === '/api/geocode/reverse', (r) => r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Couldn\'t reach the place lookup.' }) }));
    await q.page.locator('button', { hasText: 'Use my location' }).click();
    await statusIs(q.page, /^Coordinates set/, 10000);
    await calm(q.page);
    const f = await homeFields(q.page);
    S.check('location: unnamed: the coordinates fill the fields and the label', f.label === `${SPOT.latitude}, ${SPOT.longitude}` && f.lat === String(SPOT.latitude) && f.lng === String(SPOT.longitude), JSON.stringify(f));
    S.check('location: unnamed: the Save bar is showing', await barUp(q.page));
    noErrors('location: unnamed', q);
  } finally { await q.ctx.close(); }
});

// ------------------------------------------------------------------ clear
await S.step('clear: Clear home base with nothing else changed', async () => {
  await saveHome(OTHER);
  const before = await getSettings();
  const p = await settings();
  try {
    const ticket = await field(p.page, 'Avg ticket').inputValue();
    const t = await clearHome(p.page);
    const f = await homeFields(p.page);
    S.check('clear: the fields are blank', /Home base cleared/.test(t) && !f.label && !f.lat && !f.lng, `${t} ${JSON.stringify(f)}`);
    S.check('clear: the bar is down', !(await barUp(p.page)));
    await card(p.page, 'Home base').locator('p.muted').last().click();
    await calm(p.page);
    S.check('clear: a tap elsewhere doesn\'t bring the bar up', !(await barUp(p.page)));
    // The saved snapshot: home blank, everything else as it was.
    await field(p.page, 'Avg ticket').fill('18.75');
    await calm(p.page);
    const upAfterEdit = await barUp(p.page);
    await field(p.page, 'Avg ticket').fill(ticket);
    await calm(p.page);
    S.check('clear: another field changed and changed back takes the bar up and down again', upAfterEdit && !(await barUp(p.page)), `up after edit ${upAfterEdit}`);
    await field(p.page, 'Label').fill(OTHER.label);
    await calm(p.page);
    const upWithOld = await barUp(p.page);
    await field(p.page, 'Label').fill('');
    await calm(p.page);
    S.check('clear: the old home typed back counts as a change, blank again doesn\'t', upWithOld && !(await barUp(p.page)), `up with the old label ${upWithOld}`);
    const after = await getSettings();
    const rest = (s) => JSON.stringify({ ...s, home: null });
    S.check('clear: the server has no home base and the rest as it was', after.home?.label == null && after.home?.lat == null && after.home?.lng == null && rest(after) === rest(before), JSON.stringify(after.home));
    noErrors('clear', p);
  } finally { await p.ctx.close(); }
});

await S.step('edited: another field changed, then a look-up of the saved place and Clear', async () => {
  await saveHome({ ...C.HOME });
  const p = await settings();
  try {
    await field(p.page, 'Avg ticket').fill('17.75');
    await calm(p.page);
    S.check('edited: the bar is up for the changed field', await barUp(p.page));
    await lookUp(p.page, 'Testville');
    await statusIs(p.page, /^Found /);
    await calm(p.page);
    S.check('edited: it stays up through a look-up of the place already saved', await barUp(p.page));
    await clearHome(p.page);
    S.check('edited: it stays up through Clear home base', await barUp(p.page));
    const r = await pressSave(p.page);
    const s = await getSettings();
    S.check('edited: Save stores that field', r.clicked && r.status === 200 && s.avgTicketPrice === 17.75 && s.home?.lat == null, `${r.why || r.status} ${s.avgTicketPrice} ${JSON.stringify(s.home)}`);
    await calm(p.page);
    S.check('edited: the bar goes down once saved', !(await barUp(p.page)));
    noErrors('edited', p);
  } finally { await p.ctx.close(); }
});

// ------------------------------------------------------------------ keep
await S.step('keep: what already worked', async () => {
  await saveHome(OTHER);
  let p = await settings();
  try {
    await lookUp(p.page, 'two Testvilles');
    await statusIs(p.page, /^More than one/);
    await card(p.page, 'Home base').locator('.theatre-results button', { hasText: 'Use' }).nth(1).click();
    await calm(p.page);
    S.check('keep: several matches and Use fill the fields and show the bar', (await homeFields(p.page)).lat === '40.5' && await barUp(p.page));
    noErrors('keep: several', p);
  } finally { await p.ctx.close(); }

  p = await settings();
  try {
    await lookUp(p.page, 'nowhere at all');
    await statusIs(p.page, /^Nothing found/);
    await calm(p.page);
    S.check('keep: nothing found leaves the fields and the bar down', (await homeFields(p.page)).label === OTHER.label && !(await barUp(p.page)));
    await field(p.page, 'Avg ticket').fill('19.25');
    await calm(p.page);
    await lookUp(p.page, 'nowhere at all');
    await statusIs(p.page, /^Nothing found/);
    await calm(p.page);
    S.check('keep: nothing found leaves the bar up when it was up', await barUp(p.page));
    noErrors('keep: nothing found', p);
  } finally { await p.ctx.close(); }

  p = await settings();
  try {
    // The look-up service can't be reached: a 502 like the server's own.
    await p.page.route((u) => u.pathname === '/api/geocode', (r) => r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Couldn\'t reach the place lookup.' }) }));
    await lookUp(p.page, 'Testville');
    await statusIs(p.page, /unchanged/);
    await calm(p.page);
    S.check('keep: a failed look-up leaves the fields and the bar down', (await homeFields(p.page)).label === OTHER.label && !(await barUp(p.page)));
    await field(p.page, 'Avg ticket').fill('19.25');
    await calm(p.page);
    await lookUp(p.page, 'Testville again');
    await statusIs(p.page, /unchanged/);
    await calm(p.page);
    S.check('keep: a failed look-up leaves the bar up when it was up', await barUp(p.page));
    noErrors('keep: failed', p);
  } finally { await p.ctx.close(); }

  await saveHome({ ...C.HOME });
  p = await settings();
  try {
    await lookUp(p.page, 'Testville');
    await statusIs(p.page, /^Found /);
    await calm(p.page);
    S.check('keep: a look-up of the place already saved leaves the bar down', !(await barUp(p.page)));
    noErrors('keep: same place', p);
  } finally { await p.ctx.close(); }
});

// ------------------------------------------------------------------ enter
await S.step('enter: a real Enter in the look-up box', async () => {
  await saveHome(OTHER);
  let p = await settings();
  try {
    const inBox = await enterLookUp(p.page, 'Testville');
    S.check('enter: the focus is in the look-up box when Enter is pressed', inBox);
    await statusIs(p.page, /^Found /);
    await calm(p.page);
    const f = await homeFields(p.page);
    S.check('enter: one match: the fields hold the place it found', f.label === C.HOME.label && f.lat === String(C.HOME.lat) && f.lng === String(C.HOME.lng), JSON.stringify(f));
    const at = await focusNow(p.page);
    S.check('enter: one match: the focus leaves the box for a visible element that isn\'t a field', leftBox(at), say(at));
    S.check('enter: one match: where the focus lands has a ring, is on screen and isn\'t behind a bar', stopOk(at), say(at));
    S.check('enter: one match: the Save bar is showing', await barUp(p.page));
    noErrors('enter: one match', p);
  } finally { await p.ctx.close(); }

  p = await settings();
  try {
    await enterLookUp(p.page, 'two Testvilles');
    await statusIs(p.page, /^More than one/);
    await calm(p.page);
    const at = await focusNow(p.page);
    S.check('enter: several: the focus leaves the box for a visible element that isn\'t a field', leftBox(at), say(at));
    S.check('enter: several: where the focus lands has a ring, is on screen and isn\'t behind a bar', stopOk(at), say(at));
    S.check('enter: several: the bar stays down while I pick', !(await barUp(p.page)));
    await p.page.keyboard.press('Tab');
    const next = await p.page.evaluate(() => window.__a11y.desc(document.activeElement));
    S.check('enter: several: Tab from the focus reaches the first Use', /^button.*"Use"$/.test(next), next);
    await card(p.page, 'Home base').locator('.theatre-results button', { hasText: 'Use' }).nth(1).click();
    await calm(p.page);
    S.check('enter: several: Use fills the fields and shows the bar', (await homeFields(p.page)).lat === '40.5' && await barUp(p.page));
    noErrors('enter: several', p);
  } finally { await p.ctx.close(); }

  p = await settings();
  try {
    await enterLookUp(p.page, 'nowhere at all');
    await statusIs(p.page, /^Nothing found/);
    await calm(p.page);
    const at = await focusNow(p.page);
    S.check('enter: nothing found: the focus is still in the box', at.inBox, say(at));
    S.check('enter: nothing found: the fields and the bar stay as they were', (await homeFields(p.page)).label === OTHER.label && !(await barUp(p.page)));
    noErrors('enter: nothing found', p);
  } finally { await p.ctx.close(); }

  p = await settings();
  try {
    await p.page.route((u) => u.pathname === '/api/geocode', (r) => r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Couldn\'t reach the place lookup.' }) }));
    await enterLookUp(p.page, 'Testville');
    await statusIs(p.page, /unchanged/);
    await calm(p.page);
    const at = await focusNow(p.page);
    S.check('enter: a failed look-up: the focus is still in the box', at.inBox, say(at));
    noErrors('enter: failed', p);
  } finally { await p.ctx.close(); }

  // A tap on Look up: the focus goes where the tap put it and stays there.
  p = await settings();
  try {
    await lookUp(p.page, 'Testville');
    const tapped = await p.page.evaluate(() => { window.__tapped = document.activeElement; return window.__a11y.desc(document.activeElement); });
    await statusIs(p.page, /^Found /);
    await calm(p.page);
    const after = await p.page.evaluate(() => ({ same: document.activeElement === window.__tapped, desc: window.__a11y.desc(document.activeElement) }));
    S.check('tap: a tap on Look up leaves the focus where the tap put it', after.same && !/geo-status/.test(after.desc), `${tapped} -> ${after.desc}`);
    S.check('tap: the Save bar is showing', await barUp(p.page));
    noErrors('tap', p);
  } finally { await p.ctx.close(); }
});

await browser.close();
await w.close();
S.finish();
