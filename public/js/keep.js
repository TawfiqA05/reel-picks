// Keeping a sheet's place across a film trip: "What should I watch?"
// (js/wsw.js) and the header search (js/search.js) share it.
//
// A sheet keeps its state in this device's storage, per person (prefix + user
// id), for 30 minutes from the last change. Leaving it for a film (its page,
// then maybe the trailer or a person) stores `returnTo`, the page the sheet
// was opened on. After every page is drawn, resumeSheets() looks: back on that
// page (Back, the back gesture, or tapping that tab) the sheet opens again
// where it was; on a film or person page on the way, it waits; anywhere else
// the trip is over and the sheet stays shut until opened again. Closing the
// sheet any other way forgets it.
const KEEP_MS = 30 * 60 * 1000;
// Pages a film trip passes through on the way back to the sheet.
const TRIP = /^#\/(movie|person)\//;

export const uidOf = (ctx) => ctx?.getStatus?.()?.user?.id ?? null;
export const here = () => (location.hash && location.hash !== '#' ? location.hash : '#/home');

export function keeper(prefix) {
  return {
    load(uid) {
      if (uid == null) return null;
      try {
        const s = JSON.parse(localStorage.getItem(prefix + uid) || 'null');
        if (s && s.v === 1 && Date.now() - s.at < KEEP_MS) return s;
        localStorage.removeItem(prefix + uid);
      } catch { /* storage off: nothing kept */ }
      return null;
    },
    save(uid, s) {
      if (uid == null) return;
      try { localStorage.setItem(prefix + uid, JSON.stringify({ ...s, v: 1, at: Date.now() })); } catch { /* storage off or full */ }
    },
    forget(uid) {
      if (uid == null) return;
      try { localStorage.removeItem(prefix + uid); } catch { /* storage off */ }
    },
  };
}

const sheets = []; // { store, open(ctx), isOpen() }

// A sheet that can be resumed: its store and how to open it again.
export function resumable(store, { open, isOpen }) {
  sheets.push({ store, open, isOpen });
}

// After each page is drawn. At most one sheet opens: the one left last.
export function resumeSheets(ctx) {
  if (ctx.isGuest?.() || sheets.some((s) => s.isOpen())) return;
  const uid = uidOf(ctx);
  const at = here();
  let pick = null;
  for (const sh of sheets) {
    const s = sh.store.load(uid);
    if (!s?.returnTo) continue;
    const back = at === s.returnTo;
    if (!back && TRIP.test(at)) continue;
    sh.store.save(uid, { ...s, returnTo: null });
    if (back && (!pick || s.at > pick.at)) pick = { sh, at: s.at };
  }
  pick?.sh.open(ctx);
}
