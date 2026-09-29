// Notes on ratings (server/lib/notes.js) through the API:
//
//   rules     a note needs a rating; plain text on one line, 1 to 280
//             characters (emoji count as one), no HTML; invisible characters
//             go; clearing the rating takes the note; Delete works
//   private   one person's notes never reach another (a friend, the second
//             friend, the brand-new friend, the owner or the guest) in any
//             GET the app makes, the full-setup export, the backup CSV or a
//             push; the guest can't write one
//   limit     a friend's note writes count against an hourly limit; the owner
//             has none
//   lb-rss    the daily Letterboxd sync brings a review in as the note:
//             plain, a spoiler review, a very long one (cut at 280 with an
//             ellipsis, the whole kept), none for "Watched on"; never over a
//             note written or deleted here; an edited review updates a
//             Letterboxd note
//   lb-csv    reviews.csv: reviews become notes after matching, its ratings
//             count only where there's none, long and marked-up reviews come
//             out plain, a note written here is kept
//   state     the full-setup export and import carry the person's own notes
//   same      notes change no score, no pick and not the weekly four
import { suite } from '../lib/check.mjs';
import { openWorld, makeFriend, until, GUEST } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('notes');
const R0 = C.RATED[0]; // rated by the owner and Robin; directed by Ada Lindqvist
const R1 = C.RATED[1];
const R2 = C.RATED[2];
const LB = C.CLASSICS.slice(20, 26);
const LONG = `${'A slow burn that rewards patience. '.repeat(30)}The ending lands.`;
const feeds = {
  notesfan: [
    { id: LB[0].id, title: LB[0].title, year: LB[0].year, rating: 4, guid: 'n0', review: '<p>Loved the <b>score</b> &amp; the last shot.</p>' },
    { id: LB[1].id, title: LB[1].title, year: LB[1].year, rating: 3.5, guid: 'n1', spoiler: true, review: '<p>The twist: the lighthouse keeper was the narrator.</p>' },
    { id: LB[2].id, title: LB[2].title, year: LB[2].year, rating: 5, guid: 'n2', review: `<p>${LONG}</p><p>Second paragraph, with a <a href="https://example.com">link</a>.</p>` },
    { id: LB[3].id, title: LB[3].title, year: LB[3].year, rating: 3, guid: 'n3' },
    { id: LB[4].id, title: LB[4].title, year: LB[4].year, rating: 4.5, guid: 'n4', review: '<p>Letterboxd says this.</p>' },
    { id: LB[5].id, title: LB[5].title, year: LB[5].year, guid: 'n5', review: '<p>Reviewed but never rated.</p>' },
  ],
};
const w = S.world(await openWorld('notes', { letterboxd: feeds, push: true }));
const { robin: R, casey: K, jordan: J } = w.friends;
const OWNER = null;
const api = (as, m, p, body) => w.api(m, p, { as, body });
const put = (as, id, note) => api(as, 'PUT', `/api/ratings/${id}/note`, { note });
const rowOf = (uid, id) => w.q1('SELECT note, full, source FROM rating_notes WHERE user_id = ? AND tmdb_id = ?', uid, id);
const rate = (as, f, stars) => api(as, 'POST', '/api/ratings', { tmdb_id: f.id, rating: stars, title: f.title, year: f.year });

const ROLES = { owner: OWNER, robin: R, casey: K, jordan: J, guest: GUEST };
const recsOf = async (as) => {
  const r = (await api(as, 'GET', '/api/recommendations')).json;
  return JSON.stringify({ four: r.weekly4.map((e) => e.tmdb_id), list: r.list.map((e) => [e.tmdb_id, e.final]), worth: r.worthSeeing.map((e) => e.tmdb_id), near: (r.alsoNearby || []).map((e) => [e.tmdb_id, e.final]) });
};
const sideOf = async (as) => {
  // Stats carries the taste profile summary too.
  const st = await api(as, 'GET', '/api/stats');
  return JSON.stringify({ s: st.json });
};
const snapshot = async () => {
  const out = {};
  for (const [k, as] of Object.entries(ROLES)) {
    out[k] = await recsOf(as);
    if (k !== 'guest') out[`${k}-side`] = await sideOf(as);
  }
  out.tables = JSON.stringify(['ratings', 'watchlist', 'watched', 'hidden_movies', 'weekly4_log', 'weekly4_lock'].map((t) => w.q1(`SELECT COUNT(*) n FROM ${t}`).n));
  return out;
};

