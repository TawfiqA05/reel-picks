// Notes on ratings: one line of plain text a person keeps with a film they
// rated, up to NOTE_MAX characters. Private to its author: every read here is
// by user id, and nothing that shows one person's films to another (Together,
// the guest link, push, the owner's views of friends) asks for them.
//
// Where a note comes from (rating_notes.source):
//   app         written or edited here. Never overwritten by Letterboxd. A
//               Delete here leaves an app row with no text, so Letterboxd's
//               review for that film stays away too.
//   letterboxd  a review brought in by the daily RSS sync or a reviews.csv
//               import. The note is the review as plain text, cut at
//               NOTE_MAX with an ellipsis; `full` keeps the whole review when
//               it had to be cut. A later sync or import may update it.
//
// A note belongs to a rating: saving one needs the rating, and clearing the
// rating takes its note (and any Delete marker) with it. Notes change no score.
import { get, run, all } from '../db.js';

export const NOTE_MAX = 280;
// A review longer than this isn't kept whole (Letterboxd reviews run long,
// but a novel in the database helps no one).
const FULL_MAX = 20000;

const status = (code, message) => Object.assign(new Error(message), { status: code });
const chars = (s) => [...s].length;

// Invisible and direction-changing characters, and control characters.
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;
// Something that reads as an HTML tag, comment or doctype: "<b>", "</p",
// "<!--". A lone "<" ("I <3 it", "x < y") is fine.
const LOOKS_LIKE_HTML = /<\s*(?:\/?\s*[a-z]|!)/i;

// A note typed here: plain text on one line, 1 to NOTE_MAX characters.
// Throws a 400 with the reason otherwise.
export function cleanNote(raw) {
  if (typeof raw !== 'string') throw status(400, 'A note is plain text.');
  if (raw.length > NOTE_MAX * 8) throw status(400, `Keep the note to ${NOTE_MAX} characters.`);
  const s = raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if (!s) throw status(400, 'Write something first, or use Delete to remove the note.');
  if (LOOKS_LIKE_HTML.test(s)) throw status(400, 'Notes are plain text. Take out the HTML tags.');
  if (chars(s) > NOTE_MAX) throw status(400, `Keep the note to ${NOTE_MAX} characters.`);
  return s;
}

