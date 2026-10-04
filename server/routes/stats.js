// The API: Stats and the export, your year in movies, and person pages.
import { Router } from 'express';
import { all } from '../db.js';
import { getStatsGroup, STATS_GROUP_KINDS } from '../lib/recommend.js';
import { getStats } from '../lib/stats.js';
import { getStatsMore } from '../lib/statsMore.js';
import * as tmdb from '../lib/tmdb.js';
import { csvField } from '../lib/util.js';
import { isGuest } from '../lib/guest.js';
import { currentUserId } from '../lib/user.js';
import { getPerson, personCached } from '../lib/personPage.js';
import { notesOf } from '../lib/notes.js';
import { recapFor, sharePosterUrl } from '../lib/year.js';
import { notGuest } from './social.js';
import { h, isOwnerRequest, limited } from './common.js';

const router = Router();

// ---- stats / export ----------------------------------------------------

router.get('/stats', (req, res) => res.json(getStats()));

// ---- your year in movies (lib/year.js) -----------------------------------
// The caller's own recap, open Dec 1 to Jan 15; the owner's preview (?preview=1)
// any day. Not on the guest allowlist, like /stats. Read only.
router.get('/year', notGuest, (req, res) => {
  const preview = req.query.preview === '1';
  if (preview && !isOwnerRequest()) return res.status(403).json({ error: 'Only the owner can preview it.' });
  res.set('Cache-Control', 'no-store');
  const r = recapFor({ preview });
  if (!r) return res.status(404).json({ error: 'Your year in movies opens on December 1.' });
  res.json(r);
});

// A poster for the saved image, from this server so the page's canvas can
// read it back. Only films on the caller's own recap; kept in memory a day.
const posterBytes = new Map();
router.get('/year/poster/:id', notGuest, h(async (req, res) => {
  const id = Number(req.params.id);
  if (!/^\d{1,10}$/.test(req.params.id) || !Number.isSafeInteger(id)) return res.status(404).json({ error: 'Not found' });
  const preview = req.query.preview === '1';
  if (preview && !isOwnerRequest()) return res.status(403).json({ error: 'Only the owner can preview it.' });
  const url = sharePosterUrl(id, { preview });
  if (!url) return res.status(404).json({ error: 'Not found' });
  let hit = posterBytes.get(url);
  if (!hit || Date.now() - hit.at > 864e5) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !/^image\/(jpeg|png|webp)/.test(type)) throw new Error(`poster ${r.status} ${type}`);
      const body = Buffer.from(await r.arrayBuffer());
      if (body.length > 3 * 1024 * 1024) throw new Error('poster too large');
      hit = { at: Date.now(), type, body };
      if (posterBytes.size >= 64) posterBytes.delete(posterBytes.keys().next().value);
      posterBytes.set(url, hit);
    } catch (e) {
      console.error('[year poster]', id, e.message);
      return res.status(502).json({ error: "Couldn't load that poster." });
    }
  }
  res.set('Content-Type', hit.type);
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(hit.body);
}));

// ---- people ----------------------------------------------------------------
// A person's page (lib/personPage.js). On the guest allowlist, read only: the
// guest gets no one's ratings or watchlist. A person not cached yet counts as
// one new-film lookup against the caller's hourly limit.
router.get('/person/:id', h(async (req, res) => {
  const id = Number(req.params.id);
  if (!/^\d{1,10}$/.test(req.params.id) || !Number.isSafeInteger(id) || id <= 0) return res.status(404).json({ error: 'Person not found' });
  if (!tmdb.tmdbConfigured()) return res.status(503).json({ error: "TMDB isn't set up, so there's no one to show." });
  if (!personCached(id) && limited(req, res, 'newFilm')) return;
  try {
    const guest = isGuest(req);
    const d = await getPerson(id, { guest });
    // "You rated" shows the caller's own note under each film; never on the guest link.
    if (!guest) {
      const notes = notesOf(currentUserId());
      d.rated = d.rated.map((f) => ({ ...f, myNote: notes.get(f.tmdb_id)?.note ?? null }));
    }
    res.json(d);
  } catch (e) {
    // TMDB's 404, or the one lib/personPage.js gives a record it can't show.
    if (e.upstreamStatus === 404 || e.status === 404) return res.status(404).json({ error: 'Person not found' });
    console.error('[person]', id, e.message);
    res.status(502).json({ error: "Couldn't reach TMDB to load this person. Try again in a moment." });
  }
}));

// The films behind one Stats row (genre / director / actor), the caller's own.
// Not on the guest allowlist, like /stats.
router.get('/stats/group', (req, res) => {
  const kind = String(req.query.kind || '');
  const name = String(req.query.name || '');
  if (!STATS_GROUP_KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be genre, director or actor.' });
  if (!name || name.length > 300) return res.status(400).json({ error: 'name is required.' });
  // Each film carries the caller's own note, for the sheet's second line and its filter.
  const g = getStatsGroup(kind, name);
  const notes = notesOf(currentUserId());
  res.json({ ...g, films: g.films.map((f) => ({ ...f, note: notes.get(f.tmdb_id)?.note ?? null })) });
});

// The sheet's second section: "More from <person>" (TMDB filmography, cached
// 7 days for everyone) or "<Genre> playing now". Not on the guest allowlist.
router.get('/stats/more', h(async (req, res) => {
  const kind = String(req.query.kind || '');
  const name = String(req.query.name || '');
  if (!STATS_GROUP_KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be genre, director or actor.' });
  if (!name || name.length > 300) return res.status(400).json({ error: 'name is required.' });
  if (kind !== 'genre' && !tmdb.tmdbConfigured()) return res.status(503).json({ error: "TMDB isn't set up, so there's no filmography to show." });
  try {
    res.json(await getStatsMore(kind, name));
  } catch (e) {
    console.error('[stats/more]', kind, name, e.message);
    res.status(502).json({
      error: kind === 'genre' ? "Couldn't load what's playing right now. Try again later." : "Couldn't load more films from TMDB right now. Try again later.",
    });
  }
}));

router.get('/export', (req, res) => {
  const uid = currentUserId();
  const ratings = all('SELECT tmdb_id, title, year, rating, source, rated_at FROM ratings WHERE user_id = ?', uid);
  const watched = all('SELECT tmdb_id, title, watched_at, in_weekly4, ticket_price, source FROM watched WHERE user_id = ? ORDER BY id', uid);
  const lines = ['Type,tmdb_id,Title,Year,Rating,Source,RatedAt,WatchedAt,InWeekly4,Price'];
  for (const r of ratings) {
    lines.push(['rating', r.tmdb_id, csvField(r.title), r.year ?? '', r.rating, r.source, r.rated_at ?? '', '', '', ''].join(','));
  }
  for (const w of watched) {
    lines.push(['watched', w.tmdb_id, csvField(w.title), '', '', w.source ?? '', '', w.watched_at, w.in_weekly4 ? '1' : '0', w.ticket_price ?? ''].join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="reel-picks-backup.csv"');
  res.send(lines.join('\n'));
});

export default router;