// ------------------------------------------------------------------ rules
await S.step('rules: what a note may be', async () => {
  const ok = await put(OWNER, R0.id, '  Saw it twice.\n  The score is the whole film.  ');
  S.check('rules: a note saves and comes back on one line, trimmed', ok.status === 200 && ok.json.note.note === 'Saw it twice. The score is the whole film.' && ok.json.note.source === 'app', ok.text);
  const m = (await api(OWNER, 'GET', `/api/movies/${R0.id}`)).json;
  S.check('rules: the movie page carries it as myNote', m.myNote?.note === 'Saw it twice. The score is the whole film.' && m.myNote.source === 'app' && m.myNote.full === null, JSON.stringify(m.myNote));
  const unrated = C.CLASSICS[0];
  const noRating = await put(OWNER, unrated.id, 'hello');
  S.check('rules: a film not rated gets 404 "Rate the film first"', noRating.status === 404 && /Rate the film first/.test(noRating.json?.error), noRating.text);
  S.check('rules: and nothing is stored for it', !rowOf(1, unrated.id));
  for (const [what, note, re] of [
    ['empty', '   ', /Write something/], ['HTML', '<b>great</b>', /plain text/], ['a closing tag', 'ok </p>', /plain text/],
    ['a comment', 'x <!-- y -->', /plain text/], ['281 characters', 'x'.repeat(281), /280 characters/], ['a number', 42, /plain text/],
    ['an object', { a: 1 }, /plain text/], ['nothing', undefined, /plain text/],
  ]) {
    const r = await put(OWNER, R1.id, note);
    S.check(`rules: ${what} is refused with a reason`, r.status === 400 && re.test(r.json?.error || ''), `${r.status} ${r.text}`);
  }
  S.check('rules: the refused notes stored nothing', !rowOf(1, R1.id));
  const max = await put(OWNER, R1.id, 'y'.repeat(280));
  S.check('rules: exactly 280 characters is fine', max.status === 200 && rowOf(1, R1.id).note.length === 280);
  const emoji = await put(OWNER, R1.id, '🎬'.repeat(280));
  S.check('rules: 280 emoji count as 280 characters', emoji.status === 200 && [...rowOf(1, R1.id).note].length === 280, emoji.text.slice(0, 120));
  const lt = await put(OWNER, R1.id, 'I <3 it, and 2 < 3');
  S.check('rules: a lone "<" is plain text', lt.status === 200 && rowOf(1, R1.id).note === 'I <3 it, and 2 < 3');
  const hidden = await put(OWNER, R1.id, 'a​b‮c\u0007d');
  S.check('rules: invisible and control characters are taken out', hidden.status === 200 && rowOf(1, R1.id).note === 'abcd', JSON.stringify(rowOf(1, R1.id)));
  const bad = await api(OWNER, 'PUT', '/api/ratings/abc/note', { note: 'x' });
  S.check('rules: a film id that isn\'t a number is a 404', bad.status === 404);
  const del = await api(OWNER, 'DELETE', `/api/ratings/${R1.id}/note`);
  S.check('rules: Delete removes it from the movie page', del.status === 200 && (await api(OWNER, 'GET', `/api/movies/${R1.id}`)).json.myNote === null);
  await put(OWNER, R2.id, 'Gone with the rating');
  await api(OWNER, 'DELETE', `/api/ratings/${R2.id}`);
  S.check('rules: clearing the rating takes the note with it', !rowOf(1, R2.id));
  await rate(OWNER, R2, R2.stars);
  S.check('rules: rating it again doesn\'t bring the note back', (await api(OWNER, 'GET', `/api/movies/${R2.id}`)).json.myNote === null);
  const list = (await api(OWNER, 'GET', '/api/ratings')).json.ratings;
  S.check('rules: the Rate list carries the note', list.find((r) => r.tmdb_id === R0.id)?.note === 'Saw it twice. The score is the whole film.' && list.find((r) => r.tmdb_id === R1.id)?.note === null);
});

