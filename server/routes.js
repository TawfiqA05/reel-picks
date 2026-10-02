// All JSON API routes for Reel Picks, one file per area in routes/.
import { Router } from 'express';
import status from './routes/status.js';
import settings from './routes/settings.js';
import ratings from './routes/ratings.js';
import lists from './routes/lists.js';
import social from './routes/social.js';
import stats from './routes/stats.js';
import owner from './routes/owner.js';
import push from './routes/push.js';

const router = Router();
router.use(status, settings, ratings, lists, social, stats, owner, push);

export default router;
