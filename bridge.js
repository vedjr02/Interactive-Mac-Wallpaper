#!/usr/bin/env node
/* ==================================================================
   Wallpape bridge — zero dependencies.

   Serves the app and four small endpoints:
     GET    /api/state          weather + calendar + tasks, in one shot
     POST   /api/tasks          add
     PATCH  /api/tasks/:id      edit / complete / move
     DELETE /api/tasks/:id      remove

   node bridge.js            →  http://localhost:7373
   ================================================================== */

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 7373);
const CONFIG_PATH = path.join(ROOT, 'config.json');
const TASKS_PATH = path.join(ROOT, 'tasks.json');

const WINDOW_BACK = 1;    /* days of calendar to keep behind us */
const WINDOW_FWD = 9;     /* and ahead */

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ==================================================================
   config
   ================================================================== */
const DEFAULT_CONFIG = {
  _comment: 'icsUrls is the fast path — paste your calendar feeds there (Google Calendar → Settings → “Secret address in iCal format”; iCloud → Public Calendar, swap webcal:// for https://). Leave it empty and the bridge falls back to scripting Calendar.app, which works but takes about a minute per sweep. Set latitude/longitude/place by hand to pin the weather and skip the one-off geo-IP lookup. `calendars` limits the Calendar.app sweep to named calendars.',
  latitude: null,
  longitude: null,
  place: null,
  icsUrls: [],
  useCalendarApp: true,
  calendars: [],
};

let config = { ...DEFAULT_CONFIG };

async function loadConfig() {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8')) };
  } catch {
    await fsp.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    log('wrote a starter config.json');
  }

  if (config.latitude == null || config.longitude == null) await locate();
}

/* One rough geo-IP lookup so the weather works out of the box. It runs once,
   is written into config.json, and never runs again. Fill in latitude /
   longitude / place by hand if you would rather it never ran at all. */
const GEO_SERVICES = [
  ['https://ipwho.is/', (j) => ({ lat: j.latitude, lon: j.longitude, place: j.city || j.region })],
  ['https://get.geojs.io/v1/ip/geo.json', (j) => ({ lat: +j.latitude, lon: +j.longitude, place: j.city })],
  ['https://ipapi.co/json/', (j) => ({ lat: j.latitude, lon: j.longitude, place: j.city || j.region })],
];

async function locate() {
  for (const [url, pick] of GEO_SERVICES) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      const { lat, lon, place } = pick(await r.json());
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      config.latitude = lat;
      config.longitude = lon;
      config.place = place || null;
      await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
      log(`located you near ${config.place || lat + ',' + lon} — edit config.json to change it`);
      return;
    } catch { /* try the next one */ }
  }
  log('could not auto-locate; set latitude / longitude in config.json for weather');
}

/* ==================================================================
   tasks — a plain JSON file
   ================================================================== */
let tasks = [];

async function loadTasks() {
  try { tasks = JSON.parse(await fsp.readFile(TASKS_PATH, 'utf8')); } catch { tasks = []; }
  if (!Array.isArray(tasks)) tasks = [];
}

let writing = null;
async function saveTasks() {
  if (writing) return writing;
  writing = (async () => {
    const tmp = TASKS_PATH + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(tasks, null, 2));
    await fsp.rename(tmp, TASKS_PATH);
    writing = null;
  })();
  return writing;
}

/* ==================================================================
   weather — Open-Meteo, no key needed
   ================================================================== */
let weatherCache = { at: 0, data: null };