// ------------------------------------------------------------------ private
const MARK = { owner: 'OWNERSECRET lighthouse', robin: 'ROBINSECRET popcorn', casey: 'CASEYSECRET balcony' };
await S.step('private: each person sees only their own notes', async () => {
  S.check('private: owner note saved', (await put(OWNER, R0.id, MARK.owner)).status === 200);
  S.check('private: Robin (700 ratings) note saved on the same film', (await put(R, R0.id, MARK.robin)).status === 200);
  await rate(K, R0, 3);
  S.check('private: Casey note saved on the same film', (await put(K, R0.id, MARK.casey)).status === 200);
  S.check('private: the brand-new friend has none', (await api(J, 'GET', `/api/movies/${R0.id}`)).json.myNote === undefined || (await api(J, 'GET', `/api/movies/${R0.id}`)).json.myNote === null);
  // The owner watchlists the film, so the watchlist carries notes too.
  await api(OWNER, 'POST', '/api/watchlist/toggle', { tmdb_id: R0.id });
  await api(R, 'POST', '/api/watchlist/toggle', { tmdb_id: R0.id });
  const own = (who) => MARK[who];
  const paths = [
    '/api/status', '/api/recommendations', '/api/coming-soon', `/api/movies/${R0.id}`, '/api/settings', '/api/state',
    '/api/ratings', '/api/letterboxd', '/api/search?q=silent', '/api/search/recents', '/api/watchlist', '/api/hidden', '/api/alist',
    '/api/together', '/api/social', '/api/stats', `/api/person/${C.PEOPLE.ada.id}`, `/api/stats/group?kind=director&name=${encodeURIComponent(C.PEOPLE.ada.name)}`,
    `/api/stats/more?kind=director&name=${encodeURIComponent(C.PEOPLE.ada.name)}`, '/api/export', '/api/friends', '/api/home-picks', '/api/push/config',
  ];
  for (const [who, as] of Object.entries(ROLES)) {
    for (const p of paths) {
      const r = await api(as, 'GET', p);
      const others = Object.entries(MARK).filter(([k]) => k !== who).map(([, v]) => v);
      const leaked = others.filter((m) => r.text.includes(m.split(' ')[0]));
      S.check(`private: ${who} GET ${p.split('?')[0]} holds no one else's note`, !leaked.length, `${r.status} ${leaked.join(', ')}`);
    }
  }
  const movieAs = async (as) => (await api(as, 'GET', `/api/movies/${R0.id}`)).json;
  S.check('private: each person\'s movie page has their own note', (await movieAs(OWNER)).myNote?.note === MARK.owner && (await movieAs(R)).myNote?.note === MARK.robin && (await movieAs(K)).myNote?.note === MARK.casey);
  const g = await movieAs(GUEST);
  S.check('private: the guest\'s movie page has no note at all', !('myNote' in g) && !JSON.stringify(g).includes('SECRET'));
  const gp = (await api(GUEST, 'GET', `/api/person/${C.PEOPLE.ada.id}`)).json;
  S.check('private: the guest\'s person page has no note and no one\'s ratings', !JSON.stringify(gp).includes('myNote') && !JSON.stringify(gp).includes('SECRET'));
  const group = (await api(R, 'GET', `/api/stats/group?kind=director&name=${encodeURIComponent(C.PEOPLE.ada.name)}`)).json;
  S.check('private: Robin\'s Stats drill-down carries Robin\'s note', group.films.find((f) => f.tmdb_id === R0.id)?.note === MARK.robin);
  const person = (await api(R, 'GET', `/api/person/${C.PEOPLE.ada.id}`)).json;
  S.check('private: Robin\'s person page You rated carries Robin\'s note', person.rated.find((f) => f.tmdb_id === R0.id)?.myNote === MARK.robin, JSON.stringify(person.rated.slice(0, 2)));
  const wl = (await api(R, 'GET', '/api/watchlist')).json.movies;
  S.check('private: Robin\'s watchlist carries Robin\'s note', wl.find((m) => m.tmdb_id === R0.id)?.note === MARK.robin);
  const st = (await api(K, 'GET', '/api/state')).json;
  S.check('private: Casey\'s own export has Casey\'s note and no other', st.profile.notes.length === 1 && st.profile.notes[0].note === MARK.casey);
  for (const [who, as] of [['guest', GUEST]]) {
    const w1 = await put(as, R0.id, 'guest note');
    const w2 = await api(as, 'DELETE', `/api/ratings/${R0.id}/note`);
    S.check(`private: the ${who} can't write or delete a note`, w1.status === 403 && w2.status === 403, `${w1.status} ${w2.status}`);
  }
  S.check('private: the guest\'s attempts stored nothing', rowOf(1, R0.id).note === MARK.owner);
  const kd = await api(K, 'DELETE', `/api/ratings/${R0.id}/note`);
  S.check('private: deleting your own note leaves everyone else\'s', kd.status === 200 && rowOf(1, R0.id).note === MARK.owner && rowOf(R.id, R0.id).note === MARK.robin && !rowOf(K.id, R0.id)?.note);
  await put(K, R0.id, MARK.casey);
});

