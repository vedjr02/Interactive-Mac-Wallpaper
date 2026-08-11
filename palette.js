/* ------------------------------------------------------------------
   Twelve near-black colourways — one tint per month.

   The background ships plain black. Set TINTED = true at the top of
   app.js and the month's tint blooms in behind the grid instead,
   orbiting once around the frame over the course of the year.

   base   the near-black the whole field sits on
   tint   the colour of the month
------------------------------------------------------------------- */

const MONTHS = [
  { name: 'January',   base: '#080D18', tint: '#1B3E6B' },
  { name: 'February',  base: '#0A0814', tint: '#3B2A72' },
  { name: 'March',     base: '#060D08', tint: '#1F5233' },
  { name: 'April',     base: '#050C12', tint: '#175573' },
  { name: 'May',       base: '#100610', tint: '#5E1F44' },
  { name: 'June',      base: '#110D07', tint: '#5C4110' },
  { name: 'July',      base: '#130605', tint: '#6B1A0E' },
  { name: 'August',    base: '#110804', tint: '#6E320B' },
  { name: 'September', base: '#0D0E06', tint: '#414710' },
  { name: 'October',   base: '#120705', tint: '#5E1D0C' },
  { name: 'November',  base: '#09080D', tint: '#332C48' },
  { name: 'December',  base: '#040A08', tint: '#0F3D2A' },
];
