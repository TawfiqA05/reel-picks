// Getting a new deploy onto open pages without anyone closing the app.
//
// The service worker checks for a new version when the app opens, when it
// comes back to the foreground, and every 30 minutes while open. A new worker
// takes control as soon as it installs (sw.js); this page then reloads once
// onto the new code, but only when nothing is mid-action: no sheet or dialog
// open, no save in flight, no half-typed field. Otherwise it shows "Update
// ready" with a Refresh button and reloads when that's tapped or at the next
// safe moment (a sheet closing, a save finishing, a route change, returning
// to the app). A page reloads at most once per version, so a worker that
// somehow keeps reappearing can't loop it.
import { toast } from './ui.js';
import { writesInFlight, onWritesSettled } from './api.js';

const CHECK_EVERY_MS = 30 * 60 * 1000;
const RELOADED_KEY = 'rp-sw-reloaded-for';

let pending = null;   // { version, auto }: waiting for a safe moment (auto) or a tap
let prompt = null;    // the "Update ready" toast

function isBusy() {
  if (document.querySelector('.modal-overlay')) return true;
  if (writesInFlight() > 0) return true;
  const a = document.activeElement;
  return Boolean(a && a.matches?.('input, textarea, select') && a.value && a.type !== 'button');
}

function readReloaded() {
  try { return sessionStorage.getItem(RELOADED_KEY); } catch { return null; }
}
function markReloaded(version) {
  try { sessionStorage.setItem(RELOADED_KEY, version); return true; } catch { return false; }
}

// Ask the controlling worker for its version (its cache name).
function controllerVersion() {
  const c = navigator.serviceWorker.controller;
  if (!c) return Promise.resolve(null);
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 2000);
    ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data?.version || null); };
    c.postMessage({ type: 'version' }, [ch.port2]);
  });
}

function reloadNow() {
  // Without storage there's no loop guard, so don't reload on our own.
  if (!markReloaded(pending.version)) return false;
  pending = null;
  location.reload();
  return true;
}

// Called at every "might be safe now" moment.
function trySafeReload() {
  if (!pending?.auto || isBusy()) return;
  if (reloadNow()) prompt?.dismiss();
}

function showPrompt() {
  if (prompt) return;
  prompt = toast('Update ready', '', {
    duration: 0,
    // A tap is the user's call, so it reloads even where the guard wouldn't.
    action: { label: 'Refresh', onClick: () => { prompt = null; markReloaded(pending?.version || 'unknown'); location.reload(); } },
  });
}

async function onNewController(hadController) {
  if (!hadController) return; // first install: this page already runs the current code
  const version = (await controllerVersion()) || 'unknown';
  // Already reloaded for this one and it's back: don't loop, let the user decide.
  pending = { version, auto: readReloaded() !== version };
  if (pending.auto && !isBusy()) {
    if (reloadNow()) return;
    pending.auto = false; // no storage, so no loop guard: leave it to the tap
  }
  showPrompt();
}

export function watchForUpdates() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = () => Boolean(navigator.serviceWorker.controller);
  let controlled = hadController();
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const had = controlled;
    controlled = true;
    onNewController(had);
  });

  navigator.serviceWorker.register('/sw.js').then((reg) => {
    const check = () => reg.update().catch(() => {});
    // register() itself checks on open; these cover a page left open.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      check();
      trySafeReload();
    });
    setInterval(check, CHECK_EVERY_MS);
  }).catch(() => {});

  // Safe moments: a dialog closing, a save finishing, a route change.
  new MutationObserver(() => { if (pending && !document.querySelector('.modal-overlay')) trySafeReload(); })
    .observe(document.body, { childList: true });
  onWritesSettled(trySafeReload);
  window.addEventListener('hashchange', trySafeReload);
  document.addEventListener('focusout', () => setTimeout(trySafeReload, 0));
}
