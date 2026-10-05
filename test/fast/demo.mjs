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
import http from 'node:http';
import net from 'node:net';
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

// ================================================================ load
// Each of these runs its own demo server "on Railway" (canaryEnv), with its
// temp folder inside this suite's folder, so its copies can be counted.
// Visitors are told apart by X-Real-IP, as Railway's edge sets it; the
// addresses are documentation ones (198.51.100.0/24).
const FULL = 'The demo is full right now. Try again in a bit.';
const LIMIT_PER_ADDRESS = 50;
const MAX = 150;
async function loadServer(label) {
  const tmp = path.join(dir, `tmp-${label}`);
  fs.mkdirSync(tmp);
  const s = await start(label, { ...canaryEnv, DEMO_MODE: '1', TMPDIR: tmp }, 'Demo sample ready');
  const made = fs.readdirSync(tmp).find((n) => n.startsWith('reel-picks-demo-'));
  s.tmp = tmp;
  s.folder = made ? path.join(tmp, made) : null;
  s.copies = () => fs.readdirSync(path.join(s.folder, 'visitors')).filter((f) => f.endsWith('.db')).length;
  return s;
}
// One visitor with a cookie jar, from one address (or none).
function from(s, ip) {
  const v = visitor(s);
  v.call = async (method, p, body) => {
    const res = await fetch(s.base + p, {
      method, redirect: 'manual',
      headers: { ...(ip ? { 'x-real-ip': ip } : {}), ...(v.cookie ? { cookie: v.cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), origin: s.base },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie') || '';
    const m = set.match(/rp_demo=([^;]+)/);
    if (m) { v.cookie = `rp_demo=${m[1]}`; v.ids.push(m[1]); }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, setCookie: set };
  };
  return v;
}
const cookieless = (s, ip, p = '/api/version') => from(s, ip).call('GET', p);
const statuses = (list) => [...new Set(list.map((r) => r.status))].join('/');
// A POST whose body is sent only in part: resolves with the answer, or with
// status 0 when none came within `ms`. `.rq` hangs it up.
function partial(s, p, { ip, length, sent = 1024, ms = 3000 } = {}) {
  const u = new URL(s.base + p);
  const rq = http.request({ host: '127.0.0.1', port: u.port, method: 'POST', path: u.pathname, headers: { 'content-type': 'application/json', 'content-length': String(length), ...(ip ? { 'x-real-ip': ip } : {}) } });
  const done = new Promise((resolve) => {
    const t = setTimeout(() => resolve({ status: 0, text: `no answer in ${ms} ms` }), ms);
    rq.on('response', (res) => {
      let text = ''; res.on('data', (d) => { text += d; });
      res.on('end', () => { clearTimeout(t); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, text, json }); });
    });
    rq.on('error', () => { clearTimeout(t); resolve({ status: 0, text: 'hung up' }); });
  });
  rq.write('['.padEnd(sent, ' '));
  done.rq = rq;
  return done;
}
const used = new Set(); // every address sent, to look for afterwards
const ipOf = (n) => { const ip = `198.51.100.${n}`; used.add(ip); return ip; };
// No address may be written anywhere: not in the server's output, not in any
// file in its temp folder (the sample and every copy).
function noAddressWritten(s, label) {
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else files.push(p); } };
  if (s.folder && fs.existsSync(s.folder)) walk(s.folder);
  const hits = files.filter((f) => { const b = fs.readFileSync(f); return [...used].some((ip) => b.includes(ip)); });
  const outHit = [...used].some((ip) => s.out.text.includes(ip));
  S.check(`${label}: no visitor address is in the server's output or in any of its ${files.length} files`, files.length > 0 && !hits.length && !outHit, `${hits.map((f) => path.basename(f)).join(', ')}${outHit ? ' + output' : ''}`);
}

await S.step('load: a big body to an upload route is refused before it is read', async () => {
  const s = await loadServer('body');
  try {
    for (const p of ['/api/state', '/api/ratings/import']) {
      const before = s.copies();
      const q = partial(s, p, { length: 15 * 1024 * 1024 });
      const r = await q;
      q.rq.destroy();
      S.check(`POST ${p} with 15 MB on the way is answered "Off in the demo." after 1 KB of it`, r.status === 403 && r.json?.error === 'Off in the demo.', `${r.status} ${r.text.slice(0, 100)}`);
      S.check(`POST ${p} made no visitor copy`, s.copies() === before, `${before} -> ${s.copies()}`);
    }
    const small = await from(s, ipOf(1)).call('POST', '/api/state', { ratings: [] });
    S.check('a small body to the same route gets the same answer', small.status === 403 && small.json?.error === 'Off in the demo.' && small.json?.demoOff === true, `${small.status} ${small.text.slice(0, 100)}`);
    S.check('the demo is still running', s.alive());
  } finally { await s.stop(); }
});

