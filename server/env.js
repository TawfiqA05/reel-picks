// Tiny zero-dependency .env loader. Reads KEY=VALUE lines from the project-root
// .env file (if present) and copies them into process.env without overriding
// anything already set in the real environment.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));

function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip matching surrounding quotes.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

try {
  const text = fs.readFileSync(envPath, 'utf8');
  const parsed = parseEnv(text);
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
  }
} catch (err) {
  if (err.code !== 'ENOENT') console.warn('[env] could not read .env:', err.message);
}

export const config = {
  get amcKey() {
    return (process.env.AMC_API_KEY || '').trim();
  },
  get tmdbKey() {
    return (process.env.TMDB_API_KEY || '').trim();
  },
  get omdbKey() {
    return (process.env.OMDB_API_KEY || '').trim();
  },
  get port() {
    return Number(process.env.PORT) || 5170;
  },
};

// Running on Railway? Railway sets these in every deployment by itself; only
// their presence is read, never their values.
export function onRailway() {
  return ['RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID']
    .some((k) => Boolean((process.env[k] || '').trim()));
}

export function keyStatus() {
  return {
    amc: Boolean(config.amcKey),
    tmdb: Boolean(config.tmdbKey),
    omdb: Boolean(config.omdbKey),
  };
}
