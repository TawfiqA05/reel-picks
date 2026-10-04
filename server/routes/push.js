// The API: weekly picks notifications.
import { Router } from 'express';
import { state as refreshState } from '../lib/refresh.js';
import { currentUserId, currentUser } from '../lib/user.js';
import { pushEnabled, publicKey, saveSubscription, removeSubscription, hasSubscription, sendWeekly } from '../lib/push.js';
import { h, ownerOnly } from './common.js';

const router = Router();

// ---- weekly picks notifications (lib/push.js) ----------------------------
// Per person, per device. The guest link never gets here (lib/guest.js); the
// guard below is the same rule again. With no VAPID keys the feature is off:
// config says so and the rest answer 404.

const pushOn = (req, res, next) => {
  if (currentUser()?.guest) return res.status(403).json({ error: 'This shared link is read only.' });
  if (!pushEnabled()) return res.status(404).json({ error: 'Notifications aren\'t set up on this server.' });
  next();
};

router.get('/push/config', (req, res) => {
  if (currentUser()?.guest) return res.status(403).json({ error: 'This shared link is read only.' });
  res.json(pushEnabled() ? { enabled: true, publicKey: publicKey() } : { enabled: false });
});

// Is this device (its subscription endpoint) signed up for this person?
router.post('/push/check', pushOn, (req, res) => {
  res.json({ subscribed: hasSubscription(currentUserId(), req.body?.endpoint) });
});

router.post('/push/subscribe', pushOn, (req, res) => {
  try {
    saveSubscription(currentUserId(), req.body?.subscription);
    res.json({ subscribed: true });
  } catch (e) {
    if (!e.status) console.error('[push]', e.message);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong on the server. Try again.' });
  }
});

router.post('/push/unsubscribe', pushOn, (req, res) => {
  removeSubscription(currentUserId(), req.body?.endpoint);
  res.json({ subscribed: false });
});

// The Friday send by hand (it runs on its own after Friday's refresh). Still
// once per person per week: anyone who already got this week's is skipped.
router.post('/push/weekly/send', ownerOnly, pushOn, h(async (req, res) => {
  if (refreshState.running) return res.status(409).json({ error: 'A refresh is running. Try again when it finishes.' });
  res.json(await sendWeekly());
}));

export default router;
