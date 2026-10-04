// The API, owner only: AMC title matches, friends, the off-site backup and
// owner alerts.
import { Router } from 'express';
import { get, run, getSettings, dataDir } from '../db.js';
import { ingestOne } from '../lib/refresh.js';
import { setManualMatch, ignoreMatch, unignoreMatch, unmatchedTitles, reviewTitles, keepMatch } from '../lib/match.js';
import { followedTheatres } from '../lib/theatres.js';
import { localYMD, addDays } from '../lib/util.js';
import { currentUserId } from '../lib/user.js';
import { listFriends, createFriend, revokeFriend, reissueFriend, MAX_USERS } from '../lib/accounts.js';
import { pushEnabled } from '../lib/push.js';
import { recentAlerts, failingNow } from '../lib/alerts.js';
import { offsiteStatus, offsiteEnabled, uploadNow as offsiteUpload } from '../lib/offsite.js';
import { h, ownerOnly } from './common.js';

const router = Router();

// ---- AMC->TMDB matches: unmatched list, fix, ignore --------------------

// AMC titles currently showing that have no TMDB record, with where/when they
// play, so they can be matched by hand (or ignored, e.g. "Screen Unseen").
router.get('/matches/unmatched', ownerOnly, (req, res) => {
  const short = new Map(followedTheatres(getSettings()).map((t) => [t.id, t.short]));
  const decorate = (r) => ({ ...r, theatres: r.theatre_ids.map((id) => ({ id, short: short.get(id) || id })) });
  const data = unmatchedTitles(localYMD());
  res.json({
    unmatched: data.unmatched.map(decorate),
    ignored: data.ignored.map(decorate),
    review: reviewTitles(localYMD()).map(decorate),
  });
});

// Owner looked at a flagged automatic match and it's right: keep it.
router.post('/match/keep', ownerOnly, (req, res) => {
  const { amc_movie_id } = req.body || {};
  if (!amc_movie_id) return res.status(400).json({ error: 'amc_movie_id required.' });
  keepMatch(String(amc_movie_id));
  res.json({ ok: true });
});

router.post('/match/ignore', ownerOnly, (req, res) => {
  const { amc_movie_id, amc_title } = req.body || {};
  if (!amc_movie_id) return res.status(400).json({ error: 'amc_movie_id required.' });
  ignoreMatch(String(amc_movie_id), amc_title || '');
  res.json({ ok: true });
});

// Forget an ignore: the next refresh retries the match automatically.
router.delete('/match/ignore/:id', ownerOnly, (req, res) => {
  unignoreMatch(String(req.params.id));
  res.json({ ok: true });
});

router.post('/match/set', ownerOnly, h(async (req, res) => {
  const { amc_movie_id, amc_title, tmdb_id } = req.body || {};
  if (!amc_movie_id || !tmdb_id) return res.status(400).json({ error: 'amc_movie_id and tmdb_id required.' });
  await ingestOne(tmdb_id); // make sure the movie exists with full details
  setManualMatch(amc_movie_id, amc_title || '', tmdb_id);
  const today = localYMD();
  const weekEnd = localYMD(addDays(new Date(), 6));
  run(
    `UPDATE movies SET playing = 1, playing_source = 'amc'
      WHERE tmdb_id = ? AND EXISTS(SELECT 1 FROM showtimes WHERE tmdb_id = ? AND date >= ? AND date <= ?)`,
    tmdb_id, tmdb_id, today, weekEnd,
  );
  res.json({ ok: true });
}));

// ---- friends (owner only) -------------------------------------------------
// Invite links are shown once, at creation or re-issue; only a hash is kept.

router.get('/friends', ownerOnly, (req, res) => res.json({ friends: listFriends(), max: MAX_USERS }));

router.post('/friends', ownerOnly, (req, res) => {
  try {
    const { friend, token } = createFriend(req.body?.name);
    res.json({ friend, invite: `/?invite=${token}` });
  } catch (e) {
    if (!e.status) console.error('[friends]', e.message);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong on the server. Try again.' });
  }
});

router.post('/friends/:id/revoke', ownerOnly, (req, res) => {
  try {
    res.json({ friend: revokeFriend(req.params.id) });
  } catch (e) {
    if (!e.status) console.error('[friends]', e.message);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong on the server. Try again.' });
  }
});

router.post('/friends/:id/reissue', ownerOnly, (req, res) => {
  try {
    const { friend, token } = reissueFriend(req.params.id);
    res.json({ friend, invite: `/?invite=${token}` });
  } catch (e) {
    if (!e.status) console.error('[friends]', e.message);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong on the server. Try again.' });
  }
});

// ---- off-site backup (lib/offsite.js) ---------------------------------------
// Owner only. With BACKUP_S3_* unset: { enabled: false }, and nothing to press.

router.get('/offsite', ownerOnly, (req, res) => res.json(offsiteStatus()));

router.post('/offsite/upload', ownerOnly, h(async (req, res) => {
  if (!offsiteEnabled()) return res.status(404).json({ error: 'Off-site backup isn\'t set up on this server.' });
  res.json(await offsiteUpload(dataDir));
}));

// ---- owner alerts (lib/alerts.js) ------------------------------------------
// The last 10 alerts and what's failing now, for the owner's Settings card.
// Friends get a 403; the guest link never reaches it (lib/guest.js).
router.get('/alerts', ownerOnly, (req, res) => {
  res.json({
    alerts: recentAlerts(10),
    failing: failingNow(),
    pushEnabled: pushEnabled(),
    devices: get('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?', currentUserId()).n,
  });
});

export default router;
