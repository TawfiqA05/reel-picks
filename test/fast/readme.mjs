// README matches the code (old G15 and R15 g-readme, real-app G24, decisions
// D15, person search S17): it names every environment variable the server
// reads (Railway ones by name only, never with a value), leaks no key, token
// or invite link, mentions every user-facing feature and tab the code has and
// only features the code really has, documents every npm script, lists the
// five tabs in order, is in the first person with no em dash or emoji, covers
// the weekly lock, the AMC retry, the hourly limits, the Railway guest-mode
// safety, the nightly cache cleanup and person search; and a clean clone with
// no keys starts and says the keys are missing.
//
// Private details (a real home town, a friend's name) can't be named in a
// test that is committed; the release checks outside the repo cover those.
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { REPO, copyApp, tempDir, startServer, call } from '../lib/world.mjs';

const S = suite('readme');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const raw = read('README.md');
const lines = raw.split('\n');
const flat = raw.replace(/\s+/g, ' ').toLowerCase();
const has = (phrase) => flat.includes(String(phrase).replace(/\s+/g, ' ').toLowerCase());
const hasWord = (name) => new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`).test(raw);
const list = (xs) => xs.slice(0, 8).join(', ') + (xs.length > 8 ? ` and ${xs.length - 8} more` : '');

// ---- environment variables ---------------------------------------------
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}
const envNames = new Map();
const note = (name, where) => { if (!envNames.has(name)) envNames.set(name, where); };
for (const file of walk(path.join(REPO, 'server'))) {
  const src = fs.readFileSync(file, 'utf8');
  const at = (i) => `${path.relative(REPO, file)}:${src.slice(0, i).split('\n').length}`;
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) note(m[1], at(m.index));
  for (const m of src.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)) note(m[1], at(m.index));
  // A helper that reads process.env[k]: its ENV_STYLE string arguments count.
  if (/process\.env\[\s*[a-z]/.test(src)) for (const m of src.matchAll(/\(\s*'([A-Z][A-Z0-9]*_[A-Z0-9_]+)'\s*\)/g)) note(m[1], at(m.index));
  // A list of names checked in a loop (env.js onRailway).
  for (const m of src.matchAll(/\[((?:\s*'[A-Z][A-Z0-9]*_[A-Z0-9_]+',?)+)\s*\]\s*\n?\s*\.some\(\(k\) => [^)]*process\.env\[k\]/g)) {
    for (const n of m[1].matchAll(/'([A-Z0-9_]+)'/g)) note(n[1], at(m.index));
  }
}
for (const m of read('Dockerfile').matchAll(/^\s*(?:ENV\s+)?([A-Z][A-Z0-9_]*)=/gm)) note(m[1], 'Dockerfile');
for (const m of read('.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) note(m[1], '.env.example');
S.check('the scan finds the server\'s environment variables (at least 20)', envNames.size >= 20, `${envNames.size} found`);
const unnamed = [...envNames].filter(([n]) => !hasWord(n)).map(([n, w]) => `${n} (${w})`);
S.check('README names every environment variable the server reads', !unnamed.length, list(unnamed));
const railway = ['RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID', 'GUEST_MODE', 'RP_ALLOW_LAN'];
const withValue = railway.filter((n) => new RegExp(`\\b${n}\\s*=\\s*[^\\s\`<]`).test(raw.replace(/GUEST_MODE\s*=\s*1\b/g, '')));
S.check('Railway and access variables appear by name only, with no value (GUEST_MODE=1 is the documented setting)', !withValue.length, withValue.join(', '));

