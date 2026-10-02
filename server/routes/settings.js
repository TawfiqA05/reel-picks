// The API: settings, the home base and place lookups, followed theaters, and
// the full-setup export and import.
import { Router } from 'express';
import { get, getSettings, updateSettings, getSetting, dataDir, USER_SETTING_KEYS, DEFAULT_SETTINGS } from '../db.js';
import { exportState, importState } from '../lib/state.js';
import { refreshAll } from '../lib/refresh.js';
import * as amc from '../lib/amc.js';
import { homeBase, addFollowed, removeFollowed, promoteToPrimary, replacePrimary, refreshDistances, sharedTheatreIds } from '../lib/theatres.js';
import { geocode, reverseGeocode, forgetLookupsFor } from '../lib/geocode.js';
import { localYMD } from '../lib/util.js';
import { currentUserId } from '../lib/user.js';
import { startCreditsBackfill } from '../lib/backfill.js';
import { latestBackup, backupsDir } from '../lib/backup.js';
import { settingsProblems } from '../../public/js/settingsRules.js';
import { planProblems } from '../../public/js/plans.js';
import { servicesProblems, cleanServices } from '../../public/js/services.js';
import { h, isOwnerRequest, afterTheatreChange, limited, ownerOnly, forCaller } from './common.js';

const router = Router();

// ---- settings / theatre ------------------------------------------------

router.get('/settings', (req, res) => res.json(forCaller(getSettings())));

// Theaters change only through /theatre and /theatres/*, which keep the caps;
// the refresh bookkeeping is the server's own.
const NOT_VIA_SETTINGS = new Set(['theatreId', 'theatreName', 'theatreSlug', 'extraTheatres', 'lastRefresh', 'lastRefreshLog']);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const shortStrings = (v, max) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length <= 40);
// Every other key is checked for its kind, not coerced: a value of the wrong
// shape (extraTheatres as {}) used to be stored and then broke every request
// that read it, the owner's included.
function shapeProblems(patch) {
  const out = [];
  for (const [k, v] of Object.entries(patch)) {
    const def = DEFAULT_SETTINGS[k];
    if (typeof def === 'boolean' && typeof v !== 'boolean' && v !== 0 && v !== 1) out.push({ key: k, message: 'Use true or false.' });
    if ((k === 'excludedGenres' || k === 'excludedMpaa') && !shortStrings(v, 50)) out.push({ key: k, message: 'Use a list of names.' });
    if (k === 'showtimeWindows') {
      const ok = v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v).every(([day, w]) => ['weekday', 'weekend'].includes(day)
        && w && typeof w === 'object' && typeof w.enabled === 'boolean' && TIME.test(w.after) && TIME.test(w.before));
      if (!ok) out.push({ key: k, message: 'Use weekday and weekend windows with times like 18:30.' });
    }
    if (k === 'home' && v && typeof v === 'object' && 'label' in v && (typeof v.label !== 'string' || v.label.length > 200)) out.push({ key: 'home.label', message: 'Use a place name of up to 200 characters.' });
  }
  return out;
}

