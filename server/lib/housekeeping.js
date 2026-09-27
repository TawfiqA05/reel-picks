// Nightly housekeeping, run right after the 3am backup succeeds (index.js),
// so whatever it removes is still in that night's copy.
//
// The cache table is the only thing it touches. A row more than three times
// past its lifetime goes: cachedJson (lib/cache.js) serves an expired row only
// when a live call fails, and three lifetimes is ample for that. Rows with no
// lifetime are left. Once, after the first such cleanup, a VACUUM gives the
// freed space back to the disk; it never runs again on its own.
import { db, run, getSetting, setSetting } from '../db.js';

export function afterNightlyBackup(now = new Date()) {
  try {
    const gone = run(
      `DELETE FROM cache WHERE ttl > 0 AND fetched_at IS NOT NULL
         AND (julianday(?) - julianday(fetched_at)) * 86400 > ttl * 3`,
      now.toISOString(),
    ).changes;
    console.log(`[housekeeping] cache: removed ${gone} row(s) more than 3x past their lifetime`);
  } catch (e) {
    console.error('[housekeeping] cache cleanup failed:', e.message);
    return;
  }
  if (getSetting('cacheVacuumedAt')) return;
  try {
    const t = Date.now();
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    setSetting('cacheVacuumedAt', now.toISOString());
    console.log(`[housekeeping] VACUUM done in ${Date.now() - t} ms (one time only)`);
  } catch (e) {
    console.error('[housekeeping] VACUUM failed; it will try again after the next backup:', e.message);
  }
}
