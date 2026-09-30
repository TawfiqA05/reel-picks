// Nightly housekeeping, run right after the 3am backup succeeds (index.js),
// so whatever it removes is still in that night's copy.
//
// The cache: a row more than three times past its lifetime goes: cachedJson
// (lib/cache.js) serves an expired row only when a live call fails, and three
// lifetimes is ample for that. Rows with no lifetime are left. Once, after the
// first such cleanup, a VACUUM gives the freed space back to the disk; it
// never runs again on its own. VACUUM rewrites the whole database through the
// WAL, so it waits (for a later night) while the data volume hasn't room for
// one more copy of the database plus the backups' margin.
//
// Owner alerts (lib/alerts.js): the log of alerts sent is kept for 90 days.
// Each problem's current state (alert_state) is never touched.
import { db, dataDir, run, getSetting, setSetting } from '../db.js';
import { volume, roomNeeded } from './backup.js';

export const ALERTS_KEEP_DAYS = 90;

export function afterNightlyBackup(now = new Date()) {
  try {
    const gone = run(
      'DELETE FROM owner_alerts WHERE julianday(?) - julianday(at) > ?',
      now.toISOString(), ALERTS_KEEP_DAYS,
    ).changes;
    console.log(`[housekeeping] owner alerts: removed ${gone} older than ${ALERTS_KEEP_DAYS} days`);
  } catch (e) {
    console.error('[housekeeping] owner alerts cleanup failed:', e.message);
  }
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
  const free = volume(dataDir)?.free;
  const need = roomNeeded(dataDir).total;
  if (free != null && free < need) {
    console.log(`[housekeeping] VACUUM waits: ${Math.round(free / 1048576)} MB free, it needs about ${Math.round(need / 1048576)} MB; it will try again after the next backup`);
    return;
  }
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
