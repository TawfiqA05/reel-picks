// Stats: A-List usage, savings, ratings, recommendation hit-rate + tuning tip.
import { api } from '../api.js';
import { h, clear, spinner, money, pct, makeStars, toast, sectionTitle, openModal } from '../ui.js';

export async function render(root, params, ctx) {
  clear(root);
  root.appendChild(spinner('Crunching numbers…'));
  const [s, week] = await Promise.all([api.stats(), api.alist()]);
  clear(root);

  const page = h('div', { class: 'page' });

  page.appendChild(sectionTitle('This A-List week', `Resets Friday · week of ${week.weekStart}`));
  page.appendChild(h('div', { class: 'stat-grid' },
    bigStat(`${week.used}/${week.limit}`, 'reservations used', `${week.remaining} left`),
    bigStat(money(week.savings.saved), 'saved this month', `${week.savings.monthTickets} tickets vs ${money(week.savings.alistFee)} fee`),
    bigStat(money(week.savings.ticketValue), 'ticket value seen', 'this month'),
  ));
  if (week.movies.length) page.appendChild(watchLog(week.movies, ctx));

  page.appendChild(sectionTitle('Your year', String(s.year)));
  page.appendChild(h('div', { class: 'stat-grid' },
    bigStat(s.seenThisYear, 'movies seen', 'logged this year'),
    bigStat(s.totalRatings, 'ratings', 'in your profile'),
    bigStat(s.avgRating != null ? `${s.avgRating}★` : '—', 'average rating', ''),
    bigStat(s.hitRate != null ? pct(s.hitRate) : '—', 'pick hit-rate', s.ratedPicks ? `of ${s.ratedPicks} picks watched` : 'rate your picks'),
  ));

  if (s.suggestion) {
    const tip = h('div', { class: 'alert tip' },
      h('span', { class: 'alert-icon' }, '🎯'),
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

  if (s.topGenres.length) {
    page.appendChild(sectionTitle('Top genres', 'by number of ratings'));
    page.appendChild(barList(s.topGenres));
  }
  if (s.topDirectors.length) {
    page.appendChild(sectionTitle('Top directors'));
    page.appendChild(barList(s.topDirectors));
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

function barList(items) {
  const max = 5;
  return h('div', { class: 'bar-list' }, ...items.map((it) => h('div', { class: 'bar-row' },
    h('span', { class: 'bar-name' }, it.name),
    makeStars({ value: it.avg, size: 14 }),
    h('span', { class: 'bar-meta' }, `${it.avg.toFixed(1)} · ${it.n}×`),
  )));
}
