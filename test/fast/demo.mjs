// Demo mode (DEMO_MODE=1, server/demo/).
//
//   real data    the server is started with DATA_DIR pointing at a canary
//                database, a canary database at ./data too, a .env full of
//                canary values and canary keys in its environment, as if on
//                Railway with GUEST_MODE on. It must open neither database
//                (same bytes after, no -wal or -shm made), read no .env,
//                show no canary value anywhere, and make no outgoing
//                connection or name lookup at all while every page is used
//                (test/lib/demo-canary.mjs). Positive controls first: the same
//                recorder does see a normal server open DATA_DIR and read
//                .env, and does see a connection being made.
//   sample       a new visitor lands as Sam with about 150 ratings, a
//                watchlist, notes, an I'm going plan, a pick from Maya and
//                three made-up friends (Together pairs only the two opted in),
//                at the made-up theaters, with real films.
//   visitors     what one visitor does only they see; an hour later it's gone.
//   off          typed text, invites, theater changes, imports, backups,
//                push, owner alerts, the owner token and the guest view are
//                off; everything else answers.
//   crashes      a visitor cookie that isn't valid %-encoding, and a copy
//                that can't be made or dropped (a read-only folder standing
//                in for a full disk), each get an answer, and the demo keeps
//                running. Only ever sent to this local server.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { suite } from '../lib/check.mjs';
import { tempDir, copyApp, freePort, sleep, until } from '../lib/world.mjs';

const S = suite('demo');
const CANARY_PRELOAD = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'lib', 'demo-canary.mjs');
const dir = tempDir('demo');
const app = copyApp(dir);
const CAN = 'QZDEMOCANARY';
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const children = [];
process.on('exit', () => { for (const c of children) try { c.kill('SIGKILL'); } catch { /* gone */ } });

// A real-looking database at DATA_DIR and at the default ./data, with a
// canary owner and theater in it.
function canaryDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users VALUES(1, '${CAN}-OWNER');
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES('theatreName', '"${CAN} Theater"');`);
  d.close();
  return sha(file);
}
const dataDir = path.join(dir, 'realdata');
const realDb = path.join(dataDir, 'reelpicks.db');
const defaultDb = path.join(app, 'data', 'reelpicks.db');
const before = { real: canaryDb(realDb), def: canaryDb(defaultDb) };
fs.writeFileSync(path.join(app, '.env'), [
  `TMDB_API_KEY=${CAN}-dotenv-tmdb`, `OMDB_API_KEY=${CAN}-dotenv-omdb`, `AMC_API_KEY=${CAN}-dotenv-amc`,
  `OWNER_NAME=${CAN}-dotenv-owner`, `OWNER_TOKEN=${CAN}-dotenv-token-0123456789`, `DEMO_MODE=0`,
].join('\n'));

const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SystemRoot'];
const baseEnv = Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
const canaryEnv = {
  DATA_DIR: dataDir, TMDB_API_KEY: `${CAN}-env-tmdb`, OMDB_API_KEY: `${CAN}-env-omdb`, AMC_API_KEY: `${CAN}-env-amc`,
  OWNER_TOKEN: `${CAN}-env-token-0123456789abcdef`, OWNER_NAME: `${CAN}-env-owner`, GUEST_MODE: '1',
  RAILWAY_ENVIRONMENT: 'production', NODE_ENV: 'production',
  BACKUP_S3_ENDPOINT: 'https://s3.canary.invalid', BACKUP_S3_BUCKET: 'b', BACKUP_S3_KEY_ID: 'k', BACKUP_S3_SECRET: 's',
};

async function start(label, env, ready) {
  const port = await freePort();
  const log = path.join(dir, `canary-${label}.jsonl`);
  const out = { text: '' };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', `--import=${CANARY_PRELOAD}`, 'server/index.js'], {
    cwd: app, env: { ...baseEnv, ...env, PORT: String(port), RP_CANARY_LOG: log, RP_CANARY_CLOCK: path.join(dir, `clock-${label}`) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.on('data', (d) => { out.text += d; });
  child.stderr.on('data', (d) => { out.text += d; });
  const ok = await until(() => out.text.includes(ready) || child.exitCode != null, 60000, 50);
  if (!ok || child.exitCode != null) throw new Error(`${label} server did not start: ${out.text.slice(-1500)}`);
  const entries = () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return {
    base: `http://localhost:${port}`, out, entries, clock: (ms) => fs.writeFileSync(path.join(dir, `clock-${label}`), String(ms)),
    alive: () => child.exitCode == null && child.signalCode == null,
    stop: () => new Promise((r) => { if (child.exitCode != null) return r(); child.once('exit', r); child.kill('SIGTERM'); }),
  };
}

