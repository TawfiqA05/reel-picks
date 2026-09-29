// The Theme switch, the parts that need no browser (the browser half is
// test/ui/theme.mjs): the script at the top of index.html comes before the
// stylesheet and after the browser-bar colours, and applies a kept choice to
// <html> and both colours (run here in a stand-in document); the Join page
// carries the same script; styles.css has one guarded dark block and a
// forced-Dark block with the same values, and the dark-only glow and the
// soft red hover come from the palettes; Settings has the control, the
// server never hears of it, and Help and the README say how it works.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { suite } from '../lib/check.mjs';
import { openWorld, REPO } from '../lib/world.mjs';

const S = suite('theme');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const html = read('public/index.html');
const css = read('public/styles.css');

await S.step('index.html: the script comes first and does what it says', async () => {
  const script = html.match(/<script id="rp-theme">([\s\S]*?)<\/script>/);
  S.check('index.html has the Theme script', Boolean(script));
  const at = (re) => html.search(re);
  S.check('it comes after both browser-bar colours and before any stylesheet or module',
    at(/<script id="rp-theme">/) > at(/<meta name="theme-color" content="#0f1526"/) && at(/<script id="rp-theme">/) > at(/<meta name="theme-color" content="#F2EADB"/)
    && at(/<script id="rp-theme">/) < at(/<link rel="stylesheet"/) && at(/<script id="rp-theme">/) < at(/<link rel="modulepreload"/) && at(/<script id="rp-theme">/) < at(/<\/head>/));
  S.check('it is a plain inline script (runs while the head is parsed, not deferred)', !/<script id="rp-theme"[^>]*\b(type="module"|defer|async|src=)/.test(html));
  // Run it in a stand-in document with each kept value.
  const run = (kept, { throws = false } = {}) => {
    const attrs = {};
    const metas = [
      { media: '(prefers-color-scheme: light)', content: '#F2EADB', a: {}, setAttribute(k, v) { this.a[k] = v; if (k === 'content') this.content = v; }, getAttribute(k) { return this.a[k]; } },
      { media: '(prefers-color-scheme: dark)', content: '#0f1526', a: {}, setAttribute(k, v) { this.a[k] = v; if (k === 'content') this.content = v; }, getAttribute(k) { return this.a[k]; } },
    ];
    const store = new Map(kept == null ? [] : [['rp.theme', kept]]);
    const listeners = [];
    const localStorage = {
      getItem: (k) => { if (throws) throw new Error('off'); return store.has(k) ? store.get(k) : null; },
      setItem: (k, v) => { if (throws) throw new Error('off'); store.set(k, String(v)); },
      removeItem: (k) => { if (throws) throw new Error('off'); store.delete(k); },
    };
    const window = { addEventListener: (t, f) => listeners.push([t, f]) };
    const document = {
      documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, getAttribute: (k) => attrs[k] ?? null },
      querySelectorAll: (q) => (q === 'meta[name="theme-color"]' ? metas : []),
    };
    vm.runInNewContext(script[1], { window, document, localStorage });
    return { attrs, bars: () => metas.map((m) => m.content), store, api: window.rpTheme, listeners };
  };
  const none = run(null);
  S.check('nothing kept: no data-theme, each browser-bar colour its own, get() is system', !('data-theme' in none.attrs) && none.bars().join() === '#F2EADB,#0f1526' && none.api.get() === 'system');
  const dark = run('dark');
  S.check('Dark kept: data-theme="dark" and both browser-bar colours the navy', dark.attrs['data-theme'] === 'dark' && dark.bars().join() === '#0f1526,#0f1526' && dark.api.get() === 'dark');
  const light = run('light');
  S.check('Light kept: data-theme="light" and both browser-bar colours the cream', light.attrs['data-theme'] === 'light' && light.bars().join() === '#F2EADB,#F2EADB' && light.api.get() === 'light');
  const junk = run('purple');
  S.check('anything else kept counts as Match system', !('data-theme' in junk.attrs) && junk.api.get() === 'system');
  light.api.set('dark');
  S.check('set("dark") keeps it and applies it', light.store.get('rp.theme') === 'dark' && light.attrs['data-theme'] === 'dark' && light.bars().join() === '#0f1526,#0f1526');
  light.api.set('system');
  S.check('set("system") forgets the choice and gives each colour back', !light.store.has('rp.theme') && !('data-theme' in light.attrs) && light.bars().join() === '#F2EADB,#0f1526');
  const off = run(null, { throws: true });
  let ok = true;
  try { off.api.set('dark'); } catch { ok = false; }
  S.check('with storage off it still applies for this visit and never throws', ok && off.attrs['data-theme'] === 'dark' && off.api.get() === 'system');
  S.check('it listens for a change made in another tab', none.listeners.some(([t]) => t === 'storage'));
});

