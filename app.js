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

/* ------------------------------------------------------------------
   tasks
------------------------------------------------------------------- */
function dueLabel(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const due = new Date(y, m - 1, d);
  const n = daysBetween(new Date(), due);
  if (n < 0) return { text: `${-n}d late`, cls: 'late' };
  if (n === 0) return { text: 'today', cls: 'today' };
  if (n === 1) return { text: 'tomorrow', cls: '' };
  if (n < 7) return { text: due.toLocaleDateString('en-GB', { weekday: 'short' }), cls: '' };
  return { text: due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), cls: '' };
}

/* "call mum @fri" → { title:'call mum', due:'2026-08-14' } */
function parseDue(raw) {
  const m = raw.match(/\s@(\S+(?:\s\d{1,2})?)\s*$/i);
  if (!m) return { title: raw.trim(), due: null };
  const token = m[1].toLowerCase().trim();
  const title = raw.slice(0, m.index).trim();
  const today = startOfDay(new Date());
  let due = null;

  if (/^today$/.test(token)) due = today;
  else if (/^(tom|tmr|tomorrow)$/.test(token)) due = addDays(today, 1);
  else if (/^\d+d$/.test(token)) due = addDays(today, parseInt(token));
  else if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
    const [y, mo, d] = token.split('-').map(Number);
    due = new Date(y, mo - 1, d);
  } else {
    const dowIdx = DOW.findIndex((d) => d.toLowerCase() === token.slice(0, 3));
    if (dowIdx >= 0) {
      const cur = (today.getDay() + 6) % 7;
      due = addDays(today, ((dowIdx - cur + 7) % 7) || 7);
    } else {
      const dm = token.match(/^(\d{1,2})\s*([a-z]{3,})$/) || token.match(/^([a-z]{3,})\s*(\d{1,2})$/);
      if (dm) {
        const num = parseInt(/^\d/.test(dm[1]) ? dm[1] : dm[2]);
        const mon = /^\d/.test(dm[1]) ? dm[2] : dm[1];
        const mi = MONTHS.findIndex((x) => x.name.toLowerCase().startsWith(mon.slice(0, 3)));
        if (mi >= 0 && num >= 1 && num <= 31) {
          due = new Date(today.getFullYear(), mi, num);
          if (due < today) due = new Date(today.getFullYear() + 1, mi, num);
        }
      }
    }
  }
  return due ? { title, due: key(due) } : { title: raw.trim(), due: null };
}

function visibleTasks() {
  const today = key(new Date());
  return state.tasks.filter((t) => !t.done || (t.completedOn || '') === today);
}

function renderTasks() {
  if (state.editing) return;
  const list = visibleTasks();
  const open = list.filter((t) => !t.done).length;
  $('taskCount').textContent = open ? String(open) : '';

  const groups = [
    ['In progress', list.filter((t) => t.status === 'progress')],
    ['Not started', list.filter((t) => t.status !== 'progress')],
  ];

  $('taskBody').innerHTML = groups
    .filter(([, items]) => items.length)
    .map(([label, items]) => `
      <div class="tasksection">
        <span class="sectionlabel">${label}</span>
        ${items.map(taskRow).join('')}
      </div>`)
    .join('') || '<div class="empty">Nothing on the list</div>';

  updateClips();
}

function taskRow(t) {
  const d = dueLabel(t.due);
  return `
    <div class="task${t.done ? ' done' : ''}" data-id="${esc(t.id)}">
      <div class="box" data-act="toggle"></div>
      <div class="ttitle" data-act="edit">${esc(t.title)}</div>
      <div class="trail">
        <span class="act" data-act="status" title="Move">${t.status === 'progress' ? '&larr;' : '&rarr;'}</span>
        ${d ? `<span class="tdue ${d.cls}">${d.text}</span>` : ''}
        <span class="act" data-act="delete" title="Delete">&times;</span>
      </div>
    </div>`;
}

/* --- interactions ------------------------------------------------- */
$('taskBody').addEventListener('click', (e) => {
  const row = e.target.closest('.task');
  if (!row) return;
  const id = row.dataset.id;
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;

  switch (e.target.dataset.act) {
    case 'toggle':
      t.done = !t.done;
      t.completedOn = t.done ? key(new Date()) : null;
      row.classList.toggle('done', t.done);
      mutate('PATCH', `/api/tasks/${id}`, { done: t.done, completedOn: t.completedOn });
      saveLocal();
      setTimeout(renderTasks, 220);
      break;

    case 'status':
      t.status = t.status === 'progress' ? 'todo' : 'progress';
      mutate('PATCH', `/api/tasks/${id}`, { status: t.status });
      saveLocal();
      renderTasks();
      break;

    case 'delete':
      row.classList.add('fadeout');
      state.tasks = state.tasks.filter((x) => x.id !== id);
      mutate('DELETE', `/api/tasks/${id}`);
      saveLocal();
      setTimeout(renderTasks, 200);
      break;

    case 'edit':
      beginEdit(e.target, t);
      break;
  }
});

