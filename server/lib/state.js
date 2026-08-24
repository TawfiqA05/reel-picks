// Full-setup export/import: everything that makes this instance *mine* —
// settings (theatres, home base, weights, filters, windows), ratings,
// watchlist, the A-List watch log, and manual AMC-match decisions — in one
// versioned JSON document, so a fresh deployment can be made an exact
// duplicate of a local one.
//
// Deliberately NOT included: the HTTP cache, lineup snapshots, and departures.
// Those are per-instance observations; a new instance builds its own history.
//
// Shape note for later multi-user work: the document is { version, kind,
// exportedAt, profile: {...} } — one profile per document today, but nothing
// here assumes the instance only ever holds one.
import { all, get, run, getSettings, updateSettings, DEFAULT_SETTINGS } from '../db.js';
import { upsertLightMovie } from './movies.js';
import { upsertRating } from './ratings.js';
import { restoreWatched } from './alist.js';

export const STATE_VERSION = 1;

// Instance-local bookkeeping that must NOT travel between instances.
const SKIP_SETTINGS = new Set(['lastRefresh', 'lastRefreshLog']);

const settingKeys = () => Object.keys(DEFAULT_SETTINGS).filter((k) => !SKIP_SETTINGS.has(k));

export function exportState() {
  const s = getSettings();
  const settings = {};
  for (const k of settingKeys()) settings[k] = s[k];
  return {
    version: STATE_VERSION,
    kind: 'reelpicks-state',
    exportedAt: new Date().toISOString(),
    profile: {
      settings,
      ratings: all('SELECT tmdb_id, title, year, rating, source, rated_at FROM ratings'),
      watchlist: all(
        `SELECT w.tmdb_id, w.added_at, m.title, m.year FROM watchlist w
          LEFT JOIN movies m ON m.tmdb_id = w.tmdb_id`,
      ),
      watched: all('SELECT tmdb_id, title, watched_at, in_weekly4, ticket_price FROM watched'),
      // Every match row travels: the table IS the decision record (manual
      // repoints, ignores, review keeps), and automatic rows are harmless —
      // they just save the new instance re-deriving the same answer.
      matches: all('SELECT amc_movie_id, amc_title, amc_year, tmdb_id, confidence, manual, review, updated_at FROM matches'),
    },
  };
}

// Apply a state document. Additive and idempotent: rows are upserted, nothing
// local is deleted, and re-importing the same file is a no-op. Returns counts.
export function importState(doc) {
  if (!doc || doc.kind !== 'reelpicks-state' || !doc.profile) {
    throw Object.assign(new Error('Not a Reel Picks full-setup file — expected the JSON from Settings → Export full setup.'), { status: 400 });
  }
  const ver = Number(doc.version);
  if (!Number.isInteger(ver) || ver < 1) {
    throw Object.assign(new Error('This file has no valid version stamp — re-export it from Settings → Export full setup.'), { status: 400 });
  }
  if (ver > STATE_VERSION) {
    throw Object.assign(new Error(`This file is from a newer Reel Picks (state v${ver}; this instance reads v${STATE_VERSION}). Update the deployment first.`), { status: 400 });
  }
  const p = doc.profile;
  const out = { settings: 0, ratings: 0, watchlist: 0, watched: 0, matches: 0 };

  // Only accept a value whose shape matches the default's: a hand-edited file
  // with, say, extraTheatres as an object would otherwise brick every request
  // that iterates it (/api/status included) until someone edits SQLite by hand.
  const shapeOk = (def, v) => {
    if (def === null || def === undefined) return true; // free-form (lastRefresh-style; none travel today)
    if (Array.isArray(def)) return Array.isArray(v);
    if (typeof def === 'object') return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
    if (typeof def === 'number') return Number.isFinite(Number(v));
    if (typeof def === 'boolean') return typeof v === 'boolean' || v === 0 || v === 1;
    return typeof v === typeof def;
  };
  const patch = {};
  out.settingsSkipped = [];
  for (const k of settingKeys()) {
    if (!p.settings || !(k in p.settings)) continue;
    if (shapeOk(DEFAULT_SETTINGS[k], p.settings[k])) { patch[k] = p.settings[k]; out.settings++; }
    else out.settingsSkipped.push(k);
  }
  updateSettings(patch);

  for (const r of p.ratings || []) {
    if (!Number.isInteger(r.tmdb_id) || r.tmdb_id <= 0 || !Number.isFinite(Number(r.rating))) continue;
    upsertLightMovie({ tmdb_id: r.tmdb_id, title: r.title, year: r.year });
    upsertRating({
      tmdb_id: r.tmdb_id, title: r.title, year: r.year,
      rating: Math.max(0.5, Math.min(5, Number(r.rating))),
      source: r.source || 'import', rated_at: r.rated_at || null,
    });
    out.ratings++;
  }

  for (const w of p.watchlist || []) {
    if (!Number.isInteger(w.tmdb_id) || w.tmdb_id <= 0) continue;
    upsertLightMovie({ tmdb_id: w.tmdb_id, title: w.title, year: w.year });
    run(
      'INSERT INTO watchlist(tmdb_id, added_at) VALUES(?, ?) ON CONFLICT(tmdb_id) DO NOTHING',
      w.tmdb_id, w.added_at || new Date().toISOString(),
    );
    out.watchlist++;
  }

  for (const w of p.watched || []) {
    if (!Number.isInteger(w.tmdb_id) || w.tmdb_id <= 0) continue;
    upsertLightMovie({ tmdb_id: w.tmdb_id, title: w.title });
    // restoreWatched reports whether the row was new; a re-import of the same
    // file should say "0 watched", not re-count every dedup no-op.
    if (restoreWatched({
      tmdb_id: w.tmdb_id, title: w.title, watched_at: w.watched_at,
      in_weekly4: Boolean(w.in_weekly4), price: w.ticket_price ?? null,
    })) out.watched++;
  }

  for (const m of p.matches || []) {
    if (!m.amc_movie_id) continue;
    // Newer decision wins: re-importing a stale export must never revert a
    // match fixed since it was taken. A row without a timestamp gets an
    // epoch stamp so it can be inserted but never beats an existing row.
    run(
      `INSERT INTO matches(amc_movie_id, amc_title, amc_year, tmdb_id, confidence, manual, review, updated_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(amc_movie_id) DO UPDATE SET
         amc_title = excluded.amc_title, amc_year = excluded.amc_year,
         tmdb_id = excluded.tmdb_id, confidence = excluded.confidence,
         manual = excluded.manual, review = excluded.review, updated_at = excluded.updated_at
       WHERE matches.updated_at IS NULL OR excluded.updated_at > matches.updated_at`,
      m.amc_movie_id, m.amc_title || null, m.amc_year ?? null, m.tmdb_id ?? null,
      m.confidence ?? null, m.manual ? 1 : 0, m.review ?? null, m.updated_at || '1970-01-01T00:00:00.000Z',
    );
    out.matches++;
  }

  return out;
}
