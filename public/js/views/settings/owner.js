// Settings, owner only: owner alerts, friends, and the API key rows.
import { api } from '../../api.js';
import { h, clear, toast, badge, openModal, icon, setStatus } from '../../ui.js';
import { DEMO, offLine } from '../../demo.js';
import { card } from './parts.js';

// Owner alerts (server/lib/alerts.js): a failed refresh, nightly or off-site
// backup, a day with no showtimes at the primary theater, or the data volume
// more than 80% full. Newest first.
export function alertsCard() {
  const note = h('p', { class: 'muted small' });
  const list = h('ul', { class: 'alert-list' });
  const when = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  api.alerts().then((r) => {
    const failing = r.failing.map((f) => f.label.toLowerCase());
    setStatus(note, failing.length ? 'bad' : 'ok', [
      failing.length ? `Failing now: ${failing.join(', ')}.` : 'Everything is working.',
      !r.pushEnabled ? 'Push notifications are off on this server, so alerts only show here.'
        : r.devices ? `Alerts also go to ${r.devices === 1 ? 'the device' : `all ${r.devices} devices`} you turned notifications on for.`
          : 'Turn on notifications above to get these on your phone too.',
    ].join(' '));
    if (!r.alerts.length) { list.replaceWith(h('p', { class: 'muted small' }, 'No alerts yet.')); return; }
    for (const a of r.alerts) {
      list.appendChild(h('li', { class: `alert-item ${a.kind}` },
        icon(a.kind === 'problem' ? 'alert' : 'check', { size: 16, label: a.kind === 'problem' ? 'Problem' : 'Back to normal' }),
        h('div', { class: 'alert-main' },
          h('div', { class: 'alert-msg' }, a.message),
          h('div', { class: 'muted small' }, `${a.label} · ${when(a.at)}`)),
      ));
    }
  }).catch((e) => { setStatus(note, 'bad', e.message); });
  return card('Alerts',
    h('p', { class: 'muted small' }, 'If the daily refresh or a backup fails, no showtimes come back for your primary theater, or the data volume gets more than 80% full, you get one alert that day, and one more when it works again. Friends never see these.'),
    note, list);
}

// ---- Friends (owner only): invite links, revoke, re-issue. A link is shown
// once, right after it's made; the server keeps only a hash of it.
export function friendsCard() {
  const list = h('div', { class: 'theatre-list' });
  const linkSlot = h('div', {});
  const nameIn = h('input', { class: 'input', type: 'text', maxlength: '40', placeholder: 'Friend\'s name', 'aria-label': 'Friend\'s name' });
  const addBtn = h('button', { class: 'btn', type: 'button' }, 'Create invite link');
  const note = h('p', { class: 'muted small' });
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null);

  const showLink = (friend, invite) => {
    const url = `${location.origin}${invite}`;
    const field = h('input', { class: 'input', type: 'text', readonly: true, value: url, 'aria-label': `Invite link for ${friend.name}` });
    const copy = h('button', { class: 'btn', type: 'button' }, 'Copy');
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(url); toast('Link copied', 'success'); } catch { field.select(); toast('Select the link and copy it'); }
    });
    clear(linkSlot);
    linkSlot.appendChild(h('div', { class: 'import-box' },
      h('strong', {}, `Invite link for ${friend.name}`),
      h('div', { class: 'row-gap' }, field, copy),
      h('p', { class: 'muted small' }, 'Shown once. Copy it now and send it to them. It works one time, on one device, and signs them in for a year.'),
    ));
    field.focus();
    field.select();
  };

  const load = async () => {
    try {
      const { friends, max } = await api.friends();
      clear(list);
      note.textContent = `Up to ${max - 1} friends. Each gets their own ratings, watchlist, picks and settings. Revoking stops their link at once and keeps their data.`;
      if (!friends.length) list.appendChild(h('div', { class: 'muted small' }, 'No friends yet.'));
      for (const f of friends) {
        const status = f.revoked_at ? 'Revoked' : f.invite_pending ? 'Invite not used yet' : f.last_seen_at ? `Last seen ${when(f.last_seen_at)}` : 'Signed in';
        const act = async (fn, done) => {
          try { const r = await fn(); if (r.invite) showLink(r.friend, r.invite); toast(done, 'success'); load(); } catch (e) { toast(e.message, 'error'); }
        };
        list.appendChild(h('div', { class: 'theatre-item' },
          h('div', { class: 'ti-main' },
            h('div', { class: 'ti-name' }, f.name, f.revoked_at ? badge('Revoked', 'bad') : null),
            h('div', { class: 'muted small' }, `Added ${when(f.created_at)} · ${f.ratings} rating${f.ratings === 1 ? '' : 's'} · ${status}`),
          ),
          h('div', { class: 'ti-actions' },
            f.revoked_at ? null : h('button', {
              class: 'btn danger small', type: 'button', 'aria-label': `Revoke ${f.name}`,
              onClick: () => {
                const modal = openModal(h('div', { class: 'confirm' },
                  h('p', {}, `Revoke ${f.name}'s access?`),
                  h('p', { class: 'muted small' }, 'Their link stops working right away. Their ratings and lists are kept, and a new link brings them back.'),
                  h('div', { class: 'row-gap' },
                    h('button', { class: 'btn danger', onClick: () => { modal.close(); act(() => api.revokeFriend(f.id), `Revoked ${f.name}`); } }, 'Revoke'),
                    h('button', { class: 'btn soft', onClick: () => modal.close() }, 'Cancel'),
                  ),
                ), { title: 'Revoke friend' });
              },
            }, 'Revoke'),
            DEMO ? null : h('button', {
              class: 'btn soft small', type: 'button', 'aria-label': `New link for ${f.name}`,
              onClick: () => act(() => api.reissueFriend(f.id), `New link for ${f.name}`),
            }, 'New link'),
          ),
        ));
      }
    } catch (e) { clear(list); list.appendChild(h('div', { class: 'muted small' }, e.message)); }
  };

  const add = async () => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); return; }
    addBtn.disabled = true;
    try {
      const r = await api.addFriend(name);
      nameIn.value = '';
      showLink(r.friend, r.invite);
      load();
    } catch (e) { toast(e.message, 'error'); } finally { addBtn.disabled = false; }
  };
  addBtn.addEventListener('click', add);
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  load();
  // Demo mode: the made-up friends only, and no invites.
  return card('Friends', note, list, DEMO ? offLine() : h('div', { class: 'row-gap' }, nameIn, addBtn), linkSlot);
}

export function keyRow(name, present, desc) {
  return h('div', { class: 'key-row' },
    h('span', { class: `key-dot ${present ? 'on' : 'off'}` }),
    h('span', { class: 'key-name' }, name),
    h('span', { class: 'muted small' }, desc),
    h('span', { class: `key-status ${present ? 'on' : 'off'}` }, present ? 'connected' : 'missing'),
  );
}
