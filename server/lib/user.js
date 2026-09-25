// Who a piece of work is being done for. Each API request runs inside
// runAs(userId) (see server/index.js), and every per-person query reads the id
// from here, so a handler can't forget to scope a query to its caller.
//
// Background work that belongs to nobody (the daily refresh, detail
// enrichment) runs inside runSystem(): reading per-user data there throws
// instead of silently falling back to the owner, and any per-user step names
// its user explicitly (runAs, or a userId argument).
import { AsyncLocalStorage } from 'node:async_hooks';

export const OWNER_ID = 1;

const als = new AsyncLocalStorage();

export function runAs(userId, fn, extra = {}) {
  return als.run({ userId: Number(userId), ...extra }, fn);
}

export function runSystem(fn) {
  return als.run({ system: true }, fn);
}

export function currentUser() {
  return als.getStore() || null;
}

export function currentUserId() {
  const s = als.getStore();
  if (!s?.userId) {
    throw new Error(s?.system ? 'Per-user data was read from a background task with no user.' : 'No user context for this request.');
  }
  return s.userId;
}
