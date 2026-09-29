// Rate: TMDB search + inline rating, the guided ratings-import flow, and your
// ratings list.
import { api } from '../api.js';
import { h, clear, makeStars, toast, sectionTitle, chip, icon, withStars, tmdbSized } from '../ui.js';
import { filterBox } from '../filter.js';
import { noteSlot, noteLine } from '../notes.js';

// Where a rating came from, as the list names it.
const SOURCES = { letterboxd: 'Letterboxd', imdb: 'IMDb', manual: 'Rated here', onboarding: 'Quick rate', reelpicks: 'Backup' };

export async function render(root, params, ctx) {
  clear(root);
  const page = h('div', { class: 'page' });

  // ---- Search + rate ------------------------------------------------------
  const results = h('div', { class: 'search-results' });
  const input = h('input', { class: 'input big', type: 'search', placeholder: 'Search a movie to rate…' });
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) return clear(results);
    timer = setTimeout(async () => {
      try {
        const { results: found } = await api.searchRatings(q);
        renderSearch(found);
      } catch (e) { toast(e.message, 'error'); }
    }, 300);
  });

  function renderSearch(found) {
    clear(results);
    if (!found.length) { results.appendChild(h('div', { class: 'muted pad' }, 'No matches.')); return; }
    for (const r of found.slice(0, 12)) {
      // Rated from here: "Add a note" comes up after the stars (js/notes.js).
      const note = noteSlot(r, { rated: Boolean(r.myRating) });
      r.noteSlot = note;
      results.appendChild(h('div', { class: 'search-row' },
        r.poster ? h('img', { class: 'search-poster', loading: 'lazy', src: tmdbSized(r.poster, 'w92'), alt: '' }) : h('div', { class: 'search-poster ph' }),
        h('div', { class: 'search-info' },
          h('a', { class: 'search-title', href: `#/movie/${r.tmdb_id}` }, `${r.title}${r.year ? ` (${r.year})` : ''}`),
          h('div', { class: 'muted small' }, (r.genres || []).slice(0, 3).join(' · ')),
        ),
        makeStars({ value: r.myRating || 0, interactive: true, size: 22, allowClear: true, onChange: (v) => rateMovie(r, v), label: `Your rating of ${r.title}` }),
        note.el,
      ));
    }
  }

  // v === 0 means "clear" (tapped the star already selected) — delete the row
  // rather than storing a zero, so it stops feeding the taste profile.
  async function rateMovie(r, v) {
    try {
      if (v) {
        await api.rate({ tmdb_id: r.tmdb_id, rating: v, title: r.title, year: r.year, poster: r.poster, genres: r.genres });
        toast(withStars(`Rated ${r.title} ${v}★`), 'success');
      } else {
        await api.unrate(r.tmdb_id);
        toast(`Cleared rating for ${r.title}`);
      }
      r.noteSlot?.rated(v);
      justRated = v ? r.tmdb_id : null;
      ctx.refreshStatus();
      loadRecent();
    } catch (e) { toast(e.message, 'error'); }
  }
  // The film just rated in the list keeps its "Add a note" through the re-load.
  let justRated = null;
  // A note saved or deleted in the list changes what the filter finds.
  page.addEventListener('note-change', (e) => {
    const row = rows.find((x) => x.el.contains(e.target));
    if (!row) return;
    row.fields = [row.title, e.detail?.note || ''];
    filter.set(rows);
  });

  // ---- Bring your ratings from Letterboxd or IMDb -------------------------
  // Deliberately not called "link" or "connect": it is a one-time file upload
  // and nothing here talks to either account. The step copy below was checked
  // against the services' own pages (Aug 2026): Letterboxd exports from
  // Settings → Data on letterboxd.com (a ZIP of CSVs; free, not Pro-gated) and
  // is not offered inside its apps; IMDb queues "Export ratings" from Your
  // Ratings onto imdb.com/exports, where it must be downloaded once Ready.

  // Several files at once: Letterboxd's ratings.csv and reviews.csv together.
  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv', multiple: true, style: { display: 'none' } });
  const resultPanel = h('div', { class: 'import-result', hidden: true });
  const showResult = (tone, ...kids) => {
    resultPanel.hidden = false;
    resultPanel.className = `import-result ${tone}`;
    // replaceChildren stringifies null into a literal "null" — drop empty kids.
    resultPanel.replaceChildren(...kids.filter(Boolean));
  };

  // One import at a time: a second file picked mid-poll would interleave its
  // messages into the same panel and muddle the summary.
  let importBusy = false;
  fileInput.addEventListener('change', async () => {
    // ratings.csv before reviews.csv, so a review finds its rating.
    const files = [...fileInput.files].sort((a, b) => /review/i.test(a.name) - /review/i.test(b.name));
    fileInput.value = '';
    if (!files.length) return;
    if (importBusy) { toast('An import is already running. Wait for it to finish.', 'error'); return; }
    importBusy = true;
    try {
      // The most common mistake, caught before upload: the ZIP itself. Only the
      // ZIP is judged by its name — everything else is judged by its CONTENT on
      // the server, so a rating-bearing file that happens to be called
      // watched.csv still imports.
      const zip = files.find((f) => /\.zip$/i.test(f.name));
      if (zip) {
        showResult('err',
          h('strong', {}, `"${zip.name}" is the whole ZIP file.`),
          h('div', {}, 'Unzip it first, then upload the ratings.csv file from inside it (and reviews.csv, for your reviews as notes). Nothing was imported.'));
        return;
      }
      // Each file queued for matching is followed until it's matched, and the
      // summary adds them up (ratings.csv, then reviews.csv).
      let carry = null;
      for (const f of files) {
        const text = await f.text();
        showResult('warn', files.length > 1 ? `Reading ${f.name}…` : 'Reading the file…');
        let r;
        try {
          r = await api.importCsv(text);
        } catch (e) {
          if (files.length === 1) throw e;
          showResult('err', h('strong', {}, `${f.name}: ${e.message}`), h('div', {}, carry ? 'The files before it were imported.' : 'Your existing ratings were not changed.'));
          return;
        }
        if (r.format === 'reelpicks') {
          showResult(r.skipped ? 'warn' : 'ok',
            h('strong', {}, `Restored ${r.ratingsRestored} rating${r.ratingsRestored === 1 ? '' : 's'}${r.watchedRestored ? ` and ${r.watchedRestored} watched entr${r.watchedRestored === 1 ? 'y' : 'ies'}` : ''} from your backup.`),
            r.skipped ? h('div', {}, `${r.skipped} row${r.skipped > 1 ? 's' : ''} skipped: ${(r.skippedSamples || []).join(' · ')}`) : null);
          ctx.refreshStatus(); loadRecent();
          continue;
        }
        if (r.emptyExport) {
          // Valid export, zero ratings — the misleading "could not detect" case, named.
          if (files.length === 1) { showResult('warn', h('strong', {}, 'This is a valid ratings file, but it has no ratings in it.'), h('div', {}, r.note)); return; }
          continue;
        }
        carry = await pollAndSummarize(r, carry);
      }
    } catch (e) {
      showResult('err', h('strong', {}, e.message), h('div', {}, 'Your existing ratings were not changed.'));
    } finally {
      importBusy = false;
    }
  });

  // Live progress while queued titles are matched to TMDB, then a summary of
  // what actually happened: imported, skipped and why, still unmatched.
  // "Matching finished" is detected by the server's lastDrain timestamp moving
  // past the baseline the import response carried (lastDrainAt) — two server
  // clocks, so browser/server clock skew can't wedge the loop.
  // `carry`: what earlier files in the same upload brought, added in.
  // Returns the running totals.
  async function pollAndSummarize(res, carry = null) {
    const r = {
      ...res,
      received: (carry?.received || 0) + (res.reviews ? 0 : res.received),
      reviews: (carry?.reviews || 0) + (res.reviews ? res.received : 0),
      skipped: (carry?.skipped || 0) + (res.skipped || 0),
      skippedSamples: [...(carry?.skippedSamples || []), ...(res.skippedSamples || [])].slice(0, 5),
      ratingsBefore: carry?.ratingsBefore ?? res.ratingsBefore,
      pendingBefore: carry?.pendingBefore ?? res.pendingBefore,
      matched: carry?.matched || 0,
      notes: carry?.notes || 0,
    };
    if (!r.matching) {
      // No TMDB key: nothing will match now, so don't pretend to watch it.
      showResult('warn',
        h('strong', {}, `${r.received + r.reviews} row${r.received + r.reviews === 1 ? '' : 's'} saved to the matching queue.`),
        h('div', {}, 'No TMDB key is connected, so titles can\'t be matched yet. Add TMDB_API_KEY to .env and they\'ll match on their own.'),
        r.skipped ? h('div', {}, `${r.skipped} row${r.skipped > 1 ? 's' : ''} skipped: ${r.skippedWhy}.`) : null);
      return r;
    }
    const src = r.format === 'letterboxd' ? 'Letterboxd' : 'IMDb';
    // What was found: ratings, reviews (reviews.csv), or both.
    const found = [r.received ? `${r.received} ${src} rating${r.received === 1 ? '' : 's'}` : null, r.reviews ? `${r.reviews} review${r.reviews === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ') || `0 ${src} ratings`;
    const drainMoved = (s) => Boolean(s?.lastDrain && s.lastDrain.finishedAt !== (res.lastDrainAt || null));
    let s = null;
    for (let i = 0; i < 120; i++) {
      s = await api.status().catch(() => null);
      const pending = s?.counts?.unmatched ?? 0;
      if (s && !s.matching && (drainMoved(s) || !pending)) break;
      showResult('warn',
        h('strong', {}, `Found ${found}. Matching titles to TMDB…`),
        h('div', {}, r.pendingBefore
          ? `${pending} in the matching queue (includes ${r.pendingBefore} queued earlier)`
          : `${pending} left to match`),
        r.skipped ? h('div', { class: 'muted small' }, `${r.skipped} row${r.skipped > 1 ? 's' : ''} will be skipped (${r.skippedWhy}).`) : null);
      await new Promise((ok) => setTimeout(ok, 2000));
      ctx.refreshStatus();
    }
    const ratingsNow = s?.counts?.ratings;
    const leftover = s?.counts?.unmatched ?? 0;
    const moved = drainMoved(s);
    if (moved) { r.matched += s.lastDrain.matched || 0; r.notes += s.lastDrain.notes || 0; }
    const { matched, notes } = r;
    const importedLine = moved || carry
      ? [r.received || matched ? `${matched} rating${matched === 1 ? '' : 's'} imported${r.pendingBefore ? ' (including some queued earlier)' : ''}` : null,
        r.reviews ? `${notes} review${notes === 1 ? '' : 's'} brought in as notes` : null].filter(Boolean).join(', ')
      : `${r.received + r.reviews} row${r.received + r.reviews === 1 ? '' : 's'} queued`;
    showResult('ok',
      h('strong', { class: 'import-done' }, icon('check', { size: 16 }), importedLine),
      ratingsNow != null ? h('div', {}, `Your ratings went from ${r.ratingsBefore} to ${ratingsNow}.`) : null,
      r.skipped ? h('div', {},
        `${r.skipped} row${r.skipped > 1 ? 's' : ''} skipped: ${r.skippedWhy}`,
        r.skippedSamples?.length ? ` (e.g. ${r.skippedSamples.join(', ')})` : '', '.') : null,
      leftover ? h('div', {}, `${leftover} title${leftover > 1 ? 's' : ''} couldn't be matched to TMDB yet. They're kept and retried on the next refresh.`) : null,
    );
    ctx.refreshStatus();
    loadRecent();
    return r;
  }

  // ---- The guide itself ----------------------------------------------------
  // Verified against the services' own pages; see comment above.
  const GUIDES = {
    letterboxd: {
      computer: {
        steps: [
          ['On ', h('strong', {}, 'letterboxd.com'), ' (signed in), open your account menu › ', h('strong', {}, 'Settings'), ' › the ', h('strong', {}, 'Data'), ' tab.'],
          ['Click ', h('strong', {}, 'Export your data'), '. You get a ', h('strong', {}, 'ZIP file containing several CSVs'), '. The export is free, no Pro needed.'],
          ['Unzip it. The file you want is ', h('strong', {}, 'ratings.csv'), '. Not watched.csv, and not the ZIP itself.'],
          ['Upload ratings.csv here. Pick ', h('strong', {}, 'reviews.csv'), ' with it too, and your reviews become private notes on those films.'],
        ],
        warn: ['On Letterboxd, marking a film watched (the eye icon) is ', h('strong', {}, 'not'), ' the same as rating it. Only films you gave a star rating appear in ratings.csv. If you\'ve starred nothing, the export has no ratings to bring.'],
      },
      phone: {
        steps: [
          ['The Letterboxd ', h('strong', {}, 'app has no export'), '. It lives on the letterboxd.com website, and the download is a ZIP you\'d have to unzip on the phone. In practice, do it on a computer.'],
          ['Easiest: run the export on a computer (steps under "On a computer"), unzip it there, then ', h('strong', {}, 'AirDrop or email yourself ratings.csv'), ' (and reviews.csv, for your reviews as private notes) and upload them here from the phone.'],
          ['No computer handy? Rate films right here instead, with the search box above or the quick 20-film rater.'],
        ],
        warn: ['Watched ≠ rated on Letterboxd: only star ratings export. Films you only marked with the eye icon won\'t come across.'],
      },
    },
    imdb: {
      computer: {
        steps: [
          ['On ', h('strong', {}, 'imdb.com'), ' (signed in), open your profile menu › ', h('strong', {}, 'Your Ratings'), '.'],
          ['Click the ', h('strong', {}, 'three-dot menu'), ' (top right) › ', h('strong', {}, 'Export ratings'), '. IMDb queues the export instead of downloading right away.'],
          ['Go to ', h('strong', {}, 'imdb.com/exports'), ' ("Your exports") and wait for the status to turn ', h('strong', {}, 'Ready'), '. It can take a few minutes and IMDb won\'t email you.'],
          ['Download it (a single CSV, no unzipping) and upload it here. Don\'t sit on it: ready exports expire after a while.'],
        ],
        warn: ['Your ', h('strong', {}, 'watchlist is not your ratings'), ': only titles you explicitly starred (1–10) are in the ratings export. A watchlist or list export has no "Your Rating" column and will be turned away here with an explanation. 1–10 scores become 0.5–5 stars.'],
      },
      phone: {
        steps: [
          ['IMDb\'s export lives on the ', h('strong', {}, 'desktop website'), '. The app doesn\'t offer it.'],
          ['Reliable path: export on a computer (steps under "On a computer"), then email or AirDrop the CSV to your phone and upload it here.'],
          ['Or skip the export and rate films right here: search above, or quick-rate 20.'],
        ],
        warn: ['Watchlist ≠ ratings: only explicitly starred titles export.'],
      },
    },
  };

  let source = 'letterboxd';
  // Default the device tab to where the user actually is.
  let device = matchMedia('(max-width: 640px)').matches ? 'phone' : 'computer';
  const guideBody = h('div', { class: 'import-guide-body' });
  const sourceChips = h('div', { class: 'chips' });
  const deviceChips = h('div', { class: 'chips' });

  function paintGuide() {
    clear(sourceChips);
    sourceChips.append(
      chip('Letterboxd', { active: source === 'letterboxd', onClick: () => { source = 'letterboxd'; paintGuide(); } }),
      chip('IMDb', { active: source === 'imdb', onClick: () => { source = 'imdb'; paintGuide(); } }),
    );
    clear(deviceChips);
    deviceChips.append(
      chip('On a computer', { active: device === 'computer', onClick: () => { device = 'computer'; paintGuide(); } }),
      chip('On my phone', { active: device === 'phone', onClick: () => { device = 'phone'; paintGuide(); } }),
    );
    const g = GUIDES[source][device];
    clear(guideBody);
    guideBody.append(
      h('ol', { class: 'import-steps' }, ...g.steps.map((s) => h('li', {}, ...s))),
      h('div', { class: 'import-warn' }, icon('alert', { size: 16 }), ' ', ...g.warn),
      h('div', { class: 'row-gap wrap' },
        h('button', { class: 'btn', onClick: () => fileInput.click() }, icon('upload', { size: 16 }), 'Upload ratings.csv'),
        h('span', { class: 'muted small' }, 'Reel Picks backup CSVs restore here too.'),
      ),
    );
  }

  const guide = h('div', { class: 'import-guide', hidden: true }, sourceChips, deviceChips, guideBody);
  const toggleGuide = h('button', { class: 'btn' }, 'Show me how');
  toggleGuide.addEventListener('click', () => {
    guide.hidden = !guide.hidden;
    toggleGuide.textContent = guide.hidden ? 'Show me how' : 'Hide the steps';
    if (!guide.hidden) paintGuide();
  });

  // ---- Page assembly -------------------------------------------------------
  page.appendChild(sectionTitle('Rate movies', 'Every rating sharpens your picks', { level: 1 }));
  page.appendChild(input);
  page.appendChild(results);

  page.appendChild(sectionTitle('Bring your ratings',
    'A one-time file upload. Nothing connects to your account.'));
  page.appendChild(h('div', { class: 'import-split' },
    h('div', { class: 'import-box' },
      h('h3', {}, 'Rate right here'),
      h('div', { class: 'muted small' }, 'Nothing to download. Search above, or run a quick tap-through of 20 popular films.'),
      h('div', {}, h('a', { class: 'btn soft', href: '#/onboarding' }, icon('zap', { size: 16 }), 'Quick rate 20')),
    ),
    h('div', { class: 'import-box' },
      h('h3', { class: 'import-head' }, icon('upload', { size: 18 }), 'Import from Letterboxd or IMDb'),
      h('div', { class: 'muted small' }, 'Already rated films there? Download your ratings file from the site, then upload it here. The steps show where to find it.'),
      h('div', {}, toggleGuide),
    ),
  ));
  page.appendChild(guide);
  page.appendChild(resultPanel);
  page.appendChild(fileInput);

  // ---- Your ratings --------------------------------------------------------
  // The newest SHOWN, then "Show all (N)" for the rest. The filter box looks
  // through every rating, shown or not, with the same forgiving matching as
  // the Watchlist's. Rows are built once per load and only shown or hidden
  // after that, so typing stays quick with hundreds of ratings. A re-load
  // (after a rating changes) keeps what's typed and whether all are showing.
  const SHOWN = 60;
  const recentWrap = h('div', {});
  page.appendChild(recentWrap);
  // Come back to (js/place.js): the filter's text and Show all as they were.
  const kept = ctx.place?.saved || {};
  let showAll = Boolean(kept.showAll);
  let rows = [];
  const filter = filterBox({ label: 'Filter your ratings', placeholder: 'Filter your ratings', onChange: ({ query }) => paintRows(query) });
  filter.input.value = kept.filter || '';
  ctx.place?.keep('filter', () => filter.text);
  ctx.place?.keep('showAll', () => showAll);
  const moreBtn = h('button', { class: 'btn soft small show-all', type: 'button', 'aria-controls': 'rating-list' });
  moreBtn.addEventListener('click', () => {
    showAll = !showAll;
    paintRows(filter.active);
    if (!showAll) moreBtn.scrollIntoView({ block: 'nearest' });
  });
  function paintRows(query) {
    // With a query the filter decides every row; without one, the rows past
    // the first SHOWN follow the button.
    if (!query) for (let i = SHOWN; i < rows.length; i++) rows[i].el.hidden = !showAll;
    moreBtn.hidden = Boolean(query) || rows.length <= SHOWN;
    moreBtn.textContent = showAll ? 'Show fewer' : `Show all (${rows.length})`;
    moreBtn.setAttribute('aria-expanded', String(showAll));
  }

  const ratingRow = (r) => {
    const title = r.title || 'Untitled';
    // Your note as a second line; the film just rated gets "Add a note".
    const fresh = justRated === r.tmdb_id && !r.note;
    const slot = fresh ? noteSlot(r, { rated: true }) : null;
    if (fresh) slot.rated(r.rating);
    return h('div', { class: 'rating-item', 'data-rating-id': String(r.tmdb_id) },
      r.poster ? h('img', { class: 'ri-poster', loading: 'lazy', src: tmdbSized(r.poster, 'w92'), alt: '' }) : h('div', { class: 'ri-poster ph' }),
      h('div', { class: 'ri-info' },
        h('a', { class: 'ri-title', href: `#/movie/${r.tmdb_id}` }, `${title}${r.year ? ` (${r.year})` : ''}`),
        h('div', { class: 'muted small' }, SOURCES[r.source] || r.source),
        noteLine(r.note),
      ),
      makeStars({ value: r.rating, interactive: true, size: 18, allowClear: true, onChange: (v) => rateMovie(r, v), label: `Your rating of ${title}` }),
      h('button', {
        class: 'icon-btn danger ri-remove', type: 'button', title: 'Remove rating', 'aria-label': `Remove your rating of ${title}`,
        onClick: async () => {
          try {
            await api.unrate(r.tmdb_id);
            toast(`Removed your rating of ${title}`);
            ctx.refreshStatus();
            loadRecent();
          } catch (e) { toast(e.message, 'error'); }
        },
      }, icon('x', { size: 18 })),
      slot?.el,
    );
  };

  async function loadRecent() {
    // Keyboard focus in the list (a film's stars or remove button) survives the
    // re-load: back on that film's same control, or, when it's gone (cleared),
    // on the stars of the film now in its place (the filter box when none is).
    const was = document.activeElement?.closest?.('#rating-list [data-rating-id]');
    const wasId = was?.dataset.ratingId;
    const wasIndex = was ? [...was.parentElement.children].indexOf(was) : -1;
    const wasRemove = Boolean(document.activeElement?.closest?.('.ri-remove'));
    const { ratings } = await api.ratings();
    const head = sectionTitle('Your ratings', `${ratings.length} total`);
    if (!ratings.length) {
      rows = [];
      recentWrap.replaceChildren(head, h('div', { class: 'muted pad' }, 'No ratings yet.'));
      return;
    }
    const list = h('div', { class: 'rating-list', id: 'rating-list' });
    // The filter matches your own note as well as the title.
    rows = ratings.map((r) => ({ el: list.appendChild(ratingRow(r)), title: r.title || 'Untitled', fields: [r.title || 'Untitled', r.note || ''] }));
    // Swapped in whole, so the page never drops to empty and loses its place.
    recentWrap.replaceChildren(...[head, ratings.length > 8 ? filter.el : null, list, moreBtn].filter(Boolean));
    filter.set(rows); // applies whatever is typed, then paintRows folds the rest away
    if (wasId) {
      const same = list.querySelector(`[data-rating-id="${wasId}"]`);
      const row = same && !same.hidden ? same : [...list.children].slice(Math.max(0, wasIndex)).find((el) => !el.hidden);
      const target = row?.querySelector(same && wasRemove ? '.ri-remove' : '.stars.interactive');
      (target || recentWrap.querySelector('input') || moreBtn)?.focus?.();
    }
  }

  root.replaceChildren(page);
  loadRecent();
}