router.put('/settings', (req, res) => {
  const patch = { ...(req.body || {}) };
  // Friends change only their own keys; the shared ones are the owner's.
  if (!isOwnerRequest()) for (const k of Object.keys(patch)) if (!USER_SETTING_KEYS.has(k)) delete patch[k];
  const theaterKey = Object.keys(patch).find((k) => NOT_VIA_SETTINGS.has(k));
  if (theaterKey) return res.status(400).json({ error: `${theaterKey}: theaters are changed in Settings, Theaters, not here.` });
  for (const k of Object.keys(patch)) if (!(k in DEFAULT_SETTINGS)) delete patch[k];
  // Numbers out of range (or not numbers) are refused, never coerced: the
  // Settings page checks the same rules (public/js/settingsRules.js) first.
  const problems = [...settingsProblems(patch), ...planProblems(patch), ...servicesProblems(patch), ...shapeProblems(patch)];
  if (problems.length) return res.status(400).json({ error: `${problems[0].key}: ${problems[0].message}`, problems });
  if (patch.weightPublic != null || patch.weightTaste != null) {
    const wp = Number(patch.weightPublic ?? getSetting('weightPublic')) || 0;
    const wt = Number(patch.weightTaste ?? getSetting('weightTaste')) || 0;
    const sum = wp + wt || 1;
    patch.weightPublic = wp / sum;
    patch.weightTaste = wt / sum;
  }
  // Urgency: a non-negative point value and a multiplier of at least 1, so what
  // is stored is what ranking uses and what the Settings page shows.
  for (const k of ['setupDone', 'tourDone', 'youNoteSeen']) if (k in patch) patch[k] = Boolean(patch[k]);
  if ('streamingServices' in patch) patch.streamingServices = cleanServices(patch.streamingServices);
  if ('urgencyBoost' in patch) patch.urgencyBoost = Math.max(0, Number(patch.urgencyBoost) || 0);
  if ('urgencyWatchlistMultiplier' in patch) patch.urgencyWatchlistMultiplier = Math.max(1, Number(patch.urgencyWatchlistMultiplier) || 1);
  // `home` must be a (possibly partial) { label, lat, lng } object. Merge it
  // onto the stored value so a raw client PATCHing one field can't silently
  // reset the others to defaults (the Settings UI always sends all three).
  if ('home' in patch) {
    if (!patch.home || typeof patch.home !== 'object' || Array.isArray(patch.home)) {
      return res.status(400).json({ error: 'home must be an object like { label, lat, lng }.' });
    }
    const cur = getSetting('home') || {};
    const merged = { ...cur };
    for (const k of ['label', 'lat', 'lng']) if (k in patch.home) merged[k] = patch.home[k];
    patch.home = merged;
  }
  const before = homeBase(getSettings());
  const next = updateSettings(patch);
  // Home moved → this user's cached drive times measure from the wrong origin.
  // Drop them and re-measure in the background (one OSRM call per theatre), so
  // the times heal in seconds instead of at the next daily refresh.
  const after = homeBase(next);
  if ('home' in patch && (before.lat !== after.lat || before.lng !== after.lng)) {
    refreshDistances(next, before).catch((e) => console.error('[home] drive-time refresh', e.message));
  }
  res.json(forCaller(next));
});

// ---- home base / geocoding ----------------------------------------------
// The owner's and each friend's own home base. None of these are on the guest
// allowlist (lib/guest.js is default-deny), so the shared link can neither
// geocode nor read home base.

// Free-form text ("Fishers IN", "46037", a street address) → up to 5
// candidates via Nominatim, cached for months and throttled to 1 req/s
// (lib/geocode.js). Failure reports plainly; it never clears anything.
router.get('/geocode', h(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Type a place to look up.' });
  if (limited(req, res, 'place')) return;
  try {
    res.json({ results: await geocode(q) });
  } catch (e) {
    console.error('[geocode]', e.message);
    res.status(502).json({ error: 'Couldn\'t reach the place lookup (nominatim.openstreetmap.org). Check the connection and try again.' });
  }
}));

// Coordinates → place name, for the "use my current location" button. The
// browser already rounds to ~1 km before calling this, and reverseGeocode
// rounds again before anything goes to Nominatim.
router.get('/geocode/reverse', h(async (req, res) => {
  if (limited(req, res, 'place')) return;
  try {
    res.json({ result: await reverseGeocode(req.query.lat, req.query.lng) });
  } catch (e) {
    console.error('[geocode]', e.message);
    res.status(502).json({ error: 'Couldn\'t reach the place lookup. Keep the coordinates and type a label instead.' });
  }
}));

// Clear home base: wipe the stored location and the cache rows derived from
// it (its drive times, and the geocoder lookups that found it; other people's
// lookups stay), then fall back to the app default and re-measure drive times
// from there in the background.
router.delete('/home', h(async (req, res) => {
  const before = homeBase(getSettings());
  const own = get('SELECT value FROM user_settings WHERE user_id = ? AND key = ?', currentUserId(), 'home');
  let ownHome = null;
  try { ownHome = own ? JSON.parse(own.value) : null; } catch { ownHome = null; }
  const next = updateSettings({ home: { label: null, lat: null, lng: null } });
  forgetLookupsFor(ownHome);
  refreshDistances(next, before).catch((e) => console.error('[home] drive-time refresh', e.message));
  res.json({ cleared: true, home: homeBase(next) });
}));

