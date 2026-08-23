// Home: "Your 4 this week" + leaving-soon alerts + the full ranked lineup.
import { api } from '../api.js';
import { h, clear, spinner, emptyState, badge, sectionTitle } from '../ui.js';
import { weeklyCard, movieRow, posterTile, lastChanceCard, dayPicker } from './components.js';

export async function render(root, params, ctx) {
  clear(root);
  root.appendChild(spinner(ctx.isGuest?.() ? 'Loading picks…' : 'Loading your picks…'));
  const status = ctx.getStatus() || (await ctx.refreshStatus());

  // No TMDB key yet → nothing to rank. Guide setup.
  if (status && !status.keys.tmdb) {
    clear(root);
    root.appendChild(setupCard(ctx));
    return;
  }

  const data = await api.recommendations();
  clear(root);
  const page = h('div', { class: 'page' });

  // Onboarding nudge when the taste profile is thin.
  if (status && !status.onboardingDone && data.profile.count < 10) {
    page.appendChild(onboardingBanner(ctx));
  }

  if (!data.list.length) {
    // Guests can't refresh (read-only), so no setup copy and no button.
    page.appendChild(ctx.isGuest?.()
      ? emptyState('🎬', 'Nothing loaded yet', 'Check back after the next refresh.')
      : emptyState('🎬', 'No movies loaded yet',
        status?.keys?.amc ? 'Tap refresh to pull showtimes from your theatre.' : 'Add your keys, then refresh to load what\'s playing.',
        h('button', { class: 'btn', onClick: () => ctx.triggerRefresh() }, '↻ Refresh now')));
    root.appendChild(page);
    return;
  }

  // Day picker drives every showtime on the page. Defaults to today, or the
  // first published day if today's schedule is already over.
  const days = data.days || [];
  let day = days[0]?.date || null;

  // Last chance — only rendered when something genuinely qualifies, so it isn't
  // sitting empty on the weeks when nothing is leaving.
  const lastChance = data.lastChance || [];
  if (lastChance.length) {
    page.appendChild(sectionTitle('Last chance',
      `Leaving ${data.theatre?.name || 'your theatre'} soon`));
    const lcGrid = h('div', { class: 'lc-grid' });
    lastChance.forEach((e) => lcGrid.appendChild(lastChanceCard(e, ctx)));
    page.appendChild(lcGrid);
  }

  if (days.length) page.appendChild(dayPicker(days, day, (d) => { day = d; paint(); }));

  // Weekly 4.
  const guest = Boolean(ctx.isGuest?.());
  const owner = status?.ownerName || 'Owner';
  page.appendChild(sectionTitle(guest ? `${owner}'s 4 this week` : 'Your 4 this week',
    data.profile.lowData && !guest ? 'Leaning on public scores — rate more to personalize' : `${data.theatre?.name || ''}`));

  const pickGrid = h('div', { class: 'pick-grid' });
  if (data.weekly4.length) {
    page.appendChild(pickGrid);
  } else {
    page.appendChild(h('div', { class: 'muted pad' }, 'Nothing to recommend — you may have rated or filtered everything playing.'));
  }

  if (data.playingSource === 'tmdb') {
    page.appendChild(h('div', { class: 'note' },
      'Showtimes unavailable (no AMC data) — ranking TMDB\'s current US releases instead.'));
  }

  // Everything else clearing the good-match bar, so the page isn't capped at four.
  const worth = data.worthSeeing || [];
  const worthList = h('div', { class: 'list' });
  if (worth.length) {
    page.appendChild(sectionTitle('Also worth seeing',
      `${worth.length} more scoring ${data.goodMatchMinScore}+`));
    page.appendChild(worthList);
  }

  // Movies only at another followed theatre this week. Never part of the
  // ranking above, and absent entirely when a single theatre is followed.
  const multi = Boolean(data.multiTheatre);
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
  let collapsed = Boolean(status?.everythingPlayingCollapsed);
  const listWrap = h('div', { class: 'list' });
  const collapseBtn = h('button', { class: 'chip-btn section-toggle', type: 'button' });
  const paintCollapse = () => {
    listWrap.hidden = collapsed;
    collapseBtn.textContent = collapsed ? `Show all ${data.list.length}` : 'Hide';
  };
  collapseBtn.addEventListener('click', async () => {
    collapsed = !collapsed;
    paintCollapse();
    if (ctx.isGuest?.()) return;
    try { await api.saveSettings({ everythingPlayingCollapsed: collapsed }); } catch { /* local toggle still applies */ }
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
      `${unmatched} AMC title${unmatched > 1 ? 's' : ''} ${unmatched > 1 ? 'are' : 'is'} missing from this list — couldn't be matched to TMDB. `,
      h('a', { class: 'note-link', href: '#/settings' }, 'Match them in Settings →')));
  }
  page.appendChild(listWrap);

  // Re-render just the rows when the selected day changes.
  function paint() {
    clear(pickGrid);
    data.weekly4.forEach((e, i) => pickGrid.appendChild(weeklyCard(e, ctx, i + 1, { day, multi })));
    clear(worthList);
    worth.forEach((e) => worthList.appendChild(movieRow(e, ctx, { day, multi })));
    clear(nearbyList);
    nearby.forEach((e) => nearbyList.appendChild(movieRow(e, ctx, { day, multi, nearby: true })));
    clear(listWrap);
    data.list.forEach((e) => listWrap.appendChild(movieRow(e, ctx, { day, compact: true, multi })));
  }
  paint();
  paintCollapse();

  root.appendChild(page);
}

function onboardingBanner(ctx) {
  return h('div', { class: 'banner' },
    h('div', {},
      h('div', { class: 'banner-title' }, '⭐ Build your taste profile'),
      h('div', { class: 'banner-sub' }, 'Rate ~20 movies in a quick flow so your picks get personal.'),
    ),
    h('a', { class: 'btn', href: '#/onboarding' }, 'Start'),
  );
}

function setupCard(ctx) {
  return h('div', { class: 'page' },
    emptyState('🔑', 'Welcome to Reel Picks',
      'Add your TMDB (and optionally OMDb + AMC) API keys to start ranking what\'s playing.',
      h('div', { class: 'row-gap' },
        h('a', { class: 'btn', href: '#/settings' }, 'Open Settings'),
        h('button', { class: 'btn ghost', onClick: () => ctx.triggerRefresh() }, 'Try refresh'),
      )),
    h('div', { class: 'help-card' },
      h('h3', {}, 'Where keys go'),
      h('p', {}, 'Paste them into the ', h('code', {}, '.env'), ' file in the project root, then restart or hit refresh:'),
      h('pre', {}, 'TMDB_API_KEY=...\nOMDB_API_KEY=...\nAMC_API_KEY=...'),
    ),
  );
}
