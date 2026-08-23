// `npm run share` — start the Reel Picks server in read-only-guest mode and a
// Cloudflare quick tunnel, then print the public trycloudflare URL.
//
// The link only works while this process is running and your Mac is awake.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PORT = process.env.PORT || '5170';
const root = fileURLToPath(new URL('..', import.meta.url));

function findCloudflared() {
  const candidates = [
    `${homedir()}/.local/bin/cloudflared`,
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared',
    'cloudflared', // rely on PATH
  ];
  for (const c of candidates) {
    if (c === 'cloudflared' || existsSync(c)) return c;
  }
  return 'cloudflared';
}

const cloudflared = findCloudflared();

// 1. Server, with guest mode on. Localhost stays full-access; tunnel is read-only.
const server = spawn('node', ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
  cwd: root,
  env: { ...process.env, GUEST_MODE: '1' }, // OWNER_NAME / OWNER_TOKEN come from .env
  stdio: 'inherit',
});

// 2. Cloudflare quick tunnel (no account/domain needed).
const tunnel = spawn(cloudflared, ['tunnel', '--url', `http://localhost:${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

tunnel.on('error', (err) => {
  console.error(`\n  ✗ Could not start cloudflared (${err.code}).`);
  console.error('    Install it, then re-run:  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz | tar xz -C ~/.local/bin\n');
  shutdown(1);
});

let printed = false;
function onData(buf) {
  const s = buf.toString();
  process.stderr.write(s); // keep cloudflared's own logs visible
  const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !printed) {
    printed = true;
    const url = m[0];
    console.log(`\n  ┌─────────────────────────────────────────────────────────────┐`);
    console.log(`  │  🔗  Share this read-only link with your friends:            │`);
    console.log(`  │                                                             │`);
    console.log(`  │     ${url.padEnd(56)}│`);
    console.log(`  │                                                             │`);
    console.log(`  │  Local (full access):  http://localhost:${PORT}${' '.repeat(Math.max(0, 20 - PORT.length))}│`);
    console.log(`  │  Only works while this stays running and your Mac is awake.  │`);
    console.log(`  │  Press Ctrl+C to stop sharing.                              │`);
    console.log(`  └─────────────────────────────────────────────────────────────┘`);
    console.log(`     Owner (full access, you only):  ${url}/?owner=<OWNER_TOKEN>`);
    console.log(`     Visit once on your device; replace <OWNER_TOKEN> with the value in .env. Keep it private.\n`);
  }
}
tunnel.stdout.on('data', onData);
tunnel.stderr.on('data', onData);

function shutdown(code = 0) {
  server.kill('SIGTERM');
  tunnel.kill('SIGTERM');
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
server.on('exit', () => shutdown(0));
tunnel.on('exit', () => shutdown(0));