async function getWeather() {
  if (Date.now() - weatherCache.at < 15 * 60 * 1000) return weatherCache.data;
  if (config.latitude == null) return null;

  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${config.latitude}&longitude=${config.longitude}`
    + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m'
    + '&daily=temperature_2m_max,temperature_2m_min'
    + '&timezone=auto&forecast_days=1';

  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    weatherCache = {
      at: Date.now(),
      data: {
        temp: j.current.temperature_2m,
        feels: j.current.apparent_temperature,
        code: j.current.weather_code,
        wind: j.current.wind_speed_10m,
        max: j.daily.temperature_2m_max[0],
        min: j.daily.temperature_2m_min[0],
      },
    };
  } catch (e) {
    log('weather failed:', e.message);
  }
  return weatherCache.data;
}

/* ==================================================================
   iCalendar
   ================================================================== */

/* offset of a time zone at a given instant, in ms */
function tzOffset(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o = {};
  for (const p of dtf.formatToParts(date)) o[p.type] = p.value;
  return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second) - date.getTime();
}

/* wall-clock time in `tz` → a real instant */
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    let guess = wall;
    for (let i = 0; i < 2; i++) guess = wall - tzOffset(new Date(guess), tz);
    return new Date(guess);
  } catch {
    return new Date(y, mo - 1, d, h, mi, s);
  }
}

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function parseParams(chunk) {
  const params = {};
  for (const bit of chunk.split(';').slice(1)) {
    const i = bit.indexOf('=');
    if (i > 0) params[bit.slice(0, i).toUpperCase()] = bit.slice(i + 1).replace(/^"|"$/g, '');
  }
  return params;
}

/* one DTSTART/DTEND/EXDATE value → { date, allDay } */
function parseDate(value, params) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { date: new Date(+y, +mo - 1, +d), allDay: true };
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false };
  if (params.TZID) return { date: zonedToUtc(+y, +mo, +d, +h, +mi, +s, params.TZID), allDay: false };
  return { date: new Date(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
}

function unescapeText(v) {
  return v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

function parseDuration(v) {
  const m = v.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const [, , w, d, h, mi, s] = m;
  return sign * (((+w || 0) * 7 + (+d || 0)) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+s || 0)) * 1000;
}

function parseICS(text) {
  const events = [];
  let cur = null;

  for (const line of unfold(text).split('\n')) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;

    const c = line.indexOf(':');
    if (c < 0) continue;
    const head = line.slice(0, c);
    const value = line.slice(c + 1);
    const name = head.split(';')[0].toUpperCase();
    const params = parseParams(head);

    switch (name) {
      case 'UID':      cur.uid = value; break;
      case 'SUMMARY':  cur.title = unescapeText(value); break;
      case 'LOCATION': cur.location = unescapeText(value); break;
      case 'STATUS':   cur.status = value.toUpperCase(); break;
      case 'RRULE':    cur.rrule = value; break;
      case 'DURATION': cur.duration = parseDuration(value); break;
      case 'DTSTART': {
        const p = parseDate(value, params);
        if (p) { cur.start = p.date; cur.allDay = p.allDay; cur.tzid = params.TZID || null; }
        break;
      }
      case 'DTEND': {
        const p = parseDate(value, params);
        if (p) cur.end = p.date;
        break;
      }
      case 'RECURRENCE-ID': {
        const p = parseDate(value, params);
        if (p) cur.recurrenceId = p.date.getTime();
        break;
      }
      case 'EXDATE': {
        for (const v of value.split(',')) {
          const p = parseDate(v, params);
          if (p) cur.exdates.push(p.date.getTime());
        }
        break;
      }
    }
  }
  return events.filter((e) => e.start && e.title);
}

/* --- recurrence --------------------------------------------------- */
const RR_DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRRule(s) {
  const r = {};
  for (const bit of s.split(';')) {
    const [k, v] = bit.split('=');
    if (k) r[k.toUpperCase()] = v;
  }
  return {
    freq: r.FREQ,
    interval: Math.max(1, parseInt(r.INTERVAL || '1', 10)),
    count: r.COUNT ? parseInt(r.COUNT, 10) : null,
    until: r.UNTIL ? (parseDate(r.UNTIL, {}) || {}).date : null,
    byday: r.BYDAY ? r.BYDAY.split(',') : null,
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null,
    bymonth: r.BYMONTH ? r.BYMONTH.split(',').map(Number) : null,
  };
}

/* every occurrence of `ev` that lands inside [from, to] */
function expand(ev, from, to) {
  if (!ev.rrule) return (ev.start >= from && ev.start <= to) ? [ev.start] : [];

  const r = parseRRule(ev.rrule);
  const out = [];
  const s = ev.start;
  const hh = s.getHours(), mm = s.getMinutes();
  const hardEnd = r.until && r.until < to ? r.until : to;
  const CAP = 750;

  const push = (d) => {
    if (d >= from && d <= hardEnd) out.push(d);
  };

  /* with COUNT we have to walk from the start; otherwise we can jump */
  const canSkip = !r.count;

  if (r.freq === 'DAILY') {
    const step = r.interval * 86400000;
    let n = canSkip ? Math.max(0, Math.floor((from - s) / step)) : 0;
    const limit = r.count || CAP;
    for (let i = 0; i < CAP && n < limit; i++, n++) {
      const d = new Date(s.getTime() + n * step);
      if (d > hardEnd) break;
      push(d);
    }
  } else if (r.freq === 'WEEKLY') {
    const days = (r.byday || []).map((d) => RR_DAYS[d.slice(-2)]).filter((x) => x !== undefined);
    const set = days.length ? days : [s.getDay()];
    const weekStart = new Date(s.getFullYear(), s.getMonth(), s.getDate() - ((s.getDay() + 6) % 7));
    const step = r.interval * 7 * 86400000;
    let n = canSkip ? Math.max(0, Math.floor((from - weekStart) / step)) : 0;
    let made = 0;
    for (let i = 0; i < CAP; i++, n++) {
      const base = new Date(weekStart.getTime() + n * step);
      if (base.getTime() > hardEnd.getTime() + 7 * 86400000) break;
      for (const dow of set.slice().sort()) {
        const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + ((dow + 6) % 7), hh, mm);
        if (d < s) continue;
        if (r.count && ++made > r.count) return out;
        push(d);
      }
    }
  } else if (r.freq === 'MONTHLY' || r.freq === 'YEARLY') {
    const stepMonths = r.freq === 'YEARLY' ? 12 * r.interval : r.interval;
    let n = canSkip
      ? Math.max(0, (from.getFullYear() - s.getFullYear()) * 12 + (from.getMonth() - s.getMonth()) - stepMonths)
      : 0;
    n = Math.floor(n / stepMonths) * stepMonths;
    let made = 0;
    for (let i = 0; i < 240; i++, n += stepMonths) {
      const anchor = new Date(s.getFullYear(), s.getMonth() + n, 1);
      if (anchor > hardEnd) break;
      if (r.bymonth && !r.bymonth.includes(anchor.getMonth() + 1)) continue;

      let candidates = [];
      if (r.byday && r.byday.length) {
        for (const token of r.byday) {
          const ord = parseInt(token, 10) || 0;
          const dow = RR_DAYS[token.slice(-2)];
          if (dow === undefined) continue;
          const inMonth = [];
          const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
          for (let d = 1; d <= last; d++) {
            const dt = new Date(anchor.getFullYear(), anchor.getMonth(), d);
            if (dt.getDay() === dow) inMonth.push(dt);
          }
          if (!ord) candidates.push(...inMonth);
          else candidates.push(ord > 0 ? inMonth[ord - 1] : inMonth[inMonth.length + ord]);
        }
      } else {
        const dayNums = r.bymonthday || [s.getDate()];
        for (const dn of dayNums) {
          const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
          const day = dn > 0 ? dn : last + 1 + dn;
          if (day >= 1 && day <= last) candidates.push(new Date(anchor.getFullYear(), anchor.getMonth(), day));
        }
      }

      for (const c of candidates.filter(Boolean).sort((a, b) => a - b)) {
        const d = new Date(c.getFullYear(), c.getMonth(), c.getDate(), hh, mm);
        if (d < s) continue;
        if (r.count && ++made > r.count) return out;
        push(d);
      }
    }
  } else {
    if (s >= from && s <= to) out.push(s);
  }

  return out;
}

function icsToEvents(text, from, to) {
  const raw = parseICS(text);
  const overrides = new Map();
  for (const e of raw) {
    if (e.recurrenceId) overrides.set(`${e.uid}|${e.recurrenceId}`, e);
  }

  const out = [];
  for (const e of raw) {
    if (e.recurrenceId) continue;
    if (e.status === 'CANCELLED') continue;

    const dur = e.end ? (e.end - e.start) : (e.duration || (e.allDay ? 86400000 : 3600000));
    const ex = new Set(e.exdates);

    for (const start of expand(e, from, to)) {
      if (ex.has(start.getTime())) continue;
      const o = overrides.get(`${e.uid}|${start.getTime()}`);
      if (o) {
        if (o.status === 'CANCELLED') continue;
        out.push({
          id: `${e.uid}-${o.start.getTime()}`,
          title: o.title || e.title,
          location: o.location || '',
          allDay: !!o.allDay,
          start: o.start.toISOString(),
          end: new Date(o.end || o.start.getTime() + dur).toISOString(),
        });
        continue;
      }
      out.push({
        id: `${e.uid}-${start.getTime()}`,
        title: e.title,
        location: e.location || '',
        allDay: !!e.allDay,
        start: start.toISOString(),
        end: new Date(start.getTime() + dur).toISOString(),
      });
    }
  }
  return out;
}
