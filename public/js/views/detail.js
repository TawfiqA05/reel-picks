// Movie detail: hero, rating, score breakdown, showtimes, trailer.
import { api } from '../api.js';
import { h, clear, spinner, scoreNum, matchBadge, badge, makeStars, toast, openModal, icon, money } from '../ui.js';
import { planOf, planWords, loggedLine } from '../plans.js';
import { streamSection } from '../stream.js';
import { dayLabel, showtimeRow, watchlistButton, starRater, runwayLine, handoffLine, heroMedia, filmTags, reasonLine, metaLine } from './components.js';

export async function render(root, params, ctx) {
  clear(root);
  root.appendChild(spinner('Loading…'));
  const guest = ctx.isGuest?.();
  // This week's watch log, for "Seen · Undo" (the same log Stats lists).
  const [d, week] = await Promise.all([api.movie(params[0]), guest ? null : api.alist().catch(() => null)]);
  const m = d.movie;
  clear(root);
  // Dark theme: the film's poster colour glows behind the top of the page.
  ctx.setGlow?.(m.glow ?? null);

  const page = h('div', { class: 'detail' });

  // Hero: the same art treatment as the #1 pick.
  const tags = filmTags({ ...d, ...m, flags: d.flags, runway: d.playing ? d.runway : null, year: d.playing ? m.year : null, prerelease: d.prerelease }, { max: 4, noScores: false });
  tags?.classList.add('one-line');
  page.appendChild(h('section', { class: 'detail-hero', 'aria-labelledby': 'detail-title' },
    heroMedia(m),
    h('div', { class: 'hero-content' },
      h('div', { class: 'hero-line' }, matchBadge(d.final, { early: d.flags?.noScores })),
      h('h1', { class: 'hero-title', id: 'detail-title' }, m.title),
      metaLine(m) ? h('p', { class: 'hero-meta' }, metaLine(m)) : null,
      (m.genres || []).length || m.director
        ? h('p', { class: 'hero-meta' }, [(m.genres || []).join(', '), m.director ? `Directed by ${m.director}` : null].filter(Boolean).join(' · '))
        : null,
      tags,
      reasonLine(d, ctx, { cls: 'reason-line hero-reason', lastChance: d.runway?.urgent }),
      (!guest || m.trailer_key) ? h('div', { class: `detail-actions${guest || !m.trailer_key ? ' one' : ''}` },
        guest ? null : watchlistButton({ tmdb_id: m.tmdb_id, title: m.title, watchlisted: d.watchlisted }, ctx, { words: true }),
        m.trailer_key ? h('button', {
          class: 'btn soft', type: 'button', 'aria-haspopup': 'dialog',
          onClick: () => openTrailer(m),
        }, icon('play', { size: 16 }), 'Trailer') : null,
      ) : null,
    ),
  ));

  // Rate + Mark seen, worded for the user's movie plan (not the guest)
  if (!guest) page.appendChild(ratingRow(d, m, ctx, week));

  page.appendChild(showtimesSection(d, ctx));

  // Score breakdown
  const owner = guest ? (ctx.getStatus()?.ownerName || 'the owner') : null;
  page.appendChild(h('div', { class: 'score-groups' }, publicCard(d), tasteCard(d, owner)));

  // Where to stream it in the US. Not on the guest link, which can't ask TMDB.
  if (!guest) page.appendChild(streamSection(m.tmdb_id));

  // Synopsis, then who made it: each name opens their person page.
  const cast = (m.cast || []).slice(0, 6);
  if (m.synopsis || cast.length || m.director) {
    page.appendChild(h('section', { class: 'group about', 'aria-labelledby': 'about-title' },
      h('h2', { class: 'group-title', id: 'about-title' }, 'About'),
      m.synopsis ? h('p', { class: 'synopsis' }, m.synopsis) : null,
      m.director ? creditLine('Directed by', [{ name: m.director, id: m.director_id }]) : null,
      cast.length ? creditLine('Starring', cast.map((name, i) => ({ name, id: m.cast_ids?.[i] }))) : null));
  }

  root.appendChild(page);
}

// "Starring" and its names, each a link to the person's page when TMDB's id
// for them is stored (a film fetched before ids were kept shows plain names
// until its details refresh).
function creditLine(label, people) {
  return h('div', { class: 'credit-line' },
    h('span', { class: 'credit-label muted' }, label),
    h('ul', { class: 'person-links', 'aria-label': label },
      ...people.map((p) => h('li', {}, p.id
        ? h('a', { class: 'person-link', href: `#/person/${p.id}` }, p.name)
        : h('span', { class: 'person-link static' }, p.name)))));
}

