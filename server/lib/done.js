// A film someone has now seen, rated or saved: whatever was waiting on it
// for them goes. Their "I'm going" plan and its morning question
// (lib/plans.js) go when they see or rate it; a pick sent to them
// (lib/sends.js) goes when they see, rate or save it.
//
// Only what was made before the event goes: an old rating brought in by an
// import, or an old Letterboxd diary entry, leaves a plan or a pick made
// since then where it is. Imports db.js alone, so the rating and watch-log
// writers can call it without an import cycle.
import { run } from '../db.js';

const CLEARS_PLAN = new Set(['seen', 'rated']);

export function filmDone(userId, tmdbId, how, at = null) {
  const now = new Date().toISOString();
  const t = at ? new Date(at) : null;
  const when = t && Number.isFinite(t.getTime()) ? t.toISOString() : now;
  if (CLEARS_PLAN.has(how)) {
    run('DELETE FROM plans WHERE user_id = ? AND tmdb_id = ? AND created_at <= ?', userId, tmdbId, when);
  }
  run(
    'UPDATE sends SET cleared_at = ?, cleared_how = ? WHERE to_user = ? AND tmdb_id = ? AND cleared_at IS NULL AND sent_at <= ?',
    now, how, userId, tmdbId, when,
  );
}