await S.step('private: no push carries a note', async () => {
  for (const [who, as] of [['owner', OWNER], ['robin', R], ['casey', K]]) await api(as, 'POST', '/api/push/subscribe', { subscription: w.push.newSub(who) });
  await api(R, 'POST', '/api/sends', { to: 1, tmdb_id: R0.id, note: 'from robin' });
  await api(OWNER, 'POST', '/api/sends', { to: K.id, tmdb_id: R0.id });
  await api(OWNER, 'POST', '/api/push/weekly/send', {});
  await until(() => w.push.hits.length >= 2, 8000);
  const all = JSON.stringify(w.push.hits);
  S.check('push: some pushes went out', w.push.hits.length >= 2, all.slice(0, 300));
  S.check('push: none of them carries a note', !/SECRET/.test(all), all.slice(0, 300));
});

// ------------------------------------------------------------------ limit
await S.step('limit: friends\' note writes are limited, the owner\'s aren\'t', async () => {
  const f = await makeFriend(w.base, 'Writer');
  await rate(f, R0, 4);
  const codes = [];
  for (let i = 0; i < 300; i++) codes.push((await put(f, R0.id, `note ${i}`)).status);
  S.check('limit: 300 note writes in an hour are fine', codes.every((c) => c === 200), [...new Set(codes)].join('/'));
  const over = await put(f, R0.id, 'one too many');
  const overDel = await api(f, 'DELETE', `/api/ratings/${R0.id}/note`);
  S.check('limit: the next one is 429 with the usual message', over.status === 429 && over.json?.error === 'Slow down a bit, try again in a few minutes.' && overDel.status === 429, over.text);
  S.check('limit: the refused write changed nothing', rowOf(f.id, R0.id).note === 'note 299');
  const oc = [];
  for (let i = 0; i < 320; i++) oc.push((await put(OWNER, R1.id, `owner ${i}`)).status);
  S.check('limit: the owner has no limit', oc.every((c) => c === 200));
  await api(OWNER, 'DELETE', `/api/ratings/${R1.id}/note`);
  S.check('limit: another friend isn\'t affected', (await put(R, R1.id, 'fine')).status === 200);
});

