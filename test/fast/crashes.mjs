// What a visitor or a failing disk can do to the server, and what people
// see when something goes wrong.
//
//   cookies     a cookie value that isn't valid %-encoding counts as no
//               cookie: the owner, a friend and the guest all still get in.
import { suite } from '../lib/check.mjs';
import { openWorld } from '../lib/world.mjs';

const S = suite('crashes');
const { check, step } = S;

const alive = (w) => w.srv.child.exitCode == null && w.srv.child.signalCode == null;

const w = S.world(await openWorld('crashes'));
try {
  const { robin } = w.friends;

  // ============================================================== cookies
  await step('cookies: a value that isn\'t valid %-encoding counts as no cookie', async () => {
    const own = await w.api('GET', '/api/status', { headers: { cookie: 'rp_owner=%' } });
    check('the owner at localhost with "rp_owner=%" gets the app', own.status === 200, `${own.status} ${own.text.slice(0, 160)}`);
    const fr = await w.api('GET', '/api/settings', { headers: { 'cf-ray': 'test', cookie: `${robin.cookie}; rp_owner=%zz` } });
    check('a friend with a broken owner cookie beside theirs is still that friend', fr.status === 200 && fr.json && !('lastRefreshLog' in fr.json), `${fr.status} ${fr.text.slice(0, 160)}`);
    const guest = await w.api('GET', '/api/recommendations', { headers: { 'cf-ray': 'test', cookie: 'rp_user=%E0%A4%A' } });
    check('the guest with a broken friend cookie gets the guest view', guest.status === 200 && Array.isArray(guest.json?.weekly4), `${guest.status} ${guest.text.slice(0, 160)}`);
    check('the server is still running', alive(w));
  });
} finally {
  await w.close();
}

S.finish();
