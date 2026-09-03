# Phantom Monitor

A monitoring dashboard over the Ekos MongoDB store: live device state, GPS accuracy,
geofence sites on a map, guidance back to a fence, deep filters and a read-only query
console. Deploys to Vercel as-is — one serverless function plus static files, no
external services, no API keys, no build step.

```
phantom-monitor/
  api/index.js         Vercel serverless entrypoint (exports the Express app)
  server/              app, Mongo layer, geo math, filters, routes
  public/              the dashboard (vanilla JS, no bundler) + vendored libs
  scripts/             opt-in index helper, asset vendoring
  vercel.json          static output + /api/* rewrite to the function
```

## Run it locally

```bash
npm install
npm run dev          # http://localhost:4310
```

Each API call logs one line - time, status, method, path, query and duration, with
anything over 2 s marked `SLOW`:

```
19:00:06  200  GET  /api/health  229ms
19:00:09  200  GET  /api/meta  3406ms  SLOW
19:00:11  404  GET  /api/nope  1ms
```

Static assets are not logged, colour is only used when a terminal is attached, and
`LOG_REQUESTS=0` silences it. `npm run dev` also watches the files and restarts on save.
If the `SLOW` lines bother you, `npm run indexes -- --yes` adds the indexes those
aggregations want.

The dashboard opens straight away — no password, because none is configured. Set
`APP_USERNAME` and `APP_PASSWORD` and the browser starts asking for them itself.
See [The password](#the-password).

`.env` is already filled in with the staging Atlas connection copied from
`phantom-be/.env`:

| Variable | Default | Notes |
|---|---|---|
| `MONGODB_URI` | staging Atlas cluster | required |
| `MONGODB_DB` | `phantomstage` | `phantomdev` also works |
| `COLLECTION_SNAPSHOTS` | `ekosClientState` | device/user heartbeats |
| `COLLECTION_CLOCKIN_LOGS` | `validateClockInLogs` | geofence validation calls |
| `COLLECTION_EXIT_WINDOWS` | *(empty)* | leave empty: auto-detected |
| `APP_USERNAME` | *(empty)* | set both to switch the password gate on |
| `APP_PASSWORD` | *(empty)* | leave either empty and the console is open |
| `PORT` | `4310` | local only |
| `QUERY_TIMEOUT_MS` | `25000` | per-query cap |

Collection names are only hints: on startup the app samples every collection in the
database and classifies it by shape, so if the writers move data elsewhere the
dashboard still finds it.

**The dashboard never writes to MongoDB.** Only `find`/`aggregate` run, the query
console rejects write and code-execution operators, and the one script that can write
(`npm run indexes`) refuses to act without `--yes`.

## Deploy to Vercel

```bash
npm i -g vercel        # if you don't have it
vercel                 # first deploy (framework preset: Other)
vercel --prod
```

Then set the environment variables in **Project → Settings → Environment Variables**
(at minimum `MONGODB_URI` and `MONGODB_DB`) and redeploy.

**Before deploying publicly, set `APP_USERNAME` and `APP_PASSWORD`.** With them empty
the dashboard is open to anyone with the URL, and it shows live coordinates and
employee contact details. `.env` is gitignored and never uploaded.

Or from the dashboard: import the repo, leave the framework as *Other*, output
directory `public`, add the env vars, deploy.

Details that make this work unchanged on Vercel:

- `api/index.js` exports the Express app; `vercel.json` rewrites `/api/(.*)` to it, so
  one function serves the whole API.
- The Mongo client is cached on `globalThis`, so a warm instance reuses its connection
  instead of opening one per request (Atlas connection limits).
- Leaflet and Chart.js are **vendored into `public/vendor/`** — no CDN, no
  `<script>` from a third-party origin. Refresh them with `npm run vendor` after a
  dependency bump.
- Sessions are a signed cookie (HMAC), so nothing is stored server-side and any
  instance can validate them.
- Every map draws **one quiet base layer** and nothing else: Esri’s light-grey canvas
  (roads, land, water) with place names in a separate transparent layer on top. No points
  of interest - no shops, no clinics, no restaurant pins - because the basemap is a backdrop
  for our markers, and everything else on it competes with the data. There is no satellite
  option and no layer switcher.
- Both tile layers are keyless, account-free and **unwatermarked**. CARTO Positron is the
  other obvious minimal basemap, but it now stamps "API KEY REQUIRED" diagonally across
  every tile unless you pay for a key.
- **Each theme gets its own basemap.** Dark mode loads Esri’s dark canvas, which is *drawn*
  dark - the same cartography rendered for a dark ground - rather than the light one put through
  a CSS inversion, which is what made streets and labels hard to read. Switching the theme swaps
  the two tile URLs in place (`PMMap.retheme()`), so markers, fences, trails and the current
  view all stay put; "System" also follows the OS changing underneath.
- The canvas is only rendered to zoom 16, so Leaflet upscales it for 17-18 and the map
  refuses to zoom further - past that the basemap smears and Esri serves a "map data not yet
  available" placeholder. To drop third-party tiles entirely, point `BASEMAPS` in
  `public/js/maps.js` at an internal tile server; markers, fences and trails render fine
  without tiles.

Note on the gate and Vercel: for the browser to ask for a password, the **page**
request has to be refused, not just the data. So `vercel.json` sends every HTML path
and `/api/*` through the function, and leaves only `/css`, `/js`, `/vendor` and the
favicon on the CDN — those hold no data. This is a change from serving the whole of
`public/` from the edge; pages now cost a function invocation, which for an internal
console is a fair trade for a gate that actually appears.

## The password

```bash
APP_USERNAME=irteza
APP_PASSWORD=a-long-random-password
```

Both set switches the gate on; either one empty leaves the console open (and says so
loudly on startup, because a half-finished gate that silently lets everyone in is the
worst failure mode). There is no login page and nothing to maintain: unauthenticated
requests get a `401` carrying `WWW-Authenticate: Basic`, which is what makes the
browser show its own password box.

It covers **pages as well as the API**. Guarding only `/api` would leave every page
readable and never raise a prompt at all — browsers do not reliably show the dialog
for a `fetch()`, only for a top-level navigation.

Three things to know, none of them fixable from here:

- **No sign-out.** Browsers hold Basic credentials until the window closes, and there
  is no way for a site to clear them. The topbar says so rather than offering a button
  that would not work. Changing `APP_PASSWORD` is what revokes access.
- **The credentials go out on every request**, base64-encoded — encoding, not
  encryption. Over https that is fine (Vercel terminates TLS). Over plain http on a
  shared network they are readable, so `npm start` on a laptop is for you, not for the
  office wifi.
- **One shared account.** Everyone uses the same username and password, so the topbar
  can say who is signed in but nothing can tell two people apart.

The comparison itself is constant-time over SHA-256 digests of both halves, so neither
the password nor its length leaks through timing, and a wrong username costs exactly
what a wrong password does. Pages served through the gate are sent
`Cache-Control: private, no-store` so no shared cache can hold an authorised copy and
hand it to the next visitor.

## What is redacted

The heartbeat documents embed the whole employee record, which in this store carries
SSN, bank account and routing numbers, home address and emergency contacts. None of
it is needed to answer a question about geofences or device health, and every
raw-document view — the Query Explorer, the **Raw document** drawer tabs — would
otherwise put it on screen.

[`server/lib/redact.js`](server/lib/redact.js) strips those fields from every
response that carries a raw document: `/api/query`, `/api/logs/:id`,
`/api/exit-windows/:id` and `/api/users/:id`. Matching is by field **name** at any
depth, so it keeps working when the writers add a field or move one, and a value
becomes `[redacted]` rather than vanishing — redaction should not look like missing
data.

One rule is context-sensitive. An `address` is personal inside a person's record and
is stripped there, but a **job site** address is the whole point of the Sites page and
is kept. Redacting by name alone broke the site address in the Checks raw view, which
is why the distinction exists.

What deliberately remains: names, employee reference, role, email and phone. An ops
console needs to say who a device belongs to and how to reach them. If a viewer
should not see contact details, add `email` and `phone` to the `ALWAYS` list.

## What the pages show

| Page | What it answers |
|---|---|
| **Overview** | **What is wrong, first.** A severity strip opens the page - each tile carrying its change against the previous window of equal length - then the current-state tiles, then **time on site** measured per person, then a ranked feed of detected problems split into people in the field and app/data faults, then the people worst affected. The live map and the trend charts follow as context. |
| **Live Map** | Full situational map: devices coloured by fence verdict, accuracy halos, fence circles, optional trails, and a side list with a walking-directions link for anyone outside their fence. |
| **Users & Devices** | Newest snapshot per user — device, app build, battery, connectivity, permissions, clock state, fence verdict, distance to the boundary. Clicking a row opens that user's own page in the same tab (ctrl/cmd-click or middle-click for a new one). |
| **Heartbeats** | Every stored device ping for every user, newest first, with the filters to cut it down: user, tenant, device, app build, site, accuracy band, missing permission, clock state, fence state, connectivity, with/without a fix, battery, search. Silence between a device’s own heartbeats is the point - a **Silence before** column across users, and full gap rows when one user is selected. |
| **User page** (`user.html?userId=…`) | One user end to end, opened from the table with a link back to it. Above: hero header with live badges, eight KPI tiles, and the person / device / right-now / shift detail cards. Below, in tabs: **location & trail** (map, layer toolbar, its own time window, and a replay that walks the trail heartbeat by heartbeat), **history** charts, **heartbeats** (every stored document, paged, click a row for its fix on a map plus its full breakdown), **geofence validation calls**, **exit windows** (the Exit Windows table and its replay drawer, filtered to this person - one shared view, not a thinner copy), **raw document**. Tab counts show how much is in each, the active tab lives in the URL hash (`#heartbeats`) so it can be linked, and panels render lazily — a chart or map sized inside a hidden panel comes out 0x0. |
| **Geofence Checks** | Every `validateClockInLogs` call with the geometry recomputed beside the API's verdict: distance from centre and boundary, whether the accuracy padding (`effectiveRadius`) is the only reason a check passed, auto clock-outs, unmapped clock-ins. Scatter of accuracy against distance from the boundary. |
| **Exit Windows** | The grace period that opens when a device leaves a fence: outcome, duration, sample verdicts, furthest distance outside, and a replay map of the sample path with guidance back to the site. Read live from the `exit_window` documents mixed into `ekosClientState`. |
| **Geofence Sites** | The fence registry — centre, radius, address, live occupancy, boundary failures, accuracy-grace events, auto clock-outs. Every geometry number carries its provenance, and a site with no fence on record is shown as an estimate rather than a fence. |
| **Query Explorer** | Read-only `find`/`aggregate` console with the field inventory, canned recipes, explain plans, table/JSON views and JSON export. |

### Map furniture

Popups are small data cards - a titled head (name, colour dot for the verdict, one
context line) and then aligned label/value rows, built by one `popupCard()` helper in
`public/js/maps.js`. They used to be a run of `label: value<br>` lines, which reads badly:
nothing separated the identity of the thing from its facts and no two values lined up.

Every map also carries a **scale bar** - every question asked here is a distance question
("is that fix outside the fence?"), and that is unanswerable by eye without one. Marker
rings and sequence pills are white in both themes because they sit on the pale canvas, not
on the app surface. Hover labels are pills with the tooltip arrow suppressed, and the zoom
control is a rounded stack with hover and focus states.

**A bug this uncovered.** Canvas-rendered layers are hit-tested in the order they were
added and Leaflet keeps the *last* match, so clicking a heartbeat on the trail resolved to
the decorative fence-centre pin drawn on top of it - interactive, but with no popup - and
nothing opened. The pin is now `interactive: false`, and the trail adds its layers
bottom-to-top (`accuracy, fences, path, clock-ins, labels, dots`) so the dots are always
the topmost target. `PMMap.instances` exposes the live maps for the headless checks.

### Trail maps

The trail view carries a layer toolbar - **Heartbeats, Clock-ins, Path, Sequence #,
Accuracy, Geofences** - plus a state filter (all / inside / outside / no flag / poor
accuracy). The path is not one flat line: each segment is coloured by what happened between
the two fixes, because a trail is only as trustworthy as its sampling.

| Segment | Meaning |
|---|---|
| solid, verdict colour | normal reporting interval |
| dashed amber | 10-30 minute gap between heartbeats |
| dashed red | 30 minute+ gap |
| solid violet | implied speed over 150 km/h - a suspicious jump |

Clock-in checks overlay in their own colours (inside / passed on the accuracy buffer /
outside), sequence numbers are thinned so they stay legible on a long trail, and the legend
under the map names every mark. The header counts the gaps and jumps it found - on the live
data one user shows 3 reporting gaps and 1 suspicious jump across 800 heartbeats.

Clock-in checks on this map are pulled for the **same range as everything else on the page**.
They were previously fetched by user id alone, so the trail carried marks from months
outside the window - clock-ins with no heartbeat anywhere near them, plotted in a frame
chosen for the heartbeats - and the tab count disagreed with the Geofence Checks page under
identical filters.

#### "Not all my heartbeats are showing" had four separate causes

Four different things removed heartbeats between the count in the KPI tile and the marks on
the map, and the map reported none of them - so all four looked like the same bug. The chain
is now printed under the map at every step that drops anything, with the control that caused
it:

| Step | Control | Why anything goes missing |
|---|---|---|
| in range → **loaded** | `Fixes` | the newest N heartbeats, not the whole range |
| loaded → **plottable** | none | the heartbeat arrived with no coordinates |
| plottable → **matching** | `State` | remembered per browser, so it can be on from a past visit |
| matching → **drawn** | `Merge nearby` | near-duplicate fixes folded into one mark |

`stats.points` (every matching fix) and `stats.drawn` (marks on the map) are reported
separately, and the header always reads *plotted of in-range*, so the map can be reconciled
with the tile above it without reading the notes.

**Fixes** was the big one. This page asked for `historyLimit=800`, hard-coded, and the
server clamped anything to 5,000 - so a whole shift of a 1 Hz device could not be plotted no
matter what you did. It is a choice now (800 → 100,000, default 5,000, remembered per
browser) and the server ceiling is 100,000. A day of one 1 Hz device is 86,400 heartbeats,
so the top of that list is a real answer rather than a gesture. The projection is nine small
fields, so the cost is transfer rather than the query; the response carries `trackLimit`,
`trackCeiling`, `trackFetched`, `trackNoFix`, `trackTruncated`, `trackFrom` and `trackTo`,
and the map says which limit it hit and whether raising it would help.

**State** is worth its own mention: it lives in `localStorage`, so a filter set weeks ago is
still on today with nothing on screen to explain the missing marks. The control now
highlights itself while it is filtering, and the note says how many it is hiding.

#### Two fixes 3 m apart are one position, and drawing both hides everything under them

Reporting rates across this fleet differ by over 200x. A device sending a heartbeat a
second, parked inside a 3 m circle for ten minutes, produces 600 fixes at effectively one
place. Drawn literally that is 600 opaque dots stacked on each other, 599 sub-pixel path
segments buried underneath them, and 600 accuracy halos at 6% fill that add up to a flat
grey disc. **Nothing was missing** - the Path and Accuracy layers were being built and
added exactly as the toolbar said. They were invisible under the pile, which is why turning
them off and on looked like a broken toggle.

`PMMap.trail()` can thin what it *draws*, behind the **Merge nearby** chip. A fix is kept
when it is farther from the last kept one than the accuracy that produced it (floor 4 m,
ceiling 30 m - two fixes closer than their own error bars are not two positions), and always
when it carries something distance does not:

- the first and last fix of the trail,
- a change of fence state or clock state,
- either side of a reporting gap or a suspicious jump.

Everything dropped is folded into the fix it sits on, whose popup says how many and through
when. On the 800-fix stationary case that is 2 marks and 798 merged.

**It is off by default.** Merging makes a stationary cluster legible, but it also means the
map holds fewer marks than the person has heartbeats, and "show me all of them" is both the
more common ask and the safer default - so `trail()` thins only when told to (`thin: true`),
and drawing everything is what happens if nobody says otherwise.

`stats` is counted over **every** fix either way - how well a device reported is a fact
about the data and must not move when the drawing does - so the gap and jump counts in the
header never change with the chip.

The path is also built as runs rather than one polyline per pair: consecutive segments of
the same kind become one `L.polyline`, and gaps and jumps stay separate so their popup is
about those two fixes. An 800-fix trail was ~2,400 canvas paths with ~2,400 popup HTML
strings built up front; popups are now functions Leaflet calls on open. That is what makes
drawing every fix affordable at all, and the note warns past 15,000 marks that panning will
be slow and suggests the chip.

Sequence numbers come from the heartbeat's own ordinal in the track, not its index in the
filtered array, so selecting "Inside fence" no longer renumbers the survivors out of step
with the table below.

#### The History charts bucket instead of hanging

The three charts on the History tab plotted one point per heartbeat straight off the track.
At the old hard-coded 800 that was fine; at 50,000 it is a hung tab, and even at 5,000 the
lines are denser than the canvas has pixels. `bucketTrack()` groups the track into at most
1,500 contiguous buckets, and which value represents a bucket is chosen per series rather
than by taking every Nth point - a stride silently drops exactly the spikes these charts
exist to show:

| Series | Bucket value |
|---|---|
| GPS accuracy | the **worst** in the bucket - the fix least able to judge a fence |
| Battery | the **lowest** in the bucket - the one that predicts a silence |
| Geofence state | the **count** of each state, which is what the axis already said |

Under 1,500 points nothing happens and the charts are exactly as before. Above it every
title says what it is showing ("GPS accuracy per 34 heartbeats · worst in each group ·
50,000 heartbeats grouped into 1,471 points"), so a smoothed line is never mistaken for a
quiet device.

#### A fence 40 km away is not context

The map used to fit the trail and every fence the person had ever touched in one call. This
store holds sites registered tens of kilometres from where anyone works - from old
snapshots, and from fences with no site id - and one of those framed a 40 km box in which
a whole shift's trail is a single pixel. `PMMap.fitWithContext(map, points, context)` frames
the heartbeats and the current fix, then includes only the fences within reach of them (the
span of the data itself, floor 1.5 km), **to the fence boundary rather than its centre** -
fitting to the centre point drew a 300 m circle and then zoomed past it. Whatever it leaves
out is reported and printed under the map, rather than dropped off the edge in silence.

#### Raising that limit meant the response had to fit through Vercel

A Vercel serverless function may return at most **4.5 MB**. The trail is one JSON array of
heartbeats, so a limit of 100,000 is not a UI choice on its own - it is a payload question,
and getting it wrong is not a slow page but a dead one (`FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE`).
Two changes make it fit, and both were measured rather than assumed.

**The track carries only what is read.** Each point was 189 bytes and three of its ten fields
- `accuracyBand`, `connected`, `jobSiteId` - were never touched by the map or the charts. The
band is derivable from `accuracy` anyway, and the other two live on `current` and on the
Heartbeats rows, which is where they are actually used. The Mongo projection behind it asked
for fourteen fields (including `permissionsEnabled`, an array) to build a seven-field point;
it now asks for five. 189 bytes → 134.

**JSON responses are gzipped**, by about sixty lines of `zlib` in `server/app.js` rather than
a dependency - `compression` would have been the first runtime package here that is not
Express or the driver. Thousands of objects with identical keys and near-identical values is
the best case DEFLATE has, and it measures like it:

| Track | Raw | On the wire | |
|---|---|---|---|
| 5,000 | 0.64 MB | 0.07 MB | |
| 20,000 | 2.55 MB | 0.26 MB | |
| 50,000 | 6.53 MB | 0.65 MB | 10x |
| 100,000 | 12.75 MB | 1.30 MB | fits, uncompressed would not |

Only JSON is touched: HTML, CSS and JS are served by `express.static` and by the CDN on
Vercel, which compresses them itself, and the vendored images are already-compressed formats
that gzip would only make bigger. Bodies under 1 KB are sent as-is, `Vary: Accept-Encoding`
is set so no cache hands a gzipped body to a client that did not ask for one, a client
sending `Accept-Encoding: identity` still gets plain JSON, and a compression failure falls
back to the uncompressed body rather than failing the request - compression is an
optimisation and must never be the reason a response dies.

**For this store the ceiling is not reachable.** `ekosClientState` holds 79,372 documents in
total, so 100,000 is more than every heartbeat from every device ever recorded: no single
user, over any range, can be truncated by it. The default of 5,000 is what truncates - on the
two dense reporters, which is exactly where the map says so and offers the control.

The limit that does still bite is **drawing**, not loading. Past roughly 15,000 marks the
canvas is slow to pan and zoom and the fixes overlap into a blob; that is what **Merge
nearby** is for, and the note says so at that threshold. Counts, gaps, jumps and the charts
are exact either way.

#### The map survives a reload

Every reload of this page - a filter change and every auto-refresh tick - re-renders the
panel and throws the map's container away. The old `L.Map` used to survive that: its window
resize handler stayed attached to a detached container, it stayed in `PMMap.instances` for
`retheme()` to walk, and the replacement re-fitted, so anyone who had zoomed in to read a
cluster was thrown back out on every tick. The old instance is now torn down with
`map.remove()` (which prunes `PMMap.instances`), and the replacement is handed the view the
user was looking at - unless no heartbeat is left inside it, in which case it refits rather
than hand back a blank frame.

### Where a fence circle gets its radius

`PMMap.siteCircle()` draws a solid circle at the recorded radius only when told
`radiusIsAuthoritative`; otherwise it draws a dashed 40 m *estimated centre* ring, because
drawing a circle is a claim about a boundary and an unrecorded one should not be made to
look like a fence.

That contract was quietly violated by two callers that built their site object by spreading
a document's own `fence` field - which carries `lat`, `lng` and `radius` but no provenance:

- the **exit-window replay** drawer, and
- the **Geofence Checks** drawer.

Both therefore drew a dashed grey 40 m guess where a 200 m fence belonged. The site name,
site id and address all resolved correctly from the matched registry row, so the fence
looked simply absent rather than wrong. Both fences are as authoritative as this store
gets - the exit-window document records the boundary the device was judged against, and the
check's fence comes out of the geofence log itself (`siteArea.locations`) - so both callers
now declare it, and both frame the circle's edge instead of its centre. The Checks drawer
also fits its map even when the check has no usable fix, which is the one case where the
fence on its own is all there is to see.
### The map's own time window

The filter bar at the top of the page sets the range for everything. The trail map now
carries a second, tighter one, because narrowing the range is the one thing that *always*
makes a trail complete: the Fixes limit takes the newest **n** heartbeats, so a window small
enough to hold fewer than n of them cannot be truncated.

```
Window [ 2026-09-03 14:00 ] → [ 2026-09-03 14:15 ]  [Apply]
  15 min · 1 hour · 3 hours · 6 hours · 12 hours · 24 hours │ ◀ Earlier  Later ▶ │ ⤡ Narrow to what loaded
```

Presets run 15 min · 1 hour · 3 hours · 6 hours · 12 hours · 24 hours, and the page filter bar
gained a matching **Last 12 hours** (it already offered 3). They are anchored on the
**newest heartbeat that loaded**, not the wall clock - "the
last hour" of the data you are looking at, which on a range that ended yesterday is not the
same thing. **Earlier** and **Later** shift the window by exactly its own length, so a dense
day is walked one contiguous, complete window at a time.

**⤡ Narrow to what loaded** appears only when the trail was truncated, and is the one-click
version of the whole workflow: it sets the window to the span that actually came back, so the
next load is complete by construction. From there, Earlier walks backwards through the range
with nothing cut off at any step.

The window *refines the page filter* rather than sitting beside it - the request is the same
request, so every count on the page agrees with the map instead of the map quietly
disagreeing with the tile above it. That is worth being loud about, so the bar highlights
itself whenever a window is set, and changing anything in the page's own filter bar clears
it (otherwise the filter bar would appear to do nothing).

**The same bar is on the Heartbeats tab**, driving the same window. That tab fetches its own
page from `/api/snapshots`, and the window was applied in `load()` only - so it kept answering
for the whole page range while the map beside it answered for fifteen minutes. Two tabs of the
same person disagreeing about how many heartbeats exist is worse than either number on its own,
so every request this page makes now goes through one `scopedQuery()`. The map keeps
**⤡ Narrow to what loaded** to itself, because that button is about the trail.

### Replay

A trail says where someone went. It does not say when, how fast, or what the device was
reporting at the time - for that you read the Heartbeats table next to the map and join the
two by eye. Replay puts them together: **the map is cleared back to empty and the trail is
drawn again as it plays**, with a readout showing the heartbeat the marker is standing on.

```
▶ Play  ⏮ ⏭ ↺  ├────────●──────────┤  Speed [Auto (~30 s)]  ☑ Follow  ✕ Exit replay
Sep 3, 14:32:07   heartbeat 1,204 of 5,000   ● Inside   Good 12 m   84%   on the clock   travelled 1.4 km
```

Clearing first is the whole point. Playing a marker along a route that is *already* fully
drawn answers only "where are they" - the ending is on screen from the first frame. Drawn as
it goes, the map answers "what did we know at 14:32", which is the question a replay is for.
Heartbeats, path, sequence numbers, accuracy halos and clock-in checks all arrive as the
clock reaches them. **Geofences stay** - a fence is not something that happened at a moment,
it is the thing the replay is being judged against.

- **↺** winds right back to an empty map. **✕ Exit replay** hands it back and the whole
  trail returns exactly as it was; so does changing the window, the State filter or the
  Fixes limit, since those rebuild the trail underneath it.
- **Speed** defaults to *Auto*, which plays whatever is loaded in about thirty seconds
  regardless of how long the window is. Fixed rates (real time, 1 min/s, 5 min/s, 30 min/s,
  2 h/s) are there when you want to compare two windows at the same scale.
- **⏮ / ⏭** step one heartbeat at a time and land exactly on it, which is how you read a
  specific fix rather than a moment between two.
- **Follow** recentres the map only once the marker drifts out of the middle of the view -
  panning every frame fights the user and never settles - and never on the opening frame,
  which would pan straight off the frame the map had just fitted.
- The layer toolbar keeps working mid-replay: turning Accuracy on reveals halos for the
  heartbeats reached so far, not for the whole trail.

Two rules keep it honest, because a smooth animation is very good at implying knowledge that
is not there:

- **Position is interpolated only across a normal reporting interval.** Across a gap or a
  suspicious jump the marker *holds still* at the last known fix until the next one arrives,
  and the readout says `⚠ no heartbeat for 45 min - holding here`. Gliding smoothly across a
  45-minute silence would be inventing a route.
- **Nothing is blended.** Accuracy, fence state, battery and clock state are read off the
  heartbeat at or before the current instant, never averaged with the next one. A device is
  inside the fence or outside it; there is no halfway.

#### Redrawing a trail 60 times a second, without redrawing the trail

The obvious implementation - rebuild the visible trail from `points.slice(0, i)` each frame -
is O(points) per frame and hopeless past a few thousand. `PMMap.progressiveTrail()` keeps the
per-step cost flat instead, and the whole design follows from one decision: **it reveals the
very same layer objects the static trail already built**, never copies of them.

| | how |
|---|---|
| a heartbeat arrives | `addLayer` on the mark `trail()` already made - Leaflet's canvas redraws only the bounds that changed, so one dot costs about one dot |
| a stretch of route completes | the prebuilt run polyline from `trail().runs`, added whole - no re-projection, and the played path keeps the static one's colours, breaks and dashes exactly |
| the route being walked | chunked at 250 points: everything behind the current chunk is frozen into its own polyline and never touched again |

`setLatLngs` re-projects an entire polyline, so a single growing line is O(points) every
frame - which is exactly what makes a long replay stutter. Chunking bounds the redrawn line
at 250 vertices no matter how long the trail is; a full 1,000-point playback in the tests
never exceeds 251. Seeking backwards is the same machinery in reverse, so scrubbing is as
cheap as playing.

Sharing the layer objects is what makes this cheap, and it is also the one thing that can go
wrong: a Leaflet layer cannot be in two places at once. So the static groups come **off** the
map when a replay starts rather than being hidden, `applyVisibility()` stands aside while one
is running, and a rebuild tears the replay down *before* it touches the layers - otherwise
the map ends up with neither the revealed trail nor the static one.

`PMMap.trailTimeline()` precomputes timestamps, cumulative distance and which steps may be
glided across in one O(n) pass, so `PMMap.seekTimeline()` is a binary search: scrubbing a
50,000-point trail costs what scrubbing a 50-point one costs. Only the clock is written per
frame; the badges are rebuilt when the replay actually reaches the next heartbeat, not sixty
times a second for values that changed once.

### Heartbeats

A missing heartbeat is data. A device that stopped reporting looks exactly like a quiet one
unless the gap is drawn, so silence gets a row of its own:

> ⚠ **Heartbeat lost** · Sep 1, 02:54 → Sep 1, 03:12 · Silent for 18 min · ? unexplained

Ten minutes of silence is flagged and thirty is critical (red) - the same thresholds the
trail map colours its path with, since a heartbeat normally lands every 25-60 s here. The
last chip names the likely cause, read off the last heartbeat before the silence: logged
out, clocked out, device offline, battery at or under 15%, background location denied, or
not "allow all the time". Anything else reads **unexplained** rather than inventing a reason.

Gaps are measured per device between consecutive *stored* heartbeats, so one spanning a page
boundary shows on the next page - the banner above the table says so. On the all-users page
the silences become a **Silence before** column instead, because a gap row drawn between two
different people’s heartbeats would mean nothing.

#### The drawer opens on a map

Clicking a heartbeat row used to give a column of facts: `24.86072, 67.00114 · Good 12 m ·
outside · 43 m from the boundary · bearing 190° S`. Those are the right numbers and they are
close to unreadable - nobody holds a coordinate pair in their head, and "43 m outside" means
nothing without knowing whether that is across a car park or across a motorway.

So the drawer leads with **Fix & fence**: the fix with its accuracy halo, the fence it was
judged against, and the walk-back line when it landed outside - the same six values, placed.
The old column of facts is the second tab, unchanged. It is the map tab first because the
drawer renders every panel up front and an inactive one is `display:none`, which is how a map
comes out 0×0.

It draws the fence from `row.site`, which carries its own provenance, so a recorded fence gets
a solid ring at its real radius and an inferred centre gets the dashed estimate - the trap the
exit-window and Geofence Checks drawers both fell into by spreading a bare `fence`. It frames
the fence *edge* rather than its centre, degrades to whatever is known (no site, no fence, no
coordinates at all), and releases the previous map when another row is opened as well as on
close - a drawer is reopened far more often than it is closed, and the old instance would
otherwise keep a resize handler bound to a container that had left the document.

Because the view is shared, this lands on **both** the Heartbeats page and the Heartbeats tab
of a user page at once.

The table, the gap rows and the drawer live in `public/js/heartbeats.view.js`, shared by the
Heartbeats page and the Heartbeats tab on a user page.


Each `ekosClientState` document is one **heartbeat** from a device - the app writes one
every few seconds while it runs. The user page calls them that throughout, and the
Heartbeats tab lists them raw, one line per document: time, device and app build,
session (logged in + clocked in), the device geofence flag beside the recomputed verdict,
distance to the boundary, site, lat/lng, accuracy band, battery, network and device-local
time. Wide rows scroll sideways inside the table rather than wrapping, and `↓ CSV`
(`/api/snapshots.csv`) exports the same columns.

### The Overview leads with problems

Counts are not findings. "9 devices reporting, median accuracy 14 m" says nothing
about whether anything is wrong, and the old Overview made the reader know which
numbers were bad in order to spot them. So the page now opens with a severity strip -
how many critical, serious and warning findings there are - followed by the state tiles,
and then the ranked feed of what those findings actually are.

Each row is one problem: severity, how many, a sentence of what it means, who it
happened to, when it was last seen, the collection and field it came from, and a
link to that page already filtered to the documents behind the number - so every
count on the feed is checkable in one click.

The feed is split by who has to act. **People in the field** is a supervisor's list:
on the clock outside the fence, stopped reporting while clocked in, background
location denied, battery about to die, auto clock-outs, checks that failed the
geometry. **App & data** is an engineer's: the app and the geometry disagreeing on a
fence, exit windows never resolving, windows judged against a fence kilometres away,
clock drift, devices clustering outside the fence they are judged by, silence nothing
explains.

Two rules keep it honest. A detector only fires on evidence in the data - nothing is
inferred from an absence, and nothing is rolled into a single health score, because
one number that falls for unrelated reasons tells nobody what to do. And severity is
assigned by consequence, not by count: one person who stopped reporting mid-shift
outranks a hundred cosmetic warnings.

The harder rule is what stays out. A supported flow is not a fault, however unusual it
looks in the data: a site is allowed to have no geofence, and clocking in without one is
a normal path through the app - both were detectors here until someone who knows the
product said so, and both were removed rather than downgraded. A feed that reports
normal behaviour teaches the reader to skip it, which costs more than the finding was
ever worth. When in doubt about whether something is a fault or a flow, ask.

`GET /api/issues` returns the feed, `/api/issues.csv` exports it, and both take the
same filters as every other endpoint. Detection costs a few seconds, so the route
caches for 60 s (`?refresh=1` bypasses it).

#### Silence is a finding

One flat threshold cannot fit this fleet. With cadence spanning a factor of seventy,
nine minutes of silence from a device that reports every second is a dead app that no
ten-minute rule catches, while ten minutes from a device that reports every five
minutes is barely two missed beats. Each gap is therefore also compared against the
median gap **for that same device** - one device’s median is 1,002 ms, which makes
the flat ten-minute threshold six hundred times its normal cadence.

The absolute thresholds stay, because ten and thirty minutes of silence matter to
anybody whatever the device’s habits. On top of them sits one more finding, *silence
far beyond what the device normally does*, for gaps too short for a flat rule to see
but many times that device’s own cadence. Every note carries the multiple and the
baseline, so "723 min silent · 1219× its usual 36s" can be judged on sight.

Every other number on the page is computed from documents that exist. The problem
with a device that stopped reporting is documents that do not, so gaps between one
device's consecutive heartbeats are detected explicitly.

Two things keep that from being noise. Silence while someone is **off** the clock is
not a fault - the overnight gap between shifts is the largest gap in this data and
means nothing - so only silence on the clock is reported. And the state carried by
the heartbeat *before* the gap is read back, so a silence can be attributed: logged
out, device offline, battery at or under 15%, background location denied, location
not always-on. Silence with none of those is the app failing quietly, and gets its
own entry.

It runs as two queries rather than one wide one. `$setWindowFields` sorts each
partition in memory, `allowDiskUse` is not honoured on this deployment, and sorting
whole documents exceeds the 32 MB sort budget outright - so the window pass projects
down to two fields and the pre-gap state is fetched afterwards for only the gaps
that were found.

### Counting heartbeats is not measuring time

Reporting rates in this fleet differ by more than two hundred times. One device
lands a heartbeat every second; another sends one every five minutes. Two devices
alone produce about four fifths of every heartbeat in the store.

So any percentage computed over heartbeats is largely a statement about those two
phones. "38% of heartbeats were inside the fence" and "the average person was
inside 57% of the time" are both true and nowhere near each other, and only the
second is an answer to the question anybody asked.

`/api/fence-time` ([`server/lib/fence.js`](server/lib/fence.js)) measures it
properly, by integrating state instead of sampling it: the interval between two
consecutive heartbeats is credited to the state the earlier one reported. A device
reporting every second and one reporting every five minutes then give the same
answer for the same shift.

Each interval is capped at fifteen minutes - the same staleness threshold the rest
of the console uses. Past that the device was silent and its state is genuinely
unknown, so the time is dropped rather than credited, and reported separately as
**silent** time: the span where nobody knew where that person was, which is a
finding rather than a rounding error.

The method was checked against the two devices that report densely enough for a
heartbeat count to be close to the truth anyway: integration gives 47% where
counting gives 51%. For a device whose reporting rate itself changes with the thing
being measured the two diverge by nearly twenty points, and integration is the
correct one. The Overview shows both side by side, and flags any person where they
disagree by ten points or more - seeing them disagree is what makes the difference
believable.

`/api/stats` reports `dominance` for the same reason: how much of the evidence comes
from the two loudest devices, so the page can caveat its own heartbeat-weighted
charts instead of implying they were evenly sampled. It deliberately does **not**
offer a per-person share of fence time - a share of one person’s heartbeats is
still rate-biased, and averaging those per person weights somebody with four minutes
of data equally with somebody with a full day. One endpoint owns that question.

### Fence crossings, and the exits that never arrive

Every heartbeat can also carry `geofenceIn` and `geofenceOut`, the moment of the
last crossing in each direction. Two things about them, both learned the hard way:

- **They are transient markers, not state.** Most heartbeats carry neither, even
  while `isInsideGeofence` is true. Grouping heartbeats by their `geofenceIn` value
  therefore does *not* recover a visit - the first attempt at this credited one
  person 203% of their own watched time. The crossings are collected as a set of
  events and paired on their own timeline instead.
- **An exit is only recorded if a heartbeat was sent while the marker was set,** so
  exits go missing. An entry followed by another entry means they had left in
  between; the visit is closed at that second entry and marked `endInferred`, so a
  reasoned end is never presented as a measured one. An unclosed entry is credited
  only up to the last heartbeat - beyond that, being on site is an assumption.

Marker coverage is wildly uneven: one device emitted two crossings in 41 hours while
another emitted forty in a day. Visit counts are therefore a **floor**, never a
total, `eventCoverage` says how far to trust them per person, and no percentage is
ever derived from them.

What this makes visible that a heartbeat count cannot: a fence **entered and never
left** (still inside on the newest heartbeat, an entry recorded, no exit ever), and
fence crossings **flapping** - crossed and re-crossed within a minute, repeatedly,
which is GPS scatter against the boundary rather than anybody moving. Each flap can
open an exit window, so it manufactures alerts as well as draining battery.

### Network state, and one field left alone

`isConnected` and `isReachable` are separate facts and only the first was read. A
device that reports a working connection and still cannot reach the server is a
different problem from one with no signal: it points at the server, DNS or the
route, not at the person holding the phone. Six devices in this store are in that
state and nothing used to say so.

Clock-ins taken with `clockInNetworkStatus: OFFLINE` are held on the device and
sent later, so their timestamp and location are whatever the phone believed and
were never checked against the server. That makes them the least reliable records
here and the first place to look when a shift or a fence verdict is disputed.

`batteryOptimizationPermission` is deliberately **not** used. It is null on all
61,812 iOS heartbeats and a boolean on every Android one, so it is platform
specific rather than missing - and every Android device reports `true`, which
could mean the exemption is granted or that optimisation is switched on. Nothing
in the data settles the polarity, and a detector resting on a guess would either
invent faults or hide them. It needs an answer from whoever writes the app.

### Whose clock is it?

This fleet spans `America/Bogota`, `America/Chicago` and `Asia/Karachi`, and over
nine tenths of the heartbeats come from people ten or eleven hours away from a viewer
in Karachi. Every timestamp used to render in the *viewer’s* browser timezone with
nothing marking it, so a gap shown as 03:37 actually happened at 17:37 the previous
afternoon where the person was standing - which makes any reasoning about shifts,
overnight or end-of-day wrong for almost the whole fleet.

Event times - crossings, clock in, clock out, last seen - now render in the worker’s
own timezone with the zone named (`fmt.dateIn`), because a bare local time is a worse
kind of wrong: it looks authoritative and cannot be checked. Relative times ("2 h
ago") stay as they are, being timezone-independent by nature.

One trap worth recording: `toLocaleString` throws if `dateStyle`/`timeStyle` are
combined with `timeZoneName`, and the throw landed in a fallback that quietly
rendered the viewer’s time from the function whose entire purpose is not to. The
options are spelt out component by component for that reason.

### Where fence geometry comes from

Three sources feed the site registry, and they are not interchangeable. Mixing them
was the original bug: a circle drawn on the map read as a boundary regardless of
whether anyone had ever configured one.

| Source | Gives | Trust |
| --- | --- | --- |
| `validateClockInLogs` | centre, radius, address, embedded on every validation call | **authoritative** — the only real fence geometry |
| `ekosClientState` heartbeats | activity, and a centre *estimated* from on-site fixes | estimate only, never a radius |
| `exit_window` documents | fence centre + radius, but **no site id** | a candidate, listed not adopted |

So `hasFence` means one thing: the geofence log had a fence. Each row also carries
`centreSource`, `radiusSource` and `centreConfidence`, and the map only draws a solid
circle when the radius is authoritative — an estimated centre gets a dashed ring sized
to the spread of the fixes behind it, which is what is actually known.

A radius is never borrowed. Several fences of different sizes sit on the same spot in
this data (a 20 m and a 100 m fence share site 12's centre), so adopting whichever one
happened to be nearest would be picking the rule a site is judged by at random. Nearby
fence records are listed in the drawer with their distance and whether the radius
agrees, and left there.

The same rule governs verdicts: a distance-from-boundary is only computed against a
fence on record. No authoritative geometry means the row shows the device's own flag
and nothing more, rather than an invented inside/outside.

### When a site moves

Geometry is embedded on each validation call, so an edit shows up as a new revision
rather than overwriting anything. The registry groups by site **and** geometry, takes
the revision on the newest call as current, keeps the rest as history, and reports the
jump: `fenceMovedMetres`, `fenceMovedAt`, `fenceRevisions`. Per-site counts sum across
revisions, so a relocation does not silently reset them.

Estimated centres are harder, and are deliberately not an average of everything ever
stored — that yields a point between the old and new locations where nobody has stood.
Fixes are bucketed by time (hourly for ranges up to a week, daily beyond), grouped by
proximity, and the **largest** group wins. Not the newest: a phone clocked into site 60
while standing at site 12 puts six fixes 5 km away, and newest-wins made those six the
site. A second location holding a real share of the fixes is reported as a **disputed**
centre with both listed, because an estimate with two credible answers should say so.
Fixes taken outside the fence are ignored whenever inside-fence fixes exist — they say
where a person was, not where the fence is.

Two things follow. Estimated centres are scoped to the dashboard's date range, so
`/api/sites` takes `from`/`to`. And the registry is cached for 5 minutes per range, so
the ⟳ Refresh button sends `refresh=1` to rebuild it — without that, a refresh after an
edit re-runs every query against the same cached geometry and the site looks unmoved.

Finally, `centreDivergenceMetres` states the gap between the recorded centre and where
devices actually cluster, flagged when it exceeds the radius. Nobody eyeballs two
coordinate pairs and spots a 200 m error; that number is the cheapest signal that a
fence is wrong or stale.

### Accuracy is treated as part of the verdict

A fix whose accuracy circle straddles a fence boundary cannot honestly be called inside
or out, so the dashboard reports it as **Uncertain** rather than picking a side. That is
why a device can be "inside" per the app and "uncertain" here — e.g. site 12 has a 20 m
radius and phones there report ±13 m.

The same idea drives the *accuracy grace* column on Geofence Checks: the backend
compares against `effectiveRadius = radius + accuracy`, so a check can pass while the
raw geometry says the device was outside. Those cases are called out explicitly.

## Light and dark

The switcher sits in the top bar: **Light / Dark / System**. Light is the default;
System follows the OS setting. The choice is stored per browser and applied by a tiny
inline script in each page's head, so there is no flash of the wrong theme on load.

Both themes are separate palettes from the same ramps rather than one inverted into the
other, and every colour is a CSS variable in one block at the top of
[public/css/app.css](public/css/app.css). Charts and maps read those variables at
runtime, so switching theme repaints them live - no reload - and re-theming the whole
app means editing that block only. Light mode also leaves the map tiles alone; only dark
mode inverts them.

## When something fails

A failed refresh used to be the most dangerous state this console could be in.
Every panel kept exactly the numbers it already had, and the only signal was a
toast that disappeared after seven seconds - so anyone arriving a moment later
read stale figures as current. A failed *first* load left every panel shimmering
as a skeleton indefinitely.

Now a failure raises a **standing banner above the content** naming what could
not be loaded, what time the figures on screen are actually from, and a Retry
button. It stays until a load succeeds. Nothing is left in a loading state, and
the live indicator in the topbar reads `stale - refresh failed` rather than a
timestamp that implies freshness.

The Overview also requests its four endpoints with `Promise.allSettled` rather
than `Promise.all`. They answer four independent questions, and `all` discarded
three good answers whenever the fourth failed - so one slow aggregation blanked
the whole page. Panels whose own request failed say so individually; the rest
render as normal, and the banner says which is which.

## Cold starts, caches and drifting windows

`/api/meta` probes every collection and then runs a seven-way facet over all of
it: about six seconds on a cold instance. It used to be awaited before anything
was drawn, so the window stayed empty for those six seconds - the slowest thing
about using the console. Nothing on any page needs it in order to request its own
data; it fills the filter dropdowns and the shell counters. So the page now draws
and loads immediately, and the dropdowns fill in when metadata arrives.

That is why pages pass a **function** to `PM.buildFilterBar` rather than a built
spec: the bar is drawn once with empty dropdowns and rebuilt once there is
something to list. `PM.state.meta` also keeps one object identity for the life of
the page and is filled in place, because every page destructures it out of its
init argument and would otherwise hold the empty original. The Query Explorer is
the one page that builds UI *from* metadata rather than filtering by it, so it
listens for `pm:meta` and refills its collection picker.

The aggregating endpoints go through a shared 60-second per-query cache
([`server/lib/cache.js`](server/lib/cache.js)), which also collapses concurrent
requests for the same key so the Overview firing four requests at once cannot run
the same aggregation twice. Metadata is cached for ten minutes, since the contents
of a dropdown change over days. Refresh sends `refresh=1` and bypasses all of it.

**Two drifting windows had been quietly defeating every one of those caches.** A
rolling preset like "last 24 hours" resolved to `Date.now() - 24h` on every call,
so no two requests ever shared a cache key and every auto-refresh tick paid full
price. And the baseline window for the period-on-period comparison was derived
from `Date.now()` the same way, so it never cached *and its numbers moved between
two refreshes of the same page*. Both are rounded down to the minute now. A window
that starts up to sixty seconds early changes no answer here, and the comparison
is stable.

## While it loads

Nothing here says "no data" until a query has actually answered.

- The **frame goes up first**. `renderShell()` used to wait for `/api/meta` - the
  slowest request on the page, since it counts documents - which left the window blank.
  Now the sidebar, nav, page title and theme switch render immediately and
  `renderShellMeta()` fills in the collection counts and the database chip when that
  request lands.
- Each page declares what it is about to fill: `PM.showSkeleton({ '#user-table':
  'table:10x9', '#user-tiles': 'tiles:5' })`. Placeholder shapes match the real
  geometry (tile grid, row height, column count), so the layout does not jump when the
  data arrives.
- **Charts and maps keep their canvas** and take a shimmer overlay instead - replacing
  the element would break Chart.js and Leaflet. `PM.markLoaded()`, which every page
  already called when its render finished, clears them.
- **A refresh does not blink.** A container that already holds real content is left
  alone; the progress bar carries the news instead. Only genuinely empty containers get
  placeholders (pass `{ force: true }` to override, as the heartbeats pager does).
- Placeholders honour `prefers-reduced-motion`, and their grey comes from a per-theme
  token so the dark palette is not a bright flash.

## Filters

Every page shares one filter bar; state lives in the URL, so any view is a link
(**Copy link**). Time range presets or a custom window; **dropdowns** for tenant, user,
device, app version, site, accuracy band and the rest - each with a search box on longer
lists, per-option record counts, select-all/clear, and a summary on the closed control;
tri-state selects for clocked-in, inside-fence and connectivity; numeric thresholds for
accuracy, battery and staleness; and free-text search. Picking several values inside a
dropdown is debounced into a single request.

The accuracy-band dropdown now offers **Unknown (no accuracy)** alongside the five metre
bands. `filters.js` has always matched that band and every row can already be labelled with
it - a fix that arrived with no accuracy at all - but it was never listed, so the one band
you most want to isolate (a position that cannot be judged against a fence) was the only one
you could not select. It is added in `/api/meta` rather than to `ACCURACY_BANDS`, because
that list is walked as metre ranges.

**Advanced** opens a raw MongoDB **where clause** that is `$and`-ed onto the controls:

```json
{ "batteryPercentage": { "$lte": 15 }, "permissionsEnabled": { "$nin": ["LOCATION_BACKGROUND"] } }
```

Relaxed extended JSON works (`{"createdAt":{"$gte":{"$date":"2026-08-30T00:00:00Z"}}}`).
`$where`, `$function`, `$accumulator`, `$out`, `$merge`, `$lookup` and friends are
rejected server-side. Filter sets can be saved as named views (stored in the browser).

Tables export to CSV with the recomputed geometry included.

## Exit windows, and mixed document kinds

**One collection holds more than one kind of document.** `ekosClientState` carries the
heartbeat snapshots *and* the `{ type: "exit_window" }` documents (32 of them as of
2026-08-31, alongside ~89k heartbeats). Detection probes every collection for every kind
rather than classifying a collection by its newest document, and each query isolates its
kind (`type: "exit_window"` in, `type: { $ne: "exit_window" }` out) so exit windows never
pollute the device stats and vice versa. The sidebar marks a shared collection as
"shared"; hover for the collection name.

The live windows differ from the shape in the original spec, and the dashboard handles
both: `userId` is `null` (the app writes them without a session, so per-user filtering
is unavailable and the page says so), `tenantId` is used instead of `companyId`, there is
no `employeeId` or `jobSiteId`, `openedBy` includes `polling`, and `resolution` includes
`needs_review`.

**Matching windows to people.** The documents carry a `userId` key, but its value is
`null` on every one of them (35 of 35, checked 2026-09-01) and `deviceId` is null too, so
there is no id to join on. A window that ever carries an id joins exactly; otherwise it is
matched by **sample fingerprint** - a window records its own GPS samples, so a heartbeat
within 150 m and 180 s of a sample is the same handset. That attributes all 35 windows, and
the winning user does not change as the threshold loosens to 300 m or 1000 m, so the matches
are not artefacts of the cutoff. Every row states its method, its evidence ("6 of 7 window
samples matched, median 34 m and 12 s apart") and a confidence; ties stay unattributed with
their candidate list. A weaker fence-presence fallback covers windows with no usable
samples, flagged as such - an exit window means a device *left*, so "who was at the fence"
can pick up a colleague who stayed. The User filter and the per-user page use these matches.

**Fence-to-site matching.** These documents carry fence coordinates but no site id, so
the Site column and the Site filter match a fence against the site registry by centre
(within 30 m) *and* radius (within 20%). That is flagged in the UI with a `≈` badge and
the match distance - never presented as if the document named the site. It matters here:
one fence sits exactly on site 12's recorded centre with the same 20 m radius (19
windows), while four others sit ~29 m away with a 100 m radius and are correctly left
as an unmapped fence rather than folded into site 12.

## Indexes

**These are now created on the staging cluster.** All twelve were missing except
`createdAt_desc`, which meant every per-user, per-site, per-tenant and
inside/outside query was a collection scan. A per-user query now examines 50
documents instead of 65,000, in about a millisecond.

They do not speed up the whole-range facets behind `/api/meta` and `/api/stats` -
nothing indexes a full-collection group - so those rely on the caches above.
What the indexes fix is every *filtered* view: the tables, the user pages, and
each dropdown selection.

The script is idempotent - it reports what already exists and creates only what does not:

```bash
npm run indexes            # dry run, explains each index
npm run indexes -- --yes   # create them
```

## API

All endpoints sit behind the password gate and take the same filter parameters.

```
GET /api/auth/me                     (who is signed in; the gate itself is HTTP Basic)
GET  /api/health                     GET /api/meta          GET /api/stats
GET  /api/users                      GET /api/users.csv     GET /api/users/:id
GET  /api/users/:id/track            GET /api/snapshots     GET /api/snapshots.csv
GET  /api/logs                       GET /api/logs.csv      GET /api/logs/:id
GET  /api/exit-windows               GET /api/exit-windows.csv
GET  /api/exit-windows/:id           GET /api/sites         GET /api/sites.csv
GET  /api/issues                     GET /api/issues.csv    (compare=1 adds the previous window)
GET  /api/fence-time                 GET /api/fence-time.csv (visits=1 returns every visit)
POST /api/query                      GET /api/query/fields  GET /api/refresh-schema
```
