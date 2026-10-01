// The deployed app version: the service worker's cache name in public/sw.js
// ("reelpicks-v52"), read once at start-up. A deploy restarts the server, so
// this always names the code being served. The page carries the version it
// was built from in index.html (sendIndex below fills it in); js/update.js
// compares the two to notice a new deploy even when the service worker's own
// update check didn't get through.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEMO } from '../demo/mode.js';

const swPath = fileURLToPath(new URL('../../public/sw.js', import.meta.url));
const indexPath = fileURLToPath(new URL('../../public/index.html', import.meta.url));

function readVersion() {
  try {
    return fs.readFileSync(swPath, 'utf8').match(/const CACHE = '([^']+)'/)?.[1] || null;
  } catch { return null; }
}

export const appVersion = readVersion();

let indexHtml = null;
// index.html with its version filled in. Never cached by the browser: it is
// the one file that says which version the rest belongs to.
export function sendIndex(req, res) {
  indexHtml ??= fs.readFileSync(indexPath, 'utf8').replace('__RP_VERSION__', appVersion || '')
    // Demo mode (server/demo/): the page shows its banner and its "Off in the demo" lines.
    .replace('<html lang="en">', DEMO ? '<html lang="en" data-demo>' : '<html lang="en">');
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(indexHtml);
}
