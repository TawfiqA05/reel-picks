// Streaming services a person can say they have, for the "At home" picks and
// "What should I watch?". DOM-free and import-free: the browser and the server
// (server/lib/home.js, PUT /api/settings) load this same file.
//
// `providers` are TMDB watch-provider ids in the US (data from JustWatch). A
// service is often listed under more than one: the plan with ads, or the same
// catalog sold as an Amazon or Roku channel. Paid services count only when a
// film is included with the subscription ("flatrate"), never rent or buy. The
// free, ad-supported services (Tubi, Pluto TV, …) appear in TMDB as "ads" or
// "free" rather than "flatrate", so those are what counts for them.
export const SERVICES = [
  { key: 'netflix', name: 'Netflix', providers: [8, 1796] },
  { key: 'max', name: 'HBO Max', providers: [1899, 1825] },
  { key: 'disney', name: 'Disney+', providers: [337] },
  { key: 'hulu', name: 'Hulu', providers: [15] },
  { key: 'prime', name: 'Prime Video', providers: [9, 2100] },
  { key: 'apple', name: 'Apple TV+', providers: [350, 2243] },
  { key: 'peacock', name: 'Peacock', providers: [386, 387, 2553] },
  { key: 'paramount', name: 'Paramount+', providers: [2303, 2616, 582, 633] },
  { key: 'free', name: 'Free with ads', note: 'Tubi, Pluto TV, The Roku Channel, Plex', providers: [73, 300, 207, 613, 538], free: true },
];
export const SERVICE_KEYS = SERVICES.map((s) => s.key);
export const serviceByKey = (key) => SERVICES.find((s) => s.key === key) || null;

// Only known keys, each once, in the list's order.
export function cleanServices(keys) {
  const want = new Set(Array.isArray(keys) ? keys : []);
  return SERVICE_KEYS.filter((k) => want.has(k));
}

// "Netflix and HBO Max", "Netflix, HBO Max and Hulu".
export function servicesPhrase(keys) {
  const names = cleanServices(keys).map((k) => serviceByKey(k).name);
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// Settings problems for streamingServices in a patch, as [{ key, message }].
export function servicesProblems(patch) {
  if (!('streamingServices' in patch)) return [];
  const v = patch.streamingServices;
  if (!Array.isArray(v) || v.some((k) => !SERVICE_KEYS.includes(k))) {
    return [{ key: 'streamingServices', message: `Use a list of: ${SERVICE_KEYS.join(', ')}.` }];
  }
  return [];
}
