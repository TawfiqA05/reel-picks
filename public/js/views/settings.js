// Settings: keys status, theatre, weights, filters, showtime windows, pricing, data.
import { api } from '../api.js';
import { h, clear, spinner, toast, chip, labeled, sectionTitle, badge, openModal } from '../ui.js';

const GENRES = ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama',
  'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance',
  'Science Fiction', 'Thriller', 'War', 'Western'];
const MPAA = ['G', 'PG', 'PG-13', 'R', 'NC-17', 'NR'];

function card(title, ...children) {
  return h('section', { class: 'settings-card' }, h('h3', {}, title), ...children);
}

export async function render(root, params, ctx) {
  clear(root);
  root.appendChild(spinner('Loading settings…'));
  const [s, status] = await Promise.all([api.settings(), api.status().catch(() => null)]);
  clear(root);

  const page = h('div', { class: 'page settings' });
  page.appendChild(sectionTitle('Settings'));

  // ---- API keys
  const keyState = status?.keys || {};
  page.appendChild(card('API keys',
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
          h('button', { class: 'btn ghost small', title: 'Stop following', onClick: () => confirmUnfollow(t) }, '✕'),
        ),
      ));
    }
    const extras = theatres.length - 1;
    followedNote.textContent = extras
      ? `Following ${extras} more theatre${extras > 1 ? 's' : ''} (up to ${maxTheatres - 1}). Ranking and runway badges use the primary; movies only playing elsewhere appear under "Also nearby".`
      : `Follow more theatres to see where else a movie is playing. Up to ${maxTheatres - 1} extra — each adds ~14 AMC calls per daily refresh. Drive times are never shown on the shared guest link.`;
  };
  paintTheatres();

  const theatreResults = h('div', { class: 'theatre-results' });
  const theatreInput = h('input', { class: 'input', type: 'search', placeholder: 'Search AMC theatres (name or city)…' });
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
                act(() => api.followTheatre({ id: t.id, name: t.name, slug: t.slug }), `Following ${t.name} — refreshing showtimes`) }, 'Follow'),
            followed?.isPrimary ? null : h('button', { class: 'btn small', title: 'Rank by this theatre; your current primary stays followed', onClick: () =>
              act(() => (followed ? api.setPrimaryTheatre(t.id) : api.setTheatre({ id: t.id, name: t.name, slug: t.slug })),
                `${t.name} is now your primary theatre — ${theatres[0]?.short || 'the old primary'} stays followed`) }, 'Set primary'),
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
        if (!found.length) results.appendChild(h('div', { class: 'muted small' }, 'No TMDB results — try a shorter title.'));
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
        if (!found.length) results.appendChild(h('div', { class: 'muted small' }, 'No TMDB results — try a shorter title.'));
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
      h('div', { class: 'review-why' }, `⚠︎ ${u.review}`),
      whereWhen(u),
      h('div', { class: 'row-gap' },
        input,
        h('button', { class: 'btn small', onClick: search }, 'Search'),
        h('button', { class: 'btn ghost small', title: 'The match is right — stop flagging it', onClick: async () => {
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
  page.appendChild(card('AMC title matching',
    h('p', { class: 'muted small' },
      'AMC titles are matched to TMDB records automatically, using AMC\'s release year to tell a new film from an older one with the same name. '
      + 'A match to a film years older than AMC\'s release date is flagged here for review (Keep it, or search and re-point it). '
      + 'Titles that couldn\'t be matched at all aren\'t ranked, have no runway badge and never show as leaving — search and pick the right movie, or Ignore one-offs like "AMC Screen Unseen".'),
    unmatchedWrap, ignoredWrap,
  ));
  loadUnmatched();

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
    setGeoStatus(`→ ${r.label} (${r.lat}, ${r.lng}) — hit Save settings to keep it.`);
  };

  const placeIn = h('input', { class: 'input', type: 'search', placeholder: 'City & state, ZIP, or address — e.g. "Fishers IN"' });
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
        setGeoStatus(`Nothing found for "${q}" — try adding a city, state, or ZIP. Your saved home base is unchanged.`);
      } else if (results.length === 1) {
        applyPlace(results[0]);
      } else {
        setGeoStatus('More than one match — pick the right one:');
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
  const locBtn = h('button', { class: 'btn ghost' }, '📍 Use my location');
  locBtn.addEventListener('click', () => {
    if (!('geolocation' in navigator)) { setGeoStatus('This browser has no location support — type a place above instead.'); return; }
    if (!window.isSecureContext) { setGeoStatus('Location needs HTTPS or localhost — type a place above instead.'); return; }
    clear(geoResults); // candidate rows from a text search no longer match the status line
    const seq = ++geoSeq;
    setGeoStatus('Asking the browser for your location…');
    locBtn.disabled = true;
    // The old label stops being true the moment new coordinates land, so when
    // the reverse look-up can't name the place, the coordinates become the
    // label — saving then still stores something truthful.
    const unnamed = (lat, lng) => {
      homeLabelIn.value = `${lat}, ${lng}`;
      setGeoStatus(`Coordinates set (${lat}, ${lng}) — couldn't name the place; edit the label if you like, then Save settings.`);
    };
    navigator.geolocation.getCurrentPosition(async (pos) => {
      if (seq !== geoSeq) { locBtn.disabled = false; return; }
      const lat = Math.round(pos.coords.latitude * 100) / 100;
      const lng = Math.round(pos.coords.longitude * 100) / 100;
      homeLat.value = String(lat);
      homeLng.value = String(lng);
      setGeoStatus(`Got it (${lat}, ${lng}) — naming the place…`);
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
        ? 'Location permission denied — type a place above instead. Nothing was changed.'
        : 'Couldn\'t get a location fix — type a place above instead. Nothing was changed.');
    }, { timeout: 10000, maximumAge: 600000 });
  });

  const clearHomeBtn = h('button', { class: 'btn ghost small', onClick: async () => {
    const seq = ++geoSeq; // invalidate any in-flight look-up or locate
    try {
      const r = await api.clearHome();
      if (seq !== geoSeq) return;
      homeLabelIn.value = ''; homeLat.value = ''; homeLng.value = ''; placeIn.value = '';
      clear(geoResults);
      setGeoStatus(`Cleared — stored location, cached lookups, and cached drive times are gone. Drive times now measure from the app default (${r.home?.label || 'app default'}).`);
      toast('Home base cleared');
      ctx.refreshStatus();
    } catch (e) { toast(e.message, 'error'); }
  } }, 'Clear home base');

  page.appendChild(card('Home base',
    h('div', { class: 'row-gap' }, placeIn, lookupBtn, locBtn),
    geoStatus,
    geoResults,
    h('div', { class: 'grid-3' }, labeled('Label', homeLabelIn), labeled('Latitude', homeLat), labeled('Longitude', homeLng)),
    h('p', { class: 'muted small' },
      'Drive times next to each theatre are measured from here — re-measured within seconds of saving a change.'),
    h('p', { class: 'muted small' },
      h('strong', {}, 'Where your location data goes: '),
      'it\'s stored only in this app\'s local database. Two keyless OpenStreetMap services see location data: '
      + 'OSRM gets your coordinates rounded to ~1 km (never street-level) to measure drive times, and Nominatim gets '
      + 'what you type in the look-up box — sent as typed, so an exact address goes out as one — or your rounded '
      + 'coordinates, to turn them into a place. Answers are cached for months, so repeats send nothing. Your location '
      + 'is never sent to TMDB, OMDb, or AMC, and the shared guest link never includes it. '
      + '"Clear home base" removes the stored location and all of those caches.'),
    h('div', {}, clearHomeBtn),
  ));

  // ---- Weights
  const wRange = h('input', { type: 'range', min: '0', max: '100', step: '5', value: String(Math.round((s.weightPublic ?? 0.5) * 100)) });
  const wLabel = h('div', { class: 'weight-label' });
  const paintW = () => { const p = Number(wRange.value); wLabel.textContent = `Public score ${p}%  ·  Taste match ${100 - p}%`; };
  wRange.addEventListener('input', paintW); paintW();

  // Urgency: how hard a CONFIRMED end date pulls a movie up the ranking. The
  // watchlist multiplier lives in the advanced boosts card but feeds this label.
  const uRange = h('input', { type: 'range', min: '0', max: '20', step: '1', value: String(s.urgencyBoost ?? 6) });
  const uMult = h('input', { class: 'input num', type: 'number', min: '1', step: '0.1', value: String(s.urgencyWatchlistMultiplier ?? 1.5) });
  const uLabel = h('div', { class: 'weight-label' });
  const paintU = () => {
    const n = Number(uRange.value) || 0;
    const m = Math.max(1, Number(uMult.value) || 1);
    uLabel.textContent = n
      ? `Urgency up to +${n}  ·  ★ watchlisted up to +${Math.round(n * m * 10) / 10}`
      : 'Urgency off — a confirmed end date adds nothing';
  };
  uRange.addEventListener('input', paintU); uMult.addEventListener('input', paintU); paintU();

  page.appendChild(card('Ranking balance', wLabel, wRange,
    h('p', { class: 'muted small' }, 'How much public reviews vs. your personal taste drive the final score.'),
    uLabel, uRange,
    h('p', { class: 'muted small' },
      'How much a confirmed end date pulls a movie up, so the weekly 4 answers "what should I see this week". '
      + 'Full on a movie\'s last day, fading to nothing a week out — and only when the run is confirmed ending (filled calendar), never a hedged "through at least". '
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

  // ---- Now-playing fallback (only used when no AMC key)
  const recencyInput = h('input', { class: 'input num', type: 'number', min: '1', step: '1', value: String(s.fallbackRecencyWeeks ?? 8) });
  page.appendChild(card('Now-playing fallback',
    labeled('Only show films released in the last N weeks', recencyInput),
    h('p', { class: 'muted small' }, 'Applies only when no AMC key is connected (Reel Picks ranks TMDB\'s current US releases). Widen this if the list gets thin. With an AMC key, your theatre\'s actual lineup — re-releases and special screenings included — is used as-is.'),
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
      h('div', { class: 'row-gap' }, labeled('after', after), labeled('before', before)),
    ), read: () => ({ enabled: en.checked, after: after.value, before: before.value }) };
  };
  const weekday = mkWindow('weekday', 'Weekdays');
  const weekend = mkWindow('weekend', 'Weekends');
  page.appendChild(card('Preferred showtimes', weekday.el, weekend.el,
    h('p', { class: 'muted small' }, 'Picks with a showing inside your windows get a boost, and that showtime is surfaced.')));

  // ---- Pricing
  const perWeek = h('input', { class: 'input num', type: 'number', step: '1', min: '1', value: String(s.alistWeeklyLimit ?? 4) });
  const fee = h('input', { class: 'input num', type: 'number', step: '0.01', value: String(s.alistMonthlyFee ?? 25.99) });
  const ticket = h('input', { class: 'input num', type: 'number', step: '0.01', value: String(s.avgTicketPrice ?? 14.5) });
  const previews = h('input', { class: 'input num', type: 'number', step: '1', value: String(s.previewsMinutes ?? 20) });
  page.appendChild(card('A-List & pricing',
    h('div', { class: 'grid-3' },
      labeled('Reservations / week', perWeek),
      labeled('Monthly fee ($)', fee),
      labeled('Avg ticket ($)', ticket),
      labeled('Preview length (min)', previews),
    ),
    h('p', { class: 'muted small' }, 'Your plan\'s terms. AMC varies the allowance by region and raises the fee from time to time — change them here when it does.'),
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
      'Watchlist urgency × scales the urgency boost (Ranking balance) for starred movies — you\'ve already said you want to see them, so "it\'s leaving" counts for more.'),
  ));

  // ---- Picks sections
  const gmScore = h('input', { class: 'input num', type: 'number', min: '0', max: '100', value: String(s.goodMatchMinScore ?? 75) });
  page.appendChild(card('Also worth seeing',
    h('div', { class: 'grid-3' }, labeled('Minimum score', gmScore)),
    h('div', { class: 'muted small' },
      'Score a movie needs to appear in the "Also worth seeing" section under your weekly 4. '
      + 'Everything playing stays listed below it regardless of this cutoff.'),
  ));

  // ---- Last chance
  const lcScore = h('input', { class: 'input num', type: 'number', min: '0', max: '100', value: String(s.lastChanceMinScore ?? 75) });
  const lcGap = h('input', { class: 'input num', type: 'number', min: '1', value: String(s.lastChanceMinGapDays ?? 3) });
  const lcMax = h('input', { class: 'input num', type: 'number', min: '1', value: String(s.lastChanceMaxEntries ?? 3) });
  page.appendChild(card('Last chance',
    h('div', { class: 'grid-3' },
      labeled('Min score', lcScore),
      labeled('Days before horizon', lcGap),
      labeled('Max entries', lcMax),
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
    const fmtDate = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '—');
    const th = (t, num) => h('th', { class: num ? 'num' : '' }, t);
    const td = (t, num) => h('td', { class: num ? 'num' : '' }, t);
    const rows = horizons.map((hz) => {
      const src = amcByTheatre.get(hz.theatre?.id) || {};
      return h('tr', {},
        td(h('span', {}, hz.theatre?.short || hz.theatre?.name || '—', hz.theatre?.isPrimary ? h('span', { class: 'muted small' }, ' · primary') : null)),
        td(fmtDate(hz.publishedThrough)),
        td(String(hz.publishedDays ?? '—'), true),
        td(`${hz.typicalDailyLineup ?? '—'} / ${hz.typicalDailyShowtimes ?? '—'}`, true),
        td(`${hz.breadthThreshold ?? '—'} / ${hz.showtimeThreshold ?? '—'}`, true),
        td(fmtDate(hz.furthestShowtime)),
        td(String(hz.lineup ?? '—'), true),
        td(String(src.showtimes ?? '—'), true),
        td(String(src.calls ?? '—'), true),
        h('td', { class: `num${src.staleDays ? ' warn' : ''}`, title: src.staleError || '' }, src.staleDays ? `${src.staleDays} ⚠︎` : '0'),
      );
    });
    page.appendChild(card('Schedule diagnostics',
      h('div', { class: 'diag-wrap' }, h('table', { class: 'diag-table' },
        h('thead', {}, h('tr', {}, th('Theatre'), th('Published through'), th('Days', true), th('Typical movies / showtimes per day', true),
          th('Threshold (movies / showtimes)', true), th('Furthest showtime'), th('Movies', true), th('Showtimes', true), th('AMC calls', true), th('Stale days', true))),
        h('tbody', {}, ...rows),
      )),
      h('p', { class: 'muted small' },
        '"Published through" is where each theatre\'s schedule stops being densely posted (the horizon). '
        + 'A movie\'s runway badge only commits to an end date when its last showtime falls at least the "Days before horizon" setting short of it; '
        + 'otherwise it says "through at least". Typical values are medians over the nearest 3 days at that theatre; '
        + 'a day below either threshold (half of typical) is treated as the unpublished advance-sale tail. '
        + 'AMC calls are real HTTP requests on the last refresh: per-day responses are cached 24h, and a manual Refresh always re-pulls today and tomorrow (2 calls per theatre) so same-day schedule changes show up. '
        + '"Stale days" counts days whose live AMC call failed and an older cached copy was used instead — the schedule shown for those days may be out of date.'),
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
      toast(`Setup imported — ${c.ratings || 0} ratings, ${c.watchlist || 0} watchlist, ${c.watched || 0} watched, ${c.matches || 0} match decisions, ${c.settings || 0} settings. Refreshing showtimes…`, 'success');
      ctx.triggerRefresh?.();
      ctx.refreshStatus();
    } catch (e) {
      toast(e instanceof SyntaxError ? 'That file isn\'t valid JSON — use the file from "Export full setup".' : e.message, 'error');
    }
  });
  page.appendChild(card('Data',
    h('div', { class: 'row-gap wrap' },
      h('a', { class: 'btn ghost', href: api.stateUrl() }, '⬇ Export full setup'),
      h('button', { class: 'btn ghost', onClick: () => stateFile.click() }, '⬆ Import full setup'),
      stateFile,
      h('a', { class: 'btn ghost', href: api.exportUrl() }, '⬇ Export backup CSV'),
      h('button', { class: 'btn ghost', onClick: () => ctx.triggerRefresh() }, '↻ Refresh now'),
      h('a', { class: 'btn ghost', href: '#/onboarding' }, '⭐ Re-run quick rate'),
    ),
    h('p', { class: 'muted small' },
      'Full setup carries settings, theatres, home base, ratings, watchlist, watch history, and AMC match decisions — everything except caches and schedule history, which each instance builds itself. Importing is additive: nothing local is deleted.'),
    status?.lastRefreshLog?.errors?.length
      ? h('details', { class: 'log' }, h('summary', {}, `Last refresh: ${status.lastRefreshLog.errors.length} warning(s)`),
        ...status.lastRefreshLog.errors.map((e) => h('div', { class: 'muted small' }, `• ${e}`)))
      : h('div', { class: 'muted small' }, status?.lastRefresh ? `Last refreshed ${new Date(status.lastRefresh).toLocaleString()}` : 'Not refreshed yet.'),
  ));

  // ---- Save
  const save = async () => {
    const p = Number(wRange.value) / 100;
    // Out-of-range multiplier is clamped; show the value that is actually saved.
    uMult.value = String(Math.max(1, Number(uMult.value) || 1));
    paintU();
    try {
      await api.saveSettings({
        weightPublic: p,
        weightTaste: 1 - p,
        preferImax: imaxToggle.checked,
        fallbackRecencyWeeks: Number(recencyInput.value) || 8,
        excludedGenres: [...exG],
        excludedMpaa: [...exM],
        showtimeWindows: { weekday: weekday.read(), weekend: weekend.read() },
        alistWeeklyLimit: Math.max(1, Math.round(Number(perWeek.value) || 4)),
        alistMonthlyFee: Number(fee.value) || 0,
        avgTicketPrice: Number(ticket.value) || 0,
        previewsMinutes: Number(previews.value) || 0,
        watchlistBoost: Number(wlB.value) || 0,
        imaxBoost: Number(imB.value) || 0,
        windowFitBoost: Number(wfB.value) || 0,
        urgencyBoost: Number(uRange.value) || 0,
        urgencyWatchlistMultiplier: Math.max(1, Number(uMult.value) || 1),
        goodMatchMinScore: Number(gmScore.value) || 0,
        lastChanceMinScore: Number(lcScore.value) || 0,
        lastChanceMinGapDays: Number(lcGap.value) || 3,
        lastChanceMaxEntries: Number(lcMax.value) || 3,
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

function keyRow(name, present, desc) {
  return h('div', { class: 'key-row' },
    h('span', { class: `key-dot ${present ? 'on' : 'off'}` }),
    h('span', { class: 'key-name' }, name),
    h('span', { class: 'muted small' }, desc),
    h('span', { class: `key-status ${present ? 'on' : 'off'}` }, present ? 'connected' : 'missing'),
  );
}
