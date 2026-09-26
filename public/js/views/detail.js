// Movie detail: hero, rating, score breakdown, showtimes, trailer.
import { api } from '../api.js';
import { h, clear, spinner, scorePill, badge, makeStars, toast, openModal, scoreColor, icon } from '../ui.js';
import { fmtRuntime, dayLabel, showtimeChip, watchlistButton, starRater, runwayBadge, handoffLine, backBadge, heroMedia, opensBadge } from './components.js';

export async function render(root, params, ctx) {
  clear(root);
  root.appendChild(spinner('Loading…'));
  const d = await api.movie(params[0]);
  const m = d.movie;
  clear(root);
  const guest = ctx.isGuest?.();

  const page = h('div', { class: 'detail' });

  // Hero: the same backdrop-and-scrim treatment as the #1 pick, so the title
  // and metadata always sit on a dark, readable ground.
  const trailer = m.trailer_key ? h('div', { class: 'trailer-wrap', id: 'trailer' }, h('div', { class: 'trailer' },
    h('iframe', {
      src: `https://www.youtube-nocookie.com/embed/${m.trailer_key}`,
      title: `${m.title} trailer`, allow: 'accelerometer; autoplay; clipboard-write; compute-pressure; encrypted-media; gyroscope; picture-in-picture',
      allowfullscreen: true, loading: 'lazy',
    }),
  )) : null;
  if (trailer) watchFrameFocus(trailer);
  const meta = [m.year, fmtRuntime(m.runtime), m.mpaa].filter(Boolean);
  page.appendChild(h('section', { class: 'detail-hero', 'aria-labelledby': 'detail-title' },
    heroMedia(m),
    h('div', { class: 'hero-content' },
      h('div', { class: 'eyebrow' },
        h('span', { class: `eyebrow-score ${scoreColor(d.final)}`, title: d.flags?.noScores ? 'No public scores yet. This number uses a neutral 50 for reviews.' : 'Match score' },
          `${d.final ?? '-'} ${guest ? 'match' : 'your match'}`),
        d.flags?.noScores ? h('span', { class: 'eyebrow-dot' }, ' · no public scores yet') : null,
      ),
      h('h1', { class: 'hero-title', id: 'detail-title' }, m.title),
      h('div', { class: 'hero-facts' },
        meta.length ? h('span', {}, meta.join(' · ')) : null,
        d.flags?.imax ? badge('IMAX', 'imax') : null,
        d.playing ? backBadge(m) : null,
        opensBadge(d),
      ),
      (m.genres || []).length || m.director
        ? h('div', { class: 'hero-facts muted' }, [(m.genres || []).join(', '), m.director ? `Directed by ${m.director}` : null].filter(Boolean).join(' · '))
        : null,
      d.reason ? h('p', { class: 'hero-reason' }, d.reason) : null,
      h('div', { class: 'hero-actions' },
        guest ? null : watchlistButton({ tmdb_id: m.tmdb_id, title: m.title, watchlisted: d.watchlisted }, ctx),
        trailer ? h('button', {
          class: 'chip-btn', type: 'button',
          onClick: () => trailer.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }),
        }, icon('play', { size: 16 }), 'Trailer') : null,
      ),
    ),
  ));

  // Rate + A-List (owner only)
  if (!guest) page.appendChild(ratingRow(d, m, ctx));

  // Score breakdown
  const owner = guest ? (ctx.getStatus()?.ownerName || 'the owner') : null;
  page.appendChild(h('div', { class: 'cards-2' }, publicCard(d), tasteCard(d, owner)));

  // Showtimes first, then the trailer: booking is the thing people come for.
  page.appendChild(showtimesSection(d, ctx));
  if (trailer) page.appendChild(trailer);

  // Synopsis + cast
  if (m.synopsis) page.appendChild(h('p', { class: 'synopsis' }, m.synopsis));
  if ((m.cast || []).length) {
    page.appendChild(h('div', { class: 'cast' }, h('span', { class: 'muted small' }, 'Starring '), (m.cast || []).slice(0, 6).join(', ')));
  }

  root.appendChild(page);
}

function ratingRow(d, m, ctx) {
  const label = h('span', { class: 'muted' }, d.myRating ? 'Your rating' : 'Rate it');
  const stars = starRater(m, ctx, {
    value: d.myRating || 0,
    size: 30,
    onRated: (v) => { label.textContent = v ? 'Your rating' : 'Rate it'; },
  });

  const seenBtn = h('button', { class: 'btn ghost', type: 'button' }, icon('ticket', { size: 16 }), 'Mark seen (A-List)');
  seenBtn.addEventListener('click', async () => {
    try {
      const wk = await api.markWatched({ tmdb_id: m.tmdb_id, title: m.title });
      toast(`Logged. ${wk.used} of ${wk.limit} A-List this week.`, 'success');
      ctx.refreshStatus();
    } catch (e) { toast(e.message, 'error'); }
  });

  return h('div', { class: 'rating-row' },
    h('div', { class: 'rr-left' }, label, stars),
    seenBtn,
  );
}

