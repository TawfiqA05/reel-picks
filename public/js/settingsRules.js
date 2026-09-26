// What counts as a valid number for each numeric setting. Shared by the
// Settings page (which says what's wrong next to the field) and the server
// (which refuses the same values with a 400), so the two can't disagree.
// No DOM, no imports: server/routes.js loads this same file.

export const NUMBER_RULES = {
  weightPublic: { min: 0, max: 1 },
  weightTaste: { min: 0, max: 1 },
  urgencyBoost: { min: 0, max: 20 },
  urgencyWatchlistMultiplier: { min: 1, max: 5 },
  fallbackRecencyWeeks: { min: 1, max: 104, int: true },
  alistWeeklyLimit: { min: 0, max: 31, int: true }, // visits per plan period; 0 = no limit
  alistMonthlyFee: { min: 0, max: 1000 },
  avgTicketPrice: { min: 0, max: 1000 },
  previewsMinutes: { min: 0, max: 60, int: true },
  watchlistBoost: { min: 0, max: 100 },
  imaxBoost: { min: 0, max: 100 },
  windowFitBoost: { min: 0, max: 100 },
  goodMatchMinScore: { min: 0, max: 100 },
  lastChanceMinScore: { min: 0, max: 100 },
  lastChanceMinGapDays: { min: 1, max: 14, int: true },
  lastChanceMaxEntries: { min: 1, max: 12, int: true },
};

export const HOME_RULES = { lat: { min: -90, max: 90 }, lng: { min: -180, max: 180 } };

// What's wrong with `raw` under `rule`, as a sentence, or null when it's fine.
// `raw` is what was typed (a string) or a value from JSON.
export function numberProblem(rule, raw) {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return 'Enter a number.';
  if (typeof raw !== 'number' && typeof raw !== 'string') return 'Enter a number.';
  const n = Number(raw);
  if (!Number.isFinite(n)) return 'Enter a number.';
  if (rule.int && !Number.isInteger(n)) return `Use a whole number from ${rule.min} to ${rule.max}.`;
  if (n < rule.min || n > rule.max) return `Use a number from ${rule.min} to ${rule.max}.`;
  return null;
}

// Every problem in a settings patch, as [{ key, message }]. Keys the patch
// doesn't carry aren't checked. A home base may leave both coordinates blank
// (the app default) but not just one.
export function settingsProblems(patch) {
  const out = [];
  for (const [key, rule] of Object.entries(NUMBER_RULES)) {
    if (!(key in patch)) continue;
    const m = numberProblem(rule, patch[key]);
    if (m) out.push({ key, message: m });
  }
  const home = patch.home;
  if (home && typeof home === 'object') {
    const blank = (v) => v == null || v === '';
    if (blank(home.lat) !== blank(home.lng) && ('lat' in home) && ('lng' in home)) {
      out.push({ key: blank(home.lat) ? 'home.lat' : 'home.lng', message: 'Enter both latitude and longitude, or leave both blank.' });
    }
    for (const k of ['lat', 'lng']) {
      if (blank(home[k])) continue;
      const m = numberProblem(HOME_RULES[k], home[k]);
      if (m) out.push({ key: `home.${k}`, message: m });
    }
  }
  return out;
}
