// Watchlist grid + leaving-soon alerts.
import { api } from '../api.js';
import { h, clear, spinner, emptyState, sectionTitle, icon } from '../ui.js';
import { posterTile, watchlistButton, dayLabel } from './components.js';
import { filterBox } from '../filter.js';

export async function render(root, params, ctx) {
  clear(root);
  root.appendChild(spinner('Loading watchlist…'));
  const [{ movies }, recs] = await Promise.all([
    api.watchlist(),
    api.recommendations().catch(() => ({ leavingSoon: [] })),
  ]);
  clear(root);

  const page = h('div', { class: 'page' });
  const title = sectionTitle('Watchlist', `${movies.length} saved`, { level: 1 });
  page.appendChild(title);
  const empty = () => emptyState('bookmark', 'Nothing saved yet',
    'Tap Save on any movie to keep it here. Saved movies get a boost in your picks.');

  const leaving = (recs.leavingSoon || []).filter((m) => m.watchlisted);
  if (leaving.length) {
    page.appendChild(h('div', { class: 'alert' },
      h('span', { class: 'alert-icon' }, icon('hourglass', { size: 18 })),
      h('span', {}, `Leaving soon: ${leaving.map((m) => `${m.title} (${m.leftLabel})`).join(', ')}.`),
    ));
  }

  if (!movies.length) {
    page.appendChild(empty());
    root.appendChild(page);
    return;
  }

  const grid = h('div', { class: 'tile-grid' });
  const rows = [];
  // A film unstarred here leaves the grid, and the count (and at zero, the
  // empty state) follows.
  let count = movies.length;
  const removed = (tile) => {
    tile.remove();
    count--;
    const sub = title.querySelector('.section-sub');
    if (sub) sub.textContent = `${count} saved`;
    if (!count) { grid.replaceWith(empty()); page.querySelector('.filter')?.remove(); }
  };
  for (const mv of movies) {
    const tile = posterTile(mv, {
      caption: mv.title,
      corner: h('div', { class: 'tile-corner right' },
        watchlistButton({ tmdb_id: mv.tmdb_id, title: mv.title, watchlisted: true }, ctx, { compact: true, onToggle: (on) => { if (!on) removed(tile); } })),
    });
    grid.appendChild(tile);
    // Your own note (a film you rated and kept saved) is searched too.
    rows.push({ el: tile, fields: [mv.title, mv.note || ''] });
  }
  // A long watchlist gets a filter box.
  if (movies.length > 8) {
    const filter = filterBox({ label: 'Filter your watchlist', placeholder: `Filter ${movies.length} films` });
    // Come back to (js/place.js): the same text in the box.
    filter.input.value = ctx.place?.saved?.filter || '';
    ctx.place?.keep('filter', () => filter.text);
    filter.set(rows);
    page.appendChild(filter.el);
  }
  page.appendChild(grid);
  root.appendChild(page);
}
