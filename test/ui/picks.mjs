// Picks and the movie page as designed (real-app G12 g-hero, G13 g-cards, G14
// g-rows, G15 g-details, G4 g-glow; decisions D13 g-tag): the hero's tags,
// Book and three buttons; the rest-of-four cards; one grid for every showtime
// row; tinted format chips and status tags at AA; the owner's match line,
// "Rent or buy", the day chips, Settings' time fields, Save bar, plan chip
// and checkboxes; the poster-colour glow in dark; the New this week tag on a
// swapped-in pick. Light and dark at 320, 390 and 1280.
import { suite } from '../lib/check.mjs';
import { openWorld, until, sleep } from '../lib/world.mjs';
import { launch, open, go, VISIBLE } from '../lib/browser.mjs';
import { parse, over, ratio, token, realSizePosters } from '../lib/ui-helpers.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('picks');
const WIDTHS = [320, 390, 1280];
const MOVIE = C.PLAYING[0].id;
const NO_GLOW = C.PLAYING[7].id; // Quiet Frontier, given no colour worth a glow below
const EARLY = C.PLAYING[5].id; // Crimson Station: 12 votes, no OMDb record
const w = S.world(await openWorld('picks', {
  prepare: (d) => d.prepare("UPDATE movies SET poster_color = '-' WHERE tmdb_id = ?").run(NO_GLOW),
}));
const F = w.friends;
const ROLES = { owner: 'owner', heavy: F.robin, guest: 'guest' };
const browser = await launch();
const page = async (role, { width = 390, theme = 'dark', hash = 'home', ...o } = {}) => {
  const p = await open(browser, w, { role: ROLES[role], width, theme, ...o });
  await realSizePosters(p.ctx);
  if (hash) await go(p.page, w, hash, 400);
  return p;
};
const serverNow = () => C.T0_MS + (Date.now() - w.srv.startedAt);

// ---------------------------------------------------------------- controls
// Made before any page is measured, so every part sees the same world.
async function controls() {
  // Positive control for the next-showing line: take the owner's #2 off the
  // second listed day, so that day it has nothing and a later day still has showings.
  {
    const r0 = (await w.api('GET', '/api/recommendations')).json;
    const e = r0.weekly4[1]; const day = r0.days[1]?.date;
    if (e && day && (e.showtimesByDay || []).some((x) => x.date > day)) {
      const d = w.db(); d.prepare('DELETE FROM showtimes WHERE tmdb_id = ? AND date = ?').run(e.tmdb_id, day); d.close();
    }
  }
  // Rows that say "Started" must keep every column in place: the earliest
  // showing today of the owner's four and a few other films moves an hour
  // into the past (the server's clock).
  {
    const r = (await w.api('GET', '/api/recommendations')).json;
    const today = r.days?.[0]?.date;
    const ids = [...(r.weekly4 || []), ...(r.list || []).slice(0, 6)].map((e) => e.tmdb_id);
    const d = w.db();
    for (const id of ids) {
      const st = d.prepare('SELECT id FROM showtimes WHERE tmdb_id = ? AND date = ? ORDER BY start_epoch LIMIT 1').get(id, today);
      if (st) d.prepare('UPDATE showtimes SET start_epoch = ? WHERE id = ?').run(serverNow() - 3600e3, st.id);
    }
    d.close();
  }
}

