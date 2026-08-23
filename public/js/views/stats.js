// Stats: A-List usage, savings, ratings, recommendation hit-rate + tuning tip.
import { api } from '../api.js';
import { h, clear, spinner, money, pct, makeStars, toast, sectionTitle } from '../ui.js';

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
