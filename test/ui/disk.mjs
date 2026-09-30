// The data volume line in Settings > Data (public/js/views/settings.js):
//
//   owner    one line with space used and free on the data volume, the live
//            database and the backups, matching what the server measures of
//            its own folder; the backup line says 7 nightly and 3 from
//            before updates are kept; over 80% full the line is marked
//   others   friends and the guest see no disk line, and no backup line
//   clean    no console error, failed request or sideways scroll at 320,
//            390 and 1280
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld, until } from '../lib/world.mjs';
import { launch, open, settle } from '../lib/browser.mjs';

const S = suite('disk');
const w = S.world(await openWorld('disk'));
const F = w.friends;
const MB = 1024 * 1024;
const browser = await launch();
// Plant two backups so the total is more than the database alone.
const BK = path.join(w.dataDir, 'backups');
fs.mkdirSync(BK, { recursive: true });
for (const d of ['2026-09-21', '2026-09-22']) fs.writeFileSync(path.join(BK, `reelpicks-${d}.db`), Buffer.alloc(3 * MB, 1));
const du = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? du(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
const size = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n < 10485760 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1048576)} MB`);
const line = async (p) => { await p.page.waitForSelector('.disk-line', { timeout: 3000 }).catch(() => {}); return p.page.locator('.disk-line').first().innerText().catch(() => null); };
const load = async (p) => { await p.page.goto('about:blank'); await p.page.goto(`${w.base}/#/settings`); await settle(p.page, 900); };

await S.step('owner: one plain line with the volume, the database and the backups', async () => {
  const total = 2 * 1024 * MB;
  w.ctrl.disk = { total, other: 300 * MB }; w.writeCtrl();
  for (const width of [320, 390, 1280]) {
    const p = await open(browser, w, { width });
    // The status the page itself read (the WAL grows from one read to the next).
    let pageSt = null;
    p.page.on('response', async (r) => { if (new URL(r.url()).pathname === '/api/status') { try { pageSt = (await r.json()).disk; } catch { /* gone */ } } });
    await load(p);
    const text = await line(p);
    const st = pageSt;
    const files = fs.readdirSync(BK).reduce((n, f) => n + fs.statSync(path.join(BK, f)).size, 0);
    const want = `Data volume: ${size(st.used)} used, ${size(st.free)} free of ${size(st.total)}. Database ${size(st.dbBytes)}, backups ${size(st.backups.bytes)}.`;
    S.check(`owner: the line reads used, free, total, database and backups (${width})`, text === want, `${text} vs ${want}`);
    // The server's figures are the volume the test set and the folder itself.
    const used = du(w.dataDir) + 300 * MB;
    S.check(`owner: the figures match the data folder (${width})`, st.total === Math.floor(total / 4096) * 4096 && Math.abs(st.used - used) < 2 * MB && st.backups.bytes === files && st.backups.count === fs.readdirSync(BK).filter((f) => /^reelpicks-\d{4}-\d{2}-\d{2}\.db$/.test(f)).length
      && Math.abs(st.dbBytes - ['', '-wal', '-shm'].reduce((n, x) => n + (fs.existsSync(w.dbFile + x) ? fs.statSync(w.dbFile + x).size : 0), 0)) < MB, JSON.stringify(st));
    const bk = await p.page.locator('.group', { hasText: 'Export full setup' }).innerText();
    S.check(`owner: the backup line says 7 nightly and 3 from before updates, and no 14 (${width})`, /newest 7 nightly copies and 3 from before updates are kept/.test(bk) && !/last 14/.test(bk), bk.slice(0, 300));
    S.check(`owner: the line is plain, not marked, under 80% (${width})`, await p.page.locator('.disk-line .status-dot').count() === 0);
    S.check(`clean: no sideways scroll, console error or failed request (owner ${width})`, !(await p.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)) && !p.errors.length && !p.outside.length, [...p.errors, ...p.outside].join(' | '));
    await p.ctx.close();
  }
});

await S.step('owner: over 80% full the line is marked', async () => {
  const total = 1024 * MB;
  w.ctrl.disk = { total, other: Math.round(total * 0.9) - du(w.dataDir) }; w.writeCtrl();
  await until(async () => (await w.api('GET', '/api/status')).json.disk.pct > 80, 3000);
  const p = await open(browser, w, { width: 390 });
  await load(p);
  const text = await line(p);
  S.check('owner: over 80% the line carries a warning dot', await p.page.locator('.disk-line .status-dot.warn').count() === 1 && /Data volume: /.test(text || ''), text);
  await p.ctx.close();
  w.ctrl.disk = null; w.writeCtrl();
});

await S.step('friends and the guest see no disk or backup line', async () => {
  for (const [who, as] of [['robin', F.robin], ['jordan', F.jordan]]) {
    const p = await open(browser, w, { role: as, width: 390 });
    await load(p);
    if (!p.page.url().endsWith('#/settings')) await load(p);
    const body = await p.page.evaluate(() => document.body.innerText);
    S.check(`others: ${who} sees no disk line and no backup line`, await p.page.locator('.disk-line').count() === 0 && !/Data volume|automatic backup|Database \d/.test(body), body.match(/.*(Data volume|automatic backup).*/)?.[0]);
    S.check(`others: ${who}'s status has no disk figures`, !('disk' in ((await w.api('GET', '/api/status', { as })).json || {})));
    await p.ctx.close();
  }
  const g = await open(browser, w, { role: 'guest', width: 390, allow403: true });
  await g.page.goto(`${w.base}/#/settings`); await settle(g.page, 600);
  S.check('others: the guest sees no disk line', await g.page.locator('.disk-line').count() === 0 && !/Data volume/.test(await g.page.evaluate(() => document.body.innerText)));
  await g.ctx.close();
});

await browser.close();
await w.close();
S.finish();
