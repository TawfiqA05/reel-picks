// Files that are read as one text by the checks that look at source code:
// the stylesheet's parts (in the order server/lib/styles.js joins them), the API routes
// (server/routes.js and the area files it mounts) and the Settings view
// (views/settings.js and the cards it imports). Paths are repo-relative.
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const rel = (from, spec) => path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));

export const CSS_FILES = JSON.parse(read('server/lib/styles.js').match(/STYLE_PARTS = (\[[^\]]+\])/)[1].replace(/'/g, '"')).map((p) => `public/${p}`);
export const ROUTE_FILES = ['server/routes.js', ...[...read('server/routes.js').matchAll(/^import \w+ from '(\.\/routes\/[^']+)';/gm)].map((m) => rel('server/routes.js', m[1]))];
export const SETTINGS_FILES = ['public/js/views/settings.js', ...[...read('public/js/views/settings.js').matchAll(/^import .* from '(\.\/settings\/[^']+)';/gm)].map((m) => rel('public/js/views/settings.js', m[1]))];

export const readAll = (files) => files.map(read).join('\n');
