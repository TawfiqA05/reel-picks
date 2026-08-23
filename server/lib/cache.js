// Cached HTTP-JSON helper backed by the SQLite `cache` table. Enforces
// once-per-day style refresh windows and serves stale data if a fetch fails.
import { get, run } from '../db.js';

export function redact(url) {
  return String(url).replace(/(api_?key|apikey)=([^&]+)/gi, '$1=***');
}

export async function fetchJson(url, opts = {}) {
  const { headers = {}, timeoutMs = 15000, method = 'GET' } = opts;
  let res;
  try {
    res = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = new Error(`Network error for ${redact(url)}: ${err.message}`);
    e.cause = err;
    throw e;
  }
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${redact(url)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Returns parsed JSON, using the cache when a fresh copy exists. On fetch
// failure, returns the last cached value (if any) rather than throwing.
//
// `meta` (optional) is filled in so callers can tell HOW they got their data:
//   { source: 'cache' | 'live' | 'stale', fetchedAt, stale: boolean, error }
// 'stale' means the live fetch failed and an older cached copy was served —
// the caller is responsible for saying so somewhere the owner can see it.
export async function cachedJson(key, ttlSeconds, fetcher, { force = false, meta = null } = {}) {
  const row = get('SELECT value, fetched_at, ttl FROM cache WHERE key = ?', key);
  const ageSec = row ? (Date.now() - Date.parse(row.fetched_at)) / 1000 : Infinity;
  const fresh = row && ageSec < (row.ttl ?? ttlSeconds);
  const note = (patch) => { if (meta) Object.assign(meta, patch); };
  if (row && fresh && !force) {
    try {
      const v = JSON.parse(row.value);
      note({ source: 'cache', fetchedAt: row.fetched_at, stale: false, error: null });
      return v;
    } catch {
      /* fall through and refetch */
    }
  }
  try {
    const data = await fetcher();
    const now = new Date().toISOString();
    run(
      `INSERT INTO cache(key, value, fetched_at, ttl) VALUES(?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at, ttl = excluded.ttl`,
      key,
      JSON.stringify(data ?? null),
      now,
      ttlSeconds,
    );
    note({ source: 'live', fetchedAt: now, stale: false, error: null });
    return data;
  } catch (err) {
    if (row) {
      try {
        const v = JSON.parse(row.value); // stale-on-error
        note({ source: 'stale', fetchedAt: row.fetched_at, stale: true, error: err.message });
        return v;
      } catch {
        /* ignore */
      }
    }
    note({ source: 'error', fetchedAt: null, stale: false, error: err.message });
    throw err;
  }
}

export function bustCache(prefix) {
  run("DELETE FROM cache WHERE key LIKE ?", `${prefix}%`);
}
