// The API: watching together, I'm going plans and Send a pick.
import { Router } from 'express';
import { currentUserId, currentUser } from '../lib/user.js';
import { overview as togetherOverview, partnerFor, filmsFor, NOT_FOUND } from '../lib/together.js';
import { myPlans, othersPlans, planShowtime, cancelPlan, answerPlan } from '../lib/plans.js';
import { recipients, sendPick, inbox, dismiss as dismissSend, sentToday, DAILY_LIMIT, NOTE_MAX, NOT_FOUND as SEND_NOT_FOUND } from '../lib/sends.js';

const router = Router();

// ---- watch together ------------------------------------------------------

// The owner and one opted-in friend, never two friends (lib/together.js).
// Not on the guest allowlist. Every id that isn't the caller's valid partner
// gets the identical 404, so a friend can't tell another friend's id from a
// made-up one.
router.get('/together', (req, res) => res.json(togetherOverview(currentUser())));

router.get('/together/:id', (req, res) => {
  const me = currentUser();
  const partner = partnerFor(me, req.params.id);
  if (!partner) return res.status(NOT_FOUND.status).json(NOT_FOUND.body);
  res.json(filmsFor(me, partner));
});

// ---- I'm going and Send a pick (lib/plans.js, lib/sends.js) ---------------
// The caller's own plans, the plans of whoever Watch together pairs them with,
// picks sent to them, and who they can send to. Only GET /social is on the
// guest allowlist, and the guest gets it empty: no plans, no picks, nobody to
// send to. Everything else refuses the guest (the guard below is the same
// rule as the allowlist, again).

export const notGuest = (req, res, next) => (currentUser()?.guest
  ? res.status(403).json({ error: 'This shared link is read only.' })
  : next());

router.get('/social', (req, res) => {
  const me = currentUser();
  res.set('Cache-Control', 'no-store');
  if (me.guest) return res.json({ plans: [], going: [], sent: [], send: { recipients: [], left: 0, limit: DAILY_LIMIT, noteMax: NOTE_MAX } });
  res.json({
    plans: myPlans(me.userId),
    going: othersPlans(me),
    sent: inbox(me),
    send: { recipients: recipients(me), left: Math.max(0, DAILY_LIMIT - sentToday(me.userId)), limit: DAILY_LIMIT, noteMax: NOTE_MAX },
  });
});

// Make or move the plan: { showtime_id }.
router.put('/plans', notGuest, (req, res) => {
  try {
    res.json(planShowtime(currentUserId(), req.body?.showtime_id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong on the server. Try again.' });
  }
});

router.delete('/plans/:id', notGuest, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Bad id.' });
  res.json(cancelPlan(currentUserId(), id));
});

// "Did you see it?": { seen: true | false }.
router.post('/plans/:id/answer', notGuest, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Bad id.' });
  if (typeof req.body?.seen !== 'boolean') return res.status(400).json({ error: 'seen must be true or false.' });
  try {
    res.json(answerPlan(id, req.body.seen));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong on the server. Try again.' });
  }
});

// { to, tmdb_id, note }. A recipient the caller can't send to is the same 404
// as a made-up id.
router.post('/sends', notGuest, (req, res) => {
  try {
    res.json(sendPick(currentUser(), req.body || {}));
  } catch (e) {
    if (e.status === SEND_NOT_FOUND.status && e.message === SEND_NOT_FOUND.body.error) return res.status(404).json(SEND_NOT_FOUND.body);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong on the server. Try again.' });
  }
});

router.delete('/sends/:id', notGuest, (req, res) => {
  if (!dismissSend(currentUserId(), req.params.id)) return res.status(404).json(SEND_NOT_FOUND.body);
  res.json({ dismissed: true });
});

export default router;
