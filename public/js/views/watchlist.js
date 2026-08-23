// Watchlist grid + leaving-soon alerts.
import { api } from '../api.js';
import { h, clear, spinner, emptyState, sectionTitle } from '../ui.js';
import { posterTile, watchlistButton, dayLabel } from './components.js';

export async function render(root, params, ctx) {
  clear(root);
  root.appendChild(spinner('Loading watchlist…'));
  const [{ movies }, recs] = await Promise.all([
    api.watchlist(),
    api.recommendations().catch(() => ({ leavingSoon: [] })),
  ]);
  clear(root);

  const page = h('div', { class: 'page' });
  page.appendChild(sectionTitle('Watchlist', `${movies.length} starred`));

  const leaving = (recs.leavingSoon || []).filter((m) => m.watchlisted);
  if (leaving.length) {
    page.appendChild(h('div', { class: 'alert' },
      h('span', { class: 'alert-icon' }, '⏳'),
      h('span', {}, `Leaving soon: ${leaving.map((m) => `${m.title} (${m.leftLabel})`).join(', ')}.`),
    ));
  }

  if (!movies.length) {
    page.appendChild(emptyState('🔖', 'No movies starred yet',
      'Tap ☆ on any movie to add it here. Watchlisted movies get a ranking boost.'));
    root.appendChild(page);
    return;
  }

  const grid = h('div', { class: 'tile-grid' });
  for (const mv of movies) {
    const tile = posterTile(mv, {
      caption: mv.title,
      corner: h('div', { class: 'tile-corner right' },
        watchlistButton({ tmdb_id: mv.tmdb_id, watchlisted: true }, ctx, { compact: true, onToggle: () => tile.remove() })),
    });
    grid.appendChild(tile);
  }
  page.appendChild(grid);
  root.appendChild(page);
}
