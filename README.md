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
| **Overview** | **What is wrong, first.** A severity strip opens the page, then the current-state tiles, then a ranked feed of detected problems split into people in the field and app/data faults, then the people worst affected. The live map and the trend charts follow as context. |
| **Live Map** | Full situational map: devices coloured by fence verdict, accuracy halos, fence circles, optional trails, and a side list with a walking-directions link for anyone outside their fence. |
| **Users & Devices** | Newest snapshot per user — device, app build, battery, connectivity, permissions, clock state, fence verdict, distance to the boundary. Clicking a row opens that user's own page in the same tab (ctrl/cmd-click or middle-click for a new one). |
| **Heartbeats** | Every stored device ping for every user, newest first, with the filters to cut it down: user, tenant, device, app build, site, accuracy band, missing permission, clock state, fence state, connectivity, with/without a fix, battery, search. Silence between a device’s own heartbeats is the point - a **Silence before** column across users, and full gap rows when one user is selected. |
| **User page** (`user.html?userId=…`) | One user end to end, opened from the table with a link back to it. Above: hero header with live badges, eight KPI tiles, and the person / device / right-now / shift detail cards. Below, in tabs: **location & trail** map, **history** charts, **heartbeats** (every stored document, paged, click a row for its full breakdown), **geofence validation calls**, **exit windows** (the Exit Windows table and its replay drawer, filtered to this person - one shared view, not a thinner copy), **raw document**. Tab counts show how much is in each, the active tab lives in the URL hash (`#heartbeats`) so it can be linked, and panels render lazily — a chart or map sized inside a hidden panel comes out 0x0. |
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

The dashboard runs unindexed (Mongo scans; ~1–2 s per query on 87k snapshots). If it
grows, add the indexes the queries want:

```bash
npm run indexes            # dry run, explains each index
npm run indexes -- --yes   # create them
```

## API

All endpoints are behind the session cookie and take the same filter parameters.

```
GET /api/auth/me                     (who is signed in; the gate itself is HTTP Basic)
GET  /api/health                     GET /api/meta          GET /api/stats
GET  /api/users                      GET /api/users.csv     GET /api/users/:id
GET  /api/users/:id/track            GET /api/snapshots     GET /api/snapshots.csv
GET  /api/logs                       GET /api/logs.csv      GET /api/logs/:id
GET  /api/exit-windows               GET /api/exit-windows.csv
GET  /api/exit-windows/:id           GET /api/sites         GET /api/sites.csv
POST /api/query                      GET /api/query/fields  GET /api/refresh-schema
```
