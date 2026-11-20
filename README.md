# Warehouse Count — Standalone App

A separate app from the store consignment app, purpose-built for a single-day,
multi-counter warehouse annual count across three brands (ASICS, Onitsuka
Tiger, SESM). No Google sign-in required for anyone — counters never see a
login screen.

## What's inside
- `index.html`, `style.css`, `app.js`, `db.js`, `barcode.js` — the counting app
  itself, used by counters on their phones
- `dashboard.html` — a separate, read-only page for supervisors (open on a
  laptop at a command station; not meant for counters)
- `config.js` — the one file you edit with your Sheet links and Apps Script URL
- `WAREHOUSE_COUNT_APPS_SCRIPT.gs.txt` — paste this into Google Apps Script;
  it's the shared backend every device writes to
- `rack-qr-generator.html` — a one-time admin tool to print QR labels for
  each physical rack (needs internet to load; not part of the offline app)
- `sw.js`, `manifest.json`, `icons/`, `logo.png` — makes the counting app
  installable and work fully offline once set up

## How the pieces fit together
Everything that changes over time lives in Google Sheets, edited directly —
no code changes, no redeploys, for any of these:
- **3 Catalogs** (ASICS, Onitsuka, SESM) — same format as before: GTIN Number,
  Article, Material description, Model, Color, Size
- **Racks** — one shared sheet, columns `Brand`, `Rack ID`. Brands can have
  different numbers of racks; nothing assumes they're equal.
- **Current Balance** — columns `Article`, `Expected Qty`. This is the
  reconciliation baseline; only the Dashboard reads it, counters never see it.

The **Apps Script** is the one thing that receives writes — every scan, break,
resume, and rack-completion confirmation goes through it, no sign-in needed
on the counter's end, and it writes into a spreadsheet only you access.

## 1. Set up the three Catalog sheets
Same as the store app: one Google Sheet per brand with the standard columns,
Color column formatted as **Plain text** with real leading zeros (e.g. `002`,
not `2`). File → Share → Publish to web → CSV. Paste each link into
`config.js` under the matching brand's `catalogCsvUrl`.

## 2. Set up the Racks sheet
One new Google Sheet, one tab, two columns:
```
Brand      Rack ID
ASICS      R01
ASICS      R02
...
ONITSUKA   R01
...
SESM       R01
...
```
Publish to web → CSV, paste the link into `config.js` as `racksCsvUrl`.

## 3. Set up the Current Balance sheet (for the Dashboard's Variance report)
Either a simple Sheet with just `Article` and `Unrestricted`, or SAP's full
Current Balance export — the Dashboard matches columns by header name, not
position, and uses whatever is present:
```
Article  Plant  SLoc  Unrestricted  Value Unrestricted  Blocked  Value BlockedStock  ...
```
`Plant` (1100=SESM, 1101=Onitsuka Tiger, 1102=ASICS) lets the Dashboard match
Article + Plant + SLoc so different plants/brands are never mixed together;
it's optional but recommended. Share the sheet so "anyone with the link can
view", then paste either its CSV export link
(`.../export?format=csv&gid=<gid>`) or a Publish-to-web CSV link into
`config.js` as `currentBalanceCsvUrl`. Leave this blank if you don't want the
Variance report yet — everything else still works without it.

Rack locations named `R##-L##` (e.g. `R05-L03`) are matched against SAP SLoc
`MW00`; any other scanned location (e.g. `RA00`, `DA00`, `MW01`) is matched
against that exact SLoc; `GENERAL` is never matched to an SLoc.

