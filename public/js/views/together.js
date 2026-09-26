// Together: films the owner and one friend could see together (server:
// lib/together.js). The owner picks one of the friends who switched it on; a
// friend who switched it on only ever sees the owner. The server decides who
// can be paired and sends one label per film, no scores or ratings.
import { api } from '../api.js';
import { h, clear, spinner, emptyState, sectionTitle, badge, poster, toast } from '../ui.js';
import { dayLabel } from './components.js';

export async function render(root, params, ctx) {
  clear(root);
  root.appendChild(spinner('Loading…'));
  const info = await api.together();
  clear(root);

  const page = h('div', { class: 'page together' });
  root.appendChild(page);

  if (info.role === 'friend') {
    const owner = info.ownerName;
    page.appendChild(sectionTitle('Together', `You and ${owner}`, { level: 1 }));
    if (!info.optedIn) {
      const turnOn = h('button', { class: 'btn', type: 'button' }, `Let ${owner} plan movies with me`);
      turnOn.addEventListener('click', async () => {
        turnOn.disabled = true;
        try {
          await api.saveSettings({ watchTogether: true });
          ctx.rerender();
        } catch (e) {
          turnOn.disabled = false;
          toast(e.message, 'error');
        }
      });
      page.appendChild(emptyState('users', `Plan movies with ${owner}`,
        `Turn this on and this page lists films you would both enjoy at a theater you both follow. ${owner} sees one short reason for each film, never your ratings, scores or full watchlist. You can turn it off any time in Settings.`,
        turnOn));
      return;
    }
    await showPair(page, info.partner, ctx);
    return;
  }

  // Owner.
  page.appendChild(sectionTitle('Together', 'Films you and a friend would both enjoy', { level: 1 }));
  const partners = info.partners || [];
  if (!partners.length) {
    page.appendChild(emptyState('users', 'No friends have turned this on yet',
      `When a friend turns on "Let ${ctx.getStatus()?.ownerName || 'me'} plan movies with me" in their Settings, you can pick them here and see films you would both enjoy.`));
    return;
  }
  const wanted = Number(params[0]);
  const partner = partners.find((p) => p.id === wanted) || partners[0];
  page.appendChild(h('div', { class: 'tg-picker', role: 'group', 'aria-label': 'Plan with' },
    ...partners.map((p) => h('a', {
      class: `chip tg-person${p.id === partner.id ? ' active' : ''}`,
      href: `#/together/${p.id}`,
      ...(p.id === partner.id ? { 'aria-current': 'true' } : {}),
    }, p.name))));
  await showPair(page, partner, ctx);
}

async function showPair(page, partner, ctx) {
  const body = h('div', { class: 'tg-body' }, spinner(`Finding films for you and ${partner.name}…`));
  page.appendChild(body);
  let data;
  try {
    data = await api.togetherWith(partner.id);
  } catch (e) {
    clear(body);
    body.appendChild(emptyState('alert', 'Couldn\'t load this', e.message,
      h('button', { class: 'btn', type: 'button', onClick: () => ctx.rerender() }, 'Retry')));
    return;
  }
  clear(body);
  const name = data.partner.name;

  if (data.state === 'no-shared-theatre') {
    body.appendChild(emptyState('pin', `You and ${name} don't follow any of the same theaters`,
      `Together only lists showtimes at a theater you both follow. Add one of ${name}'s theaters in Settings, or ask ${name} to add one of yours.`,
      h('a', { class: 'btn ghost', href: '#/settings' }, 'Open Settings')));
    return;
  }

  body.appendChild(h('p', { class: 'muted small tg-where' },
    `At ${listOf(data.sharedTheatres.map((t) => t.short || t.name))}, playing now or opening in the next two weeks.`));

  if (data.state === 'nothing') {
    body.appendChild(emptyState('search', `Nothing you and ${name} would both love right now`,
      'A film shows up here when it is on both watchlists, on one watchlist and a great match for the other person, or a strong match for you both. Star films you want to see, then check back when the lineup changes.',
      h('a', { class: 'btn ghost', href: '#/home' }, 'Browse Picks')));
    return;
  }

  body.appendChild(h('ol', { class: 'tg-list' }, ...data.films.map((f) => filmRow(f))));
}

function filmRow(f) {
  return h('li', { class: 'tg-film' },
    poster(f, { size: 'sm' }),
    h('div', { class: 'tg-main' },
      h('a', { class: 'tg-title', href: `#/movie/${f.tmdb_id}` }, f.title, f.year ? h('span', { class: 'tg-year' }, ` ${f.year}`) : null),
      badge(f.label, `tg-label ${f.labelKind}`),
      f.showtimes.length
        ? h('ul', { class: 'tg-times', 'aria-label': 'Next showtimes' }, ...f.showtimes.map(showtime))
        : null,
    ),
  );
}

function showtime(st) {
  const text = [
    h('span', { class: 'tg-when' }, `${dayLabel(st.date)} ${st.time}`),
    h('span', { class: 'tg-at' }, [st.theatre, st.is_imax ? 'IMAX' : (st.format && !/^standard$/i.test(st.format) ? st.format : null)].filter(Boolean).join(' · ')),
  ];
  return h('li', {},
    st.purchase_url
      ? h('a', { class: 'tg-time', href: st.purchase_url, target: '_blank', rel: 'noopener', title: 'Book on AMC' }, ...text)
      : h('span', { class: 'tg-time' }, ...text));
}

const listOf = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
