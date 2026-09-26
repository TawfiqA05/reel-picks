// Home: "Your 4 this week" + leaving-soon alerts + the full ranked lineup.
import { api } from '../api.js';
import { h, clear, emptyState, sectionTitle, icon, toast } from '../ui.js';
import { weeklyCard, heroPick, movieRow, lastChanceCard, dayPicker, openHiddenList } from './components.js';
import { filterBox } from '../filter.js';

export async function render(root, params, ctx) {
  clear(root);
  root.appendChild(skeleton());
  const status = ctx.getStatus() || (await ctx.refreshStatus());

  // No TMDB key yet → nothing to rank. Guide setup (the owner only: a guest
  // gets a plain "check back" instead of instructions about .env files).
  if (status && !status.keys?.tmdb) {
    clear(root);
    root.appendChild(ctx.isGuest?.()
      ? emptyState('film', 'Nothing loaded yet', 'Check back after the next refresh.')
      : setupCard(ctx));
    return;
  }

  let data = await api.recommendations();
  // Page state that has to survive a re-render after a hide: the chosen day,
  // the collapse toggle, and which films just moved into the four.
  const state = {
    day: data.days?.[0]?.date || null,
    collapsed: Boolean(status?.everythingPlayingCollapsed),
    movedUp: new Set(),
  };

  const draw = () => {
    clear(root);
    root.appendChild(buildPage(data, status, ctx, state, actions));
  };
  // Re-fetch and redraw where the reader is, rather than via the router,
  // which would jump back to the top.
  const reload = async () => {
    const y = window.scrollY;
    data = await api.recommendations();
    draw();
    window.scrollTo(0, y);
  };

  const actions = {
    async hide(entry, card) {
      const before = new Set(data.weekly4.map((e) => e.tmdb_id));
      card?.classList.add('is-leaving');
      const fade = new Promise((r) => setTimeout(r, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220));
      try {
        await Promise.all([api.hide(entry.tmdb_id, entry.title), fade]);
      } catch (e) {
        card?.classList.remove('is-leaving');
        card?.querySelector('.not-for-me')?.removeAttribute('disabled');
        toast(e.message, 'error');
        return;
      }
      const entrants = [];
      try {
        const y = window.scrollY;
        data = await api.recommendations();
        entrants.push(...data.weekly4.filter((e) => !before.has(e.tmdb_id)));
        state.movedUp = new Set(entrants.map((e) => e.tmdb_id));
        draw();
        state.movedUp = new Set();
        window.scrollTo(0, y);
      } catch (e) {
        toast(e.message, 'error');
        return;
      }
      const next = before.has(entry.tmdb_id) && entrants[0] ? ` ${entrants[0].title} moved into your four.` : '';
      toast(`Hid ${entry.title}.${next}`, '', {
        action: { label: 'Undo', onClick: () => actions.unhide(entry, { undo: true }) },
      });
    },
    async unhide(entry, { undo = false } = {}) {
      try {
        await api.unhide(entry.tmdb_id);
        await reload();
        toast(undo ? `${entry.title} is back.` : `Unhid ${entry.title}.`);
      } catch (e) {
        toast(e.message, 'error');
      }
    },
  };

  draw();
}

