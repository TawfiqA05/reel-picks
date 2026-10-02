// No built-in theater: a fresh install starts with none picked. Every page
// still answers, the refresh looks nothing up by name and pulls no
// showtimes, and picking a theater the way Settings does it brings its
// showtimes in. A friend added after that starts on the owner's theater.
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { copyApp, tempDir, startServer, call, makeFriend, until } from '../lib/world.mjs';
import { amcMock } from '../lib/mocks.mjs';

const S = suite('notheater');
const dir = tempDir('notheater');
const dataDir = path.join(dir, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const app = copyApp(dir);
const amc = await amcMock();
const ctrl = path.join(dir, 'ctrl.json');
fs.writeFileSync(ctrl, JSON.stringify({ seq: 1, tmdb: 'ok', omdb: {} }));
const srv = await startServer({ app, dataDir, label: 'notheater', env: { RP_AMC_BASE: amc.origin, RP_CTRL_FILE: ctrl, RP_DISABLE_REFRESH: '0', RP_TIMEOUT_SCALE: '0.02' } });
const B = srv.base;
const settled = () => until(async () => { const s = (await call(B, 'GET', '/api/status')).json; return s && !s.refreshing && s.lastRefresh && s; }, 60000, 200);

try {
  await S.step('a fresh install has no theater', async () => {
    await settled();
    const s = (await call(B, 'GET', '/api/settings')).json;
    S.check('settings: no theater id, name or slug', s && s.theatreId === '' && s.theatreName === '' && s.theatreSlug === '', JSON.stringify([s?.theatreId, s?.theatreName, s?.theatreSlug]));
    const st = (await call(B, 'GET', '/api/status')).json;
    S.check('status: the theater has no id and no name', st?.theatre?.id === '' && st.theatre.name === '', JSON.stringify(st?.theatre));
    S.check('the refresh looked no theater up and pulled no showtimes', !amc.hits.some((h) => h.kind === 'theatres' || h.kind === 'showtimes'), JSON.stringify(amc.hits.map((h) => h.kind)));
    for (const p of ['/api/recommendations', '/api/coming-soon', '/api/stats', '/api/alist', '/api/home-picks']) {
      const r = await call(B, 'GET', p);
      S.check(`${p} answers`, r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
    }
    S.check('no server error was logged', !/TypeError|ReferenceError|Cannot read properties/.test(srv.log()), srv.log().split('\n').filter((l) => /Error/.test(l)).slice(0, 3).join(' | '));
  });

  await S.step('picking a theater the way Settings does brings its showtimes', async () => {
    const found = await call(B, 'GET', '/api/theatres?query=maple');
    S.check('theater search answers', found.status === 200 && found.json?.theatres?.some((t) => t.name === 'AMC Maple Grove 12'), `${found.status}`);
    const set = await call(B, 'POST', '/api/theatre', { body: { id: '9101', name: 'AMC Maple Grove 12', slug: 'amc-maple-grove-12' } });
    S.check('Set primary answers', set.status === 200, `${set.status} ${set.text.slice(0, 120)}`);
    const st = await until(async () => { const j = (await call(B, 'GET', '/api/status')).json; return j?.theatre?.id === '9101' && !j.refreshing && amc.hits.some((h) => h.kind === 'showtimes' && h.theatre === '9101') && j; }, 60000, 200);
    S.check('status names the theater and its showtimes were pulled', st && st.theatre.name === 'AMC Maple Grove 12', JSON.stringify(st?.theatre));
    const f = await makeFriend(B, 'Avery');
    const fs1 = (await call(B, 'GET', '/api/settings', { as: f })).json;
    S.check('a friend added now starts on the owner\'s theater', fs1?.theatreId === '9101' && fs1.theatreName === 'AMC Maple Grove 12', JSON.stringify([fs1?.theatreId, fs1?.theatreName]));
  });
} finally {
  await srv.stop();
  await amc.srv.shut();
  if (!process.env.RP_KEEP_TEMP) fs.rmSync(dir, { recursive: true, force: true });
}
S.finish();