router.get('/theatres', h(async (req, res) => {
  if (!amc.amcConfigured()) return res.status(400).json({ error: 'AMC_API_KEY is not set. Add it to .env to search theaters.' });
  const q = req.query.query ?? '';
  if (typeof q !== 'string') return res.status(400).json({ error: 'Type a theater name, city or ZIP.' });
  res.json({ theatres: await amc.searchTheatres(q) });
}));

// Make a theatre the primary. The old primary stays followed (demoted), so no
// schedule or history is lost; rejected if that would exceed the cap.
// An AMC theater as the Settings search returns it: a numeric id and short text.
function theaterProblem({ id, name, slug } = {}) {
  if (!/^\d{1,10}$/.test(String(id ?? ''))) return 'That isn\'t an AMC theater id.';
  if ((name != null && (typeof name !== 'string' || name.length > 200)) || (slug != null && (typeof slug !== 'string' || slug.length > 200))) return 'That theater name is too long.';
  return null;
}

router.post('/theatre', (req, res) => {
  const { id, name, slug } = req.body || {};
  const bad = theaterProblem(req.body || {});
  if (bad) return res.status(400).json({ error: bad });
  try {
    const wasShared = sharedTheatreIds().has(String(id));
    const settings = replacePrimary({ id, name, slug });
    afterTheatreChange(wasShared, 'theatre');
    res.json(forCaller(settings));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- followed theatres ---------------------------------------------------

router.post('/theatres/follow', (req, res) => {
  const { id, name, slug } = req.body || {};
  const bad = theaterProblem(req.body || {});
  if (bad) return res.status(400).json({ error: bad });
  try {
    const wasShared = sharedTheatreIds().has(String(id));
    const settings = addFollowed({ id, name, slug });
    afterTheatreChange(wasShared, 'follow');
    res.json(forCaller(settings));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.delete('/theatres/follow/:id', (req, res) => {
  res.json(forCaller(removeFollowed(req.params.id)));
});

// Promote a followed theatre to primary; the old primary stays followed.
router.post('/theatres/primary', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Theater id is required.' });
  try {
    const settings = promoteToPrimary(id);
    // Showtimes for both are already loaded; re-run so the per-theatre horizon
    // log and the primary-driven snapshot history line up with the new roles.
    afterTheatreChange(true, 'primary'); // already followed by this user, so already pulled
    res.json(forCaller(settings));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- full-setup state (owner-only; not on the guest allowlist) ----------

// Everything that makes this instance mine, as one JSON download — the way to
// clone a local setup onto a deployment. See lib/state.js for what travels.
router.get('/state', (req, res) => {
  const doc = exportState();
  res.setHeader('Content-Disposition', `attachment; filename="reelpicks-setup-${localYMD()}.json"`);
  res.json(doc);
});

// The newest automatic backup (nightly or pre-migration), as a SQLite file.
// Owner only: it holds everyone's data. Guests never reach it (not on the
// lib/guest.js allowlist).
router.get('/backup/latest', ownerOnly, (req, res) => {
  const b = latestBackup(backupsDir(dataDir));
  if (!b) return res.status(404).json({ error: 'No backup yet. The first one is taken at 3am.' });
  res.set('Cache-Control', 'no-store');
  res.download(b.file, b.name);
});

// Apply a full-setup document, then rebuild everything derived: a forced
// refresh pulls this instance's own showtimes/scores for the imported
// theatres, and detail enrichment fills in posters for imported ratings.
router.post('/state', ownerOnly, (req, res) => {
  let doc = req.body;
  if (typeof doc === 'string') { try { doc = JSON.parse(doc); } catch { doc = null; } }
  try {
    const counts = importState(doc);
    refreshAll({ force: true }).catch((e) => console.error('[state refresh]', e.message));
    startCreditsBackfill('setup import');
    res.json({ imported: counts, refreshing: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

export default router;
