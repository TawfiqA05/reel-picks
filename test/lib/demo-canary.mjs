// Loaded with --import into a server the demo suite starts (test/fast/demo.mjs).
// It changes nothing the server does; it only writes down, one JSON line each
// in RP_CANARY_LOG:
//   { kind: 'db', path }       every SQLite database opened (node:sqlite)
//   { kind: 'read', path }     every file read whose name is .env
//   { kind: 'net', host, port} every outgoing connection, to anywhere
//   { kind: 'dns', host }      every name looked up
// so the suite can prove demo mode never opens the real database path, never
// reads .env and never reaches the network. RP_CANARY_CLOCK names a file
// holding a number of ms to add to Date.now(), for the hour-long expiry.
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const LOG = process.env.RP_CANARY_LOG;
const note = (e) => { if (LOG) try { fs.appendFileSync(LOG, `${JSON.stringify(e)}\n`); } catch { /* best effort */ } };

const sqlite = require('node:sqlite');
const Real = sqlite.DatabaseSync;
sqlite.DatabaseSync = class DatabaseSync extends Real {
  constructor(file, ...rest) {
    note({ kind: 'db', path: String(file) });
    super(file, ...rest);
  }
};

const realRead = fs.readFileSync;
fs.readFileSync = function readFileSync(p, ...rest) {
  if (/(^|[\\/])\.env$/.test(String(p))) note({ kind: 'read', path: String(p) });
  return realRead.call(this, p, ...rest);
};

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const o = typeof args[0] === 'object' && args[0] !== null ? (Array.isArray(args[0]) ? args[0][0] : args[0]) : { port: args[0], host: args[1] };
  note({ kind: 'net', host: o?.host || o?.path || 'localhost', port: o?.port ?? null });
  return realConnect.apply(this, args);
};
for (const m of [dns, dns.promises]) {
  const real = m.lookup;
  m.lookup = function lookup(host, ...rest) {
    note({ kind: 'dns', host: String(host) });
    return real.call(this, host, ...rest);
  };
}
syncBuiltinESMExports();

const CLOCK = process.env.RP_CANARY_CLOCK;
if (CLOCK) {
  const realNow = Date.now;
  let off = 0;
  let readAt = 0;
  Date.now = () => {
    const t = realNow();
    if (t - readAt > 50) { readAt = t; try { off = Number(realRead(CLOCK, 'utf8')) || 0; } catch { off = 0; } }
    return t + off;
  };
}