// ------------------------------------------------------------------ lb-rss
await S.step('lb-rss: the daily sync brings reviews in as notes', async () => {
  // Jordan (brand new) already rated LB[4] and wrote a note on it here.
  await rate(J, LB[4], 4);
  await put(J, LB[4].id, 'Mine, written here');
  const r = await api(J, 'PUT', '/api/letterboxd', { username: 'notesfan' });
  S.check('lb-rss: the sync ran', r.status === 200 && !r.json.error, r.text);
  const n0 = rowOf(J.id, LB[0].id);
  S.check('lb-rss: a review becomes the note, plain text with entities decoded', n0?.note === 'Loved the score & the last shot.' && n0.source === 'letterboxd' && n0.full === null, JSON.stringify(n0));
  const n1 = rowOf(J.id, LB[1].id);
  S.check('lb-rss: a spoiler review keeps the review and drops Letterboxd\'s warning line', n1?.note === 'The twist: the lighthouse keeper was the narrator.', JSON.stringify(n1));
  const n2 = rowOf(J.id, LB[2].id);
  S.check('lb-rss: a very long review is cut to 280 with an ellipsis', n2 && [...n2.note].length <= 280 && n2.note.endsWith('…') && n2.note.startsWith('A slow burn'), JSON.stringify(n2?.note));
  S.check('lb-rss: and the whole review is kept, paragraphs and all, no HTML', n2?.full?.startsWith('A slow burn') && n2.full.includes('The ending lands.\n\nSecond paragraph, with a link.') && !/[<>]/.test(n2.full), JSON.stringify(n2?.full?.slice(-80)));
  S.check('lb-rss: "Watched on" (no review) makes no note', !rowOf(J.id, LB[3].id));
  S.check('lb-rss: a note written here is never overwritten', rowOf(J.id, LB[4].id)?.note === 'Mine, written here' && rowOf(J.id, LB[4].id).source === 'app');
  S.check('lb-rss: a review with no rating anywhere makes no note', !rowOf(J.id, LB[5].id));
  const m = (await api(J, 'GET', `/api/movies/${LB[2].id}`)).json.myNote;
  S.check('lb-rss: the movie page gets the short note, the whole review and where it came from', m?.source === 'letterboxd' && m.full?.includes('Second paragraph') && m.note.endsWith('…'));
  // Delete one here, edit one on Letterboxd, sync again.
  await api(J, 'DELETE', `/api/ratings/${LB[0].id}/note`);
  feeds.notesfan[1].review = '<p>Edited on Letterboxd.</p>';
  await new Promise((res) => setTimeout(res, 10500)); // Sync now's minimum gap
  await api(J, 'POST', '/api/letterboxd/sync', {});
  S.check('lb-rss: a note deleted here stays deleted after the next sync', !rowOf(J.id, LB[0].id)?.note && rowOf(J.id, LB[0].id)?.source === 'app');
  S.check('lb-rss: an edited review updates the Letterboxd note', rowOf(J.id, LB[1].id)?.note === 'Edited on Letterboxd.', JSON.stringify(rowOf(J.id, LB[1].id)));
  S.check('lb-rss: the note written here is still there', rowOf(J.id, LB[4].id)?.note === 'Mine, written here');
  S.check('lb-rss: nobody else got a note from Jordan\'s feed', w.q1('SELECT COUNT(*) n FROM rating_notes WHERE user_id != ? AND tmdb_id IN (?,?,?)', J.id, LB[0].id, LB[1].id, LB[2].id).n === 0);
});

