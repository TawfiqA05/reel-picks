// "At home" on the Picks page: the person's 4 best matches this week from the
// streaming services they have (server/lib/home.js), and the service chooser
// shared with Settings. Owner and friends only; the guest link never draws it.
import { api } from '../api.js';
import { h, clear, poster, scorePill, toast, icon, openModal } from '../ui.js';
import { ownerTools } from './components.js';
import { SERVICES, cleanServices, servicesPhrase } from '../services.js';

const POLL_MS = 2000;
const POLL_FOR_MS = 3 * 60 * 1000;

// Toggle chips, one per service. onChange(keys) after every tap.
export function servicesPicker(selected, onChange) {
  const on = new Set(cleanServices(selected));
  const wrap = h('div', { class: 'chips service-chips', role: 'group', 'aria-label': 'Your streaming services' });
  for (const s of SERVICES) {
    const chip = h('button', { class: 'chip', type: 'button', 'data-service': s.key, title: s.note || s.name }, s.name);
    const paint = () => { chip.classList.toggle('active', on.has(s.key)); chip.setAttribute('aria-pressed', String(on.has(s.key))); };
    paint();
    chip.addEventListener('click', () => {
      if (on.has(s.key)) on.delete(s.key); else on.add(s.key);
      paint();
      onChange(cleanServices([...on]));
    });
    wrap.appendChild(chip);
  }
  return wrap;
}

// The chooser in a sheet: pick, then "Show my picks" saves.
export function openServicesSheet(current, onSaved) {
  let keys = cleanServices(current);
  const save = h('button', { class: 'btn wide', type: 'button' }, 'Show my picks');
  const paint = () => { save.disabled = !keys.length; };
  const modal = openModal(h('div', { class: 'services-sheet' },
    h('p', { class: 'muted small' }, 'Pick the ones you pay for (and "Free with ads" for Tubi, Pluto TV and the like). Only films included with them count, never rentals.'),
    servicesPicker(keys, (k) => { keys = k; paint(); }),
    save,
  ), { title: 'Your streaming services' });
  paint();
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await api.saveSettings({ streamingServices: keys });
      modal.close();
      onSaved?.(keys);
    } catch (e) { toast(e.message, 'error'); paint(); }
  });
}

function meta(e) {
  const bits = [e.year, (e.genres || []).slice(0, 2).join(' · ')];
  if (e.runtime) bits.push(`${Math.floor(e.runtime / 60)}h ${String(e.runtime % 60).padStart(2, '0')}m`);
  return bits.filter(Boolean).join(' · ');
}

// The service a film is on: its logo (named for screen readers) and "On Max".
export function serviceTag(service) {
  if (!service) return null;
  return h('span', { class: 'service-tag' },
    service.logo ? h('img', { class: 'service-logo', src: service.logo, alt: '', width: '20', height: '20', loading: 'lazy' }) : null,
    `On ${service.name}`);
}

function homeCard(e, ctx, onHide) {
  return h('article', { class: 'pick-card home-card', 'data-id': e.tmdb_id },
    h('a', { class: 'pick-poster', href: `#/movie/${e.tmdb_id}`, tabindex: '-1', 'aria-hidden': 'true' }, poster(e, { size: 'card', link: false })),
    h('div', { class: 'pick-body' },
      h('div', { class: 'pick-head' },
        h('a', { class: 'pick-title', href: `#/movie/${e.tmdb_id}` }, e.title),
        scorePill(e.final),
      ),
      h('div', { class: 'pick-meta' }, h('span', {}, meta(e))),
      serviceTag(e.service),
      e.reason ? h('p', { class: 'pick-reason' }, e.reason) : null,
      ownerTools(e, ctx, { onHide }),
    ),
  );
}

// The whole segment. Draws at once and fills in when the week's list is ready.
export function homeSection(ctx) {
  const sub = h('span', { class: 'section-sub' });
  const change = h('button', { class: 'link-btn home-change', type: 'button', hidden: true }, 'Change services');
  const body = h('div', { class: 'home-body', 'aria-live': 'polite' });
  const section = h('section', { class: 'home-picks', id: 'at-home', 'aria-labelledby': 'at-home-title' },
    h('div', { class: 'section-head' },
      h('div', { class: 'section-title' }, h('h2', { id: 'at-home-title' }, 'At home'), sub),
      change),
    body);
  let services = [];
  let timer = null;
  let startedAt = 0;

  const skeleton = (text) => {
    clear(body);
    body.append(h('p', { class: 'muted small home-status' }, text),
      h('div', { class: 'pick-grid home-grid', 'aria-hidden': 'true' },
        ...Array.from({ length: 4 }, () => h('div', { class: 'pick-card sk-card' }, h('div', { class: 'sk poster-card' }),
          h('div', { class: 'pick-body' }, h('div', { class: 'sk sk-line', style: { width: '70%', height: '20px' } }), h('div', { class: 'sk sk-line', style: { width: '50%' } }))))));
  };
  const openSheet = () => openServicesSheet(services, (keys) => { services = keys; startedAt = Date.now(); load(); });
  change.addEventListener('click', openSheet);

  const hide = async (entry, card) => {
    card?.classList.add('is-leaving');
    try {
      await api.hide(entry.tmdb_id, entry.title);
    } catch (e) { card?.classList.remove('is-leaving'); toast(e.message, 'error'); return; }
    await load();
    toast(`Hid ${entry.title}.`, '', { action: { label: 'Undo', onClick: async () => { await api.unhide(entry.tmdb_id); load(); } } });
  };

  async function load() {
    clearTimeout(timer);
    let r;
    try { r = await api.homePicks(); } catch (e) {
      clear(body);
      body.append(h('p', { class: 'muted small' }, e.message));
      return;
    }
    services = r.services || [];
    change.hidden = !services.length;
    sub.textContent = services.length ? `This week on ${servicesPhrase(services)}` : '';
    if (r.status === 'none') {
      clear(body);
      const btn = h('button', { class: 'btn', type: 'button' }, icon('tv', { size: 16 }), 'Choose your services');
      btn.addEventListener('click', openSheet);
      body.append(h('div', { class: 'home-setup' },
        h('div', {},
          h('div', { class: 'banner-title' }, 'Staying in?'),
          h('p', { class: 'muted small' }, 'Tell us which streaming services you have and you\'ll get your 4 best matches on them every week, scored the same way as your theater picks.')),
        btn));
      return;
    }
    if (r.status === 'computing') {
      if (!startedAt) startedAt = Date.now();
      skeleton(`Finding your best films on ${servicesPhrase(services)}…`);
      if (Date.now() - startedAt < POLL_FOR_MS) timer = setTimeout(() => { if (section.isConnected) load(); }, POLL_MS);
      return;
    }
    startedAt = 0;
    clear(body);
    if (r.status === 'error') {
      const retry = h('button', { class: 'btn ghost small', type: 'button' }, 'Try again');
      retry.addEventListener('click', load);
      body.append(h('p', { class: 'muted small' }, r.message), retry);
      return;
    }
    if (!r.picks.length) {
      body.append(h('p', { class: 'muted small' }, `Nothing left to suggest on ${servicesPhrase(services)} this week. You've rated, seen or hidden everything we found. Try adding a service.`));
      return;
    }
    const grid = h('div', { class: 'pick-grid home-grid' });
    for (const e of r.picks) grid.appendChild(homeCard(e, ctx, hide));
    body.append(grid);
  }

  skeleton('Loading your home picks…');
  load();
  return section;
}

