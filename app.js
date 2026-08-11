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