await S.step(`load: one address makes at most ${LIMIT_PER_ADDRESS} new copies an hour`, async () => {
  const s = await loadServer('perip');
  try {
    const real = from(s, ipOf(21));
    const first = await real.call('GET', '/api/status');
    S.check('a visitor gets their copy', first.status === 200 && real.cookie, `${first.status}`);
    const burst = [];
    for (let i = 0; i < LIMIT_PER_ADDRESS; i++) burst.push(await cookieless(s, ipOf(66)));
    S.check(`${LIMIT_PER_ADDRESS} cookie-less calls from one address each get a copy`, burst.every((r) => r.status === 200 && /rp_demo=/.test(r.setCookie)), statuses(burst));
    const over = await cookieless(s, ipOf(66));
    S.check(`the ${LIMIT_PER_ADDRESS + 1}st from that address gets 503 and the line, with no cookie`, over.status === 503 && over.json?.error === FULL && !/rp_demo=/.test(over.setCookie), `${over.status} ${over.text.slice(0, 100)}`);
    S.check(`copies made: the visitor's and ${LIMIT_PER_ADDRESS}, no more`, s.copies() === 1 + LIMIT_PER_ADDRESS, `${s.copies()}`);
    const again = await real.call('GET', '/api/ratings');
    S.check('the visitor who was there keeps their copy (same cookie, answered)', again.status === 200 && real.ids.length === 1, `${again.status} ${real.ids.length} cookies`);
    const other = await cookieless(s, ipOf(67));
    S.check('another address still gets in', other.status === 200 && /rp_demo=/.test(other.setCookie), `${other.status}`);
    const none = [];
    for (let i = 0; i < LIMIT_PER_ADDRESS + 10; i++) none.push(await cookieless(s, null));
    S.check(`with no address there is no per-address limit (${LIMIT_PER_ADDRESS + 10} copies made)`, none.every((r) => r.status === 200 && /rp_demo=/.test(r.setCookie)), statuses(none));
    s.clock(61 * 60 * 1000);
    await sleep(150);
    const later = await cookieless(s, ipOf(66));
    S.check('an hour later that address gets a copy again', later.status === 200 && /rp_demo=/.test(later.setCookie), `${later.status}`);
    noAddressWritten(s, 'per address');
  } finally { s.clock(0); await s.stop(); }
});

await S.step(`load: at the cap of ${MAX}, a burst from one address can't wipe the visitors who are there`, async () => {
  const s = await loadServer('cap');
  try {
    const there = [];
    for (let a = 0; a < MAX / LIMIT_PER_ADDRESS; a++) {
      for (let i = 0; i < LIMIT_PER_ADDRESS; i++) { const v = from(s, ipOf(100 + a)); await v.call('GET', '/api/version'); there.push(v); }
    }
    S.check(`${MAX} visitors from ${MAX / LIMIT_PER_ADDRESS} addresses fill the demo`, s.copies() === MAX && there.every((v) => v.cookie), `${s.copies()}`);
    const burst = [];
    for (let i = 0; i < LIMIT_PER_ADDRESS + 20; i++) burst.push(await cookieless(s, ipOf(200)));
    const got = burst.filter((r) => r.status === 200).length;
    S.check(`a burst of ${LIMIT_PER_ADDRESS + 20} cookie-less calls from one address: ${LIMIT_PER_ADDRESS} get in, the rest get 503 and the line`, got === LIMIT_PER_ADDRESS && burst.slice(LIMIT_PER_ADDRESS).every((r) => r.status === 503 && r.json?.error === FULL), `${got} in, ${statuses(burst)}`);
    S.check(`still ${MAX} copies`, s.copies() === MAX, `${s.copies()}`);
    let kept = 0;
    for (const v of there) { const before = v.ids.length; const r = await v.call('GET', '/api/version'); if (r.status === 200 && v.ids.length === before) kept++; }
    S.check(`at least ${MAX - LIMIT_PER_ADDRESS} of the ${MAX} visitors kept their copies`, kept >= MAX - LIMIT_PER_ADDRESS, `${kept} kept`);
    noAddressWritten(s, 'at the cap');
  } finally { await s.stop(); }
});

