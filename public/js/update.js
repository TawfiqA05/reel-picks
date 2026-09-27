// Getting a new deploy onto open pages without anyone closing the app.
//
// Two signals, either one enough:
// - The service worker: a new one takes control as soon as it installs
//   (sw.js), and this page hears "controllerchange".
// - The version check: the page knows the version it was built from (the
//   rp-version meta, filled in by the server) and asks the server which one
//   is deployed (/api/version). If they differ, the page is behind.
//
// The version check is what reaches an app installed on an iPhone. There the
// app is mostly resumed, not relaunched, and the first requests after it comes
// back to the foreground often fail while the network wakes up; a launch with
// no network opens the worker's cached copy. Each check is therefore retried
// for about half a minute, and runs on every return to the app, when the
// network comes back, and every few minutes while the app is on screen.
//
// Behind, the page reloads once onto the new code (every page and script is
// fetched network-first, so a reload is enough), but only when nothing is
// mid-action: no sheet, dialog or tour open, no save in flight, no half-typed
// field. Otherwise it shows "Update ready" with a Refresh button and reloads
// at the next safe moment (a sheet closing, a save finishing, a route change,
// returning to the app). A page reloads at most once per version, so nothing
// can loop it.
import { toast } from './ui.js';
import { writesInFlight, onWritesSettled } from './api.js';

const MINE = document.querySelector('meta[name="rp-version"]')?.content || null;
const EVERY_MS = 5 * 60 * 1000;
// Waits between tries of one check: the network after a resume can take a
// few seconds, occasionally more.
const RETRIES_MS = [0, 1500, 4000, 10000, 20000];
const RELOADED_KEY = 'rp-sw-reloaded-for';

let pending = null;   // { version, auto }: waiting for a safe moment (auto) or a tap
let prompt = null;    // the "Update ready" toast
let registration = null;
let checking = false;
let again = false;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function isBusy() {
  if (document.querySelector('.modal-overlay, .tour-layer')) return true;
  if (writesInFlight() > 0) return true;
  const a = document.activeElement;
  return Boolean(a && a.matches?.('input, textarea, select') && a.value && a.type !== 'button' && a.type !== 'checkbox');
}

function readReloaded() {
  try { return sessionStorage.getItem(RELOADED_KEY); } catch { return null; }
}
function markReloaded(version) {
  try { sessionStorage.setItem(RELOADED_KEY, version); return true; } catch { return false; }
}

// Ask the controlling worker for its version (its cache name).
function controllerVersion() {
  const c = navigator.serviceWorker?.controller;
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

// This page runs older code than `version`.
function behind(version) {
  if (pending?.version === version) { trySafeReload(); return; }
  // Already reloaded for this one and still behind: don't loop, let the user decide.
  pending = { version, auto: readReloaded() !== version };
  if (pending.auto && !isBusy()) {
    if (reloadNow()) return;
    pending.auto = false; // no storage, so no loop guard: leave it to the tap
  }
  showPrompt();
}

async function onNewController(hadController) {
  if (!hadController) return; // first install: this page already runs the current code
  const version = (await controllerVersion()) || 'unknown';
  // The worker that just took over is the one this page was built with
  // (the page reloaded onto new code before the new worker finished
  // installing): nothing to do.
  if (MINE && version === MINE) return;
  behind(version);
}

async function deployedVersion() {
  const res = await fetch('/api/version', { cache: 'no-store' });
  if (!res.ok) throw new Error(`version ${res.status}`);
  return (await res.json())?.version || null;
}

// One check, retried while the network isn't answering. Also nudges the
// service worker to look for its new version.
// A trigger that arrives mid-check runs one more check after it.
async function check() {
  if (!MINE) return;
  if (checking) { again = true; return; }
  checking = true;
  try {
    for (const wait of RETRIES_MS) {
      if (wait) await sleep(wait);
      if (document.visibilityState === 'hidden') return; // the next return to the app checks again
      registration?.update().catch(() => {});
      let version;
      try { version = await deployedVersion(); } catch { continue; }
      if (version && version !== MINE) behind(version);
      return;
    }
  } finally {
    checking = false;
    if (again) { again = false; check(); }
  }
}

export function watchForUpdates() {
  const hasSW = 'serviceWorker' in navigator;
  if (hasSW) {
    let controlled = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const had = controlled;
      controlled = true;
      onNewController(had);
    });
    navigator.serviceWorker.register('/sw.js').then((reg) => { registration = reg; }).catch(() => {});
  }

  // Every way an installed app comes back: the tab turning visible, the page
  // restored from memory, the window focused, the network returning. They
  // often arrive together; one check answers them all.
  let queued = false;
  const soon = () => {
    if (document.visibilityState === 'hidden') return;
    trySafeReload();
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; check(); }, 50);
  };
  document.addEventListener('visibilitychange', soon);
  window.addEventListener('pageshow', soon);
  window.addEventListener('focus', soon);
  window.addEventListener('online', soon);
  setInterval(soon, EVERY_MS);
  soon();

  // Safe moments: a dialog closing, a save finishing, a route change.
  new MutationObserver(() => { if (pending && !document.querySelector('.modal-overlay, .tour-layer')) trySafeReload(); })
    .observe(document.body, { childList: true });
  onWritesSettled(trySafeReload);
  window.addEventListener('hashchange', trySafeReload);
  document.addEventListener('focusout', () => setTimeout(trySafeReload, 0));
}
