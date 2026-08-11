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