function beginEdit(el, t) {
  if (state.editing) return;
  state.editing = true;
  const before = t.title;
  el.contentEditable = 'true';
  el.spellcheck = false;
  el.focus();

  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = (commit) => {
    el.contentEditable = 'false';
    el.removeEventListener('keydown', onKey);
    el.removeEventListener('blur', onBlur);
    state.editing = false;

    const next = el.textContent.trim();
    if (!commit || next === before) { renderTasks(); return; }

    if (!next) {
      state.tasks = state.tasks.filter((x) => x.id !== t.id);
      mutate('DELETE', `/api/tasks/${t.id}`);
    } else {
      t.title = next;
      mutate('PATCH', `/api/tasks/${t.id}`, { title: next });
    }
    saveLocal();
    renderTasks();
  };

  const onKey = (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true);
  el.addEventListener('keydown', onKey);
  el.addEventListener('blur', onBlur);
}

/* --- add ---------------------------------------------------------- */
const addRow = $('addRow'), addInput = $('addInput');

addRow.addEventListener('click', () => {
  addRow.classList.add('open');
  addInput.focus();
});
addInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const raw = addInput.value.trim();
    if (raw) {
      const { title, due } = parseDue(raw);
      const t = {
        id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title, due, done: false, status: 'todo', createdAt: new Date().toISOString(),
      };
      state.tasks.push(t);
      mutate('POST', '/api/tasks', t);
      saveLocal();
      renderTasks();
    }
    addInput.value = '';
    if (!e.shiftKey) { addInput.blur(); }
  }
  if (e.key === 'Escape') { addInput.value = ''; addInput.blur(); }
});
addInput.addEventListener('blur', () => {
  addRow.classList.remove('open');
  addInput.value = '';
});

/* ------------------------------------------------------------------
   agenda
------------------------------------------------------------------- */
function eventsOn(d) {
  const k = key(d);
  return state.events
    .filter((e) => key(e.start) === k)
    .sort((a, b) => (a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1));
}

function evRow(e, now) {
  const past = !e.allDay && e.end < now;
  const live = !e.allDay && e.start <= now && e.end > now;
  return `
    <div class="ev${past ? ' past' : ''}${live ? ' now' : ''}">
      <div class="evtime">${e.allDay ? 'all day' : fmtTime(e.start)}</div>
      <div>
        <div class="evtitle">${esc(e.title)}</div>
        ${e.location ? `<div class="evsub">${esc(e.location)}</div>` : ''}
      </div>
    </div>`;
}

function renderAgenda(now) {
  /* today, with a hairline where we are in the day */
  const today = eventsOn(now);
  let html = '';
  let placed = false;
  for (const e of today) {
    if (!placed && !e.allDay && e.start > now) { html += '<div class="nowline"></div>'; placed = true; }
    html += evRow(e, now);
  }
  if (!placed && today.length) html += '<div class="nowline"></div>';
  $('todayBody').innerHTML = html || '<div class="empty">Nothing scheduled</div>';
  $('todayDate').textContent = fmtDayLabel(now);

  /* tomorrow */
  const tm = addDays(now, 1);
  const tmEvents = eventsOn(tm);
  $('tomorrowBody').innerHTML =
    tmEvents.slice(0, 6).map((e) => evRow(e, now)).join('') || '<div class="empty">Clear</div>';
  $('tomorrowDate').textContent = fmtDayLabel(tm);

  /* the rest of the week — a glance, not a second agenda */
  let later = '';
  let shown = 0, hidden = 0;
  for (let i = 2; i <= 7 && shown < 7; i++) {
    const evs = eventsOn(addDays(now, i));
    if (!evs.length) continue;
    const take = evs.slice(0, 2);
    hidden += evs.length - take.length;
    shown += take.length;
    later += `<span class="daylabel">${fmtDayLabel(addDays(now, i))}</span>` +
             take.map((e) => evRow(e, now)).join('');
  }
  if (hidden) later += `<div class="empty">+${hidden} more</div>`;
  $('laterBody').innerHTML = later || '<div class="empty">Clear</div>';

  updateClips();
}

/* ------------------------------------------------------------------
   weather
------------------------------------------------------------------- */
const WMO = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  77: 'Snow grains', 80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm, hail',
  99: 'Thunderstorm, hail',
};

function renderWeather() {
  const w = state.weather;
  if (!w) { $('weather').innerHTML = ''; return; }
  const t = Math.round(w.temp);
  const feels = Math.round(w.feels);
  const hi = Math.round(w.max), lo = Math.round(w.min);
  $('weather').innerHTML = [
    esc(WMO[w.code] || 'Weather'),
    `${t}&deg; &middot; feels ${feels}&deg;`,
    `H ${hi}&deg; L ${lo}&deg; &middot; Wind ${Math.round(w.wind)} km/h`,
    state.place ? `<span class="dim">${esc(state.place)}</span>` : '',
  ].filter(Boolean).join('<br>');
}