await S.step(`load: with every visitor busy, the cap of ${MAX} holds`, async () => {
  const s = await loadServer('busy');
  const open = [];
  try {
    // Each of these is a visitor mid-request: their copy is made, then the
    // body they promised never finishes arriving, so they stay busy.
    for (let a = 0; a < MAX / LIMIT_PER_ADDRESS; a++) {
      for (let i = 0; i < LIMIT_PER_ADDRESS; i++) open.push(partial(s, '/api/ratings', { ip: ipOf(150 + a), length: 4096, sent: 10, ms: 60000 }));
    }
    const filled = await until(() => s.copies() >= MAX, 20000, 100);
    S.check(`${MAX} busy visitors, ${MAX} copies`, filled && s.copies() === MAX, `${s.copies()}`);
    const late = await cookieless(s, ipOf(190));
    S.check('a new visitor gets 503 and the line, with no cookie', late.status === 503 && late.json?.error === FULL && !/rp_demo=/.test(late.setCookie), `${late.status} ${late.text.slice(0, 100)}`);
    const none = await cookieless(s, null);
    S.check('one with no address gets the same', none.status === 503 && none.json?.error === FULL, `${none.status}`);
    S.check(`still ${MAX} copies: nobody busy was dropped and none was added`, s.copies() === MAX, `${s.copies()}`);
    // They finish (hang up); the next new visitor gets in, in their place.
    for (const q of open) q.rq.destroy();
    await Promise.all(open);
    await sleep(300);
    const after = await cookieless(s, ipOf(191));
    S.check('once they hang up, a new visitor gets in', after.status === 200 && /rp_demo=/.test(after.setCookie), `${after.status} ${after.text.slice(0, 100)}`);
    S.check(`and the count is still ${MAX}`, s.copies() === MAX, `${s.copies()}`);
    noAddressWritten(s, 'all busy');
  } finally { for (const q of open) q.rq.destroy(); await s.stop(); }
});

await S.step('exit: the temp folder goes however the server ends', async () => {
  const demoFolders = (tmp) => fs.readdirSync(tmp).filter((n) => n.startsWith('reel-picks-demo-'));
  for (const sig of ['SIGTERM', 'SIGINT']) {
    const tmp = path.join(dir, `tmp-exit-${sig}`);
    fs.mkdirSync(tmp);
    await start(`exit-${sig}`, { ...canaryEnv, DEMO_MODE: '1', TMPDIR: tmp }, 'Demo sample ready');
    const had = demoFolders(tmp).length;
    await new Promise((r) => { const c = children[children.length - 1]; c.once('exit', r); c.kill(sig); });
    S.check(`${sig}: the temp folder is gone`, had === 1 && demoFolders(tmp).length === 0, `${had} -> ${demoFolders(tmp).join(',')}`);
  }
  // A start that fails: the port is taken, so listening throws and the
  // process ends on its own, with no signal.
  const tmp = path.join(dir, 'tmp-exit-fail');
  fs.mkdirSync(tmp);
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, r));
  const port = blocker.address().port;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', `--import=${CANARY_PRELOAD}`, 'server/index.js'], {
    cwd: app, env: { ...baseEnv, ...canaryEnv, DEMO_MODE: '1', TMPDIR: tmp, PORT: String(port), RP_CANARY_LOG: path.join(dir, 'canary-exit-fail.jsonl') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await Promise.race([new Promise((r) => child.once('exit', (c) => r(c))), sleep(20000).then(() => 'still running')]);
  blocker.close();
  if (code === 'still running') child.kill('SIGKILL');
  S.check('control: the server could not start on a taken port and ended by itself', code !== 'still running' && code !== 0 && /EADDRINUSE/.test(out), `${code} ${out.slice(-200)}`);
  S.check('a failed start leaves no temp folder', demoFolders(tmp).length === 0, demoFolders(tmp).join(','));
});

if (!process.env.RP_KEEP_TEMP) fs.rmSync(dir, { recursive: true, force: true });
S.finish();