## 4. Set up the Apps Script backend (handles all scan/break/complete data)
1. Create a **new** Google Sheet for the event itself (e.g. "Warehouse Count
   2026") — separate from the three sheets above; this one is written to
   automatically, you don't type into it.
2. Extensions → Apps Script. Delete the sample code, paste in the entire
   contents of `WAREHOUSE_COUNT_APPS_SCRIPT.gs.txt`.
3. Deploy → New deployment → type **Web app**. Execute as **Me**, access
   **Anyone**. Deploy, authorize it (expected, it's your own script), copy
   the URL ending in `/exec`.
4. Paste that URL into `config.js` as `submitUrl`.
5. Test it: paste the URL directly into a browser — you should see
   `{"ok":true,...}`. This same URL is also what `dashboard.html` reads
   live data from (GET requests return the current data; POST is how the
   counting app submits).

**If you ever edit the script later:** use Deploy → Manage deployments →
edit → New version, rather than creating a fresh deployment, or you'll get a
new URL and need to update `config.js` again.

## 5. Generate and print QR rack labels
Open `rack-qr-generator.html` in any browser (needs internet just for this
one-time step, to load the QR-drawing library and read your Racks sheet —
this file isn't part of the offline counting app). It automatically loads
and generates labels straight from your `racksCsvUrl` Racks sheet (§2) — no
copy-pasting needed. You can still hand-edit the list before generating
(e.g. to add a rack that isn't in the sheet yet, or print just a subset);
just reload from the sheet again afterward if you want it back in sync.
Click Print, and stick one label per physical rack. Counters scan this at
the start of a session to auto-set their Brand + Rack — no dropdown needed,
much harder to mis-tap under time pressure than scrolling a list.

## 6. Host and install (same as before)
Netlify Drop (app.netlify.com/drop) or similar — drag this whole folder in,
get a `https://` link. Camera access needs `https://`, so this step isn't
optional. Add to Home Screen on each phone that'll be used for counting.

Open `dashboard.html` the same way — it's part of the same deployed site
(e.g. `https://yoursite.netlify.app/dashboard.html`) — bookmark that
separately on whatever laptop/screen the supervisor is watching.

## How the counting app behaves
- **Setup:** scan a rack's QR label (or manual Brand/Rack dropdown fallback)
  → enter name → start. First time on a new brand, it downloads that brand's
  catalog (needs signal once); after that, fully offline for that brand.
- **ASICS / Onitsuka:** instant-tally scanning — scan, beep, a quick flash of
  the matched description, tallied, submitted immediately (or queued if
  signal drops, sent automatically once it returns). **Undo Last Scan**
  available any time.
- **SESM:** every scan shows a confirm card (item + adjustable quantity)
  before it submits — nothing logs until the counter explicitly confirms,
  and they can redirect to a manual search if the match looks wrong.
- **Not found:** automatically opens manual search/unscannable entry — still
  counts toward the total, tagged "Manual" for later audit.
- **Take a Break / Resume:** stops the camera, saves exactly where they were
  (rack, tally, last item) to the phone itself — survives a lock, a crash, or
  closing the browser entirely. Reopening the app offers to resume right
  where they left off.
- **Removing / undoing / editing a scan:** nothing is ever sent to the Sheet
  automatically. Removing (or undoing, or changing the quantity of) an item
  that's already on the Sheet is only *staged* — it stays in the list
  struck-through as "removal not sent yet" (tap it to restore) — and is sent
  only when the counter taps **Submit Scanned Items** and confirms. The
  confirm screen labels new scans, removals and quantity changes separately.
  Removals go as correcting rows (negative Qty), so the original scan stays
  on record and the Dashboard nets to the right number. An item that was
  never submitted is simply deleted on the phone.
- **Mark My Rack Complete:** shows a summary of everything the counter
  scanned (one line per item, netted the same way the Dashboard nets a
  rack's items) with the total, then checks that total against the same live
  data the Dashboard reads: ✅ matches / ⚠️ doesn't match (with the
  differing items, and any scans held outside the count window) / 📶 couldn't
  check (offline or still syncing). Anything unsubmitted must be submitted
  first. Only a verified match gets the plain "Confirm Complete" button;
  otherwise it becomes "Complete Anyway" behind a confirm prompt, so a bad
  signal can never trap a counter. Then the short non-enforced checklist and
  confirm. If more than one counter worked
  the same rack, it only becomes officially "Done" once **everyone** who
  touched that rack has confirmed — tracked automatically by the Apps Script
  backend, not something counters need to coordinate manually.
- **Remarks are required** on every submission (box #, notes, etc.).
- **25% audit by remark (per rack):** when a rack is marked complete, remarks
  (boxes) on *that rack* are picked at random, one after another, until the
  items under the picked remarks cover at least 25% of the rack's item lines
  (rounded up, at least 1 — e.g. a rack with 20 different items needs 5 or
  more covered). Everything under each picked remark is recounted (a remark sharing an item with a picked one is pulled in too) by a
  different counter. Older data with no remarks falls back to a random 25% of
  items. The auditor sees only the sampled items (without the
  original quantities) and can only count those. The recount is compared item
  by item against the original count. Racks a manager forces from the Dashboard
  get a full-rack recount. Original and audit counts are kept as separate
  records, never overwritten. **After updating, paste the new
  WAREHOUSE_COUNT_APPS_SCRIPT into Apps Script and deploy a new version.**

## How the Dashboard behaves
Open-and-watch, no login, updates instantly on every scan (with a 15-second safety-net refresh):
- Rack grid per brand — Not Started / In Progress / Done / Recount needed —
  with each brand's own rack count (uneven totals fully supported)
- Per-rack: item count so far, and every counter currently on it, each shown
  as counting / on break / silent (no activity in 40+ min — configurable via
  `silentAfterMinutes` in config.js)
- Flagged panel: audit-sampled racks and balance-vs-counted variances, in
  one place
- Reports & Balance tab: Variance report (Article, Expected, Counted,
  Variance) — this tab and the Current Balance data are never shown in the
  counting app, by design

## A few honest limitations, stated plainly
- I can't test the live Apps Script endpoint or real Sheet fetches from here
  — first real test happens on your end once URLs are filled in.
- The "everyone who touched a rack must confirm" logic treats anyone who
  ever sent a scan or presence ping for that rack as needing to confirm —
  if someone scans a couple of items then walks away without hitting Break
  or Complete, that rack will show as waiting on them indefinitely, which is
  a reasonable default but something a supervisor may need to manually
  resolve directly in the Sheet on the rare occasion it happens.
- `rack-qr-generator.html` needs internet to load its QR-drawing library —
  it's a one-time setup tool, not part of daily counting, so this is a
  reasonable trade-off rather than something worth engineering around.

## Real-time updates (optional)
By default the Dashboard polls the Google Sheet every few seconds, which is
fine for most teams. If you want the Dashboard to react in well under a
second — someone comes online, someone scans an item — instead of waiting
for the next poll, you can turn on a free Firebase Realtime Database as a
live signal layer. Google Sheets stays exactly as it is today, the one and
only source of truth for actual counts and status; Firebase only carries
two lightweight, ephemeral things:
- who's currently active/on break (`/live/presence`)
- a timestamp bump whenever a scan or presence change happens
  (`/live/ping`), which tells the Dashboard "go refresh from Sheets right
  now" instead of waiting for its next scheduled poll

**Setup (~10 minutes, all in the Firebase Console):**
1. Go to console.firebase.google.com → Add project (any name, Analytics
   not needed).
2. Build → Realtime Database → Create Database → any region → start in
   test mode.
3. Rules tab → replace with:
   ```json
   {
     "rules": {
       "live": { ".read": true, ".write": true },
       "$other": { ".read": false, ".write": false }
     }
   }
   ```
   Publish. This only opens the `/live` branch (ephemeral status, not your
   real data) to reading/writing — everything else stays locked.
4. Data tab → copy the database URL shown at the top (looks like
   `https://your-project-default-rtdb.firebaseio.com`).
5. Paste it into `firebaseUrl` in config.js. That's it — both the counting
   app and the Dashboard pick it up automatically. Leave it as `""` to
   skip this entirely; nothing else changes if you do.

This uses the browser's built-in `EventSource` to stream from Firebase's
REST API directly — no SDK, no build step, nothing to install.

## Combined item catalog (all brands, one download)
The catalog now downloads once at startup, covering every brand configured
in `config.js`, instead of a fresh per-brand download every time someone's
assigned brand changes. Any item scans correctly regardless of which brand
a counter is assigned to — if it belongs to a different brand than their
session, a small notice tells them so, but it's still logged (under its
real brand, not the session's), so the reconciliation data stays accurate.

## Count time window
Set on the Dashboard sidebar (Count Window panel). Scans are always accepted
and counted immediately, including ones made outside the window — there is
no longer a "pending approval" step or Pending Approval panel.

## Audit / Recount workflow
From the counting app's Setup screen, "🔍 Audit / Recount a Flagged Rack"
lists racks currently selected for the 25% remark-based audit sample. An
auditor picks one, is warned (softly — not blocked) if their name matches
an original counter on that rack, and does an independent recount that's
kept entirely separate from the main Counts data. Confirming compares
their tally against the original count server-side and posts the result
(audited qty, original qty, variance, who confirmed it) directly to the
Dashboard, which shows a ✅ badge and the full comparison in that rack's
detail popup.

## iOS
Works on iPhone/iPad as an installed PWA (Add to Home Screen). One real
platform limitation, not a bug: Safari on iOS doesn't support the
Barcode Detection API at all, so live camera scanning isn't available
there — the app already detects this and falls back cleanly to manual
entry, and to a connected USB/Bluetooth barcode scanner (which works
identically on iOS to how it works on a laptop, since that's just
keyboard input under the hood).

## Count window & Pending Approval
Set a window on the Dashboard (Count Window panel). A scan taken **outside**
it is still saved, but held as `pending` — it does not count toward any rack,
summary, reconciliation or Excel total until a manager approves it in the
Dashboard's **Pending Approval** panel (✓ Approve / ✕ Reject). Rejected scans
are kept in the Counts sheet (Status = `rejected`) for the audit trail, never
deleted. The window is judged against when the item was actually scanned, so
a scan taken offline outside the window can't slip in as "accepted" just
because it synced later. With no window set, everything is accepted as usual.
**Requires the Apps Script to be redeployed as a new version** — the hold
happens server-side in `handleScan`.

## Many counters at once (v38)
No feature changed — the same screens, rules and data — but the Sheet is now
read and written far less often per scan, so a large crew stays responsive:
- **One request per submit.** "Submit Scanned Items" (and the offline queue
  when signal returns) sends all its rows to the Apps Script in a single
  `scanBatch` request (up to 40 rows each) instead of one request per row.
  The script takes its lock once, reads the header once, runs one duplicate
  check and writes all new rows in one call. Every row is still saved on the
  phone first and removed only when the server confirms it; duplicates are
  still caught by ScanID.
- **Dashboard reads only what's new.** After the first full read, each
  refresh downloads just the Counts rows added since (the server verifies the
  Dashboard's copy lines up, otherwise it sends everything). A full re-read
  still happens every minute, on the Refresh button, and after any approve /
  reject / reset.
- **Rack completion is safer and lighter.** Two counters finishing the same
  rack at the same instant can no longer both finalize it, and the check reads
  the Counts sheet once instead of twice. It uses its own lock, so scans are
  not held up behind it.
- **"Mark My Rack Complete" check** asks the server for only that counter's
  rows instead of the whole snapshot.

**After updating:** paste the new `WAREHOUSE_COUNT_APPS_SCRIPT.gs.txt` into
Apps Script and deploy a **new version** (Deploy → Manage deployments → edit →
New version), then re-host the site. If the phones update before the script
does, they detect it and fall back to the old one-row-at-a-time sending, so
nothing breaks in between — you just don't get the speed-up until the script
is redeployed.

## Manual / Unscannable window pauses scanning (v39)
Whenever the Manual / Unscannable window opens — from its button, because a
scanned barcode wasn't in the catalog, or from "Not the right item" — the camera
and any connected barcode scanner stop scanning until the window is closed
(Add to Count, ✕, tapping outside, back button or swipe-down all count). The
camera then restarts by itself. Only one Manual window can be open at a time.

## Speed notes (real-time behavior)
- Phones send scans/presence to the Sheet in the background and push them live
  through Firebase at the same time, so the Dashboard moves instantly; the Sheet
  read is only a reconciliation.
- The Apps Script tags Presence / RackCompletion / RackStatus / Concerns with
  small version numbers (kept in the script cache). The Dashboard sends the
  version it already has; unchanged sections cost no sheet read, and Presence and
  Completion only send their NEW rows. A full re-read still happens every 60s and
  on the manual Refresh button, so hand edits in the Sheet still show up.
- Rack completion, the audit prefetch and audit confirmation read only the rows of
  that rack (one column scan + a row span) instead of the whole Counts sheet.
- The Audit picker uses a small `?only=audit` request instead of the full snapshot.
- **After updating, paste the new Apps Script code and redeploy it as a new version.**

## Firebase-first real-time (how live data flows now)
- **Phones** push every scan, presence change and rack-complete confirmation to
  Firebase the instant it happens, then write to the Sheet in the background.
  Live scans now STAY in Firebase (they used to be deleted after 10 minutes).
- **Dashboard** draws its first screen from Firebase (live scans, presence,
  completions, rack status, count window) as soon as the rack list is in, without
  waiting for Apps Script. A banner says "still syncing full history" until the
  first Sheet snapshot lands and fills in older data. The Sheet is then read only
  as a reconciliation pass (every 10s, on the Refresh button, and at most every 4s
  after a phone ping).
- **Apps Script** mirrors what only it can compute — rack status + audit sample,
  audit results, count window, resets — into Firebase right after writing the Sheet.
  Set `FIREBASE_URL` at the top of the script (same URL as `firebaseUrl` in
  config.js); leave it `""` to turn mirroring off.
- Approve/reject decisions are broadcast, so every open dashboard updates at once.
- The Sheet remains the permanent record and the source for Excel export.
- **After updating:** paste the new Apps Script and redeploy it as a NEW VERSION,
  and confirm your Firebase rules allow read/write on `/live`.

## Audit sampling and audit reports
- **Whole boxes:** the audit picks random whole boxes (remarks/locations) and recounts
  EVERYTHING in them. 25% is a minimum, not a cap: boxes keep being added until at
  least 25% of the item lines AND at least 25% of the boxes are covered. A box that
  shares an item with a picked box is pulled in too, so each item is recounted in full.
- **Detailed report, kept permanently:** confirming an audit writes one row per item
  to the new **AuditReports** sheet (original vs recount, variance, which boxes it was
  counted in) and mirrors the full report to Firebase.
  - *Counter phone:* the report opens right after confirming, and **Audit Reports**
    on the start screen re-opens any past one (also offline, from this phone's copy).
  - *Dashboard:* new **Audit Reports** view (list, item-by-item detail, boxes
    recounted, Excel export). A confirmed rack's popup has a "View detailed audit report" button.
- Update the Apps Script (new version) — the AuditReports sheet is created automatically.