// ---------------------------------------------------------------- hero
function heroProbe() {
  const hero = document.querySelector('.hero-pick');
  if (!hero) return { missing: true };
  const R = (e) => e.getBoundingClientRect();
  const line = hero.querySelector('.hero-line');
  const tags = [...hero.querySelectorAll('.tag-row .tag')];
  const book = hero.querySelector('.btn.book');
  const btns = [...hero.querySelectorAll('.hero-buttons > *')];
  const actions = hero.querySelector('.hero-actions');
  const seat = hero.querySelector('.seat-line');
  const reason = hero.querySelector('.reason-line');
  const imaxElsewhere = [...hero.querySelectorAll('.hero-content *')].filter((e) => !e.closest('.tag-row, .btn.book') && [...e.childNodes].some((n) => n.nodeType === 3 && /IMAX/.test(n.textContent))).map((e) => e.className);
  const muted = (() => { const t = document.createElement('span'); t.style.color = 'var(--muted)'; document.body.appendChild(t); const c = getComputedStyle(t).color; t.remove(); return c; })();
  return {
    line: line?.textContent.trim(), match: line?.querySelector('.match')?.textContent.trim(),
    tags: tags.map((t) => ({ text: t.textContent.trim(), cls: t.className, top: Math.round(R(t).top) })),
    tagRowWrap: hero.querySelector('.tag-row') ? getComputedStyle(hero.querySelector('.tag-row')).flexWrap : null,
    imaxElsewhere, reason: reason?.textContent, runway: hero.querySelector('.runway-line')?.textContent,
    book: book ? { text: book.textContent.trim(), left: R(book).left, right: R(book).right, pills: book.querySelectorAll('.tag, .match, .badge, span').length, disabled: book.getAttribute('aria-disabled') } : null,
    actions: actions ? { left: R(actions).left, right: R(actions).right } : null,
    btns: btns.map((x) => ({ text: x.textContent.trim(), w: R(x).width, left: R(x).left, right: R(x).right, top: R(x).top, icon: Boolean(x.querySelector('svg')), cls: x.className })),
    seat: seat ? { color: getComputedStyle(seat).color, muted, lastIsCal: seat.lastElementChild?.matches('.cal-btn'), lines: Math.round(R(seat.firstElementChild).height / parseFloat(getComputedStyle(seat.firstElementChild).lineHeight)) } : null,
  };
}
async function hero() {
  // The friend's own #1, saved, so Save shows its gold "Saved" state.
  const r = (await w.api('GET', '/api/recommendations', { as: F.robin })).json;
  const top = r.weekly4.find((e) => !e.prerelease || e.prerelease.soon);
  await w.api('POST', '/api/watchlist/toggle', { as: F.robin, body: { tmdb_id: top.tmdb_id } });
  for (const role of ['owner', 'heavy', 'guest']) {
    for (const width of WIDTHS) {
      for (const theme of ['dark', 'light']) {
        const p = await page(role, { width, theme });
        const x = await p.page.evaluate(heroProbe);
        const bad = [];
        if (x.missing) bad.push('no hero');
        else {
          if (!/^#\d this week/.test(x.line || '')) bad.push(`hero line "${x.line}"`);
          if (!(role === 'guest' ? /^Reviews \d+$|^No reviews yet$/ : /^\d+% match( ?early)?$/).test(x.match || '')) bad.push(`match "${x.match}"`);
          if (x.tags.length && (new Set(x.tags.map((t) => t.top)).size > 1 || x.tagRowWrap !== 'nowrap')) bad.push('tags on more than one line');
          if (x.tags.some((t) => /watchlist/i.test(t.text))) bad.push('an On watchlist tag');
          const kinds = x.tags.map((t) => (/\bimax\b|dolby|reald|fmt/.test(t.cls) ? 'format' : 'status'));
          if (kinds.indexOf('format') > 0) bad.push(`the format tag isn't first: ${x.tags.map((t) => t.text).join(', ')}`);
          if (x.imaxElsewhere.length) bad.push(`IMAX repeated outside its tag and Book: ${x.imaxElsewhere.join(', ')}`);
          if (/watchlisted|IMAX/.test(x.reason || '')) bad.push(`reason repeats: "${x.reason}"`);
          if (/through at least/i.test(x.runway || '')) bad.push(`runway "${x.runway}"`);
          if (!x.book) bad.push('no Book button');
          else {
            if (Math.abs(x.book.left - x.actions.left) > 1 || Math.abs(x.book.right - x.actions.right) > 1) bad.push('Book isn\'t full width');
            if (x.book.pills) bad.push('something inside the Book button');
            if (!x.book.disabled && !/^Book \d{1,2}:\d\d [AP]M (today|tonight|tomorrow|Mon|Tue|Wed|Thu|Fri|Sat|Sun)( · .+)?$/.test(x.book.text)) bad.push(`Book reads "${x.book.text}"`);
          }
          const want = role === 'guest' ? ['Details'] : ['Details', role === 'heavy' ? 'Saved' : 'Save', 'Not for me'];
          if (x.btns.map((y) => y.text).join('|') !== want.join('|')) bad.push(`buttons ${x.btns.map((y) => y.text).join('|')}`);
          if (x.btns.length) {
            if (new Set(x.btns.map((y) => Math.round(y.top))).size > 1) bad.push('the buttons aren\'t one row');
            if (Math.max(...x.btns.map((y) => y.w)) - Math.min(...x.btns.map((y) => y.w)) > 1) bad.push('the buttons aren\'t equal widths');
            if (Math.abs(x.btns[0].left - x.actions.left) > 1 || Math.abs(x.btns[x.btns.length - 1].right - x.actions.right) > 1) bad.push('the button row doesn\'t span the width');
            const save = x.btns.find((y) => /wl-btn/.test(y.cls));
            if (save && !save.icon && width > 359) bad.push('Save has no bookmark icon');
          }
          if (x.seat) {
            if (x.seat.color !== x.seat.muted) bad.push('seat line isn\'t muted');
            if (!x.seat.lastIsCal) bad.push('no calendar button at the seat line\'s end');
            if (x.seat.lines > 1) bad.push(`seat line wraps to ${x.seat.lines} lines`);
          } else if (x.book && !x.book.disabled) bad.push('no seat line');
        }
        S.check(`hero ${role} ${theme} ${width}: tags, Book, three buttons and seat line as designed`, !bad.length && !p.errors.length, [...bad, ...p.errors].slice(0, 4).join(' || '));
        await p.ctx.close();
      }
    }
  }
}

// ---------------------------------------------------------------- cards
function cardsProbe(vis) {
  const v = eval(vis); const R = (e) => e.getBoundingClientRect(); const S2 = (e) => getComputedStyle(e);
  const accent = (() => { const t = document.createElement('span'); t.style.color = 'var(--accent-text)'; document.body.appendChild(t); const c = S2(t).color; t.remove(); return c; })();
  const out = { cards: [], badges: [] };
  for (const c of [...document.querySelectorAll('.pick-grid:not(.home-grid) > .pick-card')].filter(v)) {
    const poster = c.querySelector('.pick-poster'); const body = c.querySelector('.pick-body');
    const rank = c.querySelector('.pick-rank'); const title = c.querySelector('.pick-title');
    const times = c.querySelector('.pc-times'); const tools = c.querySelector('.owner-tools');
    const inner = R(c).width - parseFloat(S2(c).paddingLeft) - parseFloat(S2(c).paddingRight);
    out.cards.push({
      title: title.textContent, posterW: R(poster).width, posterBottom: R(poster).bottom, bodyLeft: R(body).left, posterRight: R(poster).right, bodyBottom: R(body).bottom,
      rankInPoster: Boolean(rank && rank.closest('.pick-poster')), rankBeforeTitle: Boolean(rank && rank.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING),
      rankColour: rank ? S2(rank).color === accent : false, rankFont: rank ? S2(rank).fontFamily : '',
      timesTop: R(times).top, timesW: R(times).width, inner, toolsW: tools ? R(tools).width : null,
      hasMatch: Boolean(body.querySelector(':scope > .match')), hasMeta: Boolean(body.querySelector('.pick-meta')),
      noneToday: /No showtimes today/.test(c.textContent),
    });
  }
  for (const m of [...document.querySelectorAll('.match')].filter(v)) {
    const s = S2(m);
    out.badges.push({ text: m.textContent.trim(), dashed: /dashed|dotted/.test(s.borderTopStyle) || /dashed/.test(s.outlineStyle) });
  }
  return out;
}
async function cards() {
  let nextChecked = 0;
  for (const role of ['owner', 'heavy']) {
    const r = (await w.api('GET', '/api/recommendations', { as: ROLES[role] === 'owner' ? null : ROLES[role] })).json;
    for (const width of WIDTHS) {
      for (const theme of ['dark', 'light']) {
        const p = await page(role, { width, theme });
        const x = await p.page.evaluate(cardsProbe, VISIBLE);
        const bad = [];
        for (const c of x.cards) {
          const t = `"${c.title}"`;
          if (c.posterW < 90 || c.posterW > 100) bad.push(`${t}: poster ${c.posterW}px wide`);
          if (c.bodyLeft < c.posterRight) bad.push(`${t}: the facts aren't beside the poster`);
          if (c.rankInPoster) bad.push(`${t}: the rank sits on the poster`);
          if (!c.rankBeforeTitle || !c.rankColour || !/Big Shoulders/.test(c.rankFont)) bad.push(`${t}: the rank isn't an accent numeral before the title`);
          if (!c.hasMatch || !c.hasMeta) bad.push(`${t}: match or meta missing beside the poster`);
          const gap = c.timesTop - Math.max(c.posterBottom, c.bodyBottom);
          if (gap < 0 || gap > 28) bad.push(`${t}: ${Math.round(gap)}px between the top block and the showtime row`);
          if (Math.abs(c.timesW - c.inner) > 1) bad.push(`${t}: the showtime row doesn't span the card`);
          if (c.toolsW != null && Math.abs(c.toolsW - c.inner) > 1) bad.push(`${t}: the action row doesn't span the card`);
          if (c.noneToday) bad.push(`${t}: says "No showtimes today" instead of the next showing`);
        }
        for (const m of x.badges) {
          if (!/^\d+% match( ?early)?$/.test(m.text)) bad.push(`badge "${m.text}"`);
          if (m.dashed) bad.push('a dashed match badge');
        }
        S.check(`cards ${role} ${theme} ${width}: poster beside the facts, rank numeral, rows spanning the card, one match pill`, x.cards.length >= 2 && !bad.length && !p.errors.length, [`${x.cards.length} cards`, ...bad, ...p.errors].slice(0, 5).join(' || '));
        if (width === 390 && theme === 'dark') {
          const cand = [];
          for (const e of r.weekly4.slice(1)) for (const d of r.days) {
            const has = (e.showtimesByDay || []).some((y) => y.date === d.date && y.showtimes.some((s) => !s.past));
            const later = (e.showtimesByDay || []).some((y) => y.date > d.date && y.showtimes.some((s) => !s.past));
            if (!has && later) cand.push([e, d.date]);
          }
          if (cand.length) {
            const [e, day] = cand[0];
            nextChecked++;
            await p.page.locator(`.day-btn[data-date="${day}"]`).click(); await p.page.waitForTimeout(300);
            const nl = await p.page.evaluate((id) => { const c = document.querySelector(`.pick-card[data-id="${id}"] .next-line`); return c ? { text: c.textContent, book: Boolean(c.querySelector('a.st-book[href^="http"], a.st-book[href="#"]')) } : null; }, e.tmdb_id);
            S.check(`cards ${role}: a pick with nothing on the chosen day shows its next showing and Book`, nl && /^Next: (Today|Tomorrow|Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:\d\d [AP]M/.test(nl.text) && nl.book, `"${e.title}" on ${day}: ${JSON.stringify(nl)}`);
          }
        }
        await p.ctx.close();
      }
    }
  }
  S.check('cards: the next-showing line was exercised', nextChecked > 0);
  const p = await page('owner', { width: 390, theme: 'dark', hash: `movie/${EARLY}` });
  const early = await p.page.evaluate(() => { const m = document.querySelector('.hero-line .match'); return m ? { text: m.textContent.trim(), early: Boolean(m.querySelector('.match-early')), border: getComputedStyle(m).borderTopStyle } : null; });
  S.check('cards: an early film\'s badge is the same pill with the word early, no dashes', early && early.early && /^\d+% match ?early$/.test(early.text) && early.border === 'none', JSON.stringify(early));
  await p.ctx.close();
}

// ---------------------------------------------------------------- rows
function rowsProbe(vis) {
  const v = eval(vis); const R = (e) => e.getBoundingClientRect(); const S2 = (e) => getComputedStyle(e);
  const tok = (n, prop = 'color') => { const t = document.createElement('span'); t.style[prop] = `var(--${n})`; document.body.appendChild(t); const c = S2(t)[prop]; t.remove(); return c; };
  const out = { groups: [], bad: [], chips: [] };
  const byParent = new Map();
  for (const r of [...document.querySelectorAll('.st-row')].filter(v)) {
    const key = r.closest('.st-list, .pc-times, .row-wide, .hero-actions, .lv-film-body, .day-block') || r.parentElement;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(r);
  }
  for (const list of byParent.values()) {
    out.groups.push(list.map((r) => {
      const c = (s) => r.querySelector(s);
      const cells = ['.st-time', '.st-fmt', '.st-end', '.st-fit', '.st-book', '.st-cal'].map((s) => c(s));
      r.scrollIntoView({ block: 'center' });
      const time = R(cells[0]);
      const hit = document.elementFromPoint(time.left + time.width / 2, time.top + time.height / 2);
      const bookEl = r.querySelector('a.st-book');
      const fit = c('.st-fit');
      return {
        text: r.textContent.trim().slice(0, 50), h: R(r).height,
        lefts: cells.slice(0, 4).map((e) => Math.round(R(e).left)), rights: cells.slice(4).map((e) => Math.round(R(e).right)),
        mids: cells.map((e) => (R(e).height > 0 && (e.textContent.trim() || e.querySelector('svg, .tag')) ? Math.round((R(e).top + R(e).bottom) / 2) : null)),
        bookHit: bookEl ? hit === bookEl || bookEl.contains(hit) : null, past: r.classList.contains('past'),
        fitText: fit.textContent.trim(), fitIcon: Boolean(fit.querySelector('svg')), fitColour: S2(fit).color,
        bookColour: bookEl ? S2(bookEl).color : null, bookArrow: bookEl ? Boolean(bookEl.querySelector('svg')) : null,
        calInside: Boolean(r.querySelector('.st-cal.cal-btn')), calW: r.querySelector('.cal-btn') ? R(r.querySelector('.cal-btn')).width : 0,
        seat: /be there by/i.test(r.textContent),
      };
    }));
  }
  if (document.querySelector('.st-pair, .showtime-chip')) out.bad.push('old showtime chips or the separate calendar square are still in the page');
  out.good = tok('good'); out.acc = tok('accent-text');
  const bgOf = (e) => { for (let a = e.parentElement; a; a = a.parentElement) { const c = S2(a).backgroundColor; if (!/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; } return S2(document.body).backgroundColor; };
  for (const t of [...document.querySelectorAll('.tag')].filter(v)) out.chips.push({ text: t.textContent.trim(), cls: t.className, fg: S2(t).color, bg: S2(t).backgroundColor, under: bgOf(t) });
  out.tints = Object.fromEntries(['blue-soft', 'purple-soft', 'teal-soft', 'amber-soft', 'bad-soft'].map((n) => [n, tok(n, 'backgroundColor')]));
  return out;
}
async function rows() {
  let nRows = 0; let nPast = 0; let nChips = 0;
  const seenTags = new Set();
  for (const role of ['owner', 'heavy']) {
    for (const width of WIDTHS) {
      for (const theme of ['dark', 'light']) {
        for (const hash of ['home', `movie/${MOVIE}`, `movie/${C.PLAYING[1].id}`, `movie/${C.PLAYING[2].id}`, 'schedule/leaving']) {
          const p = await page(role, { width, theme, hash });
          if (hash === 'home') { const m = p.page.locator('.row-more').first(); if (await m.count()) { await m.scrollIntoViewIfNeeded(); await m.click(); await p.page.waitForTimeout(200); } }
          const x = await p.page.evaluate(rowsProbe, VISIBLE);
          const bad = [...x.bad];
          for (const g of x.groups) {
            for (const r of g) {
              nRows++; if (r.past) nPast++;
              const t = `"${r.text}"`;
              if (r.h > (width >= 375 ? 52 : 70)) bad.push(`${t}: row is ${Math.round(r.h)}px tall`);
              const mids = r.mids.filter((m) => m != null);
              if (width >= 375 && Math.max(...mids) - Math.min(...mids) > 4) bad.push(`${t}: cells aren't on one line (${r.mids.join('/')})`);
              if (width < 375) { const [tm, , en, , bk] = r.mids; if (tm == null || bk == null || Math.abs(tm - bk) > 4 || en == null || en <= tm + 8) bad.push(`${t}: the 320 layout isn't the fixed two lines (${r.mids.join('/')})`); }
              if (r.seat) bad.push(`${t}: "be there by" in a row`);
              if (!r.past) {
                if (r.bookHit === false) bad.push(`${t}: tapping the row doesn't book`);
                if (r.bookColour !== x.acc || !r.bookArrow) bad.push(`${t}: Book isn't accent text with its arrow`);
                if (!r.calInside || r.calW > 32) bad.push(`${t}: no small calendar button inside the row`);
              }
              if (r.fitText && (r.fitText !== 'Fits' || !r.fitIcon || r.fitColour !== x.good)) bad.push(`${t}: fits shows "${r.fitText}"`);
            }
            for (let k = 0; k < 4; k++) if (new Set(g.map((r) => r.lefts[k])).size > 1) bad.push(`column ${['time', 'format', 'ends', 'fits'][k]} isn't lined up across ${g.length} rows`);
            for (let k = 0; k < 2; k++) if (new Set(g.map((r) => r.rights[k])).size > 1) bad.push(`${['Book', 'calendar'][k]} isn't lined up across the rows`);
          }
          for (const c of x.chips) {
            nChips++; seenTags.add(c.text);
            const kind = /\bimax\b/.test(c.cls) ? 'blue-soft' : /\bdolby\b/.test(c.cls) ? 'purple-soft' : /\b(reald|back|teal)\b/.test(c.cls) ? 'teal-soft' : /\b(fmt|new|opens|amber)\b/.test(c.cls) ? 'amber-soft' : /\b(last|hidden|bad)\b/.test(c.cls) ? 'bad-soft' : null;
            if (kind && c.bg !== x.tints[kind]) bad.push(`tag "${c.text}" isn't ${kind}`);
            if (/^Back in theaters$/.test(c.text) && kind !== 'teal-soft') bad.push('Back in theaters isn\'t teal');
            if (/^Last chance$/.test(c.text) && kind !== 'bad-soft') bad.push('Last chance isn\'t red');
            const cr = ratio(parse(c.fg), over(parse(c.bg), parse(c.under)));
            if (cr < 4.5) bad.push(`tag "${c.text}" is ${cr.toFixed(2)}:1`);
          }
          S.check(`rows ${role} ${theme} ${width} ${hash.replace('/', ' ')}: one grid per list, tinted tags at AA`, !bad.length && !p.errors.length, [...bad, ...p.errors].slice(0, 5).join(' || '));
          await p.ctx.close();
        }
      }
    }
  }
  S.check('rows: enough showtime rows measured, started ones included', nRows >= 150 && nPast >= 8, `${nRows} rows, ${nPast} started`);
  const want = ['IMAX', 'Dolby', '3D', 'Back in theaters', 'Last chance'];
  const missingTags = want.filter((t) => ![...seenTags].some((s) => s.startsWith(t)));
  S.check('rows: IMAX, Dolby, 3D (RealD), Back in theaters and Last chance tags were all measured', !missingTags.length, `missing ${missingTags.join(', ')}; saw ${[...seenTags].join(', ')}`);
}

// ---------------------------------------------------------------- details
async function details() {
  const detail = (await w.api('GET', `/api/movies/${MOVIE}`)).json;
  S.check('details: the test film has an AMC match to show', Boolean(detail.match));
  for (const width of WIDTHS) {
    for (const theme of ['dark', 'light']) {
      const p = await page('owner', { width, theme, hash: `movie/${MOVIE}` });
      const m = await p.page.evaluate(() => {
        const el = document.querySelector('.match-line'); if (!el) return null;
        const nw = el.querySelector('.nowrap'); const mid = (r) => (r.top + r.bottom) / 2;
        const mids = [...nw.getClientRects()].map(mid);
        return { text: el.textContent.trim(), links: [...el.querySelectorAll('a, button')].map((l) => l.textContent), nowrapLines: Math.max(...mids) - Math.min(...mids) < 8 ? 1 : 2, fixSameLine: Math.abs(mid(el.querySelector('.match-fix').getBoundingClientRect()) - mids[0]) < 8, colour: getComputedStyle(el).color, size: getComputedStyle(el).fontSize };
      });
      const muted = await token(p.page, 'muted');
      S.check(`details ${theme} ${width}: the owner's match line reads "Matched to '…' · Fix", small, muted, Fix never alone`, m && /^Matched to '.+' · Fix$/.test(m.text) && m.links.join('|') === 'Fix' && m.nowrapLines === 1 && m.fixSameLine && m.colour === muted && parseFloat(m.size) <= 13, JSON.stringify(m));
      await p.ctx.close();
    }
  }
  for (const [name, same] of [['same', true], ['different', false]]) {
    const p = await page('owner', { width: 390, theme: 'dark', hash: null });
    const svc = (id, n) => ({ id, name: n, logo: null });
    await p.page.route(/\/api\/providers\?/, (r) => {
      const ids = new URL(r.request().url()).searchParams.get('ids').split(',');
      const rent = [svc(2, 'Apple TV'), svc(3, 'Google Play')];
      const buy = same ? [svc(3, 'Google Play'), svc(2, 'Apple TV')] : [svc(2, 'Apple TV'), svc(10, 'Amazon')];
      r.fulfill({ contentType: 'application/json', body: JSON.stringify({ providers: Object.fromEntries(ids.map((i) => [i, { stream: [svc(8, 'Netflix')], rent, buy, link: 'https://example.test/watch' }])) }) });
    });
    await go(p.page, w, `movie/${C.RATED[2].id}`, 900);
    const kinds = await p.page.locator('.stream-card .stream-kind').allTextContents();
    const want = same ? 'Stream,Rent or buy' : 'Stream,Rent,Buy';
    S.check(`details: Where to watch with ${name} rent and buy services shows ${want}`, kinds.join(',') === want, kinds.join(','));
    await p.ctx.close();
  }
  for (const width of WIDTHS) {
    for (const theme of ['dark', 'light']) {
      const p = await page('owner', { width, theme });
      const accent = await token(p.page, 'accent', 'backgroundColor');
      const st = await p.page.evaluate(() => {
        const strip = document.querySelector('.day-strip'); const bar = strip.querySelector('.day-picker');
        const more = bar.scrollWidth > bar.clientWidth + 2;
        const fadeOn = strip.classList.contains('more') && getComputedStyle(strip, '::after').opacity === '1';
        bar.scrollLeft = bar.scrollWidth;
        return { more, fadeOn, active: getComputedStyle(bar.querySelector('.day-btn.active')).backgroundColor };
      });
      await p.page.waitForTimeout(400);
      const after = await p.page.evaluate(() => document.querySelector('.day-strip').classList.contains('more'));
      S.check(`details ${theme} ${width}: the chosen day is filled accent and the right-edge fade shows only while more days are off screen`, st.active === accent && (st.more ? st.fadeOn && !after : !st.fadeOn), JSON.stringify({ ...st, after }));
      await p.ctx.close();
    }
  }
  for (const role of ['owner', 'heavy']) {
    for (const width of WIDTHS) {
      for (const theme of ['dark', 'light']) {
        const p = await page(role, { width, theme, hash: 'settings' });
        const pg = p.page;
        const bad = [];
        const g = await pg.evaluate(() => [...document.querySelectorAll('.window-times')].map((row) => {
          const body = row.closest('.group-body').getBoundingClientRect(); const pad = parseFloat(getComputedStyle(row.closest('.group-body')).paddingRight);
          const [a, b2] = [...row.querySelectorAll('input')].map((i) => i.getBoundingClientRect());
          return { aw: a.width, bw: b2.width, gap: b2.left - a.right, inside: a.left >= body.left - 0.5 && b2.right <= body.right - pad + 0.5 };
        }));
        if (!g.length) bad.push('no preferred-showtime fields');
        for (const x of g) {
          if (Math.abs(x.aw - x.bw) > 1) bad.push(`After and Before aren't equal (${x.aw}/${x.bw})`);
          if (x.gap < 8) bad.push(`After and Before touch (gap ${x.gap})`);
          if (!x.inside) bad.push('the time fields run past their group');
        }
        const accent = await token(pg, 'accent', 'backgroundColor');
        const s0 = await pg.evaluate(() => ({ shown: document.querySelector('.save-bar').classList.contains('show'), vis: getComputedStyle(document.querySelector('.save-bar')).visibility, plan: getComputedStyle(document.querySelector('.plan-chips .chip.active')).backgroundColor, check: getComputedStyle(document.querySelector('input[type=checkbox]')).accentColor }));
        if (s0.shown || s0.vis !== 'hidden') bad.push('the Save bar shows with nothing changed');
        if (s0.plan !== accent) bad.push('the chosen plan chip isn\'t filled accent');
        if (s0.check !== accent) bad.push(`checkboxes aren't the accent (${s0.check})`);
        const box = pg.locator('label.switch-row:has-text("Prefer IMAX") input');
        await box.scrollIntoViewIfNeeded(); await box.click(); await pg.waitForTimeout(400);
        const s1 = await pg.evaluate(() => {
          const bar = document.querySelector('.save-bar'); const r = bar.getBoundingClientRect();
          const nav = document.querySelector('.bottom-nav'); const nr = nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect() : null;
          return { shown: bar.classList.contains('show'), vis: getComputedStyle(bar).visibility, bottom: r.bottom, navTop: nr ? nr.top : innerHeight, has: document.body.classList.contains('has-save') };
        });
        if (!s1.shown || s1.vis !== 'visible' || !s1.has) bad.push('a change doesn\'t bring the Save bar up');
        if (Math.abs(s1.bottom - s1.navTop) > 1) bad.push(`the Save bar doesn't sit on the tab bar (${s1.bottom} vs ${s1.navTop})`);
        await box.click(); await pg.waitForTimeout(400);
        if (await pg.evaluate(() => document.querySelector('.save-bar').classList.contains('show'))) bad.push('undoing the change leaves the Save bar up');
        await box.click(); await pg.waitForTimeout(300);
        await pg.locator('.save-bar .btn').click();
        await pg.waitForFunction(() => !document.querySelector('.save-bar').classList.contains('show'), null, { timeout: 5000 }).catch(() => {});
        const s2 = await pg.evaluate(() => ({ shown: document.querySelector('.save-bar').classList.contains('show'), has: document.body.classList.contains('has-save') }));
        if (s2.shown || s2.has) bad.push('the Save bar stays after saving');
        // Put the setting back.
        await box.click(); await pg.waitForTimeout(300); await pg.locator('.save-bar .btn').click(); await pg.waitForTimeout(500);
        S.check(`details ${role} ${theme} ${width}: Settings time fields, Save bar, plan chip and checkboxes as designed`, !bad.length && !p.errors.length, [...bad, ...p.errors].slice(0, 4).join(' || '));
        await p.ctx.close();
      }
    }
  }
}

// ---------------------------------------------------------------- glow
async function glow() {
  const rowsDb = w.q('SELECT tmdb_id, poster, poster_color, poster_color_src FROM movies WHERE poster IS NOT NULL AND (playing = 1 OR upcoming = 1)');
  const stored = rowsDb.filter((r) => r.poster_color);
  S.check('glow: every playing film with a poster has a stored colour naming its poster', rowsDb.length > 0 && stored.length === rowsDb.length && stored.every((r) => r.poster_color_src === r.poster), `${stored.length}/${rowsDb.length}`);
  const colours = stored.map((r) => r.poster_color).filter((c) => c !== '-');
  S.check('glow: stored colours are hex colours', colours.length > 0 && colours.every((c) => /^#[0-9a-f]{6}$/.test(c)));
  const p = await page('owner', { width: 390, theme: 'dark' });
  const TOK = ['text', 'muted', 'accent-text', 'good', 'bad', 'gold', 'blue', 'purple', 'teal', 'amber'];
  const t = await p.page.evaluate((names) => { const tmp = document.createElement('span'); document.body.appendChild(tmp); const out = {}; for (const n of [...names, 'bg', 'accent', 'accent-soft', 'teal-soft', 'blue-soft', 'bad-soft', 'amber-soft']) { tmp.style.color = `var(--${n})`; out[n] = getComputedStyle(tmp).color; } tmp.remove(); return out; }, TOK);
  const bg = parse(t.bg);
  const weak = [];
  for (const [c, strength] of [...colours.map((x) => [x, 0.3]), [t.accent, 0.1]]) {
    const glowBg = over({ ...parse(c), a: strength }, bg);
    for (const k of TOK) { const r = ratio(parse(t[k]), glowBg); if (r < 4.5) weak.push(`--${k} over ${c} ${r.toFixed(2)}:1`); }
    for (const [fill, fg] of [['teal-soft', 'teal'], ['blue-soft', 'blue'], ['accent-soft', 'accent-text'], ['bad-soft', 'bad'], ['amber-soft', 'amber']]) { const r = ratio(parse(t[fg]), over(parse(t[fill]), glowBg)); if (r < 4.5) weak.push(`--${fg} on --${fill} over ${c} ${r.toFixed(2)}:1`); }
  }
  S.check('glow: every text colour keeps AA over the brightest point of every stored glow', !weak.length, weak.slice(0, 4).join('; '));
  const recs = (await w.api('GET', '/api/recommendations')).json;
  const top = recs.weekly4.find((e) => !e.prerelease || e.prerelease.soon);
  const pick = await p.page.evaluate(() => { const shell = document.querySelector('.shell'); const g = document.querySelector('.page-glow'); const s = getComputedStyle(g); return { has: shell.classList.contains('has-glow'), faint: shell.classList.contains('glow-faint'), colour: shell.style.getPropertyValue('--glow-color').trim(), display: s.display, image: s.backgroundImage, height: g.getBoundingClientRect().height }; });
  S.check('glow: Picks (dark) draws a radial glow in the #1 film\'s colour, about 700px tall', pick.has && pick.display !== 'none' && /radial-gradient/.test(pick.image) && (top.glow ? pick.colour.toLowerCase() === top.glow : pick.faint) && pick.height >= 650 && pick.height <= 820, JSON.stringify({ ...pick, want: top.glow }));
  const withC = stored.find((r) => r.tmdb_id === MOVIE && r.poster_color !== '-');
  for (const [id, want] of [[withC.tmdb_id, withC.poster_color], [NO_GLOW, 'faint']]) {
    await go(p.page, w, `movie/${id}`, 500);
    const m = await p.page.evaluate(() => ({ has: document.querySelector('.shell').classList.contains('has-glow'), faint: document.querySelector('.shell').classList.contains('glow-faint'), colour: document.querySelector('.shell').style.getPropertyValue('--glow-color').trim(), display: getComputedStyle(document.querySelector('.page-glow')).display }));
    S.check(`glow: a movie page ${want === 'faint' ? 'without a colour draws the faint amber' : 'draws its stored colour'}`, m.has && m.display !== 'none' && (want === 'faint' ? m.faint : m.colour.toLowerCase() === want), JSON.stringify(m));
  }
  await go(p.page, w, 'stats', 500);
  S.check('glow: leaving for Stats takes the glow away', await p.page.evaluate(() => getComputedStyle(document.querySelector('.page-glow')).display === 'none'));
  S.check('glow: no console error or failed request (dark)', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
  const l = await page('owner', { width: 390, theme: 'light', hash: null });
  for (const h of ['home', `movie/${withC.tmdb_id}`]) {
    await go(l.page, w, h, 500);
    S.check(`glow: light ${h.split('/')[0]} draws no glow`, await l.page.evaluate(() => getComputedStyle(document.querySelector('.page-glow')).display === 'none'));
  }
  await l.ctx.close();
}

// ---------------------------------------------------------------- New this week (D13)
// Its own world with refreshes and a fast clock: the week locks on Friday,
// then the thin film earns a score and swaps into the four on Monday.
async function tag() {
  const tw = await openWorld('picks-tag', { refresh: true, env: { RP_TIMER_SCALE: '0.002' } });
  try {
    const refreshed = (day) => until(async () => { const s = (await tw.api('GET', '/api/status')).json; return s && !s.refreshing && s.lastRefresh && C.ymdLocal(new Date(s.lastRefresh)) === day && s; }, 60000, 150);
    // Hollow Summer's run is cut short at AMC before Friday, so the four stays
    // full all week (a film leaving would be refilled, not swapped); the owner
    // saves the thin film, so once it earns a score it beats #4 by 5 or more.
    tw.amc.gone.add(C.PLAYING[6].amcId);
    await tw.api('POST', '/api/watchlist/toggle', { body: { tmdb_id: EARLY } });
    await tw.jump('2026-09-25T00:00:30-04:00');
    S.check('tag setup: Friday\'s refresh ran and locked the week', Boolean(await refreshed('2026-09-25')));
    tw.ctrl.omdb[EARLY] = { imdb: 9.5, rt: 100, meta: 99 };
    tw.writeCtrl();
    await tw.jump('2026-09-28T00:30:00-04:00');
    S.check('tag setup: Monday\'s refresh ran', Boolean(await refreshed('2026-09-28')));
    await sleep(400);
    const r = (await tw.api('GET', '/api/recommendations')).json;
    const swapped = (r.weekly4 || []).find((e) => e.pick?.newThisWeek);
    S.check('tag setup: the owner\'s four has a swapped-in film', Boolean(swapped), (r.weekly4 || []).map((e) => `${e.title}${e.pick?.newThisWeek ? '*' : ''}`).join(', '));
    const tb = await launch();
    try {
      for (const role of ['owner', 'guest']) {
        for (const theme of ['light', 'dark']) {
          for (const width of WIDTHS) {
            const p = await open(tb, tw, { role, width, theme });
            await realSizePosters(p.ctx);
            await go(p.page, tw, 'home', 500);
            const m = await p.page.evaluate(() => {
              const parse2 = (c) => { const x = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/); return x ? { r: +x[1], g: +x[2], b: +x[3], a: x[4] == null ? 1 : +x[4] } : null; };
              const over2 = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
              const lum = (c) => { const l2 = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * l2(c.r) + 0.7152 * l2(c.g) + 0.0722 * l2(c.b); };
              const bgOf = (el) => { const layers = []; for (let a = el; a && a.nodeType === 1; a = a.parentElement) { const c = parse2(getComputedStyle(a).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } } let base = parse2(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 }; for (let i = layers.length - 1; i >= 0; i--) base = over2(layers[i], base); return base; };
              const tags = [...document.querySelectorAll('.tag, .badge')].filter((b) => /New this week/.test(b.textContent) && b.getBoundingClientRect().width > 0);
              return {
                tags: tags.map((t) => {
                  const r = t.getBoundingClientRect(); const card = t.closest('.pick-card, .hero-pick') || t.parentElement; const cr = card.getBoundingClientRect();
                  const bg = bgOf(t); const fg = over2(parse2(getComputedStyle(t).color), bg); const x = lum(fg); const y = lum(bg);
                  return { inside: r.left >= cr.left - 0.5 && r.right <= cr.right + 0.5 && r.left >= 0 && r.right <= innerWidth, contrast: (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05), title: (card.querySelector('.pick-title, .hero-title, h2, h3') || {}).textContent || '' };
                }),
                wide: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
              };
            });
            const t0 = m.tags[0];
            // The guest link has no lock, so no swap and no tag.
            if (role === 'guest') S.check(`tag guest ${theme} ${width}: no New this week tag (the guest's four is the top four by reviews)`, m.tags.length === 0, JSON.stringify(m.tags));
            else S.check(`tag ${role} ${theme} ${width}: one New this week tag, on the swapped-in film, inside its card, AA`, swapped && m.tags.length === 1 && t0.inside && t0.contrast >= 4.5 && t0.title.includes(swapped.title), JSON.stringify(m.tags));
            S.check(`tag ${role} ${theme} ${width}: Picks has no console error, failed request or sideways scroll`, !p.errors.length && m.wide, p.errors.slice(0, 2).join(' | '));
            await p.ctx.close();
          }
        }
      }
    } finally { await tb.close(); }
  } finally {
    S.world(tw);
    await tw.close();
  }
}

await S.step('controls: a pick with an empty day, started showings', controls);
await S.step('hero, cards, rows, details, glow and the New this week tag', async () => {
  const parts = [hero, cards, rows, details, glow, tag];
  const errs = [];
  await Promise.all(Array.from({ length: 4 }, async () => { while (parts.length) { const f = parts.shift(); try { await f(); } catch (e) { errs.push(`${f.name}: ${String(e.stack || e).split('\n').slice(0, 3).join(' | ')}`); } } }));
  for (const e of errs) S.check(`${e.split(':')[0]} ran to the end`, false, e);
});

await browser.close();
await w.close();
S.finish();