function publicCard(d) {
  const p = d.public || {};
  const disp = p.display || {};
  const rows = [];
  if (disp.rt != null) rows.push(sourceRow('Rotten Tomatoes', `${disp.rt}%`, disp.rt));
  if (disp.metacritic != null) rows.push(sourceRow('Metacritic', `${disp.metacritic}`, disp.metacritic));
  if (disp.imdb != null) rows.push(sourceRow('IMDb', `${disp.imdb}/10`, disp.imdb * 10));
  if (disp.tmdb != null) rows.push(sourceRow('TMDB', `${disp.tmdb.toFixed(1)}/10`, disp.tmdb * 10));

  const checked = p.omdbCheckedAt ? new Date(p.omdbCheckedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
  return h('div', { class: 'stat-card' },
    h('div', { class: 'stat-head' }, h('h3', {}, 'Public score'), scorePill(p.combined)),
    d.flags?.settling ? badge('Scores still settling (new release)', 'settling') : null,
    p.divergence ? h('div', { class: 'diverge-note' }, icon('alert', { size: 14 }), ` ${p.divergence.label} (${p.divergence.gap} pts apart)`) : null,
    rows.length ? h('div', { class: 'sources' }, ...rows) : h('div', { class: 'muted small' }, 'No public scores found yet.'),
    p.noOmdbRecord
      ? h('div', { class: 'muted small' }, `No IMDb, Rotten Tomatoes or Metacritic scores for this title${checked ? ` (checked ${checked})` : ''}. ${rows.length ? 'TMDB is the only source.' : 'The match score uses a neutral 50 for reviews.'}`)
      : null,
    p.tmdbIgnored
      ? h('div', { class: 'muted small' }, p.tmdbIgnored.reason === 'unreleased'
        ? `TMDB's ${Number(p.tmdbIgnored.rating).toFixed(1)} isn't counted until it opens${p.tmdbIgnored.opens ? ` on ${new Date(`${p.tmdbIgnored.opens}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}.`
        : `TMDB's ${Number(p.tmdbIgnored.rating).toFixed(1)} rests on ${p.tmdbIgnored.votes} vote${p.tmdbIgnored.votes === 1 ? '' : 's'}, too few to count yet.`)
      : null,
    p.critic != null && p.audience != null
      ? h('div', { class: 'muted small' }, `Critics ${p.critic} · Audience ${p.audience}`) : null,
  );
}

function sourceRow(name, valueText, norm) {
  return h('div', { class: 'source-row' },
    h('span', { class: 'src-name' }, name),
    h('div', { class: 'src-bar' }, h('div', { class: `src-fill ${scoreColor(norm)}`, style: { width: `${norm}%` } })),
    h('span', { class: 'src-val' }, valueText),
  );
}

// `owner` is set on the guest link: copy switches to the third person.
function tasteCard(d, owner = null) {
  const t = d.taste || {};
  const factors = [];
  (t.genres || []).forEach((g) => factors.push(factorRow(g.name, g.avg, g.n)));
  if (t.director) factors.push(factorRow(`Director: ${t.director.name}`, t.director.avg, t.director.n));
  (t.actors || []).slice(0, 3).forEach((a) => factors.push(factorRow(a.name, a.avg, a.n)));

  const n = d.profile?.count ?? 0;
  const lowData = d.profile?.lowData
    ? (owner ? `Based on ${n} of ${owner}'s rating${n === 1 ? '' : 's'}.` : `Based on ${n} rating${n === 1 ? '' : 's'}. Add more to sharpen this.`)
    : null;
  return h('div', { class: 'stat-card' },
    h('div', { class: 'stat-head' }, h('h3', {}, 'Taste match'), scorePill(t.score)),
    lowData ? h('div', { class: 'muted small' }, lowData) : null,
    factors.length ? h('div', { class: 'factors' }, ...factors)
      : h('div', { class: 'muted small' }, owner ? `No overlap with ${owner}'s ratings yet.` : 'No overlap with your ratings yet.'),
  );
}

function factorRow(name, avg, n) {
  return h('div', { class: 'factor-row' },
    h('span', { class: 'factor-name' }, name),
    makeStars({ value: avg, size: 13 }),
    h('span', { class: 'factor-n' }, `${avg.toFixed(1)} · ${n}×`),
  );
}

function dayBlocks(showtimesByDay) {
  return showtimesByDay.map((day) => h('div', { class: 'day-block' },
    h('div', { class: 'day-label' }, `${dayLabel(day.date)} · ${new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`),
    h('div', { class: 'day-times' }, ...day.showtimes.map((st) => showtimeChip(st))),
  ));
}

// Every published showtime, per followed theatre, each with its own runway.
// With a single theatre this is the same flat day list as before.
function showtimesSection(d, ctx) {
  const wrap = h('div', { class: 'showtimes' }, h('h3', {}, 'Showtimes'));
  const groups = d.showtimesByTheatre || (d.showtimesByDay?.length ? [{ theatre: null, runway: d.runway, showtimesByDay: d.showtimesByDay }] : []);
  if (d.handoff) wrap.appendChild(handoffLine(d));
  if (!groups.length) {
    const guest = ctx.isGuest?.();
    wrap.appendChild(h('div', { class: 'muted' },
      d.playing ? (guest ? 'No showtimes listed.' : 'No showtimes listed. AMC isn\'t connected.')
        : guest ? 'Not in the current lineup.'
        : `Not currently playing at your theatre${d.multiTheatre ? 's' : ''}.`));
  } else if (!d.multiTheatre) {
    const g = groups[0];
    if (g.runway) {
      wrap.appendChild(h('div', { class: 'runway-head' }, runwayBadge(g.runway),
        g.runway.detail && !g.runway.urgent ? h('span', { class: 'muted small' }, `. ${g.runway.detail}`) : null));
    }
    wrap.append(...dayBlocks(g.showtimesByDay));
  } else {
    for (const g of groups) {
      wrap.appendChild(h('div', { class: 'theatre-block' },
        h('div', { class: 'theatre-head' },
          h('span', { class: 'theatre-title' }, g.theatre.short, g.theatre.isPrimary ? h('span', { class: 'muted small' }, ' · primary') : null),
          g.theatre.distance ? h('span', { class: 'muted small' }, g.theatre.distance.label) : null,
          runwayBadge(g.runway),
        ),
        g.runway?.detail && !g.runway.urgent ? h('div', { class: 'muted small' }, g.runway.detail) : null,
        ...dayBlocks(g.showtimesByDay),
      ));
    }
  }
  // Any matched movie can be re-pointed, not just low-confidence ones: a
  // confident-but-wrong match ("Idiots" → a 1998 film) needs a way out too.
  if (d.match && ctx.isOwner?.()) {
    wrap.appendChild(h('button', { class: 'link-btn', onClick: () => openFixMatch(d, ctx) },
      d.match.low
        ? `Wrong movie? Matched to AMC's "${d.match.amc_title}" with low confidence. Fix it`
        : `Matched to AMC's "${d.match.amc_title}". Wrong movie? Fix it`));
  }
  return wrap;
}

function openFixMatch(d, ctx) {
  const results = h('div', { class: 'fix-results' });
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Search the correct movie…' });
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (!q) return clear(results);
      try {
        const { results: found } = await api.searchRatings(q);
        clear(results);
        found.slice(0, 8).forEach((r) => {
          results.appendChild(h('button', { class: 'fix-item', onClick: async () => {
            try {
              await api.setMatch({ amc_movie_id: d.match.amc_movie_id, amc_title: d.match.amc_title, tmdb_id: r.tmdb_id });
              toast('Match fixed', 'success');
              modal.close();
              ctx.navigate(`#/movie/${r.tmdb_id}`);
            } catch (e) { toast(e.message, 'error'); }
          } },
          r.poster ? h('img', { src: r.poster, alt: '' }) : h('div', { class: 'fix-noposter' }),
          h('span', {}, `${r.title}${r.year ? ` (${r.year})` : ''}`)));
        });
      } catch (e) { toast(e.message, 'error'); }
    }, 300);
  });
  const modal = openModal(h('div', {}, input, results), { title: 'Fix movie match' });
  input.focus();
}

// Tabbing into the YouTube frame: the browser moves focus into the frame's own
// document, so the frame never matches :focus and fires no focus event here;
// the page only sees its window lose focus. Right after a Tab key that means
// the frame took it: ring it and bring all of it into view (it could otherwise
// sit under the tab bar). Clicking into the player shows no ring.
function watchFrameFocus(wrap) {
  const frame = wrap.querySelector('iframe');
  let tabAt = 0;
  const onKey = (e) => { if (e.key === 'Tab') tabAt = Date.now(); };
  const onBlur = () => setTimeout(() => {
    if (document.activeElement !== frame || Date.now() - tabAt > 500) return;
    frame.classList.add('kb-focus');
    wrap.scrollIntoView({ block: 'nearest' });
  }, 0);
  const onFocus = () => frame.classList.remove('kb-focus');
  document.addEventListener('keydown', onKey);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  window.addEventListener('hashchange', () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
  }, { once: true });
}
