// Settings: keys status, theatre, weights, filters, showtime windows, pricing, data.
import { api } from '../api.js';
import { h, clear, spinner, toast, chip, labeled, sectionTitle, badge, openModal, icon } from '../ui.js';
import { NUMBER_RULES, HOME_RULES, numberProblem } from '../settingsRules.js';
import { openHiddenList } from './components.js';
import { PLANS, PLAN_IDS, planOf, planWords } from '../plans.js';
import { servicesPicker } from './athome.js';
import { servicesPhrase } from '../services.js';

const GENRES = ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama',
  'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance',
  'Science Fiction', 'Thriller', 'War', 'Western'];
const MPAA = ['G', 'PG', 'PG-13', 'R', 'NC-17', 'NR'];

// On phones, a field that takes a whole row of its grid (see .span-all).
const spanAll = (field) => { field.classList.add('span-all'); return field; };

function card(title, ...children) {
  return h('section', { class: 'settings-card' }, h('h3', {}, title), ...children);
}

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

function notificationsCard(publicKey) {
  const label = 'Notify me when my weekly picks are ready';
  const hint = h('p', { class: 'muted small' }, 'One notification on Friday with your #1 pick, on this device. Nothing about your ratings is in it.');
  if (isIOS() && !isStandalone()) {
    return card('Notifications', h('div', { class: 'notify-static' },
      h('p', {}, label),
      h('p', { class: 'muted small notify-note' }, 'On iPhone, notifications need Reel Picks on your Home Screen first. In Safari, tap Share, then Add to Home Screen, and open it from there.')));
  }
  if (!pushSupported()) {
    return card('Notifications', h('div', { class: 'notify-static' },
      h('p', {}, label), h('p', { class: 'muted small notify-note' }, 'This browser can\'t show notifications.')));
  }

  const toggle = h('input', { type: 'checkbox', disabled: true });
  const note = h('p', { class: 'muted small notify-note', hidden: true });
  const showNote = (text) => { note.textContent = text || ''; note.hidden = !text; };
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
    if (!toggle.checked && blocked()) showNote(blockedText);
  })();

  const turnOn = async () => {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      showNote(perm === 'denied' ? blockedText : '');
      return false;
    }
    const key = keyBytes(publicKey);
    let { reg, sub } = await currentSubscription();
    // Keys changed on the server since this device signed up: start over.
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api.pushSubscribe(sub.toJSON());
    showNote('');
    return true;
  };

  const turnOff = async () => {
    const { sub } = await currentSubscription();
    if (!sub) return;
    await api.pushUnsubscribe(sub.endpoint);
    await sub.unsubscribe().catch(() => {});
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
    } finally { toggle.disabled = false; }
  });

  return card('Notifications',
    h('label', { class: 'switch-row' }, toggle, h('span', {}, label)),
    hint, note);
}