// ---- no secrets ----------------------------------------------------------
const PLACEHOLDER = /^(|<[^>]*>|your[-_a-z0-9.]*|\.\.\.|…|\*+|x{3,}|\$\{?[A-Za-z_]+\}?|changeme|placeholder|example[-_a-z0-9]*)$/i;
function secretProblems(line) {
  const out = [];
  if (/\b[0-9a-f]{32,}\b/i.test(line)) out.push('a long hex string');
  for (const m of line.matchAll(/[A-Za-z0-9+_-]{40,}={0,2}/g)) {
    const t = m[0];
    if (/[a-z]/.test(t) && /[A-Z]/.test(t) && /[0-9]/.test(t)) { out.push(`a long token-like string (${t.slice(0, 6)}…)`); break; }
  }
  for (const m of line.matchAll(/\b([A-Z][A-Z0-9_]*(?:KEY|KEY_ID|TOKEN|SECRET))\s*[=:]\s*(<[^>]*>|[^\s`'",)]*)/g)) {
    if (!PLACEHOLDER.test(m[2])) out.push(`${m[1]} set to a real-looking value`);
  }
  if (/[?&]invite=[A-Za-z0-9_-]{16,}/.test(line)) out.push('an invite link');
  if (/[?&]owner=[A-Za-z0-9_-]{12,}/.test(line)) out.push('an owner link with a token');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY/.test(line)) out.push('a private key');
  return out;
}
// The detector's own controls, built at run time so no key-shaped text is
// written in this file.
const MUST_FLAG = [
  `TMDB_API_KEY=${'3f9a'.repeat(8)}`, `OWNER_TOKEN=${'q8Zp2L'.repeat(4)}`, `the key is ${'Zm9vYm4'.repeat(7)} here`,
  'BACKUP_S3_SECRET: hunter2hunter2', `open /?invite=${'Ab3_'.repeat(8)} to join`,
];
const MUST_PASS = [
  'TMDB_API_KEY=your-tmdb-key', 'OWNER_TOKEN=<a long random string>', 'BACKUP_S3_SECRET=',
  '`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`: optional', 'Visiting `/?owner=<OWNER_TOKEN>` once',
  'https://<account id>.r2.cloudflarestorage.com', 'PORT=5170', 'GUEST_MODE=1', '`/?invite=<token>`',
];
S.check('the secret detector flags every planted secret', MUST_FLAG.every((s) => secretProblems(s).length), MUST_FLAG.filter((s) => !secretProblems(s).length).map((s) => s.slice(0, 16)).join(', '));
S.check('the secret detector passes every placeholder', MUST_PASS.every((s) => !secretProblems(s).length), MUST_PASS.filter((s) => secretProblems(s).length).join(', '));
const leaks = lines.flatMap((l, i) => secretProblems(l).map((p) => `line ${i + 1}: ${p}`));
S.check('README holds no key, token, invite link or private key', !leaks.length, list(leaks));
// A local .env (never in a clean clone) must not have any value copied in.
let envValues = [];
try { envValues = [...read('.env').matchAll(/^[A-Z_]+=(.{8,})$/gm)].map((m) => m[1].trim().replace(/^["']|["']$/g, '')).filter((v) => v.length >= 8); } catch { /* no .env */ }
S.check('README holds no value from a local .env', envValues.every((v) => !raw.includes(v)), `${envValues.filter((v) => raw.includes(v)).length} value(s)`);

// ---- features and tabs -----------------------------------------------------
const features = new Map();
const addAll = (xs, from) => { for (const f of xs) if (f && !features.has(f)) features.set(f, from); };
const app = read('public/js/app.js');
const nav = app.slice(app.indexOf('const NAV'), app.indexOf('];', app.indexOf('const NAV')));
const tabs = [...nav.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);
addAll(tabs, 'tab');
addAll([...read('public/js/views/schedule.js').matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]), 'Schedule segment');
addAll([...read('public/js/views/you.js').matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]), 'You segment');
addAll([...read('public/js/views/settings.js').matchAll(/\bcard\('([^']+)'/g)].map((m) => m[1].replace(/\s*\([^)]*\)\s*$/, '')), 'Settings group');
addAll([...read('public/js/views/home.js').matchAll(/sectionTitle\('([^']+)'/g)].map((m) => m[1]), 'Picks section');
addAll([...read('public/js/plans.js').matchAll(/\bname:\s*'([^']+)'/g)].map((m) => m[1]).filter((n) => !/^(Other|None)\b/.test(n)), 'movie plan');
addAll([...read('public/js/services.js').matchAll(/\bname:\s*'([^']+)'/g)].map((m) => m[1]), 'streaming service');
addAll([...read('public/js/wsw.js').matchAll(/\['[a-z-]+',\s*'([^']+)'\]/g)].map((m) => m[1]), 'What should I watch? answer');
addAll([
  'At home', 'What should I watch?', 'Show me 3 more', 'Not for me', 'Show hidden', 'Unhide', 'Back in theaters',
  'Trailer', 'Where to watch', 'Add to calendar', 'guest link', 'Join', 'invite', 'Revok', 'Watch together',
  'guided tour', 'Replay tour', 'Search', 'recents', 'Letterboxd', 'Sync now', 'IMDb', 'ratings.csv',
  'quick rate', 'welcome setup', 'Export full setup', 'Import full setup', 'Export backup CSV',
  'Download latest backup', 'Upload now', 'off-site', 'nightly', 'Notify me when my weekly picks are ready',
  'I\'m going', 'Send a pick', 'Sent to you', 'Did you see it', 'Sent by',
  'Home Screen', 'offline', 'service worker', 'Railway', 'Dockerfile', 'drive time', 'OpenStreetMap',
  'Ticket stub', 'Midnight marquee', 'hit-rate', 'Seen · Undo', 'Mark seen', 'Stats', 'More from',
  'You', 'Together', 'Settings', 'Help', 'Big Shoulders Display', 'IBM Plex Sans', 'glow',
  'pull the page down', 'Seat by', 'out around', 'Rent or buy', '/api/version', 'Save bar',
], 'feature');
const missingFeatures = [...features].filter(([f]) => !has(f)).map(([f, from]) => `${f} (${from})`);
S.check('README mentions every user-facing feature, tab and section the code has', !missingFeatures.length, list(missingFeatures));
const code = ['public/js/app.js', 'public/js/views/you.js', 'public/js/views/help.js', 'public/js/views/settings.js', 'public/styles.css', 'public/index.html', 'public/js/update.js', 'public/js/stream.js', 'public/js/views/components.js', 'server/routes.js', 'public/js/pull.js'].map(read).join('\n');
const phantom = ['You', 'Help', 'Replay tour', 'Big Shoulders Display', 'IBM Plex Sans', 'Rent or buy', 'Seat by', 'out around', '/version', 'save-bar', 'page-glow'].filter((f) => !code.includes(f));
S.check('the features README names by their app wording exist in the code', !phantom.length, phantom.join(', '));
const tabsSec = raw.slice(raw.indexOf('## The tabs'), raw.indexOf('\n## ', raw.indexOf('## The tabs') + 5));
const order = [...tabs, 'Stats', 'Together', 'Settings', 'Help'].map((t) => tabsSec.indexOf(`**${t}**`));
S.check('the tabs section lists the tabs in the app\'s order, then You\'s Stats, Together, Settings, Help', tabsSec.length > 20 && order.every((i) => i >= 0) && order.every((i, k) => !k || i > order[k - 1]), `positions ${order.join(',')}`);
S.check('the tabs section says how many tabs there are', new RegExp(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'][tabs.length] || String(tabs.length), 'i').test(tabsSec), `${tabs.length} tabs`);
const STALE = [
  'Projector', 'the ? at the top', 'Replay tour in Settings', 'Search and Settings sit in the header', 'every 30 minutes',
  'Wrong movie? Fix it', 'every film I starred', 'Zilla Slab', 'Work Sans', 'no cloud dependency beyond the movie APIs',
  'Anyone who reaches the app from outside without a cookie gets the read-only guest view',
].filter((p) => has(p));
S.check('claims about the old design are gone', !STALE.length, STALE.join(' | '));

// ---- setup from a clean clone ------------------------------------------------
const pkg = JSON.parse(read('package.json'));
const cmdFor = (s) => (s === 'start' ? 'npm start' : s === 'test' ? 'npm test' : `npm run ${s}`);
const undocumented = Object.keys(pkg.scripts || {}).filter((s) => !has(cmdFor(s)));
S.check('every npm script is documented', !undocumented.length, undocumented.map(cmdFor).join(', '));
const nodeMajor = String(pkg.engines?.node || '').match(/\d+/)?.[0];
S.check('README says npm install, the Node version and cp .env.example .env', has('npm install') && (!nodeMajor || has(`Node ${nodeMajor}`)) && has('cp .env.example .env') && fs.existsSync(path.join(REPO, '.env.example')));
S.check('README points at the MIT LICENSE', /MIT License/.test(read('LICENSE')) && /\bMIT\b/.test(raw) && /LICENSE/.test(raw));

// ---- voice -----------------------------------------------------------------------
const own = raw.replace(/What should I watch\?/gi, '');
const firstPerson = (own.match(/(^|[\s(])(I|I'm|I've|I'd|my|me|mine)(?=[\s.,:;!?)]|$)/g) || []).length;
S.check('README is in the first person', /(^|\s)I\s/.test(own) && firstPerson >= 40 && !/the author/i.test(raw), `${firstPerson} first-person words`);
S.check('README has no em dash', !raw.includes('—'), `${(raw.match(/—/g) || []).length} em dash(es)`);
const emoji = raw.match(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu)?.filter((c) => !/[©®™]/.test(c)) || [];
S.check('README has no emoji', !emoji.length, [...new Set(emoji)].join(' '));

// ---- the behaviour the later passes added ----------------------------------------
const low = flat;
const need = {
  'the weekly lock (the four lock at Friday\'s first refresh)': /four[^.]{0,120}lock|lock[^.]{0,120}four/.test(low) && /friday/.test(low),
  'what makes a film leave the four': /not for me/.test(low) && /(no showtimes left|leaves the theaters?|stops showing)/.test(low),
  'the one swap a week and its New this week tag': /new this week/.test(low) && /(once a week|one swap|at most one)/.test(low),
  'the AMC retry (hourly, six times)': /(every hour|hourly)/.test(low) && /(six|6) times/.test(low) && /retr/.test(low),
  'the hourly limits and their message': /slow down a bit, try again in a few minutes/.test(low) && /(per hour|an hour)/.test(low),
  'RP_ALLOW_LAN by name': /`RP_ALLOW_LAN`/.test(raw),
  'the Railway guest-mode safety': /railway/.test(low) && /guest_mode/.test(low) && /(every visitor|everyone who opens|treat[s]? every)/.test(low),
  'the nightly cache cleanup': /cache/.test(low) && /(3am|nightly)/.test(low) && /vacuum/.test(low),
  'people in the header search (up to two)': /people/.test(low) && /(up to two people|at most two people)/.test(low),
  'the person page and its Directed / Acted switch': /#\/person\//.test(low) && /directed \/ acted/.test(low),
  'people in recents and the shared credits cache': /films and people i opened/.test(low) && /credits cache/.test(low),
  'a person lookup counts toward the limit': /counts as one of the 200/.test(low),
};
for (const [what, ok] of Object.entries(need)) S.check(`README covers ${what}`, ok);

// ---- a clean clone with no keys starts ---------------------------------------------
await S.step('a clean clone with no keys starts and says so', async () => {
  const dir = tempDir('readme');
  try {
    const app = copyApp(dir);
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const srv = await startServer({ app, dataDir, label: 'clean', env: { TMDB_API_KEY: '', OMDB_API_KEY: '', AMC_API_KEY: '', RP_FAKE_NOW: '' } });
    try {
      const page = await call(srv.base, 'GET', '/');
      S.check('fresh install: the app page loads', page.status === 200 && /Reel Picks/.test(page.text), `${page.status}`);
      S.check('fresh install: the PWA manifest loads', (await call(srv.base, 'GET', '/manifest.webmanifest')).status === 200);
      const st = await call(srv.base, 'GET', '/api/status');
      S.check('fresh install with no keys: status answers and says TMDB is missing', st.status === 200 && st.json?.keys?.tmdb === false, `${st.status} ${JSON.stringify(st.json?.keys)}`);
    } finally { await srv.stop(); }
  } finally { if (!process.env.RP_KEEP_TEMP) fs.rmSync(dir, { recursive: true, force: true }); }
});

S.finish();
