// Forgiving title matching, shared by the header search (server and browser)
// and the list filters. Case, accents and punctuation never matter ("amelie"
// finds "Amélie", "spiderman" finds "Spider-Man"), each word of the query may
// be the start or any part of any word ("gun mav" finds "Top Gun: Maverick"),
// and a word of four letters or more may be a letter or two off
// ("interstelar"). No DOM, no imports: the server loads this same file.

const MARKS = /[̀-ͯ]/g;
// Letters NFD leaves whole.
const FOLD = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' };
const FOLD_RE = /[øæœßłđðþı]/g;

export function norm(s) {
  return String(s ?? '').normalize('NFD').replace(MARKS, '').toLowerCase()
    .replace(FOLD_RE, (c) => FOLD[c])
    .replace(/&/g, ' and ')
    .replace(/['’‘`]/g, '') // "don't" is one word, as typed without the apostrophe
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const compactOf = (n) => n.replace(/ /g, '');

// A list item, prepared once. fields[0] is the title; the rest (director,
// cast) only ever match word by word.
export function prepare(fields) {
  const list = (Array.isArray(fields) ? fields : [fields]).flat().filter((f) => f != null && f !== '');
  const normed = list.map(norm);
  const t = normed[0] || '';
  return {
    t,
    tc: compactOf(t),
    words: [...new Set(normed.flatMap((n) => n.split(' ')).filter(Boolean))],
    compacts: normed.map(compactOf),
  };
}

export function query(q) {
  const n = norm(q);
  return { n, c: compactOf(n), tokens: n ? n.split(' ') : [] };
}

// Optimal string alignment distance, giving up once it passes `max`.
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

// How well one query word fits a word of the item: 3 starts it, 2 sits
// inside it, 1 is a small typo of it (or of its start), 0 no.
function tokenFit(tok, words) {
  let best = 0;
  for (const w of words) {
    if (w.startsWith(tok)) return 3;
    if (best < 2 && w.includes(tok)) best = 2;
  }
  if (best || tok.length < 4) return best;
  const k = tok.length >= 8 ? 2 : 1;
  for (const w of words) {
    if (w.length < 3) continue;
    for (const cut of [w, w.slice(0, tok.length), w.slice(0, tok.length + 1), w.slice(0, tok.length - 1)]) {
      if (distance(tok, cut, k) <= k) return 1;
    }
  }
  return 0;
}

export const EXACT = 1000;
export const STARTS = 900;

// 0 = no match. EXACT and STARTS compare the title as a whole; below that,
// every query word has to fit somewhere, and a typo-only fit scores lowest.
export function score(q, item) {
  if (!q.n) return 0;
  if (q.n === item.t || (q.c && q.c === item.tc)) return EXACT;
  if (item.t.startsWith(q.n) || (q.c.length >= 3 && item.tc.startsWith(q.c))) return STARTS;
  let sum = 0;
  let typos = 0;
  for (const tok of q.tokens) {
    const f = tokenFit(tok, item.words);
    if (!f) {
      // "spiderman" against "spider man", "topgun" against "top gun".
      if (q.c.length >= 4 && item.compacts.some((c) => c.includes(q.c))) return 500;
      return 0;
    }
    if (f === 1) typos++;
    sum += f;
  }
  return typos ? 100 + Math.min(sum * 10, 150) : 300 + Math.min(sum * 10, 190);
}

export const isTypoOnly = (s) => s > 0 && s < 300; // 100–250 typo, 300–490 words, 500 run-together, 900+ whole title

export function matches(q, item) {
  return score(q, item) > 0;
}
