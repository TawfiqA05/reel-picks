// Zero-dependency CSV parsing + Letterboxd/IMDb ratings-export detection.
// Normalizes both to { title, year, rating(0.5-5 stars), rated_at, source }.

// RFC-4180-ish parser: handles quoted fields, embedded commas/newlines, "" escapes.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/^﻿/, ''); // strip BOM
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

function indexHeader(header) {
  const map = {};
  header.forEach((h, i) => {
    map[h.trim().toLowerCase()] = i;
  });
  return map;
}

export function detectFormat(header) {
  const h = header.map((x) => x.trim().toLowerCase());
  if (h.includes('type') && h.includes('tmdb_id')) return 'reelpicks'; // our own backup export
  if (h.includes('letterboxd uri')) {
    // watched.csv / watchlist.csv have the same shape as ratings.csv MINUS the
    // Rating column — the classic wrong-file upload. Name it so the error can.
    return h.includes('rating') ? 'letterboxd' : 'letterboxd-no-ratings';
  }
  if (h.includes('name') && h.includes('rating') && !h.includes('your rating')) return 'letterboxd';
  if (h.includes('your rating')) return 'imdb';
  // IMDb list/watchlist exports carry Const but no "Your Rating" column.
  if (h.includes('const')) return 'imdb-no-ratings';
  return 'unknown';
}

// Parse a Reel Picks backup export (from GET /api/export) back into ratings +
// watch history. Ratings carry tmdb_id, so no title matching is needed.
export function parseBackupCsv(text) {
  const parsed = parseCsv(text);
  if (parsed.length < 2) return { format: 'reelpicks', ratings: [], watched: [] };
  const idx = indexHeader(parsed[0]);
  const cell = (cols, name) => {
    const j = idx[name];
    return j == null ? '' : (cols[j] ?? '').trim();
  };
  const ratings = [];
  const watched = [];
  // Rows that can't be restored are counted, not dropped silently: a garbled
  // backup line should show up in the "Restored …" message.
  let skipped = 0;
  const skippedSamples = [];
  const skip = (i, why) => { skipped++; if (skippedSamples.length < 5) skippedSamples.push(`line ${i + 1}: ${why}`); };
  for (let i = 1; i < parsed.length; i++) {
    const cols = parsed[i];
    if (cols.length === 1 && !cols[0].trim()) continue; // blank line, not data
    const type = cell(cols, 'type').toLowerCase();
    const tmdb_id = Number(cell(cols, 'tmdb_id'));
    if (!Number.isInteger(tmdb_id) || tmdb_id <= 0) { skip(i, `bad tmdb_id "${cell(cols, 'tmdb_id')}"`); continue; }
    if (type === 'rating') {
      const rating = parseFloat(cell(cols, 'rating'));
      if (!Number.isFinite(rating)) { skip(i, `bad rating "${cell(cols, 'rating')}" for "${cell(cols, 'title')}"`); continue; }
      ratings.push({
        tmdb_id,
        title: cell(cols, 'title'),
        year: yr(cell(cols, 'year')),
        rating: Math.max(0.5, Math.min(5, rating)),
        source: cell(cols, 'source') || 'import',
        rated_at: cell(cols, 'ratedat') || null,
      });
    } else if (type === 'watched') {
      const price = parseFloat(cell(cols, 'price'));
      watched.push({
        tmdb_id,
        title: cell(cols, 'title'),
        watched_at: cell(cols, 'watchedat') || null,
        in_weekly4: cell(cols, 'inweekly4') === '1',
        price: Number.isFinite(price) ? price : null,
      });
    } else {
      skip(i, `unknown row type "${type || ''}"`);
    }
  }
  return { format: 'reelpicks', ratings, watched, skipped, skippedSamples };
}

const yr = (v) => {
  const n = Number(String(v || '').match(/\d{4}/)?.[0]);
  return Number.isFinite(n) ? n : null;
};

// Import ratings from CSV text. Returns { format, rows:[{title,year,rating,rated_at,source}],
// skipped, skippedSamples } — skipped rows are ones without a parsable star
// rating (on Letterboxd that's every watched-but-never-rated film).
export function normalizeRatingsCsv(text) {
  const parsed = parseCsv(text);
  if (parsed.length < 1) return { format: 'unknown', rows: [], skipped: 0, skippedSamples: [], error: 'No rows found in file.' };
  const header = parsed[0];
  const format = detectFormat(header);
  const idx = indexHeader(header);
  const out = [];
  let skipped = 0;
  const skippedSamples = [];
  const skip = (title) => { skipped++; if (title && skippedSamples.length < 5) skippedSamples.push(title); };

  for (let i = 1; i < parsed.length; i++) {
    const cols = parsed[i];
    const get = (name) => {
      const j = idx[name];
      return j == null ? '' : (cols[j] ?? '').trim();
    };

    if (format === 'letterboxd') {
      const rating = parseFloat(get('rating'));
      if (!Number.isFinite(rating)) {
        skip(get('name'));
        continue;
      }
      out.push({
        title: get('name'),
        year: yr(get('year')),
        rating: Math.max(0.5, Math.min(5, rating)),
        rated_at: get('date') || null,
        source: 'letterboxd',
      });
    } else if (format === 'imdb') {
      const raw = parseFloat(get('your rating')); // 1-10
      if (!Number.isFinite(raw)) {
        skip(get('title'));
        continue;
      }
      out.push({
        title: get('title'),
        year: yr(get('year')),
        rating: Math.max(0.5, Math.min(5, raw / 2)),
        rated_at: get('date rated') || null,
        source: 'imdb',
      });
    } else {
      skipped++;
    }
  }

  return { format, rows: out, skipped, skippedSamples };
}
