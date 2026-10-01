// What the API does differently in demo mode, in one place: mounted ahead of
// the router (index.js) only when DEMO_MODE is on, so routes.js is the same
// code either way.
//
// Off in the demo, with a short "Off in the demo." answer:
//   - anything typed: a note on a rating, a note with a sent pick, a friend's
//     name for an invite, a Letterboxd username, a place for home base
//   - invites (new or re-issued links), theater changes, imports of ratings
//     or a full setup, the backup download
// Answered here instead:
//   - status, without the server's own diagnostics (key fingerprints, where
//     the data lives, backups, disk), and with demo: true for the page
//   - a manual refresh, which has nothing new to fetch
//   - the year recap's share posters, drawn as plain colour blocks (no image
//     is fetched from anywhere)
// Everything else (rating, watchlist, Not for me, I'm going, Send a pick
// without a note, search, Stats, What should I watch?) works as on the real
// app, in the visitor's own copy.
import jpeg from 'jpeg-js';
import { Router } from 'express';
import { get } from '../db.js';
import { sharePosterUrl } from '../lib/year.js';
import { DEMO_OFF } from './mode.js';

const guard = Router();
const off = (req, res) => res.status(403).json({ error: DEMO_OFF, demoOff: true });
const typed = (v) => typeof v === 'string' && v.trim() !== '';

guard.put('/ratings/:id/note', off);
guard.post('/sends', (req, res, next) => (typed(req.body?.note) ? off(req, res) : next()));
guard.post('/friends', off);
guard.post('/friends/:id/reissue', off);
guard.put('/letterboxd', off);
guard.post('/letterboxd/sync', off);
guard.get('/geocode', off);
guard.get('/geocode/reverse', off);
guard.delete('/home', off);
guard.get('/theatres', off);
guard.post('/theatre', off);
guard.post('/theatres/follow', off);
guard.delete('/theatres/follow/:id', off);
guard.post('/theatres/primary', off);
guard.post('/ratings/import', off);
guard.post('/state', off);
guard.get('/backup/latest', off);
guard.post('/offsite/upload', off);

// Settings save everything on the page at once, home base included: home
// base stays as it is and the rest is saved.
guard.put('/settings', (req, res, next) => {
  if (req.body && typeof req.body === 'object') delete req.body.home;
  next();
});

guard.post('/refresh', (req, res) => res.json({ started: true, queued: false }));

guard.get('/status', (req, res, next) => {
  const send = res.json.bind(res);
  res.json = (body) => {
    if (!body || typeof body !== 'object' || body.error) return send(body);
    const { keyMeta, data, backup, disk, host, creditsBackfill, tmdbCalls, ...rest } = body;
    return send({ ...rest, demo: true });
  };
  next();
});

// A share poster: the film's own colour as a plain block, made here.
const blocks = new Map();
function block(hex) {
  if (blocks.has(hex)) return blocks.get(hex);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const width = 100;
  const height = 150;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([r, g, b, 255], i * 4);
  const jpg = jpeg.encode({ data, width, height }, 80).data;
  blocks.set(hex, jpg);
  return jpg;
}
guard.get('/year/poster/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!/^\d{1,10}$/.test(req.params.id) || !sharePosterUrl(id, { preview: req.query.preview === '1' })) return res.status(404).json({ error: 'Not found' });
  const c = get('SELECT poster_color FROM movies WHERE tmdb_id = ?', id)?.poster_color;
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(block(/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#3a3f52'));
});

export default guard;
