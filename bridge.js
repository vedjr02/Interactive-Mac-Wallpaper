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
