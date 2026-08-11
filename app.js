/* ==================================================================
   Wallpape — app logic
   ================================================================== */

const $ = (id) => document.getElementById(id);

const state = {
  online: false,
  tasks: [],
  events: [],
  weather: null,
  place: null,
  editing: false,
  stamp: '',          // yyyy-mm-dd, to detect a date rollover
};

/* ------------------------------------------------------------------
   colour
------------------------------------------------------------------- */
function hex2rgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function mix(a, b, t) {
  const A = hex2rgb(a), B = hex2rgb(b);
  return A.map((v, i) => Math.round(v + (B[i] - v) * t));
}
function rgba(c, a) {
  const v = Array.isArray(c) ? c : hex2rgb(c);
  return `rgba(${v[0]},${v[1]},${v[2]},${a})`;
}

/* Plain black is the everyday field. Flip TINTED to true and the month's
   colourway blooms in behind it instead. */
const TINTED = false;

function paintMonth(d) {
  const i = d.getMonth();
  const m = MONTHS[i];

  if (TINTED) {
    /* The bloom orbits once around the year, but stays in the lower-right
       quadrant — the quiet part of the frame. Text never sits on light. */
    const ang = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const bx = (73 + 25 * Math.cos(ang)).toFixed(1);
    const by = (72 + 23 * Math.sin(ang)).toFixed(1);
    const lit = mix(m.tint, '#ffffff', 0.26);

    $('bg').style.background = [
      `radial-gradient(44% 42% at ${bx}% ${by}%, ${rgba(lit, 0.95)} 0%, ${rgba(m.tint, 0.5)} 42%, ${rgba(m.tint, 0)} 74%)`,
      `radial-gradient(88% 78% at ${bx}% ${by}%, ${rgba(m.tint, 0.34)} 0%, ${rgba(m.tint, 0)} 72%)`,
      `linear-gradient(190deg, ${rgba(mix(m.tint, '#ffffff', 0.1), 0.2)} 0%, ${rgba(m.base, 0)} 46%)`,
      `linear-gradient(150deg, ${rgba(m.base, 1)} 0%, #040406 78%)`,
    ].join(',');
  } else {
    $('bg').style.background = '#000';
  }

  /* the big figure is today's date — it re-paints at midnight (see tick) */
  const numeral = $('numeral');
  numeral.textContent = String(d.getDate());
  numeral.classList.toggle('two', d.getDate() >= 10);

  $('monthName').textContent = m.name;
  $('year').textContent = d.getFullYear();
  $('todayLine').textContent =
    d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric' });

  placeNumeral();
}

/* The numeral is sized and centred against whichever bay it belongs to, so
   it fills that bay on any display and never crosses a hairline. */
function placeNumeral() {
  const n = $('numeral');
  const rows = document.body.classList.contains('layout-rows');
  const bay = document.querySelector(rows ? '.rail-right' : '.col-next');
  if (!bay || !n.textContent) return;

  const next = document.querySelector('.col-next');
  const right = document.querySelector('.rail-right');

  /* measure everything at its natural size before reserving anything */
  right.style.paddingRight = '';
  next.style.paddingBottom = '';

  const b = bay.getBoundingClientRect();
  if (b.width <= 24) return;

  n.style.fontSize = '100px';
  const unit = n.getBoundingClientRect().width / 100 || 0.55;

  /* columns: fill the bay's width. rows: take only what the rail's own
     blocks leave over, capped by the height of the foot band. */
  const contentRight = Math.max(b.left, ...[...right.children]
    .filter((el) => el.offsetParent)
    .map((el) => el.getBoundingClientRect().right));

  const size = rows
    ? Math.min(b.height * 1.22, (b.right - 14 - contentRight - 26) / unit)
    : Math.min((b.width - 24) * 0.92 / unit, 620);

  /* a date big enough to read, or none at all */
  if (!(size > 64)) { n.style.visibility = 'hidden'; return; }
  n.style.visibility = '';
  n.style.fontSize = size + 'px';

  const r = n.getBoundingClientRect();
  if (rows) {
    n.style.left = (b.right - 14 - r.width) + 'px';
    n.style.bottom = (innerHeight - b.bottom + size * 0.04) + 'px';
  } else {
    n.style.left = (b.left + (b.width - r.width) / 2) + 'px';
    n.style.bottom = '';                         /* back to the stylesheet */
    next.style.paddingBottom = (r.height + 26) + 'px';
  }
}

/* fade the foot of a column only when something is actually cut off */
function updateClips() {
  for (const el of document.querySelectorAll('.clip')) {
    el.classList.toggle('masked', el.scrollHeight > el.clientHeight + 1);
  }
}

/* ------------------------------------------------------------------
   view modes — columns / rows, and focus
------------------------------------------------------------------- */
const VIEW = 'wallpape.view';

function applyView(v) {
  document.body.classList.toggle('layout-rows', v.rows);
  document.body.classList.toggle('focus', v.focus);
  try { localStorage.setItem(VIEW, JSON.stringify(v)); } catch {}
  requestAnimationFrame(() => { placeNumeral(); updateClips(); });
}

addEventListener('resize', () => { placeNumeral(); updateClips(); });

const view = (() => {
  try { return { rows: false, focus: false, ...JSON.parse(localStorage.getItem(VIEW)) }; }
  catch { return { rows: false, focus: false }; }
})();

$('ctlLayout').addEventListener('click', () => { view.rows = !view.rows; applyView(view); });
$('ctlFocus').addEventListener('click', () => { view.focus = !view.focus; applyView(view); });

/* ------------------------------------------------------------------
   dates
------------------------------------------------------------------- */
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86400000);

function fmtTime(d) {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtDayLabel(d) {
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------
   mini calendar
------------------------------------------------------------------- */
function renderMiniCal(now) {
  const y = now.getFullYear(), m = now.getMonth();
  const first = new Date(y, m, 1);
  const lead = (first.getDay() + 6) % 7;                 // Monday-first
  const days = new Date(y, m + 1, 0).getDate();

  let html = DOW.map((d) => `<span class="mc-dow">${d[0]}</span>`).join('');
  for (let i = 0; i < lead; i++) html += '<span></span>';
  for (let d = 1; d <= days; d++) {
    const today = d === now.getDate() ? ' class="mc-today"' : '';
    html += `<span${today}>${d}</span>`;
  }
  $('minical').innerHTML = html;
}

/* ------------------------------------------------------------------
   data layer — bridge, with a local fallback
------------------------------------------------------------------- */
const LS = 'wallpape.tasks';

async function api(path, opts) {
  const r = await fetch(path, Object.assign({ cache: 'no-store' }, opts));
  if (!r.ok) throw new Error(r.status + ' ' + path);
  return r.json();
}

function localTasks() {
  try { return JSON.parse(localStorage.getItem(LS)) || []; } catch { return []; }
}
function saveLocal() {
  try { localStorage.setItem(LS, JSON.stringify(state.tasks)); } catch {}
}

async function pull() {
  try {
    const d = await api('/api/state');
    state.online = true;
    state.tasks = d.tasks || [];
    state.events = (d.events || []).map((e) => ({
      ...e, start: new Date(e.start), end: new Date(e.end),
    }));
    state.weather = d.weather || null;
    state.place = d.place || null;
  } catch {
    state.online = false;
    state.tasks = localTasks();
    state.events = [];
    state.weather = null;
  }
}

async function mutate(method, path, body) {
  if (!state.online) { saveLocal(); return; }
  try {
    await api(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { /* keep the optimistic UI; the next pull reconciles */ }
}