await S.step('styles.css: one guarded dark block, a forced-Dark twin, palette-driven glow and hover', async () => {
  const media = [...css.matchAll(/@media[^{]*prefers-color-scheme[^{]*\{\s*([^{]*)\{/g)];
  S.check('one prefers-color-scheme block, which a chosen Light turns off', media.length === 1 && media[0][1].trim() === ':root:not([data-theme="light"])', media.map((m) => m[0]).join(' || '));
  const decls = (s) => (s || '').replace(/\/\*[\s\S]*?\*\//g, '').split(';').map((x) => x.trim()).filter(Boolean);
  const sys = decls(css.match(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/)?.[1]);
  const forced = decls(css.match(/\n:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/)?.[1]);
  S.check('the forced-Dark block has the same declarations, in the same order', sys.length > 25 && sys.join(';') === forced.join(';'), `${sys.length} vs ${forced.length}`);
  S.check('color-scheme is dark in both dark blocks', sys.includes('color-scheme: dark') && forced.includes('color-scheme: dark'));
  const light = decls(css.match(/\/\* ---- palettes ----[\s\S]*?:root \{([\s\S]*?)\n\}/)?.[1]);
  const names = (d) => d.map((x) => x.split(':')[0]).filter((n) => n.startsWith('--')).sort();
  const extra = names(sys).filter((n) => !names(light).includes(n));
  S.check('every dark token also has a light value', !extra.length, extra.join(', '));
  S.check('the glow shows through --glow-display (none in light, block in dark)', light.includes('--glow-display: none') && sys.includes('--glow-display: block') && /\.shell\.has-glow \.page-glow \{[^}]*display: var\(--glow-display\)/.test(css));
  S.check('no rule outside the palettes asks for dark mode', !/@media \(prefers-color-scheme: dark\) \{ *\./.test(css));
});

await S.step('Settings, Help and the README; the server never hears of it', async () => {
  const settings = read('public/js/views/settings.js');
  S.check('Settings has the Appearance group with the Theme control', /card\('Appearance'/.test(settings) && /role: 'radiogroup', 'aria-labelledby': 'theme-label'/.test(settings) && /'Theme'/.test(settings));
  S.check('each part is named Match system, Light and Dark', /name: 'Match system'/.test(settings) && /name: 'Light'/.test(settings) && /name: 'Dark'/.test(settings));
  const server = fs.readdirSync(path.join(REPO, 'server'), { recursive: true }).filter((f) => f.endsWith('.js')).filter((f) => /rp\.theme|rpTheme|data-theme/.test(read(path.join('server', f))));
  S.check('no server file stores or reads the choice', !server.length, server.join(', '));
  const help = read('public/js/views/help.js');
  const line = help.match(/\['Theme', '([^\n]*)'\]/)?.[1] || '';
  S.check('Help has a Theme line: Settings, the three choices, this device only, the iPhone launch screen', /Settings/.test(line) && /Light/.test(line) && /Dark/.test(line) && /Match system/.test(line) && /this device only/.test(line) && /iPhone/.test(line) && !/—/.test(line), line);
  const readme = read('README.md');
  S.check('the README says it, in the first person', /unless I pick Light or Dark under Theme/.test(readme) && /kept on each device only/.test(readme) && /installed iPhone app shows while it opens/.test(readme) && /\*\*Appearance\*\*/.test(readme));
});

await S.step('the Join page carries the same script', async () => {
  const w = S.world(await openWorld('theme'));
  const jf = await w.api('POST', '/api/friends', { body: { name: 'Morgan' } });
  const token = new URL(jf.json.invite, 'http://x').searchParams.get('invite');
  const page = await (await fetch(`${w.base}/?invite=${token}`, { headers: { 'cf-ray': 'test' } })).text();
  const mine = html.match(/<script id="rp-theme">[\s\S]*?<\/script>/)[0];
  S.check('the Join page has the Theme script, word for word', page.includes(mine));
  S.check('on the Join page it comes after the browser-bar colours and before the stylesheet',
    page.indexOf(mine) > page.lastIndexOf('<meta name="theme-color"') && page.indexOf(mine) < page.indexOf('<link rel="stylesheet" href="/styles.css"'));
  const expired = await (await fetch(`${w.base}/?invite=not-a-token`, { headers: { 'cf-ray': 'test' } })).text();
  S.check('so does the expired-invite page', expired.includes(mine));
  await w.close();
});

S.finish();
