// Stats: A-List usage, savings, ratings, recommendation hit-rate + tuning tip.
import { api } from '../api.js';
import { h, clear, spinner, money, pct, makeStars, toast, sectionTitle, openModal, icon } from '../ui.js';

export async function render(root, params, ctx) {
  clear(root);
  root.appendChild(spinner('Crunching numbers…'));
  const [s, week] = await Promise.all([api.stats(), api.alist()]);
  clear(root);

  const page = h('div', { class: 'page' });

  page.appendChild(sectionTitle('This A-List week', `Resets Friday · week of ${week.weekStart}`, { level: 1 }));
  page.appendChild(h('div', { class: 'stat-grid' },
    bigStat(`${week.used}/${week.limit}`, 'reservations used', `${week.remaining} left`),
    bigStat(money(week.savings.saved), 'saved this month', `${week.savings.monthTickets} tickets vs ${money(week.savings.alistFee)} fee`),
    bigStat(money(week.savings.ticketValue), 'ticket value seen', 'this month'),
  ));
  if (week.movies.length) page.appendChild(watchLog(week.movies, ctx));

  page.appendChild(sectionTitle('Your year', String(s.year)));
  page.appendChild(h('div', { class: 'stat-grid' },
    // Only films logged as seen (Mark seen / A-List), not imported ratings.
    bigStat(s.seenThisYear, 'seen in theaters', 'logged this year'),
    bigStat(s.totalRatings, 'ratings', 'in your profile'),
    bigStat(s.avgRating != null ? `${s.avgRating}★` : '–', 'average rating', ''),
    bigStat(s.hitRate != null ? pct(s.hitRate) : '–', 'pick hit-rate', s.ratedPicks ? `of ${s.ratedPicks} picks watched` : 'rate your picks'),
  ));

  if (s.suggestion) {
    const tip = h('div', { class: 'alert tip' },
      h('span', { class: 'alert-icon' }, icon('target', { size: 18 })),
      h('span', {}, s.suggestion.text),
    );
    if (s.suggestion.weightTaste != null) {
      tip.appendChild(h('button', { class: 'btn small', onClick: async () => {
        await api.saveSettings({ weightPublic: s.suggestion.weightPublic, weightTaste: s.suggestion.weightTaste });
        toast('Weights updated', 'success');
      } }, 'Apply'));
    }
    page.appendChild(tip);
  }

  const ranked = "ranked by films you've rated";
  if (s.topGenres.length) page.appendChild(topList('Top genres', ranked, s.topGenres, 'genres'));
  if (s.topDirectors.length) page.appendChild(topList('Top directors', ranked, s.topDirectors, 'directors'));
  if (s.topActors.length) page.appendChild(topList('Top actors', ranked, s.topActors, 'actors'));
  // Imported films arrive with genres only; director and cast follow in the
  // background. Say so while it's happening, so a short list isn't a mystery.
  if (s.backfilling && s.detailsPending > 0) {
    page.appendChild(h('div', { class: 'muted small pad' },
      `Still loading details for ${s.detailsPending} of your film${s.detailsPending === 1 ? '' : 's'}`));
  }
  if (!s.totalRatings) {
    page.appendChild(h('div', { class: 'muted pad' }, 'Rate some movies to unlock genre/director insights and personalized picks.'));
  }

  root.appendChild(page);
}

// This week's logged entries, each removable. The server has always had the
// delete; nothing reached it, so an accidental "Mark seen" could only be undone
// in SQLite. Removal only — dates and rewatches are not editable here.
function watchLog(movies, ctx) {
  const list = h('div', { class: 'theatre-list' });
  for (const m of movies) {
    list.appendChild(h('div', { class: 'theatre-item' },
      h('div', { class: 'ti-main' },
        h('div', { class: 'ti-name' }, m.title || `Movie ${m.tmdb_id}`),
        h('div', { class: 'muted small' }, watchedLabel(m.watched_at)),
      ),
      h('div', { class: 'ti-actions' },
        h('button', {
          class: 'btn ghost small', type: 'button', title: 'Remove from your watch log',
          onClick: () => confirmRemove(m, ctx),
        }, '✕'),
      ),
    ));
  }
  return list;
}

function confirmRemove(m, ctx) {
  const modal = openModal(h('div', { class: 'confirm' },
    h('p', {}, `Remove ${m.title || 'this movie'} from your watch log?`),
    h('p', { class: 'muted small' }, 'It stops counting toward this week\'s three reservations, this month\'s savings, and the pick hit-rate. Your rating, if you left one, is not touched.'),
    h('div', { class: 'row-gap' },
      h('button', { class: 'btn', onClick: async () => {
        modal.close();
        try {
          await api.undoWatched(m.id);
          toast('Removed from your watch log', 'success');
          ctx?.refreshStatus?.();
          ctx?.rerender?.();
        } catch (e) { toast(e.message, 'error'); }
      } }, 'Remove'),
      h('button', { class: 'btn ghost', onClick: () => modal.close() }, 'Cancel'),
    ),
  ), { title: 'Remove watch entry' });
}

function watchedLabel(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return 'Logged';
  return `Logged ${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`;
}

function bigStat(value, label, sub) {
  return h('div', { class: 'big-stat' },
    h('div', { class: 'bs-value' }, value),
    h('div', { class: 'bs-label' }, label),
    sub ? h('div', { class: 'bs-sub' }, sub) : null,
  );
}

// One numbered row per entry: "2 films · 4.5★" (the user's own average).
function barList(items, id) {
  return h('ol', { class: 'bar-list', id }, ...items.map((it, i) => h('li', { class: 'bar-row' },
    h('span', { class: 'bar-rank', 'aria-hidden': 'true' }, String(i + 1)),
    h('span', { class: 'bar-name' }, it.name),
    makeStars({ value: it.avg, size: 14 }),
    h('span', { class: 'bar-meta' }, `${it.n} film${it.n === 1 ? '' : 's'} · ${it.avg.toFixed(1)}★`),
  )));
}

// A ranked list showing its first TOP rows, with "Show all (N)" underneath
// to expand to the rest when the server sent more (for people, that's only
// those with 2+ films).
const TOP = 10;
function topList(title, sub, items, key) {
  const id = `top-${key}`;
  const list = barList(items, id);
  const extra = [...list.children].slice(TOP);
  const wrap = h('section', { class: 'stat-list' }, sectionTitle(title, sub), list);
  if (!extra.length) return wrap;
  let open = false;
  const btn = h('button', { class: 'btn ghost small show-all', type: 'button', 'aria-controls': id });
  const paint = () => {
    for (const row of extra) row.hidden = !open;
    btn.textContent = open ? 'Show fewer' : `Show all (${items.length})`;
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.addEventListener('click', () => { open = !open; paint(); });
  paint();
  wrap.appendChild(btn);
  return wrap;
}
