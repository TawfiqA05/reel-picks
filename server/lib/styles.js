// The stylesheet is kept in parts by area: public/styles.css (the theme
// tokens and the base), then the files in public/css/ in the order listed
// here, which is the cascade order. A page asks for /styles.css and gets the
// parts as one sheet, one request compressed as one, as it was before the
// split. Read once at start-up, like the page itself (lib/version.js).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const STYLE_PARTS = ['styles.css', 'css/controls.css', 'css/picks.css', 'css/pages.css', 'css/features.css'];
const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));

let sheet = null;
export function sendStyles(req, res) {
  sheet ??= Buffer.concat(STYLE_PARTS.map((p) => fs.readFileSync(publicDir + p)));
  res.set('Cache-Control', 'public, max-age=0');
  res.type('css').send(sheet);
}