function ratingRow(d, m, ctx, week) {
  const stars = starRater(m, ctx, { value: d.myRating || 0, size: 30 });
  const seenSlot = h('div', { class: 'seen-slot' });

  // Marked seen: "Seen · Undo", with the watch-log entry it undoes. Otherwise
  // the Mark seen button. `focus` moves focus to the new control after a
  // press, so a keyboard user isn't left on a button that just went away.
  const paint = (entry, { focus = false } = {}) => {
    clear(seenSlot);
    if (entry) {
      const undo = h('button', { class: 'link-btn seen-undo', type: 'button', 'aria-label': `Undo marking ${m.title} seen` }, 'Undo');
      undo.addEventListener('click', async () => {
        undo.disabled = true;
        try {
          await api.undoWatched(entry.id);
          toast('Taken off your watch log', 'success');
          paint(null, { focus: true });
          ctx.refreshStatus();
        } catch (e) { undo.disabled = false; toast(e.message, 'error'); }
      });
      seenSlot.append(h('span', { class: 'seen-state' }, icon('check', { size: 16 }), 'Seen'), undo);
      if (focus) undo.focus();
      return;
    }
    const seenBtn = h('button', { class: 'btn soft', type: 'button' }, icon('ticket', { size: 16 }), planWords(week?.plan || planOf({})).markSeen);
    seenBtn.addEventListener('click', async () => {
      seenBtn.disabled = true;
      try {
        const wk = await api.markWatched({ tmdb_id: m.tmdb_id, title: m.title });
        toast(loggedLine(wk, money), 'success');
        paint(wk.movies.find((x) => x.tmdb_id === m.tmdb_id), { focus: true });
        ctx.refreshStatus();
      } catch (e) { seenBtn.disabled = false; toast(e.message, 'error'); }
    });
    seenSlot.append(seenBtn);
    if (focus) seenBtn.focus();
  };
  paint(week?.movies?.find((x) => x.tmdb_id === m.tmdb_id));

  return h('section', { class: 'group', 'aria-labelledby': 'rating-title' },
    h('h2', { class: 'group-title', id: 'rating-title' }, 'Your rating'),
    h('div', { class: 'group-body' }, h('div', { class: 'row-line rating-row' }, stars, seenSlot)));
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
  const notes = [
    d.flags?.settling ? 'Scores are still settling: it\'s a new release.' : null,
    p.divergence ? `${p.divergence.label} (${p.divergence.gap} points apart).` : null,
    p.noOmdbRecord ? `No IMDb, Rotten Tomatoes or Metacritic scores for this title${checked ? ` (checked ${checked})` : ''}. ${rows.length ? 'TMDB is the only source.' : 'The match uses a neutral 50 for reviews.'}` : null,
    p.tmdbIgnored
      ? (p.tmdbIgnored.reason === 'unreleased'
        ? `TMDB's ${Number(p.tmdbIgnored.rating).toFixed(1)} isn't counted until it opens${p.tmdbIgnored.opens ? ` on ${new Date(`${p.tmdbIgnored.opens}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}.`
        : `TMDB's ${Number(p.tmdbIgnored.rating).toFixed(1)} rests on ${p.tmdbIgnored.votes} vote${p.tmdbIgnored.votes === 1 ? '' : 's'}, too few to count yet.`)
      : null,
    p.critic != null && p.audience != null ? `Critics ${p.critic} · Audience ${p.audience}` : null,
  ].filter(Boolean);
  return h('section', { class: 'group', 'aria-labelledby': 'public-title' },
    h('div', { class: 'group-head' }, h('h2', { class: 'group-title', id: 'public-title' }, 'Public score'), scoreNum(p.combined)),
    h('div', { class: 'group-body' }, ...(rows.length ? rows : [h('p', { class: 'muted' }, 'No public scores found yet.')])),
    ...notes.map((n) => h('p', { class: 'group-foot' }, n)),
  );
}

function sourceRow(name, valueText, norm) {
  return h('div', { class: 'source-row' },
    h('span', { class: 'src-name' }, name),
    h('div', { class: 'src-bar', 'aria-hidden': 'true' }, h('div', { class: 'src-fill', style: { width: `${norm}%` } })),
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
  return h('section', { class: 'group', 'aria-labelledby': 'taste-title' },
    h('div', { class: 'group-head' }, h('h2', { class: 'group-title', id: 'taste-title' }, 'Taste match'), scoreNum(t.score)),
    h('div', { class: 'group-body' }, ...(factors.length ? factors
      : [h('p', { class: 'muted' }, owner ? `No overlap with ${owner}'s ratings yet.` : 'No overlap with your ratings yet.')])),
    lowData ? h('p', { class: 'group-foot' }, lowData) : null,
  );
}

function factorRow(name, avg, n) {
  return h('div', { class: 'factor-row' },
    h('span', { class: 'factor-name' }, name),
    makeStars({ value: avg, size: 13 }),
    h('span', { class: 'factor-n' }, `${avg.toFixed(1)} · ${n} rated`),
  );
}

// A day's showtimes as rows, under its own heading ("Today · Sep 27").
function dayBlocks(showtimesByDay) {
  return showtimesByDay.map((day) => h('div', { class: 'day-block' },
    h('h3', { class: 'day-label' }, `${dayLabel(day.date)} · ${new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`),
    h('div', { class: 'st-list' }, ...day.showtimes.map((st) => showtimeRow(st))),
  ));
}

// Every published showtime, per followed theater, each with its own runway.
// With a single theater this is the same flat day list as before.
function showtimesSection(d, ctx) {
  const wrap = h('section', { class: 'showtimes', id: 'showtimes', 'aria-labelledby': 'showtimes-title' },
    h('h2', { class: 'group-title', id: 'showtimes-title' }, 'Showtimes'));
  const groups = d.showtimesByTheatre || (d.showtimesByDay?.length ? [{ theatre: null, runway: d.runway, showtimesByDay: d.showtimesByDay }] : []);
  if (d.handoff) wrap.appendChild(handoffLine(d));
  if (!groups.length) {
    const guest = ctx.isGuest?.();
    wrap.appendChild(h('p', { class: 'muted' },
      d.playing ? (guest ? 'No showtimes listed.' : 'No showtimes listed. AMC isn\'t connected.')
        : guest ? 'Not in the current lineup.'
        : `Not playing at your theater${d.multiTheatre ? 's' : ''} right now.`));
  } else if (!d.multiTheatre) {
    const g = groups[0];
    if (g.runway) wrap.appendChild(runwayLine(g.runway));
    if (g.runway?.detail && !g.runway.urgent) wrap.appendChild(h('p', { class: 'muted small' }, `${g.runway.detail}.`));
    wrap.append(...dayBlocks(g.showtimesByDay));
  } else {
    for (const g of groups) {
      wrap.appendChild(h('div', { class: 'theatre-block' },
        h('div', { class: 'theatre-head' },
          h('h3', { class: 'theatre-title' }, g.theatre.short),
          g.theatre.isPrimary ? badge('Primary', 'accent') : null,
          g.theatre.distance ? h('span', { class: 'muted small' }, g.theatre.distance.label) : null,
        ),
        runwayLine(g.runway, { compact: true }),
        g.runway?.detail && !g.runway.urgent ? h('p', { class: 'muted small' }, `${g.runway.detail}.`) : null,
        ...dayBlocks(g.showtimesByDay),
      ));
    }
  }
  // Any matched movie can be re-pointed, not just low-confidence ones: a
  // confident-but-wrong match ("Idiots" to a 1998 film) needs a way out too.
  // "Matched to 'AMC's title' · Fix", with the last word, the dot and Fix
  // kept together so Fix never sits alone on a line.
  if (d.match && ctx.isOwner?.()) {
    const words = `'${d.match.amc_title}'`.split(' ');
    const last = words.pop();
    wrap.appendChild(h('p', { class: 'match-line' },
      `Matched to ${words.length ? `${words.join(' ')} ` : ''}`,
      h('span', { class: 'nowrap' }, `${last}${d.match.low ? ' (not sure)' : ''} · `,
        h('button', { class: 'link-btn match-fix', type: 'button', 'aria-label': `Fix the match for ${d.movie.title}`, onClick: () => openFixMatch(d, ctx) }, 'Fix'))));
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

// The trailer plays in a dialog, inside the app. It never starts on its own:
// the player waits for a tap on play. Closing it (X, Escape, a tap outside)
// takes the player out at once, so no sound carries on while the dialog fades,
// and focus goes back to the Trailer button.
function openTrailer(m) {
  const frame = h('iframe', {
    src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(m.trailer_key)}?rel=0&playsinline=1`,
    title: `${m.title} trailer`, allow: 'accelerometer; clipboard-write; compute-pressure; encrypted-media; gyroscope; picture-in-picture',
    allowfullscreen: true,
  });
  const wrap = h('div', { class: 'trailer-wrap' }, h('div', { class: 'trailer' }, frame));
  const stopRing = watchFrameFocus(wrap);
  openModal(wrap, {
    title: `${m.title}: trailer`,
    cls: 'trailer-overlay',
    onClose: () => { stopRing(); frame.src = 'about:blank'; frame.remove(); },
  });
}

// Tabbing into the YouTube frame: the browser moves focus into the frame's own
// document, so the frame never matches :focus and fires no focus event here;
// the page only sees its window lose focus. Right after a Tab key that means
// the frame took it: ring it. Clicking into the player shows no ring. Returns
// the function that stops watching.
function watchFrameFocus(wrap) {
  const frame = wrap.querySelector('iframe');
  let tabAt = 0;
  const ring = () => { if (document.activeElement === frame) frame.classList.add('kb-focus'); };
  // Also look right after the Tab itself: the window's blur can come late, or
  // not at all, on a busy device.
  const onKey = (e) => { if (e.key === 'Tab') { tabAt = Date.now(); setTimeout(ring, 50); } };
  const onBlur = () => setTimeout(() => {
    if (Date.now() - tabAt > 500) return;
    ring();
  }, 0);
  const onFocus = () => frame.classList.remove('kb-focus');
  document.addEventListener('keydown', onKey);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  return () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
  };
}