// ------------------------------------------------------------------ lb-csv
await S.step('lb-csv: reviews.csv reviews become notes', async () => {
  const f = await makeFriend(w.base, 'Importer');
  const c = C.CLASSICS.slice(0, 5);
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  // ratings.csv first: the up-to-date ratings.
  const ratings = ['Date,Name,Year,Letterboxd URI,Rating', ...c.slice(0, 3).map((m, i) => `2024-01-0${i + 1},${m.title},${m.year},https://boxd.it/r${i},${[4, 2.5, 5][i]}`)].join('\n');
  const r1 = await api(f, 'POST', '/api/ratings/import', { csv: ratings });
  S.check('lb-csv: ratings.csv queued', r1.status === 200 && r1.json.received === 3, r1.text);
  const LONGCSV = `${'Every frame could hang in a gallery. '.repeat(12)}<br />Final line.`;
  const reviews = ['Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date',
    `2024-01-05,${c[0].title},${c[0].year},https://boxd.it/v0,3,,${q('A <i>quiet</i> wonder &amp; a half.')},,2024-01-05`,
    `2024-01-06,${c[1].title},${c[1].year},https://boxd.it/v1,,,${q('Spoilers: the dog lives.\nSecond line.')},,2024-01-06`,
    `2024-01-07,${c[2].title},${c[2].year},https://boxd.it/v2,5,,${q(LONGCSV)},,2024-01-07`,
    `2024-01-08,${c[3].title},${c[3].year},https://boxd.it/v3,3.5,,${q('Only in reviews.csv.')},,2024-01-08`,
    `2024-01-09,${c[4].title},${c[4].year},https://boxd.it/v4,,,${q('No rating anywhere.')},,2024-01-09`,
    `2024-01-10,Empty Review,2001,https://boxd.it/v5,4,,,,2024-01-10`,
  ].join('\n');
  const r2 = await api(f, 'POST', '/api/ratings/import', { csv: reviews });
  S.check('lb-csv: reviews.csv is recognised and its 5 reviews queued, the empty one skipped', r2.status === 200 && r2.json.reviews === true && r2.json.received === 5 && r2.json.skipped === 1, r2.text);
  const done = await until(() => w.q1('SELECT COUNT(*) n FROM unmatched_notes WHERE user_id = ?', f.id).n === 0 && w.q1('SELECT COUNT(*) n FROM unmatched_ratings WHERE user_id = ?', f.id).n === 0, 30000, 200);
  S.check('lb-csv: everything matched', Boolean(done), JSON.stringify(w.q('SELECT title FROM unmatched_notes WHERE user_id = ?', f.id)));
  const rt = (id) => w.q1('SELECT rating FROM ratings WHERE user_id = ? AND tmdb_id = ?', f.id, id)?.rating;
  S.check('lb-csv: a review\'s rating never overrides ratings.csv', rt(c[0].id) === 4, rt(c[0].id));
  S.check('lb-csv: a film only in reviews.csv takes the review\'s rating', rt(c[3].id) === 3.5);
  S.check('lb-csv: a review with no rating anywhere adds no rating', rt(c[4].id) == null);
  S.check('lb-csv: marked-up text comes out plain', rowOf(f.id, c[0].id)?.note === 'A quiet wonder & a half.' && rowOf(f.id, c[0].id).source === 'letterboxd', JSON.stringify(rowOf(f.id, c[0].id)));
  S.check('lb-csv: a spoiler review with two lines is one line, the whole kept', rowOf(f.id, c[1].id)?.note === 'Spoilers: the dog lives. Second line.' && rowOf(f.id, c[1].id).full === 'Spoilers: the dog lives.\nSecond line.', JSON.stringify(rowOf(f.id, c[1].id)));
  const long = rowOf(f.id, c[2].id);
  S.check('lb-csv: a very long review is cut at 280 with an ellipsis, the whole kept', long && [...long.note].length <= 280 && long.note.endsWith('…') && long.full.endsWith('Final line.') && !long.full.includes('<br'), JSON.stringify(long));
  S.check('lb-csv: no rating, no note', !rowOf(f.id, c[4].id));
  // A note written here, then the same reviews.csv again.
  await put(f, c[0].id, 'Written here after the import');
  await api(f, 'POST', '/api/ratings/import', { csv: reviews });
  await until(() => w.q1('SELECT COUNT(*) n FROM unmatched_notes WHERE user_id = ?', f.id).n === 0, 30000, 200);
  S.check('lb-csv: importing again never overwrites a note written here', rowOf(f.id, c[0].id)?.note === 'Written here after the import' && rowOf(f.id, c[0].id).source === 'app');
  S.check('lb-csv: importing again changes no rating', rt(c[0].id) === 4 && rt(c[3].id) === 3.5);
});

