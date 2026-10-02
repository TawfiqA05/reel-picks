// Settings: weekly picks notifications and Watchlist alerts.
import { api } from '../../api.js';
import { h, toast, setStatus } from '../../ui.js';
import { card } from './parts.js';

// ---- Weekly picks notifications ------------------------------------------
// Per device: the switch shows whether this browser is signed up for this
// person. Permission is asked for only when the switch is turned on. iPhone
// and iPad only allow web push from an app added to the Home Screen, so there
// Safari gets a note instead of a switch that can't work.

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(b64url) {
  const s = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const sameKey = (a, b) => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

async function currentSubscription() {
  // ready never settles when the service worker couldn't register.
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('the app\'s service worker isn\'t running')), 8000)),
  ]);
  return { reg, sub: await reg.pushManager.getSubscription() };
}

// ---- Watchlist alerts -------------------------------------------------------
// Per person, saved on the server (watchlistAlerts, lib/watchalerts.js), so it
// holds on every device. The pushes only reach devices with notifications on,
// so when this one isn't, the row says to turn them on first.
function watchlistAlertsRows(on) {
  const toggle = h('input', { type: 'checkbox', ...(on ? { checked: true } : {}) });
  const note = h('p', { class: 'muted small notify-note watch-alerts-note', hidden: true });
  toggle.addEventListener('change', async () => {
    const want = toggle.checked;
    toggle.disabled = true;
    try {
      await api.saveSettings({ watchlistAlerts: want });
      toast(want ? 'You\'ll get a notification when a film on your watchlist starts showing or has its last week.' : 'Watchlist alerts are off.', want ? 'success' : undefined);
    } catch (e) {
      toggle.checked = !want;
      toast(e.message, 'error');
    } finally { toggle.disabled = false; }
  });
  const rows = [
    h('label', { class: 'switch-row watch-alerts' }, toggle, h('span', {}, 'Watchlist alerts')),
    h('p', { class: 'muted small' }, 'A notification when a film on your watchlist starts showing at your theaters, and when it has its last week. Never between 9\u00a0PM and 9\u00a0AM.'),
    note,
  ];
  // pushOn: whether this device has notifications on for this person.
  const setPush = (pushOn) => {
    setStatus(note, 'warn', 'Turn on notifications first. Watchlist alerts only reach devices with notifications on.');
    note.hidden = Boolean(pushOn);
  };
  return { rows, setPush };
}

export function notificationsCard(publicKey, settings) {
  const label = 'Notify me when my weekly picks are ready';
  const hint = h('p', { class: 'muted small' }, 'One notification on Friday with your #1 pick, on this device. Nothing about your ratings is in it.');
  const watch = watchlistAlertsRows(settings?.watchlistAlerts === true);
  if (isIOS() && !isStandalone()) {
    watch.setPush(false);
    return card('Notifications', h('div', { class: 'notify-static' },
      h('p', {}, label),
      setStatus(h('p', { class: 'muted small notify-note' }), 'warn', 'On iPhone, notifications need Reel Picks on your Home Screen first. In Safari, tap Share, then Add to Home Screen, and open it from there.')),
    ...watch.rows);
  }
  if (!pushSupported()) {
    watch.setPush(false);
    return card('Notifications', h('div', { class: 'notify-static' },
      h('p', {}, label), setStatus(h('p', { class: 'muted small notify-note' }), 'warn', 'This browser can\'t show notifications.')),
    ...watch.rows);
  }

  const toggle = h('input', { type: 'checkbox', disabled: true });
  const note = h('p', { class: 'muted small notify-note', hidden: true });
  const showNote = (text, state = '') => { setStatus(note, state, text || ''); note.hidden = !text; };
  const onText = 'On for this device.';
  const blocked = () => Notification.permission === 'denied';
  const blockedText = 'Notifications are blocked for Reel Picks in this browser\'s settings. Allow them there, then turn this on.';

  // Initial state: on only if this browser has a subscription the server
  // knows belongs to this person.
  (async () => {
    try {
      const { sub } = await currentSubscription();
      toggle.checked = Boolean(sub && Notification.permission === 'granted' && (await api.pushCheck(sub.endpoint)).subscribed);
    } catch { toggle.checked = false; }
    toggle.disabled = false;
    watch.setPush(toggle.checked);
    if (toggle.checked) showNote(onText, 'ok');
    else if (blocked()) showNote(blockedText, 'bad');
  })();

  const turnOn = async () => {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      showNote(perm === 'denied' ? blockedText : '', perm === 'denied' ? 'bad' : '');
      return false;
    }
    const key = keyBytes(publicKey);
    let { reg, sub } = await currentSubscription();
    // Keys changed on the server since this device signed up: start over.
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api.pushSubscribe(sub.toJSON());
    showNote(onText, 'ok');
    return true;
  };

  const turnOff = async () => {
    const { sub } = await currentSubscription();
    if (!sub) return;
    await api.pushUnsubscribe(sub.endpoint);
    await sub.unsubscribe().catch(() => {});
    showNote('');
  };

  toggle.addEventListener('change', async () => {
    const on = toggle.checked;
    toggle.disabled = true;
    try {
      if (on) {
        const ok = await turnOn();
        toggle.checked = ok;
        if (ok) toast('You\'ll get a notification when your weekly picks are ready.', 'success');
      } else {
        await turnOff();
        toast('Weekly picks notifications are off on this device.');
      }
    } catch (e) {
      toggle.checked = !on;
      toast(on ? `Couldn't turn notifications on: ${e.message}` : e.message, 'error');
    } finally {
      toggle.disabled = false;
      watch.setPush(toggle.checked);
    }
  });

  return card('Notifications',
    h('label', { class: 'switch-row' }, toggle, h('span', {}, label)),
    hint, note, ...watch.rows);
}