// ---- turning a Letterboxd review into a note ---------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '-', ndash: '-', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// HTML (a feed's description) to plain text: paragraphs and line breaks
// become new lines, every tag goes, entities are decoded, spaces are tidied.
export function htmlToText(html) {
  return decodeEntities(String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|blockquote|li|h\d)\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, ''))
    .replace(INVISIBLE, (c) => (c === '\n' ? c : ''))
    .split('\n').map((l) => l.replace(/[ \t\r\f\v ]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The whole review text -> { note, full }: the note on one line, cut at
// NOTE_MAX (at a word where there is one close by) with an ellipsis; `full`
// is the review itself when it was cut, else null.
export function shortNote(text) {
  const whole = String(text ?? '').replace(INVISIBLE, (c) => (c === '\n' ? c : '')).trim();
  if (!whole) return null;
  const line = whole.replace(/\s+/g, ' ');
  const cp = [...line];
  if (cp.length <= NOTE_MAX) return { note: line, full: whole.includes('\n') ? whole.slice(0, FULL_MAX) : null };
  let cut = cp.slice(0, NOTE_MAX - 1).join('');
  const space = cut.lastIndexOf(' ');
  if (space > NOTE_MAX * 0.75) cut = cut.slice(0, space);
  return { note: `${cut.replace(/[\s.,;:!?-]+$/, '')}…`, full: [...whole].slice(0, FULL_MAX).join('') };
}

// A Letterboxd feed item's description -> the review as plain text, or null
// when the entry has none. With no review, Letterboxd writes "Watched on
// <date>." under the poster; a spoiler review opens with "This review may
// contain spoilers." Both lines are Letterboxd's, not the review.
export function reviewFromDescription(html) {
  const cleaned = String(html ?? '')
    .replace(/<p>\s*<img[^>]*>\s*<\/p>/gi, ' ')
    .replace(/<img[^>]*>/gi, ' ')
    .replace(/<p>\s*(<em>)?\s*This review may contain spoilers\.?\s*(<\/em>)?\s*<\/p>/gi, ' ');
  const text = htmlToText(cleaned);
  if (!text) return null;
  if (/^(Re)?watched on [A-Za-z]+,? [A-Za-z]+ \d{1,2},? \d{4}\.?$/i.test(text)) return null;
  if (/^This review may contain spoilers\.?$/i.test(text)) return null;
  return text;
}

// ---- storage -----------------------------------------------------------------

const hasRating = (userId, tmdbId) => Boolean(get('SELECT 1 AS x FROM ratings WHERE user_id = ? AND tmdb_id = ?', userId, tmdbId));

// What a page shows: { note, full, source }, or null when there's no note
// (none, or deleted here).
export function getNote(userId, tmdbId) {
  const r = get('SELECT note, full, source FROM rating_notes WHERE user_id = ? AND tmdb_id = ?', userId, tmdbId);
  return r?.note ? { note: r.note, full: r.full || null, source: r.source } : null;
}

// Every note this person has, by film: Map(tmdb_id -> { note, full, source }).
export function notesOf(userId) {
  const out = new Map();
  for (const r of all('SELECT tmdb_id, note, full, source FROM rating_notes WHERE user_id = ? AND note IS NOT NULL', userId)) {
    out.set(r.tmdb_id, { note: r.note, full: r.full || null, source: r.source });
  }
  return out;
}

// Written or edited here. Needs a rating for the film (404 without one).
export function setNote(userId, tmdbId, raw) {
  const note = cleanNote(raw);
  if (!hasRating(userId, tmdbId)) throw status(404, 'Rate the film first, then add a note.');
  run(`INSERT INTO rating_notes(user_id, tmdb_id, note, full, source, updated_at) VALUES(?,?,?,NULL,'app',?)
       ON CONFLICT(user_id, tmdb_id) DO UPDATE SET note = excluded.note, full = NULL, source = 'app', updated_at = excluded.updated_at`,
  userId, tmdbId, note, new Date().toISOString());
  return { note, full: null, source: 'app' };
}

// Deleted here: an app row with no text, which keeps a Letterboxd review for
// the film from coming back. Nothing to delete is fine.
export function deleteNote(userId, tmdbId) {
  if (!hasRating(userId, tmdbId)) { run('DELETE FROM rating_notes WHERE user_id = ? AND tmdb_id = ?', userId, tmdbId); return; }
  run(`INSERT INTO rating_notes(user_id, tmdb_id, note, full, source, updated_at) VALUES(?,?,NULL,NULL,'app',?)
       ON CONFLICT(user_id, tmdb_id) DO UPDATE SET note = NULL, full = NULL, source = 'app', updated_at = excluded.updated_at`,
  userId, tmdbId, new Date().toISOString());
}

// The rating went: its note goes with it.
export function dropNote(userId, tmdbId) {
  run('DELETE FROM rating_notes WHERE user_id = ? AND tmdb_id = ?', userId, tmdbId);
}

// A Letterboxd review for a film this person rated. Written only when there's
// no app note (or Delete marker) for the film. Returns true when it wrote.
export function letterboxdNote(userId, tmdbId, reviewText) {
  const short = shortNote(reviewText);
  if (!short || !hasRating(userId, tmdbId)) return false;
  const cur = get('SELECT note, full, source FROM rating_notes WHERE user_id = ? AND tmdb_id = ?', userId, tmdbId);
  if (cur?.source === 'app') return false;
  if (cur && cur.note === short.note && (cur.full || null) === short.full) return false;
  run(`INSERT INTO rating_notes(user_id, tmdb_id, note, full, source, updated_at) VALUES(?,?,?,?,'letterboxd',?)
       ON CONFLICT(user_id, tmdb_id) DO UPDATE SET note = excluded.note, full = excluded.full, source = 'letterboxd', updated_at = excluded.updated_at
       WHERE rating_notes.source = 'letterboxd'`,
  userId, tmdbId, short.note, short.full, new Date().toISOString());
  return true;
}

// ---- the full-setup export and import -----------------------------------------

// This person's rows, Delete markers included (so an imported copy keeps a
// deleted Letterboxd review away as well).
export function exportNotes(userId) {
  return all('SELECT tmdb_id, note, full, source, updated_at FROM rating_notes WHERE user_id = ? ORDER BY tmdb_id', userId);
}

// Rows from an export. Checked like a note typed here (an app note) or a
// review (Letterboxd), and only for films this person has rated after the
// ratings were imported. An app note already here wins over a Letterboxd one
// from the file; otherwise the file's row is taken. Returns how many landed.
export function importNotes(userId, rows) {
  if (!Array.isArray(rows)) return 0;
  let n = 0;
  for (const r of rows.slice(0, 50000)) {
    const tmdbId = Number(r?.tmdb_id);
    if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0 || !hasRating(userId, tmdbId)) continue;
    const source = r.source === 'letterboxd' ? 'letterboxd' : 'app';
    const at = typeof r.updated_at === 'string' && !Number.isNaN(Date.parse(r.updated_at)) ? r.updated_at : new Date().toISOString();
    const cur = get('SELECT source FROM rating_notes WHERE user_id = ? AND tmdb_id = ?', userId, tmdbId);
    if (source === 'letterboxd') {
      if (cur?.source === 'app') continue;
      const text = typeof r.full === 'string' && r.full ? r.full : r.note;
      if (typeof text !== 'string') continue;
      const short = shortNote(text.slice(0, FULL_MAX));
      if (!short) continue;
      run(`INSERT INTO rating_notes(user_id, tmdb_id, note, full, source, updated_at) VALUES(?,?,?,?,'letterboxd',?)
           ON CONFLICT(user_id, tmdb_id) DO UPDATE SET note = excluded.note, full = excluded.full, source = 'letterboxd', updated_at = excluded.updated_at`,
      userId, tmdbId, short.note, short.full, at);
      n++;
      continue;
    }
    let note = null;
    if (r.note != null) { try { note = cleanNote(r.note); } catch { continue; } }
    run(`INSERT INTO rating_notes(user_id, tmdb_id, note, full, source, updated_at) VALUES(?,?,?,NULL,'app',?)
         ON CONFLICT(user_id, tmdb_id) DO UPDATE SET note = excluded.note, full = NULL, source = 'app', updated_at = excluded.updated_at`,
    userId, tmdbId, note, at);
    n++;
  }
  return n;
}

// ---- reviews.csv rows waiting for a TMDB match ----------------------------------

export function queueReview({ userId, title, year, rating, review, rated_at }) {
  run('INSERT INTO unmatched_notes(user_id, title, year, rating, review, rated_at) VALUES(?,?,?,?,?,?)',
    userId, title, year ?? null, rating ?? null, review, rated_at || null);
}

export const pendingReviews = (userId) => get('SELECT COUNT(*) AS n FROM unmatched_notes WHERE user_id = ?', userId).n;
