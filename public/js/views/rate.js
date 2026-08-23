// Rate: TMDB search + inline rating, the guided ratings-import flow, and your
// ratings list.
import { api } from '../api.js';
import { h, clear, makeStars, toast, sectionTitle, chip } from '../ui.js';

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
      results.appendChild(h('div', { class: 'search-row' },
        r.poster ? h('img', { class: 'search-poster', src: r.poster, alt: '', loading: 'lazy' }) : h('div', { class: 'search-poster ph' }),
        h('div', { class: 'search-info' },
          h('a', { class: 'search-title', href: `#/movie/${r.tmdb_id}` }, `${r.title}${r.year ? ` (${r.year})` : ''}`),
          h('div', { class: 'muted small' }, (r.genres || []).slice(0, 3).join(' · ')),
        ),
        makeStars({ value: r.myRating || 0, interactive: true, size: 22, allowClear: true, onChange: (v) => rateMovie(r, v) }),
      ));
    }
  }

  // v === 0 means "clear" (tapped the star already selected) — delete the row
  // rather than storing a zero, so it stops feeding the taste profile.
  async function rateMovie(r, v) {
    try {
      if (v) {
        await api.rate({ tmdb_id: r.tmdb_id, rating: v, title: r.title, year: r.year, poster: r.poster, genres: r.genres });
        toast(`Rated ${r.title} ${v}★`, 'success');
      } else {
        await api.unrate(r.tmdb_id);
        toast(`Cleared rating for ${r.title}`);
      }
      ctx.refreshStatus();
      loadRecent();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---- Bring your ratings from Letterboxd or IMDb -------------------------
  // Deliberately not called "link" or "connect": it is a one-time file upload
  // and nothing here talks to either account. The step copy below was checked
  // against the services' own pages (Aug 2026): Letterboxd exports from
  // Settings → Data on letterboxd.com (a ZIP of CSVs; free, not Pro-gated) and
  // is not offered inside its apps; IMDb queues "Export ratings" from Your
  // Ratings onto imdb.com/exports, where it must be downloaded once Ready.

  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv', style: { display: 'none' } });
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
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    if (importBusy) { toast('An import is already running — wait for it to finish.', 'error'); return; }
    importBusy = true;
    try {
      // The most common mistake, caught before upload: the ZIP itself. Only the
      // ZIP is judged by its name — everything else is judged by its CONTENT on
      // the server, so a rating-bearing file that happens to be called
      // watched.csv still imports.
      if (/\.zip$/i.test(f.name)) {
        showResult('err',
          h('strong', {}, `"${f.name}" is the export ZIP itself.`),
          h('div', {}, 'Unzip it first, then upload the ratings.csv file from inside it. Nothing was imported.'));
        return;
      }
      const text = await f.text();
      showResult('warn', 'Reading the file…');
      const r = await api.importCsv(text);
      if (r.format === 'reelpicks') {
        showResult(r.skipped ? 'warn' : 'ok',
          h('strong', {}, `Restored ${r.ratingsRestored} rating${r.ratingsRestored === 1 ? '' : 's'}${r.watchedRestored ? ` and ${r.watchedRestored} watched entr${r.watchedRestored === 1 ? 'y' : 'ies'}` : ''} from your backup.`),
          r.skipped ? h('div', {}, `${r.skipped} row${r.skipped > 1 ? 's' : ''} skipped: ${(r.skippedSamples || []).join(' · ')}`) : null);
        ctx.refreshStatus(); loadRecent();
        return;
      }
      if (r.emptyExport) {
        // Valid export, zero ratings — the misleading "could not detect" case, named.
        showResult('warn', h('strong', {}, 'This is a valid export, but it has no ratings in it.'), h('div', {}, r.note));
        return;
      }
      await pollAndSummarize(r);
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
  async function pollAndSummarize(r) {
    if (!r.matching) {
      // No TMDB key: nothing will match now, so don't pretend to watch it.
      showResult('warn',
        h('strong', {}, `${r.received} rating${r.received === 1 ? '' : 's'} saved to the matching queue.`),
        h('div', {}, 'No TMDB key is connected, so titles can\'t be matched to movies yet — add TMDB_API_KEY to .env and they\'ll match automatically.'),
        r.skipped ? h('div', {}, `${r.skipped} row${r.skipped > 1 ? 's' : ''} skipped — ${r.skippedWhy}.`) : null);
      return;
    }
    const src = r.format === 'letterboxd' ? 'Letterboxd' : 'IMDb';
    const drainMoved = (s) => Boolean(s?.lastDrain && s.lastDrain.finishedAt !== (r.lastDrainAt || null));
    let s = null;
    for (let i = 0; i < 120; i++) {
      s = await api.status().catch(() => null);
      const pending = s?.counts?.unmatched ?? 0;
      if (s && !s.matching && (drainMoved(s) || !pending)) break;
      showResult('warn',
        h('strong', {}, `Found ${r.received} ${src} rating${r.received === 1 ? '' : 's'} — matching titles to TMDB…`),
        h('div', {}, r.pendingBefore
          ? `${pending} in the matching queue (includes ${r.pendingBefore} queued earlier)`
          : `${pending} left to match`),
        r.skipped ? h('div', { class: 'muted small' }, `${r.skipped} row${r.skipped > 1 ? 's' : ''} will be skipped (${r.skippedWhy}).`) : null);
      await new Promise((res) => setTimeout(res, 2000));
      ctx.refreshStatus();
    }
    const ratingsNow = s?.counts?.ratings;
    const leftover = s?.counts?.unmatched ?? 0;
    const matched = drainMoved(s) ? s.lastDrain.matched : null;
    const importedLine = matched != null
      ? `${matched} rating${matched === 1 ? '' : 's'} imported${r.pendingBefore ? ' (including some queued earlier)' : ''}`
      : `${r.received} rating${r.received === 1 ? '' : 's'} queued`;
    showResult('ok',
      h('strong', {}, `✓ ${importedLine}`),
      ratingsNow != null ? h('div', {}, `Your ratings: ${r.ratingsBefore} → ${ratingsNow}.`) : null,
      r.skipped ? h('div', {},
        `${r.skipped} row${r.skipped > 1 ? 's' : ''} skipped — ${r.skippedWhy}`,
        r.skippedSamples?.length ? ` (e.g. ${r.skippedSamples.join(', ')})` : '', '.') : null,
      leftover ? h('div', {}, `${leftover} title${leftover > 1 ? 's' : ''} couldn't be matched to TMDB yet — kept, and retried automatically on the next refresh.`) : null,
    );
    ctx.refreshStatus();
    loadRecent();
  }

  // ---- The guide itself ----------------------------------------------------
  // Verified against the services' own pages; see comment above.
  const GUIDES = {
    letterboxd: {
      computer: {
        steps: [
          ['On ', h('strong', {}, 'letterboxd.com'), ' (signed in), open your account menu → ', h('strong', {}, 'Settings'), ' → the ', h('strong', {}, 'Data'), ' tab.'],
          ['Click ', h('strong', {}, 'Export your data'), '. You get a ', h('strong', {}, 'ZIP file containing several CSVs'), ' — export is free, no Pro needed.'],
          ['Unzip it. The file you want is ', h('strong', {}, 'ratings.csv'), ' — not watched.csv, not the ZIP itself.'],
          ['Upload ratings.csv here.'],
        ],
        warn: ['On Letterboxd, marking a film watched (the eye icon) is ', h('strong', {}, 'not'), ' the same as rating it. Only films you gave a star rating appear in ratings.csv — if you\'ve starred nothing, the export has no ratings to bring.'],
      },
      phone: {
        steps: [
          ['The Letterboxd ', h('strong', {}, 'app has no export'), ' — it lives on the letterboxd.com website, and the download is a ZIP you\'d have to unzip on the phone. In practice, do it on a computer.'],
          ['Easiest: run the export on a computer (steps under "On a computer"), unzip it there, then ', h('strong', {}, 'AirDrop or email yourself just ratings.csv'), ' and upload it here from the phone.'],
          ['No computer handy? Just rate films right here instead — the search box above, or the quick 20-film rater.'],
        ],
        warn: ['Watched ≠ rated on Letterboxd: only star ratings export. Films you only marked with the eye icon won\'t come across.'],
      },
    },
    imdb: {
      computer: {
        steps: [
          ['On ', h('strong', {}, 'imdb.com'), ' (signed in), open your profile menu → ', h('strong', {}, 'Your Ratings'), '.'],
          ['Click the ', h('strong', {}, '⋮ menu'), ' (top right) → ', h('strong', {}, 'Export ratings'), '. IMDb queues the export instead of downloading right away.'],
          ['Go to ', h('strong', {}, 'imdb.com/exports'), ' ("Your exports") and wait for the status to turn ', h('strong', {}, 'Ready'), ' — it can take a few minutes and IMDb won\'t email you.'],
          ['Download it — a single CSV, no unzipping — and upload it here. Don\'t sit on it: ready exports expire after a while.'],
        ],
        warn: ['Your ', h('strong', {}, 'watchlist is not your ratings'), ': only titles you explicitly starred (1–10) are in the ratings export. A watchlist or list export has no "Your Rating" column and will be turned away here with an explanation. 1–10 scores become 0.5–5 stars.'],
      },
      phone: {
        steps: [
          ['IMDb\'s export lives on the ', h('strong', {}, 'desktop website'), ' — the app doesn\'t offer it.'],
          ['Reliable path: export on a computer (steps under "On a computer"), then email or AirDrop the CSV to your phone and upload it here.'],
          ['Or skip the export and rate films right here — search above, or quick-rate 20.'],
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
      h('div', { class: 'import-warn' }, '⚠︎ ', ...g.warn),
      h('div', { class: 'row-gap wrap' },
        h('button', { class: 'btn', onClick: () => fileInput.click() }, '⬆ Upload ratings.csv'),
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
  page.appendChild(sectionTitle('Rate movies', 'Every rating sharpens your picks'));
  page.appendChild(input);
  page.appendChild(results);

  page.appendChild(sectionTitle('Bring your ratings from Letterboxd or IMDb',
    'A one-time file upload — nothing connects to your account'));
  page.appendChild(h('div', { class: 'import-split' },
    h('div', { class: 'import-box' },
      h('h4', {}, '⭐ Rate right here'),
      h('div', { class: 'muted small' }, 'No export needed. Search above, or run a quick tap-through of 20 popular films.'),
      h('div', {}, h('a', { class: 'btn ghost', href: '#/onboarding' }, '⚡ Quick rate 20')),
    ),
    h('div', { class: 'import-box' },
      h('h4', {}, '⬆ Upload an export'),
      h('div', { class: 'muted small' }, 'Already rated films on Letterboxd or IMDb? Bring them over as a CSV.'),
      h('div', {}, toggleGuide),
    ),
  ));
  page.appendChild(guide);
  page.appendChild(resultPanel);
  page.appendChild(fileInput);

  // ---- Your ratings --------------------------------------------------------
  const recentWrap = h('div', {});
  page.appendChild(recentWrap);

  async function loadRecent() {
    const { ratings } = await api.ratings();
    clear(recentWrap);
    recentWrap.appendChild(sectionTitle('Your ratings', `${ratings.length} total`));
    if (!ratings.length) {
      recentWrap.appendChild(h('div', { class: 'muted pad' }, 'No ratings yet.'));
      return;
    }
    const list = h('div', { class: 'rating-list' });
    for (const r of ratings.slice(0, 60)) {
      list.appendChild(h('div', { class: 'rating-item' },
        r.poster ? h('img', { class: 'ri-poster', src: r.poster, alt: '', loading: 'lazy' }) : h('div', { class: 'ri-poster ph' }),
        h('div', { class: 'ri-info' },
          h('a', { class: 'ri-title', href: `#/movie/${r.tmdb_id}` }, `${r.title || 'Untitled'}${r.year ? ` (${r.year})` : ''}`),
          h('div', { class: 'muted small' }, r.source),
        ),
        makeStars({ value: r.rating, interactive: true, size: 18, allowClear: true, onChange: (v) => rateMovie(r, v) }),
        h('button', { class: 'link-btn', title: 'Remove', onClick: async () => {
          await api.unrate(r.tmdb_id);
          toast('Removed');
          ctx.refreshStatus();
          loadRecent();
        } }, '✕'),
      ));
    }
    recentWrap.appendChild(list);
  }

  root.replaceChildren(page);
  loadRecent();
}
