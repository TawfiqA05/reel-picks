// No built-in home base: a new friend starts with none, sees no drive time
// anywhere, and every page still answers; setting a home base brings the
// drive times, clearing it takes them away again. The owner's own home base
// and the guest are untouched.
import { suite } from '../lib/check.mjs';
import { openWorld, makeFriend, until } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('nohome');
const w = S.world(await openWorld('nohome'));
const as = (f) => ({ as: f });
const distances = (j) => [...(j?.theatres || []), ...(j?.theatre ? [j.theatre] : [])].map((t) => t.distance ?? null);
const recDistances = (j) => [...(j?.weekly4 || []), ...(j?.worthSeeing || []), ...(j?.list || [])].flatMap((e) => [e.theatre?.distance ?? null, ...(e.theatres || []).map((t) => t.distance ?? null)]);

const nf = await makeFriend(w.base, 'Avery');
await w.api('POST', '/api/theatre', { ...as(nf), body: { id: '9101', name: 'AMC Maple Grove 12', slug: 'amc-maple-grove-12' } });
await w.api('PUT', '/api/settings', { ...as(nf), body: { setupDone: true, tourDone: true, youNoteSeen: true, onboardingDone: true } });

await S.step('a new friend has no home base', async () => {
  const st = (await w.api('GET', '/api/status', as(nf))).json;
  S.check('status: no home base', st && st.home === null, JSON.stringify(st?.home));
  S.check('status: no drive time to their theater', distances(st).length > 0 && distances(st).every((d) => d === null), JSON.stringify(distances(st)));
  const s = (await w.api('GET', '/api/settings', as(nf))).json;
  S.check('settings: the home base is empty', s?.home && s.home.label === null && s.home.lat === null && s.home.lng === null, JSON.stringify(s?.home));
  // Settings' Save sends the empty home base back as it is.
  const save = await w.api('PUT', '/api/settings', { ...as(nf), body: { home: { label: null, lat: null, lng: null }, avgTicketPrice: 12.5 } });
  S.check('saving Settings with no home base works and keeps none', save.status === 200 && save.json?.avgTicketPrice === 12.5 && save.json?.home?.lat === null, `${save.status} ${save.text.slice(0, 120)}`);
  S.check('a label that is not text is still refused', (await w.api('PUT', '/api/settings', { ...as(nf), body: { home: { label: 5 } } })).status === 400);
});

await S.step('every page answers without a home base', async () => {
  const rec = await w.api('GET', '/api/recommendations', as(nf));
  S.check('Picks answers, with no drive time on any film', rec.status === 200 && recDistances(rec.json).every((d) => d === null), `${rec.status}`);
  const id = rec.json?.weekly4?.[0]?.tmdb_id || C.PLAYING[0].id;
  const mv = await w.api('GET', `/api/movies/${id}`, as(nf));
  S.check('a movie page answers, with no drive time', mv.status === 200 && (mv.json?.theatres || []).every((t) => t.distance == null), `${mv.status}`);
  for (const [what, m, p, body] of [['Schedule: Coming soon', 'GET', '/api/coming-soon'], ['At home', 'GET', '/api/home-picks'],
    ['What should I watch?', 'POST', '/api/suggest', { where: 'either', time: 'any', mood: 'surprise', exclude: [] }], ['Stats', 'GET', '/api/stats'], ['Together', 'GET', '/api/together']]) {
    const r = await w.api(m, p, { ...as(nf), body });
    S.check(`${what} answers`, r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
  }
  S.check('no server error was logged', !/\n\s*(TypeError|ReferenceError)|Cannot read properties of null/.test(w.srv.log()), w.srv.log().split('\n').filter((l) => /Error|null/.test(l)).slice(0, 3).join(' | '));
});

await S.step('setting a home base brings drive times; clearing it takes them away', async () => {
  const put = await w.api('PUT', '/api/settings', { ...as(nf), body: { home: C.HOME } });
  S.check('the home base saves', put.status === 200 && put.json?.home?.label === C.HOME.label, `${put.status}`);
  const st = await until(async () => { const j = (await w.api('GET', '/api/status', as(nf))).json; return distances(j).some((d) => d) && j; }, 20000);
  S.check('status: the home base and a drive time show', st && st.home?.label === C.HOME.label && distances(st).some((d) => d?.label), JSON.stringify(st?.home));
  const del = await w.api('DELETE', '/api/home', as(nf));
  S.check('Clear home base answers with no home base', del.status === 200 && del.json?.cleared === true && del.json.home === null, del.text.slice(0, 120));
  const after = (await w.api('GET', '/api/status', as(nf))).json;
  S.check('status: no home base and no drive time again', after.home === null && distances(after).every((d) => d === null), JSON.stringify(distances(after)));
});

await S.step('the owner and the guest are untouched', async () => {
  const st = (await w.api('GET', '/api/status')).json;
  S.check('the owner keeps their own home base', st.home?.label === C.HOME.label && st.home.lat === C.HOME.lat && st.home.lng === C.HOME.lng, JSON.stringify(st.home));
  const g = (await w.api('GET', '/api/status', { as: w.GUEST })).json;
  S.check('the guest gets no home base and no drive time', g && !('home' in g && g.home) && distances(g).every((d) => d === null));
});

await S.step('the recap answers without a home base (in December)', async () => {
  await w.api('DELETE', '/api/home', as(nf));
  await w.jump('2026-12-05T20:00:00-05:00');
  const r = await w.api('GET', '/api/year', as(nf));
  S.check('the recap answers', r.status === 200 && r.json && !/lat|lng|distance/.test(r.text), `${r.status} ${r.text.slice(0, 120)}`);
});

await w.close();
S.finish();
