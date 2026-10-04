// Roles (decisions D7 g-railway, person search S7 g-guest API parts, and the
// invite flow from old G6).
//
// Railway (Railway's own variables faked with test values): with GUEST_MODE
// missing or not 1 every visitor is the read-only guest, the owner token and
// friend logins still work, and the owner gets one alert per start (pushed to
// their device); with GUEST_MODE=1 the same, with no alert. Locally,
// localhost is the owner and no alert goes out.
//
// The guest: no search or recents, a person page read only (no one's ratings
// or watchlist, the owner's still there for the owner), every write 403.
//
// Invites: opening a link (any user agent, GET or HEAD) never redeems it;
// only a same-origin POST to /invite/join does, once; revoking ends the
// session at once; a re-issued link replaces older ones; a tampered cookie is
// nobody.
import { suite } from '../lib/check.mjs';
import { openWorld, until, sleep, GUEST } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('roles');
const TOKEN = 'roles-test-owner-token-0123456789abcdef';
const w = S.world(await openWorld('roles', { push: true, env: { OWNER_TOKEN: TOKEN, GUEST_MODE: '' } }));
const base = () => w.base;
const RAILWAY = { RAILWAY_ENVIRONMENT_NAME: 'production', RAILWAY_PROJECT_ID: 'test-project-id', OWNER_TOKEN: TOKEN };
const alerts = () => w.q("SELECT * FROM owner_alerts WHERE problem = 'guestmode' AND kind = 'problem' ORDER BY id");
const pushes = () => w.push.hits.filter((h) => h.name === 'owner' && /alert-guestmode/.test(h.topic));

