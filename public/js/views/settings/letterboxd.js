// Settings: the Letterboxd auto-sync card.
import { api } from '../../api.js';
import { h, toast, icon, setStatus } from '../../ui.js';
import { DEMO, offLine } from '../../demo.js';
import { card } from './parts.js';

// Letterboxd: a username, the last sync's result, Sync now. Saving a name
// syncs at once, so a misspelled one shows its message right here.
export function letterboxdCard(ctx, words) {
  const nameIn = h('input', {
    class: 'input', type: 'text', maxlength: '80', placeholder: 'Letterboxd username', 'aria-label': 'Letterboxd username',
    autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false',
  });
  const saveBtn = h('button', { class: 'btn', type: 'button' }, 'Save');
  const syncBtn = h('button', { class: 'btn soft', type: 'button' }, icon('refresh', { size: 16 }), 'Sync now');
  const line = h('p', { class: 'muted small lb-status', role: 'status', 'aria-live': 'polite' });
  const syncRow = h('div', {}, syncBtn);
  let st = null;

  const when = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const paint = () => {
    syncRow.hidden = !st?.username;
    if (!st?.username) { setStatus(line, '', 'Not linked.'); return; }
    if (st.syncing) { setStatus(line, '', 'Syncing…'); return; }
    if (st.error) { setStatus(line, 'bad', st.error); return; }
    if (!st.lastOkAt) { setStatus(line, 'warn', `Linked to ${st.username}. Not synced yet.`); return; }
    const extra = [
      st.ratingsUpdated ? `${plural(st.ratingsUpdated, 'rating')} updated` : '',
      st.kept ? `${plural(st.kept, 'rating')} you changed here kept` : '',
      st.unmatched ? `${plural(st.unmatched, 'film')} not found on TMDB` : '',
    ].filter(Boolean);
    setStatus(line, 'ok', `Last synced ${when(st.lastOkAt)}: ${plural(st.added, 'film')} added.${extra.length ? ` ${extra.join(', ')}.` : ''}`);
  };
  const busy = (on) => { saveBtn.disabled = on; syncBtn.disabled = on; };
  const done = (r) => {
    st = r;
    nameIn.value = r.username || '';
    paint();
    if (!r.error && (r.added || r.ratingsUpdated)) ctx.refreshStatus?.();
  };
  const save = async () => {
    busy(true);
    st = { ...(st || {}), username: nameIn.value.trim() || null, syncing: Boolean(nameIn.value.trim()), error: null };
    paint();
    try { done(await api.letterboxdSave(nameIn.value.trim())); } catch (e) { toast(e.message, 'error'); try { done(await api.letterboxd()); } catch { /* keep the line */ } } finally { busy(false); }
  };
  saveBtn.addEventListener('click', save);
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  syncBtn.addEventListener('click', async () => {
    busy(true);
    st = { ...st, syncing: true };
    paint();
    try { done(await api.letterboxdSync()); } catch (e) { toast(e.message, 'error'); try { done(await api.letterboxd()); } catch { /* keep the line */ } } finally { busy(false); }
  });
  api.letterboxd().then(done).catch((e) => { setStatus(line, 'bad', e.message); });
  paint();

  if (DEMO) syncRow.hidden = true;
  return card('Letterboxd',
    DEMO ? offLine() : h('div', { class: 'row-gap' }, nameIn, saveBtn),
    DEMO ? null : line,
    DEMO ? null : syncRow,
    h('p', { class: 'muted small' },
      'Once a day Reel Picks reads your public Letterboxd diary and brings in new star ratings and the films you logged as watched. '
      + `Each entry comes in once, and a rating you change here is never overwritten. Films logged on Letterboxd count as seen, ${words.notCounted}. `
      + 'The feed only has your latest 50 or so entries; for your whole history, import ratings.csv on the Rate page. Clear the name and save to unlink.'),
  );
}
