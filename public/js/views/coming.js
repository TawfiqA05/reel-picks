// Coming Soon: upcoming releases + advance screenings, ranked by predicted taste.
import { api } from '../api.js';
import { h, clear, spinner, emptyState, scorePill, badge, sectionTitle } from '../ui.js';
import { posterTile, isOldRelease } from './components.js';

export async function render(root, params, ctx) {
  clear(root);
  root.appendChild(spinner('Loading upcoming…'));
  const data = await api.comingSoon();
  clear(root);

  const page = h('div', { class: 'page' });
  page.appendChild(sectionTitle('Coming soon',
    data.profile.lowData ? 'Predicted from public taste. Rate more to make it yours.' : 'Ranked by your predicted taste match'));

  if (!data.list.length) {
    page.appendChild(emptyState('calendar', 'Nothing upcoming yet',
      'Refresh with a TMDB key to load upcoming releases and advance screenings.'));
    root.appendChild(page);
    return;
  }

  const grid = h('div', { class: 'tile-grid' });
  for (const mv of data.list) {
    const tags = [
      scorePill(mv.predicted),
      mv.advance ? badge('Advance', 'advance') : null,
    ];
    // An old film coming back carries its original release date, which would
    // read as if it opened decades ago. Say what it is instead.
    const sub = h('div', {},
      isOldRelease(mv) ? `Re-release · ${mv.year}`
        : mv.release_date ? new Date(`${mv.release_date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '',
    );
    grid.appendChild(posterTile(mv, { tags, caption: mv.title, sub }));
  }
  page.appendChild(grid);
  root.appendChild(page);
}