async function ownerCookie() {
  const r = await fetch(`${base()}/?owner=${TOKEN}`, { redirect: 'manual' });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
async function friendVia(ownerHeaders, name) {
  const r = await w.api('POST', '/api/friends', { headers: { ...ownerHeaders, origin: base() }, body: { name } });
  const token = r.json?.invite ? new URL(r.json.invite, 'http://x').searchParams.get('invite') : null;
  const j = await fetch(`${base()}/invite/join`, { method: 'POST', redirect: 'manual', headers: { origin: base(), 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${token}` });
  return { status: r.status, cookie: (j.headers.get('set-cookie') || '').split(';')[0] };
}
const status = async (headers = {}) => (await w.api('GET', '/api/status', { headers })).json;

// ---------------------------------------------------------------- local
await S.step('locally, localhost is the owner and no guest-mode alert goes out', async () => {
  const st = await status();
  S.check('local: localhost is the owner', st?.user?.isOwner === true && st?.guest === false);
  S.check('local: the owner can write', (await w.api('PUT', '/api/settings', { body: { previewsMinutes: 20 } })).status === 200);
  S.check('local: owner-only reads work', (await w.api('GET', '/api/friends')).status === 200);
  const g = await status(GUEST);
  S.check('local: a tunnel visitor is the guest', g?.guest === true && !g.user);
  S.check('local: no guest-mode alert', alerts().length === 0);
});

// ---------------------------------------------------------------- the guest
await S.step('the guest reads a person page with no one\'s ratings, and writes nothing', async () => {
  const PID = C.PEOPLE.ada.id;
  const mine = (await w.api('GET', `/api/person/${PID}`)).json;
  const rated = mine.rated[0];
  S.check('setup: the owner has rated one of the person\'s films', Boolean(rated));
  const g = await w.api('GET', `/api/person/${PID}`, { as: GUEST });
  S.check('guest GET /api/person is allowed', g.status === 200 && g.json?.person?.id === PID, `${g.status}`);
  const all = g.json ? [...g.json.playing, ...g.json.rated, ...g.json.directed, ...g.json.acted, ...g.json.actedSmaller] : [];
  S.check('the guest gets no ratings and no watchlist, not even empty marks', g.json && !g.json.rated.length && all.every((f) => !('myRating' in f) && !('watchlisted' in f)) && all.some((f) => f.tmdb_id === rated?.tmdb_id));
  S.check('the owner still has their rating (control)', (await w.api('GET', `/api/person/${PID}`)).json.rated.some((f) => f.tmdb_id === rated?.tmdb_id && f.myRating === rated.myRating));
  S.check('guest /api/search is 403', (await w.api('GET', '/api/search?q=lindqvist', { as: GUEST })).status === 403);
  S.check('guest recents are 403', (await w.api('GET', '/api/search/recents', { as: GUEST })).status === 403);
  S.check('guest /api/providers is 403', (await w.api('GET', `/api/providers?ids=${rated?.tmdb_id}`, { as: GUEST })).status === 403);
  const writes = [['POST', '/api/ratings', { tmdb_id: rated?.tmdb_id, rating: 1 }], ['DELETE', `/api/ratings/${rated?.tmdb_id}`], ['POST', '/api/watchlist/toggle', { tmdb_id: rated?.tmdb_id }],
    ['POST', '/api/search/recents', { person: { id: PID, name: 'x' } }], ['POST', '/api/hidden', { tmdb_id: rated?.tmdb_id }], ['POST', '/api/watched', { tmdb_id: rated?.tmdb_id }],
    ['PUT', '/api/settings', { previewsMinutes: 5 }], ['POST', '/api/refresh', {}], ['POST', '/api/friends', { name: 'x' }], ['PUT', '/api/letterboxd', { username: 'x' }]];
  for (const [m, p, body] of writes) {
    const r = await w.api(m, p, { as: GUEST, body });
    S.check(`guest ${m} ${p.replace(/\d{5,}/, '<id>')} is 403`, r.status === 403, `${r.status}`);
  }
  S.check('the owner\'s rating survived the guest\'s writes', w.q1('SELECT rating FROM ratings WHERE user_id = 1 AND tmdb_id = ?', rated?.tmdb_id)?.rating === rated?.myRating);
  const unknown = await w.api('GET', '/api/person/59999', { as: GUEST });
  S.check('guest: a person TMDB doesn\'t know is a plain 404', unknown.status === 404, `${unknown.status}`);
});

// ---------------------------------------------------------------- invites
await S.step('the invite flow', async () => {
  const mk = async (name) => {
    const r = await w.api('POST', '/api/friends', { body: { name } });
    return { id: r.json.friend.id, token: new URL(r.json.invite, 'http://x').searchParams.get('invite') };
  };
  const join = (token, headers = {}) => fetch(`${base()}/invite/join`, {
    method: 'POST', redirect: 'manual', headers: { 'cf-ray': 'test', 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: `token=${token}`,
  });
  const D = await mk('Invite Test');
  const UAS = ['facebookexternalhit/1.1 Facebot Twitterbot/1.0', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'WhatsApp/2.23.20.0', 'TelegramBot (like TwitterBot)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'curl/8.4.0', 'Googlebot/2.1'];
  for (const ua of UAS) {
    for (const m of ['GET', 'HEAD']) {
      const r = await fetch(`${base()}/?invite=${D.token}`, { method: m, redirect: 'manual', headers: { 'cf-ray': 'test', 'user-agent': ua } });
      const text = await r.text();
      S.check(`${m} invite link as "${ua.slice(0, 24)}" shows the Join page and sets no cookie`, r.status === 200 && !r.headers.get('set-cookie') && (m === 'HEAD' || /<form/i.test(text)), `${r.status}`);
      if (m === 'GET') {
        S.check('the invite page sends Referrer-Policy: no-referrer', r.headers.get('referrer-policy') === 'no-referrer');
        S.check('the invite page is Cache-Control: no-store', /no-store/.test(r.headers.get('cache-control') || ''));
      }
    }
  }
  const pending = async () => (await w.api('GET', '/api/friends')).json.friends.find((f) => f.id === D.id)?.invite_pending;
  S.check('previews did not use the invite', await pending() === true);
  const bad = [
    [{}, 'no Origin or Referer'], [{ origin: 'https://evil.example' }, 'another site\'s Origin'], [{ referer: 'https://evil.example/x' }, 'another site\'s Referer'],
    [{ 'sec-fetch-site': 'cross-site', origin: base() }, 'Sec-Fetch-Site cross-site'], [{ 'sec-fetch-site': 'same-site' }, 'Sec-Fetch-Site same-site'],
    [{ 'sec-fetch-site': 'none' }, 'Sec-Fetch-Site none'], [{ origin: 'null' }, 'Origin null'],
  ];
  for (const [h, why] of bad) {
    const r = await join(D.token, h);
    S.check(`invite join is refused with ${why}`, r.status === 403 && !r.headers.get('set-cookie'), `${r.status}`);
  }
  S.check('refused joins did not burn the invite', await pending() === true);
  const ok = await join(D.token, { origin: base() });
  const cookieD = (ok.headers.get('set-cookie') || '').split(';')[0];
  S.check('a same-origin join works and goes to onboarding', ok.status === 303 && cookieD.startsWith('rp_user=') && /onboarding/.test(ok.headers.get('location') || ''), `${ok.status} ${ok.headers.get('location')}`);
  const again = await join(D.token, { origin: base() });
  S.check('a used invite is refused', again.status === 410 && !again.headers.get('set-cookie'), `${again.status}`);
  const reget = await fetch(`${base()}/?invite=${D.token}`, { headers: { 'cf-ray': 'test' } });
  const regetText = await reget.text();
  S.check('a used invite shows the expired page and doesn\'t echo the token', reget.status === 410 && !regetText.includes(D.token), `${reget.status}`);
  const junk = await fetch(`${base()}/?invite=${encodeURIComponent('<script>alert(1)</script>')}`, { headers: { 'cf-ray': 'test' } });
  S.check('a junk invite token is not echoed', !(await junk.text()).includes('<script>alert'));
  const ownerOpen = await fetch(`${base()}/?invite=${D.token}`, { redirect: 'manual' });
  S.check('the owner opening an invite link is sent to Settings, never redeems', ownerOpen.status === 302 && /settings/.test(ownerOpen.headers.get('location') || ''), `${ownerOpen.status}`);
  const DH = { headers: { 'cf-ray': 'test', cookie: cookieD } };
  S.check('the joined friend works', (await w.api('GET', '/api/ratings', { as: DH })).status === 200);
  await w.api('POST', `/api/friends/${D.id}/revoke`);
  S.check('a revoked friend is refused on the next request', (await w.api('GET', '/api/ratings', { as: DH })).status === 403);
  S.check('a revoked friend is only a guest', (await w.api('GET', '/api/status', { as: DH })).json?.guest === true);
  const r1 = await w.api('POST', `/api/friends/${D.id}/reissue`);
  const t1 = new URL(r1.json.invite, 'http://x').searchParams.get('invite');
  const r2 = await w.api('POST', `/api/friends/${D.id}/reissue`);
  const t2 = new URL(r2.json.invite, 'http://x').searchParams.get('invite');
  S.check('re-issuing doesn\'t revive the old cookie', (await w.api('GET', '/api/ratings', { as: DH })).status === 403);
  S.check('a superseded re-issued link is dead', (await join(t1, { origin: base() })).status === 410);
  const nj = await join(t2, { origin: base() });
  const cookieD2 = (nj.headers.get('set-cookie') || '').split(';')[0];
  S.check('the newest re-issued link works', nj.status === 303 && cookieD2.startsWith('rp_user='), `${nj.status}`);
  S.check('the new session works', (await w.api('GET', '/api/ratings', { as: { headers: { 'cf-ray': 'test', cookie: cookieD2 } } })).status === 200);
  const forged = cookieD2.replace(/\.(\d+)\.(\d+)\./, (m, v, e) => `.${Number(v) + 1}.${e}.`);
  S.check('a tampered friend cookie is refused', (await w.api('GET', '/api/ratings', { as: { headers: { 'cf-ray': 'test', cookie: forged } } })).status === 403);
  // The cookie names the friend by handle (v2); an old-kind one naming user 1
  // with the same version, expiry and signature must not pass.
  const [, , ver2, exp2, sig2] = decodeURIComponent(cookieD2.slice('rp_user='.length)).split('.');
  const ownerAs = `rp_user=v1.1.${ver2}.${exp2}.${sig2}`;
  S.check('the new session\'s cookie is the handle kind', cookieD2.startsWith('rp_user=v2.'));
  S.check('a friend cookie edited to user 1 is refused', (await w.api('GET', '/api/friends', { as: { headers: { 'cf-ray': 'test', cookie: ownerAs } } })).status === 403);
});

// ---------------------------------------------------------------- Railway, GUEST_MODE missing
await S.step('on Railway with GUEST_MODE missing, everyone is the guest', async () => {
  await w.restart({ env: { ...RAILWAY } });
  const plain = await status();
  S.check('Railway, GUEST_MODE missing: a plain visitor is the guest', plain?.guest === true, JSON.stringify({ guest: plain?.guest, user: plain?.user }));
  S.check('Railway, GUEST_MODE missing: a plain visitor can\'t write', (await w.api('PUT', '/api/settings', { body: { previewsMinutes: 5 } })).status === 403);
  S.check('Railway, GUEST_MODE missing: owner-only reads are refused', (await w.api('GET', '/api/friends')).status === 403);
  const oc = await ownerCookie();
  const oh = { cookie: oc };
  const ost = await status(oh);
  S.check('the owner token still unlocks the owner', oc.startsWith('rp_owner=') && ost?.user?.isOwner === true && !ost.guest);
  S.check('the owner can still write', (await w.api('PUT', '/api/settings', { headers: { ...oh, origin: base() }, body: { previewsMinutes: 20 } })).status === 200);
  const fr = await friendVia(oh, 'Rail Friend');
  const fst = await status({ cookie: fr.cookie });
  S.check('friend logins still work', fr.status === 200 && fr.cookie.startsWith('rp_user=') && fst?.guest === false && fst?.user?.isOwner === false);
  S.check('a known friend is still themselves on Railway', (await status(w.friends.robin.headers))?.user?.name === 'Robin');
  await until(() => alerts().length >= 1, 5000);
  S.check('one owner alert on this start', alerts().length === 1, alerts().map((a) => a.message).join(' | '));
  S.check('the alert says what to set, and nothing secret', /GUEST_MODE/.test(alerts()[0]?.message || '') && !(alerts()[0]?.message || '').includes(TOKEN));
  const sub = await w.api('POST', '/api/push/subscribe', { headers: { ...oh, origin: base() }, body: { subscription: w.push.newSub('owner') } });
  S.check('setup: the owner\'s device is subscribed', sub.status === 200, `${sub.status} ${sub.text.slice(0, 80)}`);
  await sleep(1200);
  S.check('still one alert later on the same start', alerts().length === 1);
});
await S.step('a restart sends the alert once more, to the owner\'s device', async () => {
  await w.restart({ env: { ...RAILWAY } });
  await until(() => alerts().length >= 2 && pushes().length >= 1, 8000);
  await sleep(800);
  S.check('a restart alerts once more, pushed once', alerts().length === 2 && pushes().length === 1, `${alerts().length} alerts, ${pushes().length} pushes`);
  S.check('the push is the owner alert', /GUEST_MODE/.test(pushes()[0]?.msg?.body || ''), pushes()[0]?.msg?.title);
});
await S.step('GUEST_MODE=0 is "not 1"', async () => {
  await w.restart({ env: { ...RAILWAY, GUEST_MODE: '0' } });
  await until(() => alerts().length >= 3, 5000);
  S.check('Railway, GUEST_MODE=0: every visitor is the guest and the alert goes out', (await status())?.guest === true && alerts().length === 3);
});
await S.step('on Railway with GUEST_MODE=1 nothing changes and no alert goes out', async () => {
  await w.restart({ env: { ...RAILWAY, GUEST_MODE: '1' } });
  await sleep(1500);
  S.check('Railway, GUEST_MODE=1: a plain visitor is the guest', (await status())?.guest === true);
  S.check('Railway, GUEST_MODE=1: the owner token works', (await status({ cookie: await ownerCookie() }))?.user?.isOwner === true);
  S.check('Railway, GUEST_MODE=1: no new alert', alerts().length === 3);
});
await S.step('back off Railway, localhost is the owner again with no alert', async () => {
  const before = alerts().length;
  await w.restart({ env: { GUEST_MODE: '' } });
  await sleep(800);
  S.check('local again: localhost is the owner', (await status())?.user?.isOwner === true);
  S.check('local again: no guest-mode alert', alerts().length === before);
});

await w.close();
S.finish();
