// First-run onboarding: a fast tap-to-rate flow over ~20 popular movies.
import { api } from '../api.js';
import { h, clear, spinner, poster, toast, emptyState } from '../ui.js';

export async function render(root, params, ctx) {
  clear(root);
  root.appendChild(spinner('Loading movies…'));
  let movies;
  try {
    ({ movies } = await api.onboardingMovies());
  } catch (e) {
    clear(root);
    root.appendChild(emptyState('🔑', 'TMDB key needed', e.message, h('a', { class: 'btn', href: '#/settings' }, 'Settings')));
    return;
  }
  clear(root);

  if (!movies.length) {
    root.appendChild(emptyState('✓', 'All set', 'No new movies to rate right now.', h('a', { class: 'btn', href: '#/home' }, 'Go to picks')));
    return;
  }

  const collected = [];
  let i = 0;
  const page = h('div', { class: 'onboard' });
  const bar = h('div', { class: 'ob-progress' }, h('div', { class: 'ob-fill' }));
  const stage = h('div', { class: 'ob-stage' });
  const counter = h('div', { class: 'muted small' });

  const finish = async () => {
    clear(page);
    page.appendChild(spinner('Saving…'));
    try {
      await api.onboardingRate(collected);
      toast(`Saved ${collected.length} ratings`, 'success');
    } catch (e) { toast(e.message, 'error'); }
    await ctx.refreshStatus();
    ctx.navigate('#/home');
  };

  const advance = () => {
    i += 1;
    if (i >= movies.length) return finish();
    show();
  };

  const rate = (m, v) => {
    collected.push({ tmdb_id: m.tmdb_id, title: m.title, year: m.year, poster: m.poster, genres: m.genres, rating: v });
    advance();
  };

  function show() {
    const m = movies[i];
    page.querySelector('.ob-fill').style.width = `${(i / movies.length) * 100}%`;
    counter.textContent = `${i + 1} of ${movies.length} · ${collected.length} rated`;
    clear(stage);
    stage.appendChild(h('div', { class: 'ob-card' },
      poster(m, { size: 'xl', link: false }),
      h('div', { class: 'ob-title' }, m.title),
      h('div', { class: 'muted' }, [m.year, (m.genres || []).slice(0, 2).join(' · ')].filter(Boolean).join(' · ')),
      h('div', { class: 'ob-stars' }, ...[1, 2, 3, 4, 5].map((n) =>
        h('button', { class: 'ob-star', title: `${n}★`, onClick: () => rate(m, n) }, '★'.repeat(n)))),
      h('div', { class: 'ob-buttons' },
        h('button', { class: 'btn ghost', onClick: advance }, 'Haven\'t seen →'),
      ),
    ));
  }

  page.append(
    h('div', { class: 'ob-head' },
      h('h2', {}, 'Quick rate'),
      h('button', { class: 'link-btn', onClick: async () => { await api.onboardingDone(); await ctx.refreshStatus(); ctx.navigate('#/home'); } }, 'Skip'),
    ),
    bar, counter, stage,
    h('button', { class: 'btn wide', onClick: finish }, 'Done — build my profile'),
  );
  root.appendChild(page);
  show();
}