// ------------------------------------------------------------------ state
await S.step('state: the full-setup export and import carry your notes', async () => {
  const doc = (await api(OWNER, 'GET', '/api/state')).json;
  const mine = doc.profile.notes;
  S.check('state: the owner\'s export has the owner\'s notes only', mine.length > 0 && mine.every((n) => !/ROBIN|CASEY/.test(n.note || '')) && mine.some((n) => n.note === MARK.owner), JSON.stringify(mine).slice(0, 300));
  S.check('state: including a Delete marker', mine.some((n) => n.tmdb_id === R1.id && n.note === null && n.source === 'app'));
  const jd = (await api(J, 'GET', '/api/state')).json.profile.notes;
  S.check('state: a Letterboxd note travels with its whole review', jd.some((n) => n.tmdb_id === LB[2].id && n.source === 'letterboxd' && n.full?.includes('Second paragraph')));
  // Wipe the owner's notes and import the file back.
  w.q('DELETE FROM rating_notes WHERE user_id = 1');
  const imp = await api(OWNER, 'POST', '/api/state', doc);
  S.check('state: importing reports the notes', imp.status === 200 && imp.json.imported.notes === mine.length, imp.text.slice(0, 300));
  const back = w.q('SELECT tmdb_id, note, full, source FROM rating_notes WHERE user_id = 1 ORDER BY tmdb_id');
  S.check('state: every note is back as it was', JSON.stringify(back) === JSON.stringify(mine.map(({ updated_at, ...n }) => n)), `${JSON.stringify(back).slice(0, 200)}`);
  const again = await api(OWNER, 'POST', '/api/state', doc);
  S.check('state: importing twice changes nothing', again.status === 200 && JSON.stringify(w.q('SELECT tmdb_id, note, full, source FROM rating_notes WHERE user_id = 1 ORDER BY tmdb_id')) === JSON.stringify(back));
  const junk = { ...doc, profile: { ...doc.profile, notes: [{ tmdb_id: R0.id, note: '<script>x</script>' }, { tmdb_id: -1, note: 'x' }, { tmdb_id: 4242, note: 'not rated' }, 'nonsense'] } };
  w.q('DELETE FROM rating_notes WHERE user_id = 1 AND tmdb_id = ?', R0.id);
  await api(OWNER, 'POST', '/api/state', junk);
  S.check('state: a file with HTML, bad ids or unrated films brings none of them in', !rowOf(1, R0.id) && !rowOf(1, 4242));
  await put(OWNER, R0.id, MARK.owner);
});

// ------------------------------------------------------------------ same
await S.step('same: notes change no score, pick or stat', async () => {
  // Everything above that moves scores on purpose (ratings, saves) is done;
  // from here only notes are written, edited and deleted.
  const before = await snapshot();
  const writes = [];
  for (const f of C.RATED) writes.push(await put(OWNER, f.id, `Owner on ${f.title}: ${'words '.repeat(f.id % 20)}`.trim()));
  for (const f of C.RATED.slice(0, 8)) writes.push(await put(R, f.id, `Robin on ${f.title}`));
  writes.push(await put(K, R0.id, 'Casey again'));
  for (const f of C.RATED.slice(0, 10)) writes.push(await api(OWNER, 'DELETE', `/api/ratings/${f.id}/note`));
  for (const f of C.RATED.slice(0, 5)) writes.push(await put(OWNER, f.id, 'and back'));
  S.check('same: 54 note writes went through', writes.every((r) => r.status === 200) && writes.length === 54, [...new Set(writes.map((r) => r.status))].join('/'));
  const after = await snapshot();
  for (const k of Object.keys(before)) {
    S.check(`same: ${k} is exactly as before`, after[k] === before[k], `${before[k].slice(0, 160)} -> ${after[k].slice(0, 160)}`);
  }
});

await w.close();
S.finish();
