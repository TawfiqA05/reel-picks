// Coming Soon: upcoming releases + advance screenings, ranked by predicted taste.
import { api } from '../api.js';
import { h, clear, spinner, emptyState, scorePill, badge, sectionTitle } from '../ui.js';
import { posterTile } from './components.js';

export async function render(root, params, ctx) {
  clear(root);
  root.appendChild(spinner('Loading upcoming…'));
  const data = await api.comingSoon();
  clear(root);

  const page = h('div', { class: 'page' });
  page.appendChild(sectionTitle('Coming soon',
    data.profile.lowData ? 'Predicted from public taste — rate more to personalize' : 'Ranked by your predicted taste match'));

  if (!data.list.length) {
    page.appendChild(emptyState('🗓️', 'Nothing upcoming yet',
      'Refresh with a TMDB key to load upcoming releases and advance screenings.'));
    root.appendChild(page);
    return;
  }

  const grid = h('div', { class: 'tile-grid' });
  for (const mv of data.list) {
    const corner = h('div', { class: 'tile-corner' },
      scorePill(mv.predicted),
      mv.advance ? badge('Advance', 'advance') : null,
    );
    const sub = h('div', {},
      mv.release_date ? new Date(`${mv.release_date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '',
    );
    grid.appendChild(posterTile(mv, { corner, caption: mv.title, sub }));
  }
  page.appendChild(grid);
  root.appendChild(page);
}
