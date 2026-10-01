// Which database a demo request reads and writes: the visitor's own copy.
// server/db.js hands out `db` as a stand-in that forwards every call to the
// database bound here, so lib/ code runs unchanged. Bound per request, after
// the body parser (as runAs is in index.js), and inherited by everything the
// request starts.
//
// With nothing bound, the call goes to the database server/db.js opened,
// but only while the server is still setting up (the empty schema the sample
// is built from). After that a query with no visitor behind it throws, so
// stray work can never write into the shared sample.
import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage();
let base = null;
let baseOpen = true;

// `key` names the visitor, for the little work kept in memory per person
// (lib/home.js), where every visitor is the same user 1.
export const withDb = (handle, key, fn) => scope.run({ handle, key }, fn);
export const visitorKey = () => scope.getStore()?.key ?? null;
export function closeBase() { baseOpen = false; }

function current() {
  const h = scope.getStore()?.handle;
  if (h) return h;
  if (baseOpen) return base;
  throw new Error('Demo: a query ran with no visitor database.');
}

export function scopedDb(opened) {
  base = opened;
  return new Proxy({}, {
    get(_, prop) {
      const h = current();
      const v = h[prop];
      return typeof v === 'function' ? v.bind(h) : v;
    },
  });
}