function buildPage(data, status, ctx, state, actions) {
  const page = h('div', { class: 'page' });
  const guest = Boolean(ctx.isGuest?.());
  const onHide = guest ? null : actions.hide;
  const onUnhide = guest ? null : (e) => actions.unhide(e);

  // Onboarding nudge when the taste profile is thin.
  if (!guest && status && !status.onboardingDone && data.profile.count < 10) {
    page.appendChild(onboardingBanner(ctx));
  }

  if (!data.list.length) {
    // Guests can't refresh (read-only), so no setup copy and no button.
    page.appendChild(guest
      ? emptyState('film', 'Nothing loaded yet', 'Check back after the next refresh.')
      : emptyState('film', 'No movies loaded yet',
        status?.keys?.amc ? 'Tap refresh to pull showtimes from your theatre.' : 'Add your keys, then refresh to load what\'s playing.',
        h('button', { class: 'btn', onClick: () => ctx.triggerRefresh() }, icon('refresh', { size: 16 }), 'Refresh now')));
    return page;
  }

  // Day picker drives every showtime on the page. Defaults to today, or the
  // first published day if today's schedule is already over.
  const days = data.days || [];
  if (state.day && !days.some((d) => d.date === state.day)) state.day = days[0]?.date || null;

  // Weekly 4: the first pick is the hero, the day picker sits under it and
  // drives every showtime on the page, and the other three follow as cards.
  const owner = status?.ownerName || 'Owner';
  const heroSlot = h('div', { class: 'hero-slot' });
  const pickGrid = h('div', { class: 'pick-grid' });
  if (data.weekly4.length) page.appendChild(heroSlot);
  if (days.length) page.appendChild(dayPicker(days, state.day, (d) => { state.day = d; paint(); }));
  if (data.weekly4.length > 1) {
    page.appendChild(sectionTitle(guest ? `The rest of ${owner}'s four` : 'The rest of your four',
      data.profile.lowData && !guest ? 'Leaning on public scores. Rate more to make it yours.' : `${data.theatre?.name || ''}`));
  }
  if (data.weekly4.length) {
    page.appendChild(pickGrid);
  } else {
    page.appendChild(h('div', { class: 'muted pad' }, 'Nothing to recommend. You may have rated or filtered everything playing.'));
  }

  // Last chance — only rendered when something genuinely qualifies, so it isn't
  // sitting empty on the weeks when nothing is leaving.
  const lastChance = data.lastChance || [];
  if (lastChance.length) {
    page.appendChild(h('div', { class: 'section-head' },
      sectionTitle('Last chance', `Leaving ${data.theatre?.name || 'your theatre'} soon`),
      h('a', { class: 'section-link', href: '#/schedule/leaving' }, 'See the week', icon('arrowRight', { size: 16 })),
    ));
    const lcGrid = h('div', { class: 'lc-grid' });
    lastChance.forEach((e) => lcGrid.appendChild(lastChanceCard(e, ctx)));
    page.appendChild(lcGrid);
  }

  if (data.playingSource === 'tmdb') {
    page.appendChild(h('div', { class: 'note' }, guest
      ? 'Showtimes aren\'t available right now. These are this week\'s US releases.'
      : 'No AMC showtimes, so this ranks TMDB\'s current US releases instead.'));
  }

  // Everything else clearing the good-match bar, so the page isn't capped at four.
  const worth = data.worthSeeing || [];
  const worthList = h('div', { class: 'list worth-list' });
  if (worth.length) {
    page.appendChild(sectionTitle('Also worth seeing',
      `${worth.length} more scoring ${data.goodMatchMinScore}+`));
    page.appendChild(worthList);
  }
  // What "Not for me" took out, and the way back.
  const hiddenCount = guest ? 0 : (data.hiddenCount || 0);
  if (hiddenCount) {
    page.appendChild(h('div', { class: 'hidden-line' },
      `${hiddenCount} hidden · `,
      h('button', { class: 'link-btn', type: 'button', onClick: () => openHiddenList((m) => actions.unhide(m)) }, 'Show hidden')));
  }

  // Movies only at another followed theatre this week. Never part of the
  // ranking above, and absent entirely when a single theatre is followed.
  // How many theatres are followed, or 0 with just one (see theatreChips).
  const multi = data.multiTheatre ? (data.theatres || []).length : 0;
  const nearby = data.alsoNearby || [];
  const nearbyList = h('div', { class: 'list' });
  if (nearby.length) {
    const others = (data.theatres || []).filter((t) => !t.isPrimary).map((t) => t.short).join(' / ');
    page.appendChild(sectionTitle('Also nearby',
      `Not at ${data.theatre?.short || 'your theatre'} this week · ${others}`));
    page.appendChild(nearbyList);
  }

  // Full lineup — nothing disappears, whatever the cutoff is. Collapsible, and
  // the choice is remembered server-side (guests just toggle locally).
  const listWrap = h('div', { class: 'list playing-list' });
  const listFilter = filterBox({ label: 'Filter everything playing', placeholder: `Filter ${data.list.length} movies` });
  const collapseBtn = h('button', { class: 'chip-btn section-toggle', type: 'button' });
  const paintCollapse = () => {
    listWrap.hidden = state.collapsed;
    listFilter.el.hidden = state.collapsed;
    collapseBtn.textContent = state.collapsed ? `Show all ${data.list.length}` : 'Hide';
    collapseBtn.setAttribute('aria-expanded', String(!state.collapsed));
  };
  collapseBtn.addEventListener('click', async () => {
    state.collapsed = !state.collapsed;
    paintCollapse();
    if (guest) return;
    try { await api.saveSettings({ everythingPlayingCollapsed: state.collapsed }); } catch { /* local toggle still applies */ }
  });
  page.appendChild(h('div', { class: 'section-head' },
    sectionTitle('Everything playing', `${data.list.length} movies`),
    collapseBtn,
  ));
  // Titles AMC is showing that never matched a TMDB record aren't in this
  // list at all — say so here, where their absence would be noticed.
  const unmatched = guest ? 0 : (status?.counts?.unmatchedAmc || 0);
  if (unmatched) {
    page.appendChild(h('div', { class: 'note' },
      `${unmatched} AMC title${unmatched > 1 ? 's' : ''} ${unmatched > 1 ? 'are' : 'is'} missing from this list. ${unmatched > 1 ? 'They' : 'It'} couldn't be matched to TMDB. `,
      h('a', { class: 'note-link', href: '#/settings' }, 'Match in Settings')));
  }
  page.appendChild(listFilter.el);
  page.appendChild(listWrap);

  // Re-render just the rows when the selected day changes.
  function paint() {
    const { day } = state;
    const moved = (e) => state.movedUp.has(e.tmdb_id);
    clear(heroSlot);
    // The hero is the top pick you can actually go and see: a film that hasn't
    // opened yet (every showtime this week an early screening) is passed over
    // unless one of those screenings is within two days. It keeps its rank on
    // its card; nothing about the order changes.
    const four = data.weekly4.map((e, i) => ({ e, rank: i + 1 }));
    const heroAt = Math.max(0, four.findIndex(({ e }) => !e.prerelease || e.prerelease.soon));
    const hero = four[heroAt];
    if (hero) heroSlot.appendChild(heroPick(hero.e, ctx, { day, multi, onHide, movedUp: moved(hero.e), rank: hero.rank }));
    clear(pickGrid);
    four.filter((_, i) => i !== heroAt).forEach(({ e, rank }) => pickGrid.appendChild(weeklyCard(e, ctx, rank, { day, multi, onHide, movedUp: moved(e) })));
    clear(worthList);
    worth.forEach((e) => worthList.appendChild(movieRow(e, ctx, { day, multi, onHide, tools: true })));
    clear(nearbyList);
    nearby.forEach((e) => nearbyList.appendChild(movieRow(e, ctx, { day, multi, nearby: true, onHide })));
    clear(listWrap);
    const rows = data.list.map((e) => ({ el: movieRow(e, ctx, { day, compact: true, multi, onUnhide }), fields: [e.title] }));
    rows.forEach((r) => listWrap.appendChild(r.el));
    listFilter.set(rows); // a new day redraws the rows; whatever is typed still applies
  }
  paint();
  paintCollapse();
  return page;
}

