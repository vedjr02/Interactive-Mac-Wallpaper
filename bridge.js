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
const EVENTS_PATH = path.join(ROOT, 'events.json');
const CACHE_PATH = path.join(ROOT, 'cache.json');

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
  /* Scripting Calendar.app LAUNCHES it. Left false, the bridge only reads
     from it when you already have it open. Set true if you would rather have
     fresh events than a closed Calendar.app. */
  launchCalendarApp: false,
};

let config = { ...DEFAULT_CONFIG };

async function loadConfig() {
  try {
    const onDisk = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
    config = { ...DEFAULT_CONFIG, ...onDisk };
    /* backfill any option added since this config was written, so every
       setting is visible in the file rather than only in the defaults */
    const missing = Object.keys(DEFAULT_CONFIG).filter((k) => !(k in onDisk));
    if (missing.length) {
      config._comment = DEFAULT_CONFIG._comment;
      await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
      log(`added new settings to config.json: ${missing.join(', ')}`);
    }
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
   ticked-off calendar events

   Calendar.app is read-only to us, so "done" lives here instead, keyed
   by title + start so it survives a re-sweep renumbering the events.
   ================================================================== */
let doneEvents = {};

function pruneDoneEvents() {
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  for (const k of Object.keys(doneEvents)) {
    if (!doneEvents[k] || doneEvents[k] < cutoff) delete doneEvents[k];
  }
}

async function loadDoneEvents() {
  try { doneEvents = JSON.parse(await fsp.readFile(EVENTS_PATH, 'utf8')); } catch { doneEvents = {}; }
  if (!doneEvents || typeof doneEvents !== 'object' || Array.isArray(doneEvents)) doneEvents = {};
  pruneDoneEvents();
}

let writingEvents = null;
async function saveDoneEvents() {
  if (writingEvents) return writingEvents;
  writingEvents = (async () => {
    const tmp = EVENTS_PATH + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(doneEvents, null, 2));
    await fsp.rename(tmp, EVENTS_PATH);
    writingEvents = null;
  })();
  return writingEvents;
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

/* --- Calendar.app -------------------------------------------------
   Scripting Calendar.app is genuinely slow — a full sweep of a dozen
   calendars takes the better part of a minute. So it never runs on the
   request path: a background timer refreshes it and /api/state always
   answers from the cache. Point `icsUrls` at your feeds instead and this
   whole branch is skipped.
------------------------------------------------------------------- */
function runOsascript(script, timeout = 150000) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

function calendarScript(only) {
  return `
  var Cal = Application('Calendar');
  var only = ${JSON.stringify(only || [])};
  var from = new Date(); from.setDate(from.getDate() - ${WINDOW_BACK}); from.setHours(0,0,0,0);
  var to   = new Date(); to.setDate(to.getDate() + ${WINDOW_FWD});      to.setHours(23,59,59,0);
  var out = [];
  var cals = Cal.calendars();
  for (var i = 0; i < cals.length; i++) {
    var name;
    try { name = cals[i].name(); } catch (e) { continue; }
    if (only.length && only.indexOf(name) < 0) continue;
    var evs;
    /* the whose() filter is what costs the time; resolve it once, then read
       each event individually — asking the filtered set for a whole property
       at a time makes Calendar re-run the filter and is far slower. */
    try {
      evs = cals[i].events.whose({ _and: [
        { startDate: { _greaterThan: from } },
        { startDate: { _lessThan: to } }
      ]})();
    } catch (err) { continue; }

    for (var j = 0; j < evs.length; j++) {
      try {
        var st = evs[j].startDate();
        out.push({
          id: name + '-' + st.getTime() + '-' + j,
          title: evs[j].summary() || '(no title)',
          location: evs[j].location() || '',
          allDay: !!evs[j].alldayEvent(),
          start: st.toISOString(),
          end: evs[j].endDate().toISOString(),
          calendar: name
        });
      } catch (err) {}
    }

    /* A repeating event is stored once, and its start date is the FIRST
       occurrence — a birthday added in 2019 reports 2019 — so the window
       filter above can never see it. Collect them by their rule instead
       and expand the occurrences in Node. */
    var rec;
    try {
      rec = cals[i].events.whose({ recurrence: { _contains: 'FREQ' } })();
    } catch (err) { continue; }

    for (var k = 0; k < rec.length; k++) {
      try {
        out.push({
          id: name + '-r' + k,
          title: rec[k].summary() || '(no title)',
          location: rec[k].location() || '',
          allDay: !!rec[k].alldayEvent(),
          start: rec[k].startDate().toISOString(),
          end: rec[k].endDate().toISOString(),
          rrule: rec[k].recurrence(),
          calendar: name
        });
      } catch (err) {}
    }
  }
  JSON.stringify(out);
`;
}

/* Turn the repeating events Calendar.app handed back into real occurrences,
   reusing the same rule expander the iCalendar feeds go through. */
function expandAppEvents(raw, from, to) {
  const out = [];
  for (const e of raw) {
    if (!e.rrule) { out.push(e); continue; }

    const start = new Date(e.start);
    const dur = Math.max(0, new Date(e.end) - start);

    for (const occ of expand({ start, rrule: e.rrule, exdates: [] }, from, to)) {
      out.push({
        id: `${e.id}-${occ.getTime()}`,
        title: e.title,
        location: e.location,
        allDay: e.allDay,
        start: occ.toISOString(),
        end: new Date(occ.getTime() + dur).toISOString(),
        calendar: e.calendar,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------
   the event cache — filled by background timers, read instantly
------------------------------------------------------------------- */
let calCache = { events: [], source: 'none', at: 0 };
let appBusy = false;

const getEvents = () => calCache.events;

function windowBounds() {
  const n = new Date();
  return [
    new Date(n.getFullYear(), n.getMonth(), n.getDate() - WINDOW_BACK),
    new Date(n.getFullYear(), n.getMonth(), n.getDate() + WINDOW_FWD, 23, 59, 59),
  ];
}

function commit(events, source) {
  const seen = new Set();
  calCache = {
    at: Date.now(),
    source,
    events: events
      .filter((e) => {
        const k = e.title + '|' + e.start;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => new Date(a.start) - new Date(b.start)),
  };
  saveCache();
}

/* Keep the last good sweep on disk. A restart should never leave the
   wallpaper blank just because the next refresh has not landed yet. */
function saveCache() {
  fsp.writeFile(CACHE_PATH + '.tmp', JSON.stringify(calCache))
    .then(() => fsp.rename(CACHE_PATH + '.tmp', CACHE_PATH))
    .catch(() => {});
}

async function loadCache() {
  try {
    const c = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
    if (Array.isArray(c.events)) {
      /* only worth restoring while it still overlaps the window we show */
      const [from, to] = windowBounds();
      const kept = c.events.filter((e) => {
        const s = new Date(e.start);
        return s >= from && s <= to;
      });
      calCache = { at: 0, source: c.source || 'cache', events: kept };
      if (kept.length) log(`restored ${kept.length} cached events from the last sweep`);
    }
  } catch { /* no cache yet */ }
}

async function refreshFeeds() {
  const [from, to] = windowBounds();
  const events = [];
  for (const url of config.icsUrls) {
    try {
      const r = await fetch(url.replace(/^webcal:/, 'https:'), { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      events.push(...icsToEvents(await r.text(), from, to));
    } catch (e) {
      log('feed failed:', url.slice(0, 50) + '…', e.message);
    }
  }
  commit(events, 'feeds');
  log(`feeds: ${calCache.events.length} events`);
}

/* Is Calendar.app already open? Checked with pgrep rather than an Apple
   Event, because asking the app anything is what launches it. */
function calendarIsRunning() {
  return new Promise((resolve) => {
    execFile('/usr/bin/pgrep', ['-x', 'Calendar'], (err) => resolve(!err));
  });
}

/* The EventKit helper reads the same store without involving the app at all,
   and returns in milliseconds. It needs Calendar access granted to it, so we
   probe once and remember the answer. */
const CALDUMP = path.join(ROOT, 'caldump');
let caldumpOk = null;        /* null = untried, true/false = last outcome */
let caldumpLogged = false;   /* only complain about it once */

function runCaldump() {
  return new Promise((resolve, reject) => {
    execFile(CALDUMP, [String(WINDOW_BACK), String(WINDOW_FWD)], { timeout: 20000, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)));
  });
}

async function refreshCalendarApp() {
  if (appBusy) return;
  appBusy = true;
  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(1);

  try {
    /* 1. EventKit, if it has been granted access. Retried every sweep — it
          costs a fraction of a second — so the moment you grant access it
          starts being used, with no restart. */
    if (fs.existsSync(CALDUMP)) {
      try {
        const rows = JSON.parse((await runCaldump()).trim() || '[]');
        if (caldumpOk !== true) log('using EventKit — Calendar.app is never launched');
        caldumpOk = true;
        caldumpLogged = false;
        commit(rows, 'eventkit');
        log(`EventKit: ${calCache.events.length} events in ${secs()}s`);
        return;
      } catch (e) {
        caldumpOk = false;
        if (!caldumpLogged) {
          caldumpLogged = true;
          log('EventKit unavailable (' + e.message.split('\n')[0].slice(0, 60) + ')');
          log('  → run  ./caldump  once from Terminal and allow Calendar access,');
          log('    or set icsUrls in config.json. Until then Calendar.app is left closed.');
        }
      }
    }

    /* 2. Scripting. Only while the app is already open, unless you have
          explicitly asked for it to be launched. */
    if (!config.launchCalendarApp && !(await calendarIsRunning())) {
      log('Calendar.app is closed; leaving it that way and keeping the cached events');
      return;
    }

    const [from, to] = windowBounds();
    const raw = JSON.parse((await runOsascript(calendarScript(config.calendars))).trim() || '[]');
    const repeats = raw.filter((e) => e.rrule).length;
    commit(expandAppEvents(raw, from, to), 'calendar.app');
    log(`Calendar.app: ${calCache.events.length} events in ${secs()}s (from ${repeats} repeating)`);
  } catch (e) {
    log('calendar refresh failed:', e.message.split('\n')[0].slice(0, 120));
  } finally {
    appBusy = false;
  }
}

function startCalendarLoop() {
  if (config.icsUrls && config.icsUrls.length) {
    refreshFeeds();
    setInterval(refreshFeeds, 5 * 60 * 1000);
    return;
  }
  if (config.useCalendarApp) {
    log('no icsUrls set — falling back to Calendar.app (slow; first sweep can take a minute)');
    refreshCalendarApp();
    setInterval(refreshCalendarApp, 15 * 60 * 1000);
  }
}

/* ==================================================================
   http
   ================================================================== */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(s),
  });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 1e6) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  if (req.method === 'OPTIONS') return json(res, 204, {});

  /* --- api ------------------------------------------------------- */
  if (p === '/api/state') {
    return json(res, 200, {
      weather: await getWeather(),
      events: getEvents(),
      tasks,
      doneEvents,
      place: config.place,
    });
  }

  if (p === '/api/events/done' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      if (!b.key) return json(res, 400, { error: 'key required' });
      if (b.done) doneEvents[String(b.key).slice(0, 400)] = new Date().toISOString().slice(0, 10);
      else delete doneEvents[b.key];
      pruneDoneEvents();
      await saveDoneEvents();
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (p === '/api/tasks' && req.method === 'POST') {
    try {
      const t = await readBody(req);
      if (!t.title) return json(res, 400, { error: 'title required' });
      tasks.push({
        id: t.id || 't' + Date.now().toString(36),
        title: String(t.title).slice(0, 400),
        due: t.due || null,
        done: false,
        status: t.status === 'progress' ? 'progress' : 'todo',
        createdAt: new Date().toISOString(),
      });
      await saveTasks();
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  const taskMatch = p.match(/^\/api\/tasks\/([\w-]+)$/);
  if (taskMatch) {
    const id = taskMatch[1];
    const i = tasks.findIndex((t) => t.id === id);

    if (req.method === 'DELETE') {
      if (i >= 0) { tasks.splice(i, 1); await saveTasks(); }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PATCH') {
      if (i < 0) return json(res, 404, { error: 'no such task' });
      try {
        const b = await readBody(req);
        for (const f of ['title', 'due', 'done', 'status', 'completedOn']) {
          if (f in b) tasks[i][f] = f === 'title' ? String(b[f]).slice(0, 400) : b[f];
        }
        await saveTasks();
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
  }

  if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });

  /* --- static ---------------------------------------------------- */
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)
      || ['tasks.json', 'config.json', 'events.json', 'cache.json'].includes(rel)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

/* ================================================================== */
(async function start() {
  await loadConfig();
  await loadTasks();
  await loadDoneEvents();
  await loadCache();
  server.listen(PORT, '127.0.0.1', () => {
    log(`wallpape → http://localhost:${PORT}`);
    log(`${tasks.length} task${tasks.length === 1 ? '' : 's'} loaded`);
  });
  getWeather();
  startCalendarLoop();
})();
