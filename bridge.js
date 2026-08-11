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