// Placeholder shapes in the layout's own proportions while the picks load, so
// the page doesn't jump when they arrive.
function skeleton() {
  const card = () => h('div', { class: 'pick-card sk-card' },
    h('div', { class: 'sk poster-card' }),
    h('div', { class: 'pick-body' },
      h('div', { class: 'sk sk-line', style: { width: '70%', height: '22px' } }),
      h('div', { class: 'sk sk-line', style: { width: '40%' } }),
      h('div', { class: 'sk sk-line' }),
      h('div', { class: 'sk sk-line', style: { width: '85%' } }),
      h('div', { class: 'sk sk-line', style: { width: '60%', height: '40px', marginTop: 'auto' } }),
    ));
  return h('div', { class: 'page skeleton', 'aria-busy': 'true', 'aria-label': 'Loading picks' },
    h('div', { class: 'hero-pick sk-hero' },
      h('div', { class: 'hero-content' },
        h('div', { class: 'sk sk-line', style: { width: '180px' } }),
        h('div', { class: 'sk sk-line', style: { width: '70%', height: '56px' } }),
        h('div', { class: 'sk sk-line', style: { width: '45%' } }),
        h('div', { class: 'sk sk-line', style: { width: '85%' } }),
        h('div', { class: 'sk sk-line', style: { width: '200px', height: '44px' } }),
      )),
    h('div', { class: 'day-picker' }, ...Array.from({ length: 7 }, () => h('div', { class: 'sk day-btn' }))),
    h('div', { class: 'pick-grid' }, card(), card(), card()),
  );
}

function onboardingBanner(ctx) {
  return h('div', { class: 'banner' },
    h('div', {},
      h('div', { class: 'banner-title' }, 'Build your taste profile'),
      h('div', { class: 'banner-sub' }, 'Rate about 20 movies so your picks get personal.'),
    ),
    h('a', { class: 'btn', href: '#/onboarding' }, 'Start'),
  );
}

function setupCard(ctx) {
  return h('div', { class: 'page' },
    emptyState('key', 'Welcome to Reel Picks',
      'Add a TMDB key to start ranking what\'s playing. OMDb and AMC keys are optional.',
      h('div', { class: 'row-gap' },
        h('a', { class: 'btn', href: '#/settings' }, 'Open Settings'),
        h('button', { class: 'btn ghost', onClick: () => ctx.triggerRefresh() }, 'Try refresh'),
      )),
    h('div', { class: 'help-card' },
      h('h3', {}, 'Where keys go'),
      h('p', {}, 'Paste them into the ', h('code', {}, '.env'), ' file in the project root, then restart or refresh:'),
      h('pre', {}, 'TMDB_API_KEY=...\nOMDB_API_KEY=...\nAMC_API_KEY=...'),
    ),
  );
}
