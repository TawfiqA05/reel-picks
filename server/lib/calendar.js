// "Add to calendar": one showtime as an iCalendar (.ics) event that iPhone,
// Google, Outlook and macOS Calendar all import. The event starts at AMC's
// listed time in the theater's own time zone (a TZID with its VTIMEZONE, not
// a UTC instant, so it reads right wherever the phone is), ends when the film
// lets out, and its notes say when to be in the seat (the listed time plus the
// user's preview minutes, the same "be there by" the showtime chips show).
import { get } from '../db.js';
import { beThereByLabel, endTimeLabel } from './ranking.js';
import { timeLabel } from './util.js';

// AMC names a theater's zone in words ("EASTERN TIME") next to its state.
// Most of Indiana keeps its own zone name; Arizona has no daylight saving.
const ZONES = {
  EASTERN: (state) => (/^INDIANA$/i.test(state) ? 'America/Indianapolis' : /^MICHIGAN$/i.test(state) ? 'America/Detroit' : 'America/New_York'),
  CENTRAL: () => 'America/Chicago',
  MOUNTAIN: (state) => (/^ARIZONA$/i.test(state) ? 'America/Phoenix' : 'America/Denver'),
  PACIFIC: () => 'America/Los_Angeles',
  ALASKA: () => 'America/Anchorage',
  HAWAII: () => 'Pacific/Honolulu',
};

// The theater's IANA zone, else the server's own (showtime math already
// assumes the server runs in the theaters' zone; see README, TZ).
export function theatreZone(record) {
  const word = String(record?.timezone || '').trim().split(/\s+/)[0]?.toUpperCase();
  const zone = ZONES[word]?.(record?.state || '');
  return zone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

// What AMC told us about a theater (name, street, city, state, zone), from the
// cache the theater search and drive times fill. Never goes to the network.
export function theatreRecord(id) {
  const one = get('SELECT value FROM cache WHERE key = ?', `amc:theatre:${id}`);
  try { if (one) return JSON.parse(one.value); } catch { /* fall through */ }
  const list = get("SELECT value FROM cache WHERE key = 'amc:theatres:all'");
  try { return (JSON.parse(list?.value || '[]') || []).find((t) => String(t.id) === String(id)) || null; } catch { return null; }
}

const title = (s) => String(s || '').toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

export function theatreAddress(record) {
  if (!record) return '';
  return [record.address, title(record.city), title(record.state)].map((x) => String(x || '').trim()).filter(Boolean).join(', ');
}

// ---- iCalendar text --------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Lines longer than 75 octets continue on the next line after a space,
// never splitting a UTF-8 character.
function fold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const pad = (n) => String(n).padStart(2, '0');
// "2026-09-26T19:45:00" -> "20260926T194500" (wall time, no zone).
const wall = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
const utcStamp = (d) => `${wall(d)}Z`;
// A local wall time held in a Date's UTC fields, so adding minutes can't be
// shifted by the server's own zone.
const wallDate = (local) => {
  const m = String(local || '').match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))) : null;
};

// The zone's UTC offset ("-0400") and short name ("EDT") at an instant.
function zoneAt(zone, instant) {
  const parts = (opt) => new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: opt }).formatToParts(instant).find((p) => p.type === 'timeZoneName')?.value || '';
  const m = parts('longOffset').match(/GMT(?:([+-])(\d\d):(\d\d))?/);
  const offset = m && m[1] ? `${m[1]}${m[2]}${m[3]}` : '+0000';
  return { offset, name: parts('short') || zone };
}

// VTIMEZONE for a US zone: the offsets and names in January and July of the
// event's year, switching on the US rules (second Sunday of March, first
// Sunday of November, 2am). A zone without daylight time gets one block.
export function vtimezone(zone, year) {
  const winter = zoneAt(zone, new Date(Date.UTC(year, 0, 15, 12)));
  const summer = zoneAt(zone, new Date(Date.UTC(year, 6, 15, 12)));
  const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`];
  if (winter.offset === summer.offset) {
    lines.push('BEGIN:STANDARD', `TZOFFSETFROM:${winter.offset}`, `TZOFFSETTO:${winter.offset}`, `TZNAME:${winter.name}`, 'DTSTART:19700101T000000', 'END:STANDARD');
  } else {
    lines.push(
      'BEGIN:DAYLIGHT', `TZOFFSETFROM:${winter.offset}`, `TZOFFSETTO:${summer.offset}`, `TZNAME:${summer.name}`,
      'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
      'BEGIN:STANDARD', `TZOFFSETFROM:${summer.offset}`, `TZOFFSETTO:${winter.offset}`, `TZNAME:${winter.name}`,
      'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    );
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

// Runtime unknown: the event still needs an end, so it assumes two hours and
// the notes don't claim an end time.
const FALLBACK_RUNTIME = 120;

export function showtimeIcs({ showtime: s, movie, theatreName, record, previewsMinutes = 0, now = new Date() }) {
  const start = wallDate(s.start_local);
  if (!start) return null;
  const zone = theatreZone(record);
  const previews = Math.max(0, Number(previewsMinutes) || 0);
  const runtime = Number(movie?.runtime || s.runtime_min) || null;
  const end = new Date(start.getTime() + (previews + (runtime || FALLBACK_RUNTIME)) * 60000);
  const listed = timeLabel(s.start_local);
  const seat = beThereByLabel(s.start_local, previews) || listed;
  const endLabel = runtime ? endTimeLabel(s.start_local, runtime, previews) : null;
  const format = s.is_imax ? 'IMAX' : (s.format && !/^standard$/i.test(s.format) ? s.format : null);
  const film = movie?.title || 'Movie';
  const notes = [
    `Be there by ${seat}.${previews ? ` AMC lists ${listed}; about ${previews} minutes of previews come first.` : ''}`,
    endLabel ? `Ends around ${endLabel}.` : null,
    format ? `Format: ${format}.` : null,
    s.purchase_url ? `Tickets: ${s.purchase_url}` : null,
  ].filter(Boolean).join('\n');
  const address = theatreAddress(record);
  const location = [theatreName || record?.name, address].filter(Boolean).join(', ');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Reel Picks//Showtime//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    ...vtimezone(zone, start.getUTCFullYear()),
    'BEGIN:VEVENT',
    `UID:showtime-${String(s.id).replace(/[^\w.-]/g, '')}@reelpicks`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART;TZID=${zone}:${wall(start)}`,
    `DTEND;TZID=${zone}:${wall(end)}`,
    `SUMMARY:${esc(film)}`,
    `DESCRIPTION:${esc(notes)}`,
    location ? `LOCATION:${esc(location)}` : null,
    Number.isFinite(record?.lat) && Number.isFinite(record?.lng) ? `GEO:${record.lat};${record.lng}` : null,
    s.purchase_url ? `URL:${s.purchase_url}` : null,
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export function icsFilename(film, s) {
  const slug = String(film || 'movie').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_]+/g, '-').slice(0, 60) || 'movie';
  return `${slug}-${String(s.start_local || '').slice(0, 16).replace(/[:T]/g, '-')}.ics`;
}
