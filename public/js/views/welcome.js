// First-run welcome setup, three short steps: pick your theater, rate at least
// ten films you've seen, and what the app does. It opens on its own for a new
// friend, and for anyone with fewer than MIN_RATINGS ratings, until they finish
// or skip it; that is stored per user (setupDone). The guest link never gets
// it (js/app.js). Every step can be skipped.
import { api } from '../api.js';
import { h, clear, spinner, toast, makeStars, icon } from '../ui.js';

export const MIN_RATINGS = 5; // under this many ratings, the setup opens on its own
const GOAL = 10;

export function needsSetup(status) {
  return Boolean(status && !status.guest && status.user && !status.setupDone && (status.counts?.ratings ?? 0) < MIN_RATINGS);
}

// Set by js/app.js: what happens once the setup is finished or skipped (the
// guided tour, then Picks).
let afterSetup = (ctx) => ctx.navigate('#/home');
export function onSetupDone(fn) { afterSetup = fn; }

const STEPS = ['Your theater', 'Rate 10 movies', 'How it works'];

export async function render(root, params, ctx) {
  const status = ctx.getStatus() || await ctx.refreshStatus();
  if (!status || status.guest) { ctx.navigate('#/home'); return; }
  // The header's tabs and buttons step aside while this is on screen.
  const shell = document.querySelector('.shell');
  shell?.classList.add('in-setup');
  window.addEventListener('hashchange', () => shell?.classList.remove('in-setup'), { once: true });

  let step = 0;
  let rated = status.counts?.ratings ?? 0;
  const mine = new Map(); // tmdb_id -> rating given here
  const page = h('div', { class: 'welcome' });
  const body = h('div', { class: 'welcome-card' });
  const stepLine = h('p', { class: 'wc-step' });
  const dots = h('ol', { class: 'wc-dots', 'aria-hidden': 'true' }, ...STEPS.map(() => h('li')));
  let finishing = false;
  const finish = async () => {
    if (finishing) return;
    finishing = true;
    try { await api.saveSettings({ setupDone: true }); } catch (e) { toast(e.message, 'error'); }
    await ctx.refreshStatus();
    afterSetup(ctx);
  };
  page.append(
    h('div', { class: 'wc-head' },
      h('div', {},
        h('h1', { class: 'wc-title' }, status.user?.isOwner ? 'Welcome to Reel Picks' : `Welcome, ${status.user?.name || 'friend'}`),
        stepLine),
      h('button', { class: 'link-btn wc-skip', type: 'button', onClick: finish }, 'Skip setup')),
    dots,
    body,
  );
  clear(root);
  root.appendChild(page);

  const go = (n) => {
    step = n;
    stepLine.textContent = `Step ${n + 1} of ${STEPS.length} · ${STEPS[n]}`;
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i <= n));
    clear(body);
    body.append(...[theaterStep, rateStep, summaryStep][n]());
    window.scrollTo(0, 0);
    // Keyboard and screen readers start at the new step's heading.
    body.querySelector('h2')?.focus({ preventScroll: true });
  };

  const foot = (...kids) => h('div', { class: 'wc-foot' }, ...kids);
  const back = () => h('button', { class: 'btn ghost', type: 'button', onClick: () => go(step - 1) }, 'Back');

  // ---- 1. theater
  function theaterStep() {
    const current = h('p', { class: 'wc-current' });
    const paintCurrent = () => {
      const t = ctx.getStatus()?.theatre;
      clear(current);
      if (t?.id) current.append(icon('check', { size: 16 }), 'Your theater: ', h('strong', {}, t.name));
      else current.append('No theater chosen yet.');
    };
    paintCurrent();
    const results = h('div', { class: 'wc-results', 'aria-live': 'polite' });
    const input = h('input', { class: 'input', type: 'search', placeholder: 'Theater name or city', 'aria-label': 'Search AMC theaters by name or city', autocomplete: 'off', enterkeyhint: 'search' });
    let timer;
    let ticket = 0;
    const search = async () => {
      clearTimeout(timer);
      const q = input.value.trim();
      const mineTicket = ++ticket;
      if (!q) { clear(results); return; }
      clear(results);
      results.appendChild(spinner('Searching…'));
      try {
        const { theatres } = await api.theatres(q);
        if (mineTicket !== ticket) return;
        clear(results);
        if (!theatres.length) { results.appendChild(h('p', { class: 'muted small' }, `No AMC theaters match "${q}".`)); return; }
        for (const t of theatres.slice(0, 8)) {
          const chosen = String(ctx.getStatus()?.theatre?.id) === String(t.id);
          const choose = h('button', { class: chosen ? 'btn ghost small' : 'btn small', type: 'button', disabled: chosen, 'aria-label': `Choose ${t.name}` }, chosen ? 'Chosen' : 'Choose');
          choose.addEventListener('click', async () => {
            choose.disabled = true;
            try {
              await api.setTheatre({ id: t.id, name: t.name, slug: t.slug });
              await ctx.refreshStatus();
              toast(`${t.name} is your theater`, 'success');
              paintCurrent();
              search();
            } catch (e) { choose.disabled = false; toast(e.message, 'error'); }
          });
          results.appendChild(h('div', { class: 'wc-row' },
            h('div', { class: 'wc-row-main' }, h('div', { class: 'wc-row-title' }, t.name), h('div', { class: 'muted small' }, [t.city, t.state].filter(Boolean).map(titleCase).join(', '))),
            choose));
        }
      } catch (e) {
        if (mineTicket !== ticket) return;
        clear(results);
        results.appendChild(h('p', { class: 'muted small' }, 'Theater search isn\'t available right now. You can choose one later in Settings.'));
      }
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
    return [
      h('h2', { tabindex: '-1' }, 'Pick your theater'),
      h('p', { class: 'wc-lead' }, 'Reel Picks ranks what\'s playing at your AMC. You can follow more theaters later in Settings.'),
      current,
      h('div', { class: 'row-gap' }, input, h('button', { class: 'btn', type: 'button', onClick: search }, 'Search')),
      results,
      foot(h('span'), h('button', { class: 'btn', type: 'button', onClick: () => go(1) }, 'Next')),
    ];
  }

  // ---- 2. ratings
  function rateStep() {
    const count = h('p', { class: 'wc-count', role: 'status' });
    const bar = h('div', { class: 'wc-bar' }, h('div', { class: 'wc-bar-fill' }));
    const next = h('button', { class: 'btn', type: 'button', onClick: () => go(2) }, 'Next');
    const skipStep = h('button', { class: 'link-btn', type: 'button', onClick: () => go(2) }, 'Skip this step');
    const paintCount = () => {
      const left = Math.max(0, GOAL - rated);
      count.textContent = left ? `${rated} rated · ${left} to go` : `${rated} rated. Nice, that's enough to start.`;
      bar.firstChild.style.transform = `scaleX(${Math.min(1, rated / GOAL)})`;
      next.disabled = rated < GOAL;
      skipStep.hidden = rated >= GOAL;
    };
    paintCount();

    const rate = async (m, v, stars) => {
      const before = mine.get(m.tmdb_id) ?? m.myRating ?? 0;
      try {
        if (v) await api.rate({ tmdb_id: m.tmdb_id, rating: v, title: m.title, year: m.year, poster: m.poster, genres: m.genres });
        else await api.unrate(m.tmdb_id);
        if (!before && v) rated++;
        if (before && !v) rated = Math.max(0, rated - 1);
        mine.set(m.tmdb_id, v);
        paintCount();
      } catch (e) { stars.setValue(before); toast(e.message, 'error'); }
    };
    const starsFor = (m) => {
      const stars = makeStars({ value: mine.get(m.tmdb_id) ?? m.myRating ?? 0, interactive: true, size: 22, allowClear: true, onChange: (v) => rate(m, v, stars) });
      stars.setAttribute('role', 'group');
      stars.setAttribute('aria-label', `Rate ${m.title}`);
      return stars;
    };

    // Search any film.
    const results = h('div', { class: 'wc-results' });
    const input = h('input', { class: 'input', type: 'search', placeholder: 'Search any movie', 'aria-label': 'Search a movie to rate', autocomplete: 'off', enterkeyhint: 'search' });
    let timer;
    let ticket = 0;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      const mineTicket = ++ticket;
      if (!q) { clear(results); return; }
      timer = setTimeout(async () => {
        try {
          const { results: found } = await api.searchRatings(q);
          if (mineTicket !== ticket) return;
          clear(results);
          if (!found.length) { results.appendChild(h('p', { class: 'muted small' }, 'No matches.')); return; }
          for (const r of found.slice(0, 6)) results.appendChild(filmRow(r));
        } catch (e) { toast(e.message, 'error'); }
      }, 300);
    });
    const filmRow = (m) => h('div', { class: 'wc-row wc-film' },
      m.poster ? h('img', { class: 'wc-thumb', src: m.poster.replace(/\/w\d+\//, '/w92/'), alt: '', loading: 'lazy', width: '40', height: '60' }) : h('span', { class: 'wc-thumb' }),
      h('div', { class: 'wc-row-main' }, h('div', { class: 'wc-row-title' }, m.title, m.year ? h('span', { class: 'muted' }, ` ${m.year}`) : null)),
      starsFor(m));

    // Well-known films to start with: the ones most people have seen.
    const popular = h('div', { class: 'wc-popular' }, spinner('Loading movies…'));
    api.onboardingMovies({ known: true }).then(({ movies }) => {
      clear(popular);
      if (!movies.length) { popular.remove(); return; }
      popular.append(...movies.slice(0, 18).map((m) => h('div', { class: 'wc-tile' },
        h('img', { class: 'wc-poster', src: m.poster, alt: '', loading: 'lazy' }),
        h('div', { class: 'wc-tile-title' }, m.title),
        starsFor(m))));
    }, () => popular.remove());

    // Import from Letterboxd or IMDb.
    const importNote = h('p', { class: 'wc-import-note', role: 'status' });
    const file = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true, 'aria-label': 'Ratings file' });
    const upload = h('button', { class: 'btn ghost', type: 'button', onClick: () => file.click() }, icon('upload', { size: 16 }), 'Upload ratings.csv');
    file.addEventListener('change', async () => {
      const f = file.files[0];
      file.value = '';
      if (!f) return;
      if (/\.zip$/i.test(f.name)) { importNote.textContent = `"${f.name}" is the whole ZIP. Unzip it and upload ratings.csv from inside.`; return; }
      upload.disabled = true;
      try {
        importNote.textContent = 'Reading the file…';
        const r = await api.importCsv(await f.text());
        if (r.emptyExport) { importNote.textContent = 'That file has no ratings in it.'; return; }
        if (r.format !== 'reelpicks' && r.matching) {
          const drainMoved = (s) => Boolean(s?.lastDrain && s.lastDrain.finishedAt !== (r.lastDrainAt || null));
          for (let i = 0; i < 120; i++) {
            const s = await api.status().catch(() => null);
            const pending = s?.counts?.unmatched ?? 0;
            if (s && !s.matching && (drainMoved(s) || !pending)) break;
            importNote.textContent = `Found ${r.received} ratings. Matching titles… ${pending} left.`;
            await new Promise((res) => setTimeout(res, 2000));
          }
        }
        const s = await ctx.refreshStatus();
        const before = rated;
        rated = Math.max(rated, s?.counts?.ratings ?? rated);
        importNote.textContent = `Imported ${Math.max(0, rated - before)} rating${rated - before === 1 ? '' : 's'}.`;
        paintCount();
      } catch (e) {
        importNote.textContent = `${e.message} Your ratings weren't changed.`;
      } finally { upload.disabled = false; }
    });

    return [
      h('h2', { tabindex: '-1' }, 'Rate 10 movies you\'ve seen'),
      h('p', { class: 'wc-lead' }, 'More ratings mean better picks. Rate anything you\'ve seen, old or new, and skip what you haven\'t.'),
      count, bar,
      h('div', { class: 'wc-search' }, input, results),
      h('div', { class: 'wc-import' },
        h('div', {},
          h('h3', {}, 'Rated movies on Letterboxd or IMDb?'),
          h('p', { class: 'muted small' }, 'Letterboxd: Settings, then Data, then Export your data; unzip it and upload ratings.csv. IMDb: Your Ratings, then the ⋮ menu, then Export.')),
        upload, file, importNote),
      h('h3', { class: 'wc-sub' }, 'Movies most people have seen'),
      popular,
      foot(back(), h('div', { class: 'wc-foot-end' }, skipStep, next)),
    ];
  }

  // ---- 3. what the app does
  function summaryStep() {
    const point = (name, text) => h('li', {}, h('span', { class: 'wc-icon' }, icon(name, { size: 18 })), h('span', {}, text));
    return [
      h('h2', { tabindex: '-1' }, 'How Reel Picks works'),
      h('p', { class: 'wc-big' }, 'Every week Reel Picks picks the 4 movies at your theaters you\'ll most likely love, based on your ratings and what critics think.'),
      h('ul', { class: 'wc-points' },
        point('star', 'Rate what you\'ve seen. Every rating makes next week\'s picks better.'),
        point('bookmark', 'Save movies to your Watchlist. They get a boost, and you hear before they leave.'),
        point('calendar', 'Schedule shows what\'s leaving soon and what\'s opening.')),
      foot(back(), h('button', { class: 'btn', type: 'button', onClick: finish }, 'See my picks')),
    ];
  }

  go(0);
}

const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
