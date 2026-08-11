# Interactive Mac Wallpaper

A desktop interface that lives *in* the wallpaper. Calendar, weather and tasks
on a Swiss grid, driven by [Plash](https://sindresorhus.com/plash).

Plain HTML, CSS and JS with no build step, plus one zero-dependency Node file
that serves the page and talks to your calendar.

```
index.html    the markup
styles.css    the whole design system
palette.js    twelve monthly colourways — edit freely
app.js        rendering, interaction, view modes
bridge.js     local server: static files + /api
config.json   written on first run
tasks.json    your tasks
```

---

## Setting it up

**1. Start the bridge.**

```bash
node /Users/ved/wallpape/bridge.js
```

It prints `wallpape → http://localhost:7373`. Open that in any browser to check
it before wiring it to the desktop.

**2. Point Plash at it.**

Install Plash from the Mac App Store, then from its menu bar icon choose
**Open URL…** and enter:

```
http://localhost:7373
```

**3. Turn on Browsing Mode.**

Plash's menu bar icon → **Browsing Mode**. Without it, clicks pass straight
through to the desktop and nothing is interactive. With it on, the wallpaper
takes clicks like a normal window.

**4. Keep it running across restarts.**

```bash
cp /Users/ved/wallpape/com.wallpape.bridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.wallpape.bridge.plist
```

Logs land in `bridge.log`. To stop it:

```bash
launchctl unload ~/Library/LaunchAgents/com.wallpape.bridge.plist
```

---

## Connecting your calendar

Open `config.json` (created on first run) and paste your feeds into `icsUrls`:

```json
{
  "icsUrls": [
    "https://calendar.google.com/calendar/ical/…/basic.ics"
  ]
}
```

- **Google Calendar** — Settings → pick the calendar → *Secret address in iCal format*
- **iCloud** — right-click the calendar → Share → Public Calendar → copy the link,
  then change `webcal://` to `https://`

Feeds refresh every five minutes and cost almost nothing. Recurring events,
exceptions, all-day events and time zones are all handled.

**If you leave `icsUrls` empty**, the bridge falls back to scripting
Calendar.app. That works and picks up every account you have synced, but a full
sweep takes about a minute of CPU, so it runs on a background timer every
fifteen minutes rather than on demand. macOS will ask for Automation permission
the first time. Narrow it down with `"calendars": ["Work", "Personal"]` or turn
it off with `"useCalendarApp": false`.

## Weather

Open-Meteo, no API key. On first run the bridge does a single geo-IP lookup to
find you and writes the result into `config.json`. Set `latitude`, `longitude`
and `place` by hand beforehand and that lookup never happens.

---

## Using it

Everything is invisible until you go near it.

| | |
|---|---|
| **Add a task** | Click the empty row under the list, type, press Return |
| **Due date** | Add `@today`, `@tomorrow`, `@fri`, `@6 aug`, `@3d` or `@2026-09-01` to the end |
| **Complete** | Click the hairline checkbox |
| **Edit** | Click the task's text. Return saves, Escape reverts, emptying it deletes |
| **Delete** | Hover the task, click the `×` at the right |
| **Start / un-start** | Hover the task, click the arrow — moves it between *In progress* and *Not started* |

Two controls sit in the top-right corner, at about 17% opacity until you
approach them:

- **The bars glyph** switches between the column layout and the horizontal row
  layout. It shows the layout you'll get, not the one you're in.
- **The circle** is focus mode. Everything but the date, month, weather and
  the mini calendar fades out over five seconds. Click again to bring it back.

Both choices are remembered.

---

## The design

Twelve colourways, one per month, switching automatically at midnight on the
first. The month's colour name and hex are printed bottom-right in the same
spec-block typography as the weather.

The background ships as **plain black**. The colourways are still there — set
`TINTED = true` at the top of `app.js` and the month's tint blooms in behind
the grid instead, orbiting once around the frame over the course of the year.

Layout notes worth knowing before you edit:

- Hairlines are `border-left` on the grid sections, so they can never drift out
  of alignment with the content.
- The big figure is **today's date**, repainted at midnight. It owns the
  bottom-right corner and is drawn in SF Pro's condensed width so two digits
  can still stand tall. `placeNumeral` in `app.js` measures the corner, sizes
  the figure to fill it, and reserves the space back out of the upcoming
  column — so it never lands on a line of text or runs past the frame, at any
  window size, in either layout, on any day of the month.
- Columns that overflow get a fade at the foot, and only when something is
  genuinely cut off.
- `--inset-top` and `--inset-bottom` in `styles.css` keep content clear of the
  menu bar and Dock. Adjust if your Dock is on the side or hidden.

## If the bridge isn't running

The page still loads and still works — tasks fall back to browser storage and
the clock shows `offline`. Calendar and weather are blank rather than faked.