// One visitor: a cookie jar of one cookie.
function visitor(srv) {
  const v = { cookie: '', ids: [] };
  v.call = async (method, p, body) => {
    const res = await fetch(srv.base + p, {
      method, redirect: 'manual',
      headers: { ...(v.cookie ? { cookie: v.cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), origin: srv.base },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie') || '';
    const m = set.match(/rp_demo=([^;]+)/);
    if (m) { v.cookie = `rp_demo=${m[1]}`; v.ids.push(m[1]); }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers, setCookie: set };
  };
  return v;
}

const transcript = [];
const keepText = (r) => { transcript.push(r.text); return r; };

// ================================================================ controls
await S.step('controls: the recorder sees what it is meant to catch', async () => {
  const controlData = path.join(dir, 'controldata');
  const normal = await start('normal', { ...canaryEnv, DATA_DIR: controlData, TMDB_API_KEY: '', OMDB_API_KEY: '', AMC_API_KEY: '', DEMO_MODE: '', RP_DISABLE_REFRESH: '1', BACKUP_S3_ENDPOINT: '' }, 'Reel Picks running');
  await sleep(300);
  const e = normal.entries();
  await normal.stop();
  S.check('control: a normal server is seen opening DATA_DIR/reelpicks.db', e.some((x) => x.kind === 'db' && path.resolve(x.path) === path.join(controlData, 'reelpicks.db')), JSON.stringify(e.filter((x) => x.kind === 'db')));
  S.check('control: a normal server is seen reading .env', e.some((x) => x.kind === 'read'));
  // The network hook: a fetch to an address nobody answers (no DNS, no traffic past this machine's router).
  const log = path.join(dir, 'canary-control.jsonl');
  await new Promise((r) => {
    const c = spawn(process.execPath, [`--import=${CANARY_PRELOAD}`, '-e', "fetch('http://192.0.2.1/', { signal: AbortSignal.timeout(300) }).catch(() => {})"], { env: { ...baseEnv, RP_CANARY_LOG: log }, stdio: 'ignore' });
    c.on('exit', r);
  });
  const n = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  S.check('control: an outgoing connection is seen', n.some((x) => x.kind === 'net' && x.host === '192.0.2.1'), JSON.stringify(n));
  S.check('control: the canary databases are untouched so far', sha(realDb) === before.real && sha(defaultDb) === before.def);
});

// ================================================================ the demo
const srv = await start('demo', { ...canaryEnv, DEMO_MODE: '1' }, 'Demo sample ready');
const A = visitor(srv);
const B = visitor(srv);

await S.step('sample: a new visitor lands as Sam with everything in place', async () => {
  const st = keepText(await A.call('GET', '/api/status'));
  S.check('status answers 200 and sets a visitor cookie', st.status === 200 && /rp_demo=/.test(st.setCookie) && /HttpOnly/i.test(st.setCookie), `${st.status} ${st.setCookie}`);
  S.check('the visitor is Sam, the owner of their copy, not the guest', st.json?.user?.name === 'Sam' && st.json?.user?.isOwner === true && st.json?.guest === false);
  S.check('status says demo and carries none of the server\'s diagnostics', st.json?.demo === true && !('keyMeta' in st.json) && !('data' in st.json) && !('backup' in st.json) && !('disk' in st.json));
  S.check('status says every source is there (the snapshot answers)', st.json?.keys?.tmdb && st.json?.keys?.omdb && st.json?.keys?.amc);
  S.check('the theaters are the made-up ones', st.json?.theatres?.map((t) => t.name).join('|') === 'Riverside 12|Northgate 8', JSON.stringify(st.json?.theatres));
  S.check('home base is the made-up town', st.json?.home?.label === 'Maple Hollow');
  const rec = keepText(await A.call('GET', '/api/recommendations')).json;
  S.check('there is a weekly four of real films', rec?.weekly4?.length === 4 && rec.weekly4.every((f) => f.title && /^https:\/\/image\.tmdb\.org\//.test(f.poster || '')), JSON.stringify(rec?.weekly4?.map((f) => f.title)));
  const days = rec?.days || [];
  S.check('showtimes start today', JSON.stringify(days).includes(new Date().toISOString().slice(0, 4)) && rec?.list?.length >= 8, `${rec?.list?.length} films`);
  const ratings = keepText(await A.call('GET', '/api/ratings')).json?.ratings || [];
  S.check('about 150 ratings', ratings.length >= 140 && ratings.length <= 160, `${ratings.length}`);
  S.check('a few notes on them', ratings.filter((r) => r.note).length >= 3, `${ratings.filter((r) => r.note).length}`);
  const wl = keepText(await A.call('GET', '/api/watchlist')).json?.movies || [];
  S.check('a watchlist', wl.length >= 5, `${wl.length}`);
  const soc = keepText(await A.call('GET', '/api/social')).json;
  S.check('an I\'m going plan', soc?.plans?.length === 1, JSON.stringify(soc?.plans));
  S.check('a pick sent by Maya, with her note', soc?.sent?.length === 1 && soc.sent[0].from === 'Maya' && soc.sent[0].note.length > 0);
  S.check('send goes to the made-up friends only', soc?.send?.recipients?.map((r) => r.name).sort().join('|') === 'Maya|Priya|Theo', JSON.stringify(soc?.send?.recipients));
  S.check('a friend\'s plan shows (Together)', soc?.going?.length >= 1 && soc.going.every((g) => g.name === 'Maya' || g.name === 'Theo'));
  const fr = keepText(await A.call('GET', '/api/friends')).json?.friends || [];
  S.check('three made-up friends', fr.map((f) => f.name).join('|') === 'Maya|Theo|Priya', JSON.stringify(fr.map((f) => f.name)));
  const tg = keepText(await A.call('GET', '/api/together')).json;
  S.check('Together pairs Sam with the two friends who opted in', JSON.stringify(tg).includes('Maya') && JSON.stringify(tg).includes('Theo') && !JSON.stringify(tg).includes('Priya'), JSON.stringify(tg).slice(0, 300));
  const stats = keepText(await A.call('GET', '/api/stats')).json;
  S.check('Stats has the ratings and a watch log', stats?.totalRatings === ratings.length && stats?.seenAll >= 5, `${stats?.totalRatings} ${stats?.seenAll}`);
  const yr = keepText(await A.call('GET', '/api/year?preview=1'));
  S.check('Your year in movies preview opens, with films seen at the made-up theater', yr.status === 200 && yr.json?.cards?.some((c) => c.kind === 'theater' && c.name === 'Riverside 12'), `${yr.status} ${yr.text.slice(0, 200)}`);
  const poster = yr.json?.share?.posters?.[0];
  if (poster) {
    const img = await A.call('GET', `/api/year/poster/${poster}?preview=1`);
    S.check('its share posters are drawn here, as images', img.status === 200 && img.headers.get('content-type') === 'image/jpeg');
  }
  const top = rec?.weekly4?.[0]?.tmdb_id;
  const movie = keepText(await A.call('GET', `/api/movies/${top}`)).json;
  S.check('a movie page has its credits', Boolean(movie?.movie?.director && movie.movie.cast?.length));
  const pid = movie?.movie?.director_id;
  if (pid) {
    const person = keepText(await A.call('GET', `/api/person/${pid}`));
    S.check('a person page answers', person.status === 200 && person.json?.person?.name, `${person.status}`);
  }
  const nolan = keepText(await A.call('GET', '/api/person/525'));
  S.check('a person with no saved page still gets one, from the films they made', nolan.status === 200 && nolan.json?.person?.name === 'Christopher Nolan' && nolan.json.rated.length + nolan.json.directed.length > 0, `${nolan.status}`);
  const wsw = keepText(await A.call('POST', '/api/suggest', { where: 'either', time: 'any', mood: 'surprise' })).json;
  S.check('What should I watch? answers with films', wsw?.films?.length >= 1, JSON.stringify(wsw).slice(0, 200));
  const search = keepText(await A.call('GET', '/api/search?q=interstellar')).json;
  S.check('search finds a film', JSON.stringify(search).includes('Interstellar'));
});

await S.step('visitors: what one does, only they see; an hour on, it is gone', async () => {
  const pick = (await A.call('GET', '/api/recommendations')).json.weekly4[1];
  const r = await A.call('POST', '/api/ratings', { tmdb_id: pick.tmdb_id, rating: 0.5 });
  S.check('a visitor can rate', r.status === 200, r.text);
  await A.call('POST', '/api/watchlist/toggle', { tmdb_id: pick.tmdb_id });
  await A.call('POST', '/api/hidden', { tmdb_id: (await A.call('GET', '/api/recommendations')).json.weekly4[2].tmdb_id });
  const mine = (await A.call('GET', '/api/ratings')).json.ratings.find((x) => x.tmdb_id === pick.tmdb_id);
  S.check('their rating is theirs', mine?.rating === 0.5);
  await B.call('GET', '/api/status');
  S.check('two visitors get two copies', A.ids[0] && B.ids[0] && A.ids[0] !== B.ids[0]);
  const theirs = (await B.call('GET', '/api/ratings')).json.ratings.find((x) => x.tmdb_id === pick.tmdb_id);
  const bHidden = (await B.call('GET', '/api/hidden')).json.movies.length;
  const aHidden = (await A.call('GET', '/api/hidden')).json.movies.length;
  S.check('another visitor does not see that rating', !theirs || theirs.rating !== 0.5, JSON.stringify(theirs));
  S.check('or that Not for me', bHidden === aHidden - 1, `${aHidden} ${bHidden}`);
  const send = await A.call('POST', '/api/sends', { to: 2, tmdb_id: pick.tmdb_id });
  S.check('Send a pick without a note works', send.status === 200 && send.json?.sent === true, send.text);
  srv.clock(61 * 60 * 1000);
  await sleep(150);
  const again = await A.call('GET', '/api/ratings');
  S.check('an hour later the visitor gets a fresh copy (new cookie)', A.ids.length === 2 && A.ids[1] !== A.ids[0], JSON.stringify(A.ids));
  S.check('and their rating is gone', !again.json.ratings.some((x) => x.tmdb_id === pick.tmdb_id && x.rating === 0.5));
  srv.clock(0);
});

await S.step('off: typed text, invites, theaters, imports, backups, push, alerts, owner token, guest view', async () => {
  const film = (await A.call('GET', '/api/ratings')).json.ratings[0].tmdb_id;
  const off = async (method, p, body) => {
    const r = keepText(await A.call(method, p, body));
    S.check(`${method} ${p.split('?')[0]} is off in the demo`, r.status === 403 && r.json?.error === 'Off in the demo.' && r.json?.demoOff === true, `${r.status} ${r.text.slice(0, 120)}`);
  };
  await off('PUT', `/api/ratings/${film}/note`, { note: 'typed' });
  await off('POST', '/api/sends', { to: 2, tmdb_id: film, note: 'typed' });
  await off('POST', '/api/friends', { name: 'Someone' });
  await off('POST', '/api/friends/2/reissue');
  await off('PUT', '/api/letterboxd', { username: 'someone' });
  await off('POST', '/api/letterboxd/sync');
  await off('GET', '/api/geocode?q=somewhere');
  await off('GET', '/api/geocode/reverse?lat=1&lng=2');
  await off('DELETE', '/api/home');
  await off('GET', '/api/theatres?query=amc');
  await off('POST', '/api/theatre', { id: '849', name: 'Another' });
  await off('POST', '/api/theatres/follow', { id: '849', name: 'Another' });
  await off('POST', '/api/ratings/import', { csv: 'Name,Year,Rating\nX,2000,4' });
  await off('POST', '/api/state', { ratings: [] });
  await off('GET', '/api/backup/latest');
  const set = keepText(await A.call('PUT', '/api/settings', { home: { label: 'Somewhere else', lat: 1, lng: 2 }, weightPublic: 0.4, weightTaste: 0.6 }));
  S.check('saving settings keeps the made-up home base and saves the rest', set.status === 200 && set.json?.home?.label === 'Maple Hollow' && Math.abs(set.json?.weightPublic - 0.4) < 1e-9, set.text.slice(0, 200));
  const push = keepText(await A.call('GET', '/api/push/config')).json;
  S.check('notifications are off', push?.enabled === false);
  const sub = await A.call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/x', keys: {} } });
  S.check('nothing can subscribe to push', sub.status === 404);
  const al = keepText(await A.call('GET', '/api/alerts')).json;
  S.check('no owner alerts (GUEST_MODE on "Railway" raised none)', al?.alerts?.length === 0 && al?.failing?.length === 0, JSON.stringify(al));
  const ref = keepText(await A.call('POST', '/api/refresh'));
  S.check('a manual refresh answers at once and fetches nothing', ref.status === 200 && ref.json?.started === true);
  const tok = await fetch(`${srv.base}/?owner=${encodeURIComponent(canaryEnv.OWNER_TOKEN)}`, { redirect: 'manual' });
  S.check('the owner token does nothing (no owner cookie)', !/rp_owner=/.test(tok.headers.get('set-cookie') || ''));
  const inv = await fetch(`${srv.base}/?invite=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG`, { redirect: 'manual' });
  const invText = await inv.text();
  S.check('an invite link shows the app, not a Join page', inv.status === 200 && /data-demo/.test(invText) && !/Join/.test(invText.slice(0, 2000)));
  const join = await fetch(`${srv.base}/invite/join`, { method: 'POST', redirect: 'manual', headers: { origin: srv.base, 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=abcdefghijklmnopqrstuvwxyz0123' });
  S.check('Join does nothing', join.status === 303 && !/rp_user=/.test(join.headers.get('set-cookie') || ''));
  const page = await fetch(`${srv.base}/`);
  const html = await page.text();
  S.check('the page is marked as the demo (banner, Off in the demo lines)', /<html lang="en" data-demo>/.test(html));
});

await S.step('real data: no real database, no .env, no key, no network', async () => {
  // Every page a visitor can reach, once more, while the recorder listens.
  for (const p of ['/', '/api/status', '/api/recommendations', '/api/coming-soon', '/api/stats', '/api/home-picks', '/api/settings', '/api/state', '/api/export', '/api/onboarding/movies?known=1', '/api/search?q=nolan', '/api/providers?ids=157336,27205']) keepText(await A.call('GET', p));
  await sleep(500);
  const e = srv.entries();
  const dbs = e.filter((x) => x.kind === 'db').map((x) => path.resolve(x.path));
  const inside = (p, d) => p === d || p.startsWith(`${d}${path.sep}`);
  S.check('demo mode opened databases (the recorder is listening)', dbs.length >= 3, JSON.stringify(dbs));
  S.check('demo mode never opened DATA_DIR', !dbs.some((p) => inside(p, dataDir)), JSON.stringify(dbs.filter((p) => inside(p, dataDir))));
  S.check('demo mode never opened ./data', !dbs.some((p) => inside(p, path.join(app, 'data'))), JSON.stringify(dbs));
  S.check('the DATA_DIR database is byte-identical, with no -wal or -shm made', sha(realDb) === before.real && !fs.existsSync(`${realDb}-wal`) && !fs.existsSync(`${realDb}-shm`) && fs.readdirSync(dataDir).length === 1, fs.readdirSync(dataDir).join(','));
  S.check('the ./data database is byte-identical, with nothing beside it', sha(defaultDb) === before.def && fs.readdirSync(path.dirname(defaultDb)).length === 1, fs.readdirSync(path.dirname(defaultDb)).join(','));
  S.check('demo mode never read .env', !e.some((x) => x.kind === 'read'));
  const net = e.filter((x) => x.kind === 'net' || x.kind === 'dns');
  S.check('demo mode made no outgoing connection and looked up no name', net.length === 0, JSON.stringify(net.slice(0, 5)));
  const all = transcript.join('\n') + srv.out.text;
  S.check('no canary value (key, owner name, token, theater) shows anywhere', !all.includes(CAN), all.slice(Math.max(0, all.indexOf(CAN) - 80), all.indexOf(CAN) + 80));
});

// ================================================================ crashes
await S.step('crashes: a cookie that isn\'t valid %-encoding gets a normal answer', async () => {
  for (const bad of ['%', '%zz', 'abc%E0%A4%A']) {
    const r = await fetch(`${srv.base}/api/status`, { headers: { cookie: `rp_demo=${bad}` }, signal: AbortSignal.timeout(20000) }).catch((e) => ({ status: 0, err: e.message, headers: new Headers() }));
    S.check(`"Cookie: rp_demo=${bad}" gets a normal answer and a new visitor cookie`, r.status === 200 && /rp_demo=/.test(r.headers.get('set-cookie') || ''), `${r.status} ${r.err || ''}`);
  }
  S.check('the demo is still running after the bad cookies', srv.alive(), srv.out.text.slice(-600));
});

await srv.stop();

// A second demo server whose temp folder (the sample and every visitor's
// copy) is made inside this suite's folder. A read-only visitors folder
// stands in for a full disk: a copy can be neither made nor deleted there.
await S.step('crashes: a copy that can\'t be made or dropped gets an answer, and the demo keeps running', async () => {
  const demoTmp = path.join(dir, 'tmp');
  fs.mkdirSync(demoTmp);
  const disk = await start('disk', { ...canaryEnv, DEMO_MODE: '1', TMPDIR: demoTmp }, 'Demo sample ready');
  try {
    const made = fs.readdirSync(demoTmp).find((n) => n.startsWith('reel-picks-demo-'));
    const vdir = made && path.join(demoTmp, made, 'visitors');
    S.check('the demo\'s visitors folder is found', vdir && fs.existsSync(vdir), fs.readdirSync(demoTmp).join(','));
    if (!vdir) return;
    const C = visitor(disk);
    await C.call('GET', '/api/status');
    fs.chmodSync(vdir, 0o555);
    try {
      let blocked = false;
      try { fs.writeFileSync(path.join(vdir, 'probe'), 'x'); fs.rmSync(path.join(vdir, 'probe')); } catch { blocked = true; }
      S.check('control: nothing can be written in the read-only folder', blocked);
      // An hour on, C's copy is due to go, and can't be deleted.
      disk.clock(61 * 60 * 1000);
      await sleep(150);
      const old = await C.call('GET', '/api/status').catch((e) => ({ status: 0, text: e.message }));
      S.check('a visitor whose old copy can\'t be dropped gets an error answer', old.status === 500 && old.json?.error === 'Something went wrong on the server. Try again.', `${old.status} ${old.text?.slice(0, 200)}`);
      S.check('the demo is still running after the failed drop', disk.alive(), disk.out.text.slice(-600));
      const fresh = await visitor(disk).call('GET', '/api/status').catch((e) => ({ status: 0, text: e.message }));
      S.check('a new visitor whose copy can\'t be made gets an error answer', fresh.status === 500 && fresh.json?.error === 'Something went wrong on the server. Try again.', `${fresh.status} ${fresh.text?.slice(0, 200)}`);
      S.check('the demo is still running after the failed copy', disk.alive(), disk.out.text.slice(-600));
    } finally {
      fs.chmodSync(vdir, 0o755);
      disk.clock(0);
    }
    const after = await visitor(disk).call('GET', '/api/status').catch((e) => ({ status: 0, text: e.message }));
    S.check('once the disk has room again, a new visitor gets their copy', after.status === 200 && /rp_demo=/.test(after.setCookie || ''), `${after.status} ${after.text?.slice(0, 200)}`);
  } finally {
    await disk.stop();
  }
});

if (!process.env.RP_KEEP_TEMP) fs.rmSync(dir, { recursive: true, force: true });
S.finish();