export async function render(root, params, ctx) {
  clear(root);
  root.appendChild(spinner('Loading settings…'));
  const [s, status, pushCfg] = await Promise.all([
    api.settings(), api.status().catch(() => null), api.pushConfig().catch(() => null),
  ]);
  clear(root);

  const page = h('div', { class: 'page settings' });
  page.appendChild(sectionTitle('Settings', null, { level: 1 }));
  // A friend sees their own settings only: no key status, no AMC matching, and
  // none of the shared tuning (fallback window, good-match cutoff, Last chance),
  // which the owner sets for everyone. The server enforces the same split.
  const isOwner = status?.user?.isOwner !== false;

  // ---- API keys
  const keyState = status?.keys || {};
  if (isOwner) page.appendChild(card('API keys',
    h('div', { class: 'key-list' },
      keyRow('TMDB', keyState.tmdb, 'posters, metadata, matching'),
      keyRow('OMDb', keyState.omdb, 'IMDb / RT / Metacritic scores'),
      keyRow('AMC', keyState.amc, 'your theatre\'s showtimes'),
    ),
    h('p', { class: 'muted small' }, 'Keys live in the ', h('code', {}, '.env'), ' file in the project root. Edit it, then hit Refresh or restart.'),
  ));

  // ---- Theatres: the primary plus any followed ones, in order.
  let theatres = status?.theatres || [];
  const maxTheatres = status?.maxTheatres || 5;
  const homeLabel = () => status?.home?.label || 'home';
  const theatreList = h('div', { class: 'theatre-list' });
  const followedNote = h('div', { class: 'muted small' });

  const reloadTheatres = async () => {
    const st = await ctx.refreshStatus();
    theatres = st?.theatres || theatres;
    paintTheatres();
  };

  const act = async (fn, okMsg) => {
    try {
      await fn();
      toast(okMsg, 'success');
      await reloadTheatres();
    } catch (e) { toast(e.message, 'error'); }
  };

  // Unfollowing drops the theatre's current showtimes (cheap to re-pull); its
  // lineup history is kept on the server, so this is reversible in practice.
  const confirmUnfollow = (t) => {
    const modal = openModal(h('div', { class: 'confirm' },
      h('p', {}, `Stop following ${t.name}?`),
      h('p', { class: 'muted small' }, 'Its showtimes are removed from Picks and "Also nearby". Its schedule history (for "Last chance" and the departure log) is kept and comes back if you follow it again.'),
      h('div', { class: 'row-gap' },
        h('button', { class: 'btn', onClick: async () => { modal.close(); await act(() => api.unfollowTheatre(t.id), `Stopped following ${t.short}`); } }, 'Stop following'),
        h('button', { class: 'btn ghost', onClick: () => modal.close() }, 'Cancel'),
      ),
    ), { title: 'Unfollow theatre' });
  };

  const paintTheatres = () => {
    clear(theatreList);
    for (const t of theatres) {
      theatreList.appendChild(h('div', { class: 'theatre-item' },
        h('div', { class: 'ti-main' },
          h('div', { class: 'ti-name' }, t.name, t.isPrimary ? badge('Primary', 'watch') : null),
          h('div', { class: 'muted small' }, t.distance
            ? `${t.distance.label} from ${homeLabel()}${t.distance.estimated ? ' (estimated)' : ''}`
            : 'Drive time appears after the next refresh'),
        ),
        t.isPrimary ? null : h('div', { class: 'ti-actions' },
          h('button', { class: 'btn ghost small', title: 'Rank by this theatre instead', onClick: () =>
            act(() => api.setPrimaryTheatre(t.id), `${t.short} is now your primary theatre`) }, 'Make primary'),
          h('button', { class: 'btn ghost small', title: 'Stop following', 'aria-label': `Stop following ${t.name}`, onClick: () => confirmUnfollow(t) }, icon('x', { size: 16 })),
        ),
      ));
    }
    const extras = theatres.length - 1;
    followedNote.textContent = extras
      ? `Following ${extras} more theatre${extras > 1 ? 's' : ''} (up to ${maxTheatres - 1}). Ranking and runway badges use the primary; movies only playing elsewhere appear under "Also nearby".`
      : `Follow more theatres to see where else a movie is playing. Up to ${maxTheatres - 1} extra. Each adds about 14 AMC calls to the daily refresh. Drive times are never shown on the shared guest link.`;
  };
  paintTheatres();

  const theatreResults = h('div', { class: 'theatre-results' });
  const theatreInput = h('input', { class: 'input', type: 'search', placeholder: 'Search AMC theatres', 'aria-label': 'Search AMC theatres by name or city' });
  const theatreSearch = async () => {
    if (!keyState.amc) { toast('Add an AMC key first', 'error'); return; }
    clear(theatreResults);
    theatreResults.appendChild(spinner());
    try {
      const { theatres: found } = await api.theatres(theatreInput.value.trim());
      clear(theatreResults);
      if (!found.length) theatreResults.appendChild(h('div', { class: 'muted small' }, 'No theatres found.'));
      found.forEach((t) => {
        const followed = theatres.find((x) => x.id === String(t.id));
        const full = theatres.length >= maxTheatres;
        theatreResults.appendChild(h('div', { class: 'theatre-row' },
          h('div', {}, h('div', {}, t.name), h('div', { class: 'muted small' }, [t.city, t.state].filter(Boolean).join(', '))),
          h('div', { class: 'ti-actions' },
            followed
              ? h('span', { class: 'muted small' }, followed.isPrimary ? 'Primary' : 'Following')
              : h('button', { class: 'btn ghost small', disabled: full, title: full ? `Already following ${maxTheatres}` : 'Pull this theatre\'s showtimes too', onClick: () =>
                act(() => api.followTheatre({ id: t.id, name: t.name, slug: t.slug }), `Following ${t.name}. Refreshing showtimes.`) }, 'Follow'),
            followed?.isPrimary ? null : h('button', { class: 'btn small', title: 'Rank by this theatre; your current primary stays followed', onClick: () =>
              act(() => (followed ? api.setPrimaryTheatre(t.id) : api.setTheatre({ id: t.id, name: t.name, slug: t.slug })),
                `${t.name} is now your primary theatre. ${theatres[0]?.short || 'The old primary'} stays followed.`) }, 'Set primary'),
          ),
        ));
      });
    } catch (e) { clear(theatreResults); toast(e.message, 'error'); }
  };
  theatreInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') theatreSearch(); });
  page.appendChild(card('Theatres', theatreList, followedNote,
    h('div', { class: 'row-gap' }, theatreInput, h('button', { class: 'btn', onClick: theatreSearch }, 'Search')),
    theatreResults,
  ));

  if (isOwner) page.appendChild(friendsCard());

  // ---- Unmatched AMC titles: showing at a followed theatre, but no TMDB
  // record, so invisible to ranking / runway / departures until matched.
  const unmatchedWrap = h('div', { class: 'unmatched-list' });
  const ignoredWrap = h('div', { class: 'unmatched-ignored' });
  const fmtDay = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
  const whereWhen = (u) => h('div', { class: 'muted small' },
    `${u.showtimes} showtime${u.showtimes === 1 ? '' : 's'} · ${u.theatres.map((t) => t.short).join(', ')} · `
    + (u.first_date === u.last_date ? fmtDay(u.first_date) : `${fmtDay(u.first_date)} – ${fmtDay(u.last_date)}`));
  const afterChange = async () => { await loadUnmatched(); ctx.refreshStatus(); };

  const unmatchedRow = (u) => {
    const results = h('div', { class: 'fix-results' });
    const input = h('input', { class: 'input', type: 'search', value: u.suggested || u.amc_title, placeholder: 'Search TMDB…' });
    const search = async () => {
      const q = input.value.trim();
      if (!q) return;
      clear(results);
      results.appendChild(spinner());
      try {
        const { results: found } = await api.searchRatings(q);
        clear(results);
        if (!found.length) results.appendChild(h('div', { class: 'muted small' }, 'No TMDB results. Try a shorter title.'));
        found.slice(0, 8).forEach((r) => results.appendChild(h('div', { class: 'fix-item static' },
          r.poster ? h('img', { src: r.poster, alt: '' }) : h('div', { class: 'fix-noposter' }),
          h('span', { class: 'fix-name' }, `${r.title}${r.year ? ` (${r.year})` : ''}`),
          h('button', { class: 'btn small', onClick: async () => {
            try {
              await api.setMatch({ amc_movie_id: u.amc_movie_id, amc_title: u.amc_title, tmdb_id: r.tmdb_id });
              toast(`Matched "${u.amc_title}" → ${r.title}`, 'success');
              afterChange();
            } catch (e) { toast(e.message, 'error'); }
          } }, 'Match'),
        )));
      } catch (e) { clear(results); toast(e.message, 'error'); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
    return h('div', { class: 'unmatched-row' },
      h('div', { class: 'um-title' }, u.amc_title, u.amc_year ? h('span', { class: 'muted' }, ` ${u.amc_year}`) : null),
      whereWhen(u),
      h('div', { class: 'row-gap' },
        input,
        h('button', { class: 'btn small', onClick: search }, 'Search'),
        h('button', { class: 'btn ghost small', title: 'Leave it unmatched and stop flagging it (e.g. a mystery screening)', onClick: async () => {
          try { await api.ignoreMatch(u.amc_movie_id, u.amc_title); toast(`Ignoring "${u.amc_title}"`); afterChange(); } catch (e) { toast(e.message, 'error'); }
        } }, 'Ignore'),
      ),
      results,
    );
  };

  // A flagged automatic match: shows what it matched and why it's suspect,
  // with Keep (confirm) or a search to re-point it.
  const reviewRow = (u) => {
    const results = h('div', { class: 'fix-results' });
    const input = h('input', { class: 'input', type: 'search', value: u.suggested || u.amc_title, placeholder: 'Search TMDB…' });
    const search = async () => {
      const q = input.value.trim();
      if (!q) return;
      clear(results);
      results.appendChild(spinner());
      try {
        const { results: found } = await api.searchRatings(q);
        clear(results);
        if (!found.length) results.appendChild(h('div', { class: 'muted small' }, 'No TMDB results. Try a shorter title.'));
        found.slice(0, 8).forEach((r) => results.appendChild(h('div', { class: 'fix-item static' },
          r.poster ? h('img', { src: r.poster, alt: '' }) : h('div', { class: 'fix-noposter' }),
          h('span', { class: 'fix-name' }, `${r.title}${r.year ? ` (${r.year})` : ''}`),
          h('button', { class: 'btn small', onClick: async () => {
            try {
              await api.setMatch({ amc_movie_id: u.amc_movie_id, amc_title: u.amc_title, tmdb_id: r.tmdb_id });
              toast(`Re-pointed "${u.amc_title}" → ${r.title}`, 'success');
              afterChange();
            } catch (e) { toast(e.message, 'error'); }
          } }, 'Use this'),
        )));
      } catch (e) { clear(results); toast(e.message, 'error'); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
    return h('div', { class: 'unmatched-row review' },
      h('div', { class: 'um-title' }, `AMC "${u.amc_title}"`, u.amc_year ? h('span', { class: 'muted' }, ` ${u.amc_year}`) : null,
        h('span', { class: 'muted' }, ' → '), `${u.matched.title}${u.matched.year ? ` (${u.matched.year})` : ''}`),
      h('div', { class: 'review-why' }, icon('alert', { size: 14 }), ` ${u.review}`),
      whereWhen(u),
      h('div', { class: 'row-gap' },
        input,
        h('button', { class: 'btn small', onClick: search }, 'Search'),
        h('button', { class: 'btn ghost small', title: 'The match is right. Stop flagging it.', onClick: async () => {
          try { await api.keepMatch(u.amc_movie_id); toast(`Kept "${u.amc_title}" → ${u.matched.title}`); afterChange(); } catch (e) { toast(e.message, 'error'); }
        } }, 'Keep'),
      ),
      results,
    );
  };

  async function loadUnmatched() {
    clear(unmatchedWrap); clear(ignoredWrap);
    try {
      const { unmatched, ignored, review = [] } = await api.unmatched();
      if (review.length) {
        unmatchedWrap.appendChild(h('div', { class: 'sub-label' }, `Needs review (${review.length})`));
        review.forEach((u) => unmatchedWrap.appendChild(reviewRow(u)));
        unmatchedWrap.appendChild(h('div', { class: 'sub-label' }, `Unmatched (${unmatched.length})`));
      }
      if (!unmatched.length) unmatchedWrap.appendChild(h('div', { class: 'muted small' }, review.length ? 'No unmatched titles.' : 'Everything AMC is showing is matched.'));
      unmatched.forEach((u) => unmatchedWrap.appendChild(unmatchedRow(u)));
      if (ignored.length) {
        ignoredWrap.appendChild(h('details', { class: 'log' },
          h('summary', {}, `${ignored.length} ignored`),
          ...ignored.map((u) => h('div', { class: 'unmatched-row ignored' },
            h('div', { class: 'um-title' }, u.amc_title),
            whereWhen(u),
            h('button', { class: 'btn ghost small', title: 'Retry matching on the next refresh', onClick: async () => {
              try { await api.unignoreMatch(u.amc_movie_id); toast('Will retry matching on the next refresh'); afterChange(); } catch (e) { toast(e.message, 'error'); }
            } }, 'Restore'),
          )),
        ));
      }
    } catch (e) { unmatchedWrap.appendChild(h('div', { class: 'muted small' }, e.message)); }
  }
  if (isOwner) page.appendChild(card('AMC title matching',
    h('p', { class: 'muted small' },
      'AMC titles are matched to TMDB records automatically, using AMC\'s release year to tell a new film from an older one with the same name. '
      + 'A match to a film years older than AMC\'s release date is flagged here for review (Keep it, or search and re-point it). '
      + 'Titles that couldn\'t be matched at all aren\'t ranked, have no runway badge and never show as leaving. Search and pick the right movie, or Ignore one-offs like "AMC Screen Unseen".'),
    unmatchedWrap, ignoredWrap,
  ));
  if (isOwner) loadUnmatched();

  // ---- Home base (where drive times are measured from). Values come only from
  // the owner-only status payload — this file is a public static asset, so it
  // must not carry a default label or coordinates itself. Guests never see this
  // card (Settings is owner-only) and the geocode endpoints reject guests anyway.
  const home = status?.home || s.home || {};
  const homeLabelIn = h('input', { class: 'input', type: 'text', placeholder: 'Label, e.g. Home', value: home.label || '' });
  const homeLat = h('input', { class: 'input num', type: 'number', step: '0.0001', placeholder: 'lat', value: home.lat == null ? '' : String(home.lat) });
  const homeLng = h('input', { class: 'input num', type: 'number', step: '0.0001', placeholder: 'lng', value: home.lng == null ? '' : String(home.lng) });

  const geoStatus = h('div', { class: 'muted small geo-status' });
  const geoResults = h('div', { class: 'theatre-results' });
  const setGeoStatus = (msg) => { geoStatus.textContent = msg || ''; };
  // Monotonic ticket per look-up / locate / clear: a slow response that isn't
  // the newest action anymore must not write into the fields (e.g. an uncached
  // lookup delayed by the geocoder's 1 req/s throttle landing after a faster,
  // newer one — or after Clear).
  let geoSeq = 0;

  // Fill the fields from a geocoder hit. Nothing is stored until Save settings;
  // a failed or empty lookup never touches the fields.
  const applyPlace = (r) => {
    clear(geoResults);
    if (r.label) homeLabelIn.value = r.label;
    if (r.lat != null) homeLat.value = String(r.lat);
    if (r.lng != null) homeLng.value = String(r.lng);
    setGeoStatus(`Found ${r.label} (${r.lat}, ${r.lng}). Save settings to keep it.`);
  };

  const placeIn = h('input', { class: 'input', type: 'search', placeholder: 'City, ZIP or address', 'aria-label': 'Look up a place: city and state, ZIP, or address, like Fishers IN' });
  const lookupBtn = h('button', { class: 'btn' }, 'Look up');
  const lookup = async () => {
    const q = placeIn.value.trim();
    if (!q) { setGeoStatus('Type a city & state, a ZIP, or an address first.'); return; }
    const seq = ++geoSeq;
    clear(geoResults);
    setGeoStatus('Looking up…');
    lookupBtn.disabled = true;
    try {
      const { results } = await api.geocode(q);
      if (seq !== geoSeq) return; // a newer look-up / locate / clear won
      if (!results.length) {
        setGeoStatus(`Nothing found for "${q}". Try adding a city, state, or ZIP. Your saved home base is unchanged.`);
      } else if (results.length === 1) {
        applyPlace(results[0]);
      } else {
        setGeoStatus('More than one match. Pick the right one:');
        results.forEach((r) => geoResults.appendChild(h('div', { class: 'theatre-row' },
          h('div', {}, h('div', {}, r.label), h('div', { class: 'muted small' }, r.place)),
          h('button', { class: 'btn small', onClick: () => applyPlace(r) }, 'Use'),
        )));
      }
    } catch (e) {
      if (seq === geoSeq) setGeoStatus(`${e.message} Your saved home base is unchanged.`);
    } finally {
      lookupBtn.disabled = false;
    }
  };
  lookupBtn.addEventListener('click', lookup);
  placeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') lookup(); });

  // Browser geolocation. The precise fix never leaves this page: it is rounded
  // to ~1 km before the reverse-geocode call and before it lands in the fields.
  const locBtn = h('button', { class: 'btn ghost' }, icon('pin', { size: 16 }), 'Use my location');
  locBtn.addEventListener('click', () => {
    if (!('geolocation' in navigator)) { setGeoStatus('This browser can\'t share a location. Type a place above instead.'); return; }
    if (!window.isSecureContext) { setGeoStatus('Location needs HTTPS or localhost. Type a place above instead.'); return; }
    clear(geoResults); // candidate rows from a text search no longer match the status line
    const seq = ++geoSeq;
    setGeoStatus('Asking the browser for your location…');
    locBtn.disabled = true;
    // The old label stops being true the moment new coordinates land, so when
    // the reverse look-up can't name the place, the coordinates become the
    // label — saving then still stores something truthful.
    const unnamed = (lat, lng) => {
      homeLabelIn.value = `${lat}, ${lng}`;
      setGeoStatus(`Coordinates set (${lat}, ${lng}). Couldn't name the place, so edit the label if you like, then Save settings.`);
    };
    navigator.geolocation.getCurrentPosition(async (pos) => {
      if (seq !== geoSeq) { locBtn.disabled = false; return; }
      const lat = Math.round(pos.coords.latitude * 100) / 100;
      const lng = Math.round(pos.coords.longitude * 100) / 100;
      homeLat.value = String(lat);
      homeLng.value = String(lng);
      setGeoStatus(`Got it (${lat}, ${lng}). Naming the place…`);
      try {
        const { result } = await api.reverseGeocode(lat, lng);
        if (seq !== geoSeq) return;
        if (result) applyPlace(result);
        else unnamed(lat, lng);
      } catch {
        if (seq === geoSeq) unnamed(lat, lng);
      } finally {
        locBtn.disabled = false;
      }
    }, (err) => {
      locBtn.disabled = false;
      if (seq !== geoSeq) return;
      setGeoStatus(err.code === 1
        ? 'Location permission denied. Type a place above instead. Nothing was changed.'
        : 'Couldn\'t get a location fix. Type a place above instead. Nothing was changed.');
    }, { timeout: 10000, maximumAge: 600000 });
  });

  const clearHomeBtn = h('button', { class: 'btn ghost small', onClick: async () => {
    const seq = ++geoSeq; // invalidate any in-flight look-up or locate
    try {
      const r = await api.clearHome();
      if (seq !== geoSeq) return;
      homeLabelIn.value = ''; homeLat.value = ''; homeLng.value = ''; placeIn.value = '';
      clear(geoResults);
      setGeoStatus(`Cleared. The stored location, cached lookups, and cached drive times are gone. Drive times now measure from the app default (${r.home?.label || 'app default'}).`);
      toast('Home base cleared');
      ctx.refreshStatus();
    } catch (e) { toast(e.message, 'error'); }
  } }, 'Clear home base');

  // ---- Watch together (friends only). The owner is always available, so only
  // a friend has a switch. It saves on change, so switching off takes the
  // friend out of the owner's Together page straight away.
  if (!isOwner) {
    const owner = status?.ownerName || 'the owner';
    const tgToggle = h('input', { type: 'checkbox', ...(s.watchTogether ? { checked: true } : {}) });
    tgToggle.addEventListener('change', async () => {
      const on = tgToggle.checked;
      tgToggle.disabled = true;
      try {
        await api.saveSettings({ watchTogether: on });
        toast(on ? `${owner} can now plan movies with you on Together.` : `Watch together is off. ${owner} won't see you on Together.`, 'success');
      } catch (e) {
        tgToggle.checked = !on;
        toast(e.message, 'error');
      } finally { tgToggle.disabled = false; }
    });
    page.appendChild(card('Watch together',
      h('label', { class: 'switch-row' }, tgToggle, h('span', {}, `Let ${owner} plan movies with me`)),
      h('p', { class: 'muted small' }, `Together lists films you would both enjoy at a theater you both follow. ${owner} sees one short reason for each film, never your ratings, scores or full watchlist.`),
    ));
  }

  // ---- Weekly picks notifications: only when the server has VAPID keys.
  if (pushCfg?.enabled && !status?.guest) page.appendChild(notificationsCard(pushCfg.publicKey));

  // ---- Streaming services, for "At home" on Picks (js/views/athome.js).
  // Each tap saves; the week's home picks are worked out again for the new set.
  if (!status?.guest) {
    const svcNote = h('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' });
    let saving = Promise.resolve();
    const picker = servicesPicker(s.streamingServices || [], (keys) => {
      saving = saving.then(async () => {
        try {
          await api.saveSettings({ streamingServices: keys });
          svcNote.textContent = keys.length ? `Saved. Picks will come from ${servicesPhrase(keys)}.` : 'Saved. No services: At home asks you to choose.';
        } catch (e) { toast(e.message, 'error'); }
      });
    });
    page.appendChild(card('Streaming services',
      picker,
      svcNote,
      h('p', { class: 'muted small' }, 'At home on Picks shows your 4 best matches each week from films included with these (US, never rentals), scored like your theater picks. "Free with ads" covers Tubi, Pluto TV, The Roku Channel and Plex.')));
  }

  // ---- Letterboxd auto-sync: owner and friends (the guest never gets here).
  if (!status?.guest) page.appendChild(letterboxdCard(ctx, planWords(planOf(s))));

  page.appendChild(card('Home base',
    h('div', { class: 'row-gap geo-row' }, placeIn, lookupBtn, locBtn),
    geoStatus,
    geoResults,
    h('div', { class: 'grid-3' }, spanAll(labeled('Label', homeLabelIn)), labeled('Latitude', homeLat), labeled('Longitude', homeLng)),
    h('p', { class: 'muted small' },
      'Drive times next to each theatre are measured from here, and re-measured within seconds of saving a change.'),
    h('p', { class: 'muted small' },
      h('strong', {}, 'Where your location data goes: '),
      'it\'s stored only in this app\'s local database. Two keyless OpenStreetMap services see location data: '
      + 'OSRM gets your coordinates rounded to ~1 km (never street-level) to measure drive times, and Nominatim gets '
      + 'what you type in the look-up box (sent as typed, so an exact address goes out as one) or your rounded '
      + 'coordinates, to turn them into a place. Answers are cached for months, so repeats send nothing. Your location '
      + 'is never sent to TMDB, OMDb, or AMC, and the shared guest link never includes it. '
      + '"Clear home base" removes the stored location and all of those caches.'),
    h('div', {}, clearHomeBtn),
  ));

  // ---- Weights
  const wRange = h('input', { type: 'range', 'aria-label': 'Balance between public scores and your taste', min: '0', max: '100', step: '5', value: String(Math.round((s.weightPublic ?? 0.5) * 100)) });
  const wLabel = h('div', { class: 'weight-label' });
  const paintW = () => { const p = Number(wRange.value); wLabel.textContent = `Public score ${p}%  ·  Taste match ${100 - p}%`; };
  wRange.addEventListener('input', paintW); paintW();

  // Urgency: how hard a CONFIRMED end date pulls a movie up the ranking. The
  // watchlist multiplier lives in the advanced boosts card but feeds this label.
  const uRange = h('input', { type: 'range', 'aria-label': 'Urgency boost for films about to leave', min: '0', max: '20', step: '1', value: String(s.urgencyBoost ?? 6) });
  const uMult = h('input', { class: 'input num', type: 'number', min: '1', step: '0.1', value: String(s.urgencyWatchlistMultiplier ?? 1.5) });
  const uLabel = h('div', { class: 'weight-label' });
  const paintU = () => {
    const n = Number(uRange.value) || 0;
    const m = Math.max(1, Number(uMult.value) || 1);
    uLabel.textContent = n
      ? `Urgency up to +${n}  ·  ★ watchlisted up to +${Math.round(n * m * 10) / 10}`
      : 'Urgency off. A confirmed end date adds nothing.';
  };
  uRange.addEventListener('input', paintU); uMult.addEventListener('input', paintU); paintU();

  page.appendChild(card('Ranking balance', wLabel, wRange,
    h('p', { class: 'muted small' }, 'How much public reviews vs. your personal taste drive the final score.'),
    uLabel, uRange,
    h('p', { class: 'muted small' },
      'How much a confirmed end date pulls a movie up, so the weekly 4 answers "what should I see this week". '
      + 'Full on a movie\'s last day, fading to nothing a week out, and only when the run is confirmed ending (filled calendar), never a hedged "through at least". '
      + 'A few points breaks ties and nudges a good movie that\'s leaving ahead of a slightly better one that isn\'t; 15+ (about 10 for starred films) starts overriding quality.'),
  ));

  // ---- Preferences & filters
  const imaxToggle = h('input', { type: 'checkbox', ...(s.preferImax ? { checked: true } : {}) });
  const exG = new Set(s.excludedGenres || []);
  const exM = new Set(s.excludedMpaa || []);
  const genreChips = h('div', { class: 'chips' }, ...GENRES.map((g) => {
    const c = chip(g, { active: exG.has(g), onClick: () => { exG.has(g) ? exG.delete(g) : exG.add(g); c.classList.toggle('active'); } });
    return c;
  }));
  const mpaaChips = h('div', { class: 'chips' }, ...MPAA.map((m) => {
    const c = chip(m, { active: exM.has(m), onClick: () => { exM.has(m) ? exM.delete(m) : exM.add(m); c.classList.toggle('active'); } });
    return c;
  }));
  page.appendChild(card('Preferences',
    h('label', { class: 'switch-row' }, imaxToggle, h('span', {}, 'Prefer IMAX (boosts IMAX showings)')),
    h('div', { class: 'sub-label' }, 'Never recommend these genres in the weekly 4'),
    genreChips,
    h('div', { class: 'sub-label' }, 'Never recommend these ratings'),
    mpaaChips,
    h('p', { class: 'muted small' }, 'Filtered movies still appear in the full list, greyed out.'),
  ));

  // ---- Hidden films: everything marked "Not for me", each with Unhide.
  const hiddenCount = h('p', { class: 'muted small' }, 'Checking…');
  const showHidden = h('button', { class: 'btn ghost', type: 'button' }, 'Show hidden films');
  const paintHidden = async () => {
    try {
      const n = (await api.hidden()).movies.length;
      hiddenCount.textContent = n
        ? `${n} film${n === 1 ? '' : 's'} marked Not for me. They stay out of your picks until you unhide them.`
        : 'Nothing is hidden. Films you mark Not for me land here, and you can bring them back any time.';
      showHidden.hidden = !n;
    } catch { hiddenCount.textContent = ''; }
  };
  showHidden.addEventListener('click', () => openHiddenList(async (m) => {
    try {
      await api.unhide(m.tmdb_id);
      toast(`${m.title} is back in your picks.`, 'success');
    } catch (e) { toast(e.message, 'error'); }
    paintHidden();
  }));
  paintHidden();
  page.appendChild(card('Hidden films', hiddenCount, h('div', {}, showHidden)));

  // ---- Now-playing fallback (only used when no AMC key)
  const recencyInput = h('input', { class: 'input num', type: 'number', min: '1', step: '1', value: String(s.fallbackRecencyWeeks ?? 8) });
  if (isOwner) page.appendChild(card('Now-playing fallback',
    labeled('Only show films released in the last N weeks', recencyInput),
    h('p', { class: 'muted small' }, 'Applies only when no AMC key is connected (Reel Picks ranks TMDB\'s current US releases). Widen this if the list gets thin. With an AMC key, your theatre\'s actual lineup (re-releases and special screenings included) is used as-is.'),
  ));

  // ---- Showtime windows
  const win = s.showtimeWindows || {};
  const mkWindow = (key, label) => {
    const w = win[key] || { enabled: true, after: '18:30', before: '23:30' };
    const en = h('input', { type: 'checkbox', ...(w.enabled ? { checked: true } : {}) });
    const after = h('input', { class: 'input time', type: 'time', value: w.after || '18:30' });
    const before = h('input', { class: 'input time', type: 'time', value: w.before || '23:30' });
    return { el: h('div', { class: 'window-row' },
      h('label', { class: 'switch-row tight' }, en, h('span', {}, label)),
      h('div', { class: 'grid-2' }, labeled('after', after), labeled('before', before)),
    ), read: () => ({ enabled: en.checked, after: after.value, before: before.value }) };
  };
  const weekday = mkWindow('weekday', 'Weekdays');
  const weekend = mkWindow('weekend', 'Weekends');
  page.appendChild(card('Preferred showtimes', weekday.el, weekend.el,
    h('p', { class: 'muted small' }, 'Picks with a showing inside your windows get a boost, and that showtime is surfaced.')));

  // ---- Movie plan & pricing (public/js/plans.js). Picking a plan fills in
  // its usual terms, which stay editable; "None" has no allowance or fee.
  let plan = planOf(s).id;
  let period = planOf(s).period;
  const perWeek = h('input', { class: 'input num', type: 'number', step: '1', min: '0', value: String(s.alistWeeklyLimit ?? 4) });
  const fee = h('input', { class: 'input num', type: 'number', step: '0.01', value: String(s.alistMonthlyFee ?? 25.99) });
  const ticket = h('input', { class: 'input num', type: 'number', step: '0.01', value: String(s.avgTicketPrice ?? 14.5) });
  const previews = h('input', { class: 'input num', type: 'number', step: '1', value: String(s.previewsMinutes ?? 20) });
  const periodSel = h('select', { class: 'input', 'aria-label': 'Allowance counts per' },
    h('option', { value: 'week' }, 'per week'), h('option', { value: 'month' }, 'per month'));
  periodSel.value = period;
  periodSel.addEventListener('change', () => { period = periodSel.value; paintPlan(); });
  const visitsField = labeled('Visits / week', perWeek);
  const periodField = labeled('Counted', periodSel);
  const feeField = labeled('Monthly fee ($)', fee);
  const planNote = h('p', { class: 'muted small' });
  const planPicker = h('div', { class: 'chips plan-chips', role: 'radiogroup', 'aria-label': 'Your movie plan' });
  const planChips = PLAN_IDS.map((id) => {
    const c = h('button', { class: 'chip', type: 'button', role: 'radio', 'data-plan': id }, PLANS[id].name);
    c.addEventListener('click', () => {
      if (plan === id) return;
      plan = id;
      const d = PLANS[id].defaults;
      perWeek.value = String(d.limit);
      fee.value = String(d.fee);
      ticket.value = String(d.ticket);
      period = d.period;
      periodSel.value = period;
      for (const input of [perWeek, fee, ticket]) input.dispatchEvent(new Event('input')); // clears any error under them
      paintPlan();
    });
    return c;
  });
  planPicker.append(...planChips);
  // Arrow keys move between the plans, as in any radio group.
  planPicker.addEventListener('keydown', (e) => {
    const i = planChips.indexOf(document.activeElement);
    if (i < 0 || !['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const next = planChips[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + planChips.length) % planChips.length];
    next.focus();
    next.click();
  });
  function paintPlan() {
    const p = PLANS[plan];
    for (const c of planChips) {
      const on = c.dataset.plan === plan;
      c.classList.toggle('active', on);
      c.setAttribute('aria-checked', String(on));
      c.tabIndex = on ? 0 : -1;
    }
    visitsField.hidden = !p.subscription;
    feeField.hidden = !p.subscription;
    periodField.hidden = plan !== 'other';
    const per = plan === 'other' ? period : p.defaults.period;
    visitsField.querySelector('.field-label').textContent = `${p.units[0].toUpperCase()}${p.units.slice(1)} / ${per}${plan === 'regal-unlimited' || plan === 'other' ? ' (0 = no limit)' : ''}`;
    planNote.textContent = p.note;
  }
  paintPlan();
  page.appendChild(card('Movie plan & pricing',
    planPicker,
    h('div', { class: 'grid-4 plan-fields' }, visitsField, periodField, feeField, labeled('Avg ticket ($)', ticket), labeled('Preview length (min)', previews)),
    planNote,
    h('p', { class: 'muted small' }, 'Showtimes always come from AMC theaters; the plan only changes the allowance, savings and wording.'),
    h('p', { class: 'muted small' }, 'AMC\'s listed showtime is when previews start. Preview length sets the "be there by" time on every showtime (when the film itself begins) and is included in the end time. AMC publishes no preview or program length of its own, so this number is the only source for it.')));

  // ---- Advanced boosts
  const wlB = h('input', { class: 'input num', type: 'number', value: String(s.watchlistBoost ?? 8) });
  const imB = h('input', { class: 'input num', type: 'number', value: String(s.imaxBoost ?? 4) });
  const wfB = h('input', { class: 'input num', type: 'number', value: String(s.windowFitBoost ?? 6) });
  page.appendChild(card('Score boosts (advanced)',
    h('div', { class: 'grid-2' },
      labeled('Watchlist +', wlB),
      labeled('IMAX +', imB),
      labeled('Fits window +', wfB),
      labeled('Watchlist urgency ×', uMult),
    ),
    h('p', { class: 'muted small' },
      'Watchlist urgency × scales the urgency boost (Ranking balance) for starred movies. You\'ve already said you want to see them, so "it\'s leaving" counts for more.'),
  ));

  // ---- Picks sections
  const gmScore = h('input', { class: 'input num', type: 'number', min: '0', max: '100', value: String(s.goodMatchMinScore ?? 75) });
  if (isOwner) page.appendChild(card('Also worth seeing',
    labeled('Minimum score', gmScore),
    h('div', { class: 'muted small' },
      'Score a movie needs to appear in the "Also worth seeing" section under your weekly 4. '
      + 'Everything playing stays listed below it regardless of this cutoff.'),
  ));

  // ---- Last chance
  const lcScore = h('input', { class: 'input num', type: 'number', min: '0', max: '100', value: String(s.lastChanceMinScore ?? 75) });
  const lcGap = h('input', { class: 'input num', type: 'number', min: '1', value: String(s.lastChanceMinGapDays ?? 3) });
  const lcMax = h('input', { class: 'input num', type: 'number', min: '1', value: String(s.lastChanceMaxEntries ?? 3) });
  if (isOwner) page.appendChild(card('Last chance',
    h('div', { class: 'grid-3' },
      labeled('Min score', lcScore),
      labeled('Days before horizon', lcGap),
      spanAll(labeled('Max entries', lcMax)),
    ),
    h('div', { class: 'muted small' },
      'Only flags a movie whose last showtime falls this many days before the end of the published schedule, '
      + 'so a week AMC hasn\'t posted yet doesn\'t look like everything leaving at once.'),
  ));

  // ---- Schedule diagnostics: the per-theatre horizon the runway badges and
  // "Last chance" depend on, so it can be sanity-checked against AMC's site.
  const horizons = status?.lastRefreshLog?.horizons || [];
  if (horizons.length) {
    const amcByTheatre = new Map((status?.lastRefreshLog?.sources?.amc?.theatres || []).map((t) => [t.id, t]));
    const fmtDate = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '–');
    const th = (t, num) => h('th', { class: num ? 'num' : '' }, t);
    const td = (t, num, label) => h('td', { class: num ? 'num' : '', 'data-label': label }, t);
    const rows = horizons.map((hz) => {
      const src = amcByTheatre.get(hz.theatre?.id) || {};
      return h('tr', {},
        td(h('span', {}, hz.theatre?.short || hz.theatre?.name || '–', hz.theatre?.isPrimary ? h('span', { class: 'muted small' }, ' · primary') : null)),
        td(fmtDate(hz.publishedThrough), false, 'Through'),
        td(String(hz.publishedDays ?? '–'), true, 'Days'),
        td(`${hz.typicalDailyLineup ?? '–'} / ${hz.typicalDailyShowtimes ?? '–'}`, true, 'Typical / day'),
        td(`${hz.breadthThreshold ?? '–'} / ${hz.showtimeThreshold ?? '–'}`, true, 'Threshold'),
        td(fmtDate(hz.furthestShowtime), false, 'Furthest'),
        td(String(hz.lineup ?? '–'), true, 'Movies'),
        td(String(src.showtimes ?? '–'), true, 'Showtimes'),
        td(String(src.calls ?? '–'), true, 'AMC calls'),
        h('td', { class: `num${src.staleDays ? ' warn' : ''}`, title: src.staleError || '', 'data-label': 'Stale days' }, src.staleDays ? [`${src.staleDays} `, icon('alert', { size: 13, label: 'stale' })] : '0'),
      );
    });
    // Wide screens scroll the table sideways inside the card, with a fade on
    // the right edge while there's more to see; phones stack each theatre.
    const diagWrap = h('div', { class: 'diag-wrap' }, h('table', { class: 'diag-table' },
      h('thead', {}, h('tr', {}, th('Theatre'), th('Published through'), th('Days', true), th('Typical movies / showtimes per day', true),
        th('Threshold (movies / showtimes)', true), th('Furthest showtime'), th('Movies', true), th('Showtimes', true), th('AMC calls', true), th('Stale days', true))),
      h('tbody', {}, ...rows),
    ));
    const diagScroll = h('div', { class: 'diag-scroll' }, diagWrap);
    const paintFade = () => diagScroll.classList.toggle('more', diagWrap.scrollLeft + diagWrap.clientWidth < diagWrap.scrollWidth - 2);
    diagWrap.addEventListener('scroll', paintFade, { passive: true });
    new ResizeObserver(paintFade).observe(diagWrap);
    page.appendChild(card('Schedule diagnostics',
      diagScroll,
      h('p', { class: 'muted small' },
        '"Published through" is where each theatre\'s schedule stops being densely posted (the horizon). '
        + 'A movie\'s runway badge only commits to an end date when its last showtime falls at least the "Days before horizon" setting short of it; '
        + 'otherwise it says "through at least". Typical values are medians over the nearest 3 days at that theatre; '
        + 'a day below either threshold (half of typical) is treated as the unpublished advance-sale tail. '
        + 'AMC calls are real HTTP requests on the last refresh: per-day responses are cached 24h, and a manual Refresh always re-pulls today and tomorrow (2 calls per theatre) so same-day schedule changes show up. '
        + '"Stale days" counts days whose live AMC call failed and an older cached copy was used instead. The schedule shown for those days may be out of date.'),
    ));
  }

  // ---- Data
  // Full setup = settings + theatres + home + ratings + watchlist + watch log
  // + match decisions, as one JSON file. The way to make another instance (a
  // deployment, a new machine) an exact duplicate of this one.
  const stateFile = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  stateFile.addEventListener('change', async () => {
    const f = stateFile.files[0];
    stateFile.value = '';
    if (!f) return;
    try {
      const doc = JSON.parse(await f.text());
      const r = await api.importState(doc);
      const c = r.imported || {};
      toast(`Setup imported: ${c.ratings || 0} ratings, ${c.watchlist || 0} watchlist, ${c.watched || 0} watched, ${c.matches || 0} match decisions, ${c.hidden || 0} hidden, ${c.settings || 0} settings. Refreshing showtimes…`, 'success');
      ctx.triggerRefresh?.();
      ctx.refreshStatus();
    } catch (e) {
      toast(e instanceof SyntaxError ? 'That file isn\'t valid JSON. Use the file from "Export full setup".' : e.message, 'error');
    }
  });
  // Automatic backups (owner only): nightly at 3am and before schema changes.
  const bk = status?.backup;
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
  const backupLine = !isOwner ? null : h('div', bk?.lastError ? { class: 'small', style: { color: 'var(--low)' } } : { class: 'muted small' },
    bk?.lastError
      ? `Last backup attempt failed (${new Date(bk.lastError.at).toLocaleString()}): ${bk.lastError.message}`
      : bk?.last
        ? `Last automatic backup ${new Date(bk.last.at).toLocaleString()}, ${mb(bk.last.bytes)}. One is taken every night at 3am; the last 14 are kept.`
        : 'No automatic backup yet. One is taken every night at 3am; the last 14 are kept.');
  // Off-site copy (owner only, and only when the server has BACKUP_S3_* set):
  // the last upload's time and size, and Upload now. Hidden otherwise.
  const offsiteSlot = h('div', { class: 'offsite', hidden: true });
  if (isOwner) {
    const offLine = h('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' });
    const offBtn = h('button', { class: 'btn ghost', type: 'button' }, icon('upload', { size: 16 }), 'Upload now');
    const paintOff = (o) => {
      if (!o?.enabled) { offsiteSlot.hidden = true; return; }
      offsiteSlot.hidden = false;
      offLine.classList.toggle('lb-error', Boolean(o.lastError));
      const next = new Date(o.next).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      offLine.textContent = o.uploading ? 'Uploading…'
        : o.lastError ? `Last off-site upload failed (${new Date(o.lastError.at).toLocaleString()}): ${o.lastError.message}`
          : o.last ? `Last off-site copy ${new Date(o.last.at).toLocaleString()}, ${mb(o.last.bytes)}. A copy goes up every Sunday at 4am (next ${next}); the last ${o.keep} are kept.`
            : `No off-site copy yet. One goes up every Sunday at 4am; the last ${o.keep} are kept.`;
    };
    offBtn.addEventListener('click', async () => {
      offBtn.disabled = true;
      offLine.classList.remove('lb-error');
      offLine.textContent = 'Uploading…';
      try {
        const o = await api.offsiteUpload();
        paintOff(o);
        if (o?.lastError) toast('The upload failed', 'error'); else toast('Off-site copy uploaded', 'success');
      } catch (e) {
        toast(e.message, 'error');
        api.offsite().then(paintOff).catch(() => {});
      } finally { offBtn.disabled = false; }
    });
    offsiteSlot.append(offLine, h('div', {}, offBtn));
    api.offsite().then(paintOff).catch(() => {});
  }

  // ---- Help: the guided tour again (js/tour.js).
  page.appendChild(card('Help',
    h('p', { class: 'muted small' }, 'A quick walk through Picks, Schedule, Search and the rest. The ? at the top opens it too.'),
    h('div', {}, h('button', { class: 'btn ghost', type: 'button', onClick: () => ctx.startTour() }, icon('help', { size: 16 }), 'Replay tour')),
  ));

  // ---- Alerts (owner only): the last 10 problems and recoveries.
  if (isOwner) page.appendChild(alertsCard());

  page.appendChild(card('Data',
    h('div', { class: 'row-gap wrap' },
      h('a', { class: 'btn ghost', href: api.stateUrl() }, isOwner ? '⬇ Export full setup' : '⬇ Export my data'),
      isOwner ? h('button', { class: 'btn ghost', onClick: () => stateFile.click() }, '⬆ Import full setup') : null,
      isOwner ? stateFile : null,
      h('a', { class: 'btn ghost', href: api.exportUrl() }, '⬇ Export backup CSV'),
      isOwner && bk?.last ? h('a', { class: 'btn ghost', href: api.backupUrl() }, '⬇ Download latest backup') : null,
      isOwner ? h('button', { class: 'btn ghost', onClick: () => ctx.triggerRefresh() }, icon('refresh', { size: 16 }), 'Refresh now') : null,
      h('a', { class: 'btn ghost', href: '#/onboarding' }, icon('zap', { size: 16 }), 'Re-run quick rate'),
    ),
    h('p', { class: 'muted small' }, isOwner
      ? 'Full setup carries settings, theatres, home base, ratings, watchlist, watch history, AMC match decisions, and hidden films. Everything except caches and schedule history, which each instance builds itself. Importing is additive: nothing local is deleted.'
      : 'Your export carries your own settings, theatres, home base, ratings, watchlist, watch history and hidden films.'),
    backupLine,
    offsiteSlot,
    status?.lastRefreshLog?.errors?.length
      ? h('details', { class: 'log' }, h('summary', {}, `Last refresh: ${status.lastRefreshLog.errors.length} warning(s)`),
        ...status.lastRefreshLog.errors.map((e) => h('div', { class: 'muted small' }, `• ${e}`)))
      : h('div', { class: 'muted small' }, status?.lastRefresh ? `Last refreshed ${new Date(status.lastRefresh).toLocaleString()}` : 'Not refreshed yet.'),
  ));

  // ---- Save
  // Every number is checked before anything is sent (the server checks the
  // same rules, js/settingsRules.js). A bad one gets its message under its
  // field's row and nothing is saved; typing in the field clears it.
  const numbers = [
    ['alistWeeklyLimit', perWeek], ['alistMonthlyFee', fee], ['avgTicketPrice', ticket], ['previewsMinutes', previews],
    ['watchlistBoost', wlB], ['imaxBoost', imB], ['windowFitBoost', wfB], ['urgencyWatchlistMultiplier', uMult],
    ['fallbackRecencyWeeks', recencyInput], ['goodMatchMinScore', gmScore],
    ['lastChanceMinScore', lcScore], ['lastChanceMinGapDays', lcGap], ['lastChanceMaxEntries', lcMax],
  ];
  const clearError = (input) => {
    const id = input.getAttribute('aria-describedby');
    if (id) document.getElementById(id)?.remove();
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
  };
  const showError = (input, message) => {
    clearError(input);
    const label = input.closest('.field')?.querySelector('.field-label')?.textContent || '';
    const id = `err-${Math.random().toString(36).slice(2, 8)}`;
    const note = h('p', { class: 'form-error', id }, label ? `${label}: ${message}` : message);
    // Under the row the field sits in, after any message already there.
    let at = input.closest('.settings-card > *');
    while (at.nextElementSibling?.classList.contains('form-error')) at = at.nextElementSibling;
    at.after(note);
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', id);
    input.addEventListener('input', () => clearError(input), { once: true });
  };
  const validate = () => {
    const bad = [];
    const check = (input, message) => { if (message) { showError(input, message); bad.push(input); } else clearError(input); };
    // Owner-only cards aren't on a friend's page; their fields aren't checked.
    for (const [key, input] of numbers) if (input.isConnected) check(input, numberProblem(NUMBER_RULES[key], input.value));
    const blank = (i) => i.value.trim() === '';
    if (blank(homeLat) !== blank(homeLng)) check(blank(homeLat) ? homeLat : homeLng, 'Enter both latitude and longitude, or leave both blank.');
    else for (const [k, input] of [['lat', homeLat], ['lng', homeLng]]) check(input, blank(input) ? null : numberProblem(HOME_RULES[k], input.value));
    for (const input of page.querySelectorAll('.window-row input[type=time]')) check(input, input.value ? null : 'Enter a time.');
    return bad;
  };

  const save = async () => {
    const p = Number(wRange.value) / 100;
    const bad = validate();
    if (bad.length) {
      bad[0].focus();
      toast(bad.length === 1 ? 'One setting needs fixing. Nothing was saved.' : `${bad.length} settings need fixing. Nothing was saved.`, 'error');
      return;
    }
    paintU();
    try {
      await api.saveSettings({
        weightPublic: p,
        weightTaste: 1 - p,
        preferImax: imaxToggle.checked,
        fallbackRecencyWeeks: Number(recencyInput.value),
        excludedGenres: [...exG],
        excludedMpaa: [...exM],
        showtimeWindows: { weekday: weekday.read(), weekend: weekend.read() },
        moviePlan: plan,
        planPeriod: plan === 'other' ? period : PLANS[plan].defaults.period,
        alistWeeklyLimit: Number(perWeek.value),
        alistMonthlyFee: Number(fee.value),
        avgTicketPrice: Number(ticket.value),
        previewsMinutes: Number(previews.value),
        watchlistBoost: Number(wlB.value),
        imaxBoost: Number(imB.value),
        windowFitBoost: Number(wfB.value),
        urgencyBoost: Number(uRange.value) || 0,
        urgencyWatchlistMultiplier: Number(uMult.value),
        goodMatchMinScore: Number(gmScore.value),
        lastChanceMinScore: Number(lcScore.value),
        lastChanceMinGapDays: Number(lcGap.value),
        lastChanceMaxEntries: Number(lcMax.value),
        // Blank fields are sent as null; the server falls back to its default.
        home: {
          label: homeLabelIn.value.trim() || null,
          lat: homeLat.value.trim() === '' ? null : Number(homeLat.value),
          lng: homeLng.value.trim() === '' ? null : Number(homeLng.value),
        },
      });
      toast('Settings saved', 'success');
      ctx.refreshStatus();
    } catch (e) { toast(e.message, 'error'); }
  };
  page.appendChild(h('div', { class: 'save-bar' }, h('button', { class: 'btn wide', onClick: save }, 'Save settings')));

  root.appendChild(page);
}

// ---- Friends (owner only): invite links, revoke, re-issue. A link is shown
// once, right after it's made; the server keeps only a hash of it.
// Owner alerts (server/lib/alerts.js): a failed refresh, nightly or off-site
// backup, or a day with no showtimes at the primary theater. Newest first.
function alertsCard() {
  const note = h('p', { class: 'muted small' });
  const list = h('ul', { class: 'alert-list' });
  const when = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  api.alerts().then((r) => {
    const failing = r.failing.map((f) => f.label.toLowerCase());
    note.textContent = [
      failing.length ? `Failing now: ${failing.join(', ')}.` : 'Everything is working.',
      !r.pushEnabled ? 'Push notifications are off on this server, so alerts only show here.'
        : r.devices ? `Alerts also go to ${r.devices === 1 ? 'the device' : `all ${r.devices} devices`} you turned notifications on for.`
          : 'Turn on notifications above to get these on your phone too.',
    ].join(' ');
    if (!r.alerts.length) { list.replaceWith(h('p', { class: 'muted small' }, 'No alerts yet.')); return; }
    for (const a of r.alerts) {
      list.appendChild(h('li', { class: `alert-item ${a.kind}` },
        icon(a.kind === 'problem' ? 'alert' : 'check', { size: 16, label: a.kind === 'problem' ? 'Problem' : 'Back to normal' }),
        h('div', { class: 'alert-main' },
          h('div', { class: 'alert-msg' }, a.message),
          h('div', { class: 'muted small' }, `${a.label} · ${when(a.at)}`)),
      ));
    }
  }).catch((e) => { note.textContent = e.message; });
  return card('Alerts',
    h('p', { class: 'muted small' }, 'If the daily refresh or a backup fails, or no showtimes come back for your primary theater, you get one alert that day, and one more when it works again. Friends never see these.'),
    note, list);
}

// Letterboxd: a username, the last sync's result, Sync now. Saving a name
// syncs at once, so a misspelled one shows its message right here.
function letterboxdCard(ctx, words) {
  const nameIn = h('input', {
    class: 'input', type: 'text', maxlength: '80', placeholder: 'Letterboxd username', 'aria-label': 'Letterboxd username',
    autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false',
  });
  const saveBtn = h('button', { class: 'btn', type: 'button' }, 'Save');
  const syncBtn = h('button', { class: 'btn ghost', type: 'button' }, icon('refresh', { size: 16 }), 'Sync now');
  const line = h('p', { class: 'muted small lb-status', role: 'status', 'aria-live': 'polite' });
  let st = null;

  const when = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const paint = () => {
    line.classList.toggle('lb-error', Boolean(st?.error));
    syncBtn.hidden = !st?.username;
    if (!st?.username) { line.textContent = 'Not linked.'; return; }
    if (st.syncing) { line.textContent = 'Syncing…'; return; }
    if (st.error) { line.textContent = st.error; return; }
    if (!st.lastOkAt) { line.textContent = `Linked to ${st.username}. Not synced yet.`; return; }
    const extra = [
      st.ratingsUpdated ? `${plural(st.ratingsUpdated, 'rating')} updated` : '',
      st.kept ? `${plural(st.kept, 'rating')} you changed here kept` : '',
      st.unmatched ? `${plural(st.unmatched, 'film')} not found on TMDB` : '',
    ].filter(Boolean);
    line.textContent = `Last synced ${when(st.lastOkAt)}: ${plural(st.added, 'film')} added.${extra.length ? ` ${extra.join(', ')}.` : ''}`;
  };
  const busy = (on) => { saveBtn.disabled = on; syncBtn.disabled = on; };
  const done = (r) => {
    st = r;
    nameIn.value = r.username || '';
    paint();
    if (!r.error && (r.added || r.ratingsUpdated)) ctx.refreshStatus?.();
  };
  const save = async () => {
    busy(true);
    st = { ...(st || {}), username: nameIn.value.trim() || null, syncing: Boolean(nameIn.value.trim()), error: null };
    paint();
    try { done(await api.letterboxdSave(nameIn.value.trim())); } catch (e) { toast(e.message, 'error'); try { done(await api.letterboxd()); } catch { /* keep the line */ } } finally { busy(false); }
  };
  saveBtn.addEventListener('click', save);
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  syncBtn.addEventListener('click', async () => {
    busy(true);
    st = { ...st, syncing: true };
    paint();
    try { done(await api.letterboxdSync()); } catch (e) { toast(e.message, 'error'); try { done(await api.letterboxd()); } catch { /* keep the line */ } } finally { busy(false); }
  });
  api.letterboxd().then(done).catch((e) => { line.textContent = e.message; });
  paint();

  return card('Letterboxd',
    h('div', { class: 'row-gap' }, nameIn, saveBtn),
    line,
    h('div', {}, syncBtn),
    h('p', { class: 'muted small' },
      'Once a day Reel Picks reads your public Letterboxd diary and brings in new star ratings and the films you logged as watched. '
      + `Each entry comes in once, and a rating you change here is never overwritten. Films logged on Letterboxd count as seen, ${words.notCounted}. `
      + 'The feed only has your latest 50 or so entries; for your whole history, import ratings.csv on the Rate page. Clear the name and save to unlink.'),
  );
}

function friendsCard() {
  const list = h('div', { class: 'theatre-list' });
  const linkSlot = h('div', {});
  const nameIn = h('input', { class: 'input', type: 'text', maxlength: '40', placeholder: 'Friend\'s name', 'aria-label': 'Friend\'s name' });
  const addBtn = h('button', { class: 'btn', type: 'button' }, 'Create invite link');
  const note = h('p', { class: 'muted small' });
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null);

  const showLink = (friend, invite) => {
    const url = `${location.origin}${invite}`;
    const field = h('input', { class: 'input', type: 'text', readonly: true, value: url, 'aria-label': `Invite link for ${friend.name}` });
    const copy = h('button', { class: 'btn', type: 'button' }, 'Copy');
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(url); toast('Link copied', 'success'); } catch { field.select(); toast('Select the link and copy it'); }
    });
    clear(linkSlot);
    linkSlot.appendChild(h('div', { class: 'import-box' },
      h('strong', {}, `Invite link for ${friend.name}`),
      h('div', { class: 'row-gap' }, field, copy),
      h('p', { class: 'muted small' }, 'Shown once. Copy it now and send it to them. It works one time, on one device, and signs them in for a year.'),
    ));
    field.focus();
    field.select();
  };

  const load = async () => {
    try {
      const { friends, max } = await api.friends();
      clear(list);
      note.textContent = `Up to ${max - 1} friends. Each gets their own ratings, watchlist, picks and settings. Revoking stops their link at once and keeps their data.`;
      if (!friends.length) list.appendChild(h('div', { class: 'muted small' }, 'No friends yet.'));
      for (const f of friends) {
        const status = f.revoked_at ? 'Revoked' : f.invite_pending ? 'Invite not used yet' : f.last_seen_at ? `Last seen ${when(f.last_seen_at)}` : 'Signed in';
        const act = async (fn, done) => {
          try { const r = await fn(); if (r.invite) showLink(r.friend, r.invite); toast(done, 'success'); load(); } catch (e) { toast(e.message, 'error'); }
        };
        list.appendChild(h('div', { class: 'theatre-item' },
          h('div', { class: 'ti-main' },
            h('div', { class: 'ti-name' }, f.name, f.revoked_at ? badge('Revoked', 'muted') : null),
            h('div', { class: 'muted small' }, `Added ${when(f.created_at)} · ${f.ratings} rating${f.ratings === 1 ? '' : 's'} · ${status}`),
          ),
          h('div', { class: 'ti-actions' },
            f.revoked_at ? null : h('button', {
              class: 'btn ghost small', type: 'button', 'aria-label': `Revoke ${f.name}`,
              onClick: () => {
                const modal = openModal(h('div', { class: 'confirm' },
                  h('p', {}, `Revoke ${f.name}'s access?`),
                  h('p', { class: 'muted small' }, 'Their link stops working right away. Their ratings and lists are kept, and a new link brings them back.'),
                  h('div', { class: 'row-gap' },
                    h('button', { class: 'btn', onClick: () => { modal.close(); act(() => api.revokeFriend(f.id), `Revoked ${f.name}`); } }, 'Revoke'),
                    h('button', { class: 'btn ghost', onClick: () => modal.close() }, 'Cancel'),
                  ),
                ), { title: 'Revoke friend' });
              },
            }, 'Revoke'),
            h('button', {
              class: 'btn ghost small', type: 'button', 'aria-label': `New link for ${f.name}`,
              onClick: () => act(() => api.reissueFriend(f.id), `New link for ${f.name}`),
            }, 'New link'),
          ),
        ));
      }
    } catch (e) { clear(list); list.appendChild(h('div', { class: 'muted small' }, e.message)); }
  };

  const add = async () => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); return; }
    addBtn.disabled = true;
    try {
      const r = await api.addFriend(name);
      nameIn.value = '';
      showLink(r.friend, r.invite);
      load();
    } catch (e) { toast(e.message, 'error'); } finally { addBtn.disabled = false; }
  };
  addBtn.addEventListener('click', add);
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  load();
  return card('Friends', note, list, h('div', { class: 'row-gap' }, nameIn, addBtn), linkSlot);
}

function keyRow(name, present, desc) {
  return h('div', { class: 'key-row' },
    h('span', { class: `key-dot ${present ? 'on' : 'off'}` }),
    h('span', { class: 'key-name' }, name),
    h('span', { class: 'muted small' }, desc),
    h('span', { class: `key-status ${present ? 'on' : 'off'}` }, present ? 'connected' : 'missing'),
  );
}
