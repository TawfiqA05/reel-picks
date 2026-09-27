// A film's main poster colour, for the glow behind the top of Picks and the
// movie page in dark mode. Worked out once per poster from TMDB's smallest
// poster (92px wide), stored on the film (movies.poster_color, with the
// poster it came from in poster_color_src) and never asked again unless the
// poster changes. "-" means the poster has no colour worth a glow (greys,
// black and white); the page then uses a faint amber one.
//
// The colour is the most common strong hue on the poster, averaged, then
// held to a middle lightness and saturation, so a pale or neon poster can't
// wash out the text drawn over its glow.
import jpeg from 'jpeg-js';
import { all, run, get } from '../db.js';

const SMALL = 'w92';
const MAX_BYTES = 200 * 1024;

const small = (url) => (typeof url === 'string' && url.startsWith('https://image.tmdb.org/') ? url.replace(/\/(w\d+|original)\//, `/${SMALL}/`) : null);

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
}

// The dominant strong colour of an RGBA pixel buffer, or null.
export function dominantColor({ data, width, height }) {
  const bins = new Map(); // hue bucket -> { n, h (x,y for circular mean), s, l }
  let counted = 0;
  const step = Math.max(1, Math.floor((width * height) / 4000));
  for (let i = 0; i < width * height; i += step) {
    const o = i * 4;
    const [h, s, l] = rgbToHsl(data[o], data[o + 1], data[o + 2]);
    counted++;
    if (s < 0.28 || l < 0.12 || l > 0.88) continue; // greys, near black, near white
    const key = Math.floor(h / 20);
    const w = s * (1 - Math.abs(l - 0.5));
    const b = bins.get(key) || { n: 0, x: 0, y: 0, s: 0, l: 0 };
    b.n += w; b.x += Math.cos((h * Math.PI) / 180) * w; b.y += Math.sin((h * Math.PI) / 180) * w; b.s += s * w; b.l += l * w;
    bins.set(key, b);
  }
  const best = [...bins.values()].sort((a, b) => b.n - a.n)[0];
  // A colour that covers too little of the poster isn't its colour.
  if (!best || best.n < counted * 0.04) return null;
  let h = (Math.atan2(best.y, best.x) * 180) / Math.PI;
  if (h < 0) h += 360;
  const s = Math.min(0.75, Math.max(0.35, best.s / best.n));
  const l = Math.min(0.5, Math.max(0.38, best.l / best.n));
  return hslToHex(h, s, l);
}

async function colorOf(posterUrl) {
  const url = small(posterUrl);
  if (!url) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`poster ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('poster too large');
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 1, maxMemoryUsageInMB: 32 });
  return dominantColor(img);
}

// Films that need a colour: playing or coming soon, with a poster that has
// none worked out (or one worked out from a different poster).
function needing(limit) {
  return all(`SELECT tmdb_id, poster FROM movies
    WHERE poster IS NOT NULL AND (poster_color IS NULL OR poster_color_src IS NOT poster)
      AND (playing = 1 OR upcoming = 1)
    ORDER BY playing DESC LIMIT ?`, limit);
}

export function storeColor(tmdbId, poster, color) {
  run('UPDATE movies SET poster_color = ?, poster_color_src = ? WHERE tmdb_id = ?', color || '-', poster, tmdbId);
}

let running = null;
// Works through every film that needs one, four at a time. Safe to call
// often: one run at a time, and a film that fails is tried again next run.
export function backfillPosterColors({ limit = 400 } = {}) {
  if (running) return running;
  running = (async () => {
    const list = needing(limit);
    let done = 0;
    for (let i = 0; i < list.length; i += 4) {
      await Promise.all(list.slice(i, i + 4).map(async (m) => {
        try { storeColor(m.tmdb_id, m.poster, await colorOf(m.poster)); done++; } catch { /* next run */ }
      }));
    }
    if (list.length) console.log(`  ✓ Poster colours: ${done} of ${list.length} film(s)`);
    return done;
  })().finally(() => { running = null; });
  return running;
}

// One film, when its page is opened and it has none yet (a film found by
// search, say). Answers at once; the colour is there next time.
export function ensurePosterColor(tmdbId) {
  const m = get('SELECT poster, poster_color, poster_color_src FROM movies WHERE tmdb_id = ?', tmdbId);
  if (!m?.poster || (m.poster_color && m.poster_color_src === m.poster)) return;
  colorOf(m.poster).then((c) => storeColor(tmdbId, m.poster, c)).catch(() => {});
}

// What the page gets: a hex colour, or null for "use the faint amber".
export const glowColor = (m) => (m?.poster_color && m.poster_color !== '-' && m.poster_color_src === m.poster ? m.poster_color : null);
