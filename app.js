/* app.js — Warehouse Count. Setup → Scan → (Break/Resume) → Mark Rack Complete.
   Every screen assumes zero signal is possible at any moment: catalog and rack
   lists are cached locally after first download, and every submission queues
   locally and retries automatically if it can't reach the server right away. */

const appEl = document.getElementById("app");
const toastEl = document.getElementById("toast");
const onlineStatusEl = document.getElementById("onlineStatus");

/* ---------- small helpers ---------- */
function toast(msg, ms = 2400) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.add("hidden"), ms);
}

// Full-screen "working…" overlay so nobody thinks the app froze during a slow
// server step. Returns a function that removes it. After a few seconds it adds
// a reassurance line, and it blocks taps underneath so nothing gets sent twice.
function showLoading_(msg, sub) {
  const box = el(`<div class="whc-loading" role="status" aria-live="polite"><div class="whc-loading-card"><div class="whc-spinner"></div><div class="whc-loading-msg"></div><div class="whc-loading-sub muted"></div><div class="whc-loading-bar"><div></div></div></div></div>`);
  box.querySelector(".whc-loading-msg").textContent = msg || "Working…";
  const subEl = box.querySelector(".whc-loading-sub");
  subEl.textContent = sub || "Please don't close the app.";
  document.body.appendChild(box);
  const t1 = setTimeout(() => { subEl.textContent = "Still working — this can take a few seconds on big racks. Please wait."; }, 4000);
  const t2 = setTimeout(() => { subEl.textContent = "Still going… slow signal or a large count. It has NOT crashed — please keep this screen open."; }, 12000);
  let done = false;
  return function hideLoading() {
    if (done) return;
    done = true;
    clearTimeout(t1); clearTimeout(t2);
    box.remove();
  };
}
function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
}
function nowStamp() {
  return new Date().toISOString();
}
function uid(prefix) {
  return prefix + "-" + Math.random().toString(36).slice(2, 10);
}
// Wraps an async button handler so a fast double-tap (or a duplicate click
// event some touchscreens/browsers fire for one tap) can't run the handler
// twice concurrently — without this, a single physical tap on "Confirm &
// Submit" etc. could log the same item twice, each with its own scanId, so
// neither the app's own scanId-dedup nor the Dashboard's ever catches it.
// Once the first call finishes (success OR error/early-return), the button
// is live again for a genuine next tap.
function onceAsync_(fn) {
  let busy = false;
  return async (...args) => {
    if (busy) return;
    busy = true;
    try {
      await fn(...args);
    } finally {
      busy = false;
    }
  };
}
const APP_VERSION = "v39";
function updateOnlineStatus() {
  const online = navigator.onLine;
  onlineStatusEl.textContent = (online ? "● online" : "● offline — still counting locally") + " · " + APP_VERSION;
  onlineStatusEl.className = "brand-sub " + (online ? "online" : "offline");
}
window.addEventListener("online", () => {
  updateOnlineStatus();
  flushQueue();
});
window.addEventListener("offline", updateOnlineStatus);

// Last-resort safety net: if any async handler throws without its own
// try/catch, the browser normally just logs it to a console nobody on a
// phone can see — the screen just sits there looking "stuck" with zero clue
// why. This turns that into a visible message instead, so a silent failure
// becomes a reportable one.
window.addEventListener("unhandledrejection", (e) => {
  const msg = (e.reason && e.reason.message) ? e.reason.message : String(e.reason || "Unknown error");
  console.error("Unhandled error:", e.reason);
  toast("⚠️ Something went wrong: " + msg, 5000);
});

/* ---------- Keyboard-wedge scanner support (laptop use) ----------
   Most USB/Bluetooth barcode scanners act like a keyboard: they "type" the
   scanned code's characters faster than a human ever could, then send Enter.
   This listens globally and, whenever a screen sets `wedgeCallback`, hands
   it whatever code came through — same callback shape as the camera
   scanner's onDetect, so both input methods can be active at once. Ignored
   while an actual text field has focus, so it never interferes with typing
   a name or a manual search. */
let wedgeCallback = null;
let wedgeBuffer = "";
let wedgeLastTime = 0;
const WEDGE_MAX_GAP_MS = 60; // hardware scanners type far faster than any human
const WEDGE_MIN_LEN = 3;
document.addEventListener("keydown", (e) => {
  if (!wedgeCallback) return;
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  const now = Date.now();
  if (now - wedgeLastTime > WEDGE_MAX_GAP_MS) wedgeBuffer = "";
  wedgeLastTime = now;
  if (e.key === "Enter") {
    if (wedgeBuffer.length >= WEDGE_MIN_LEN) {
      const code = wedgeBuffer;
      wedgeBuffer = "";
      wedgeCallback(code);
    }
    return;
  }
  if (e.key.length === 1) wedgeBuffer += e.key;
});

let modalStack = [];
let suppressPopstate = false;

function openModal(innerHtml, opts = {}) {
  const backdrop = el(`<div class="modal-backdrop"><div class="modal" style="position:relative;"><div class="modal-handle"></div><button class="modal-close" id="mClose" aria-label="Close">✕</button>${innerHtml}</div></div>`);
  document.body.appendChild(backdrop);
  const panel = backdrop.querySelector(".modal");

  // Push a history entry so the phone's back button (or gesture) closes this
  // modal instead of leaving the app — popstate below intercepts it.
  //
  // BUT only when the page has had a real user tap. Browsers (Chrome/Android
  // "history manipulation intervention") flag history entries pushed without
  // user activation as skippable — so on a page freshly opened from a rack
  // QR scan (no tap yet), history.back() on close skips that entry AND the
  // app's own entry, and lands outside the app: the tab just closes. In that
  // case don't push (and don't back()) at all.
  const activated = !navigator.userActivation || navigator.userActivation.hasBeenActive;
  if (activated) history.pushState({ whcModal: true }, "");
  backdrop._whcPushed = activated;

  function doClose(fromPopstate) {
    if (!backdrop.isConnected) return;
    backdrop.remove();
    modalStack = modalStack.filter((m) => m !== backdrop);
    if (!fromPopstate && backdrop._whcPushed && history.state && history.state.whcModal) {
      suppressPopstate = true; // consume the state we pushed without re-triggering close logic
      history.back();
    }
    if (opts.onClose) opts.onClose();
  }
  backdrop._whcClose = doClose;
  modalStack.push(backdrop);

  backdrop.querySelector("#mClose").onclick = () => doClose(false);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) doClose(false); // tap outside the sheet
  });

  // Drag the handle (or the sheet itself) down to dismiss — mirrors a native bottom sheet.
  let startY = null;
  function onStart(e) {
    startY = e.touches ? e.touches[0].clientY : e.clientY;
    panel.style.transition = "none";
  }
  function onMove(e) {
    if (startY == null) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const dy = Math.max(0, y - startY);
    panel.style.transform = `translateY(${dy}px)`;
  }
  function onEnd(e) {
    if (startY == null) return;
    const y = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
    const dy = y - startY;
    startY = null;
    panel.style.transition = "";
    if (dy > 90) doClose(false);
    else panel.style.transform = "";
  }
  const handle = backdrop.querySelector(".modal-handle");
  handle.addEventListener("touchstart", onStart, { passive: true });
  handle.addEventListener("touchmove", onMove, { passive: true });
  handle.addEventListener("touchend", onEnd);
  handle.addEventListener("mousedown", onStart);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onEnd);

  return backdrop;
}
function closeModal(modal) {
  if (modal && modal._whcClose) modal._whcClose(false);
  else if (modal) modal.remove();
}
window.addEventListener("popstate", () => {
  if (suppressPopstate) {
    suppressPopstate = false;
    return;
  }
  const top = modalStack[modalStack.length - 1];
  if (top && top._whcClose) top._whcClose(true);
});

/* ---------- CSV parsing (published Google Sheets, no auth needed) ---------- */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function normalizeColor(v) {
  if (v == null || v === "") return "";
  const t = String(v).trim();
  if (/^\d+$/.test(t) && t.length < 3) return t.padStart(3, "0");
  return t;
}
function findCol(header, names) {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

async function fetchCatalog(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Catalog fetch failed: " + res.status);
  const rows = parseCSV(await res.text());
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const gtinIdx = findCol(header, ["gtin number", "gtin"]);
  const articleIdx = findCol(header, ["article"]);
  const descIdx = findCol(header, ["material description", "description", "desc"]);
  const modelIdx = findCol(header, ["model"]);
  const colorIdx = findCol(header, ["color", "colour"]);
  const sizeIdx = findCol(header, ["size"]);
  if (gtinIdx < 0) throw new Error('Catalog sheet needs a "GTIN Number" column');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    const gtin = String(r[gtinIdx] || "").trim();
    if (!gtin) continue;
    out.push({
      gtin,
      article: articleIdx >= 0 ? r[articleIdx] : "",
      desc: descIdx >= 0 ? r[descIdx] : "",
      model: modelIdx >= 0 ? r[modelIdx] : "",
      color: colorIdx >= 0 ? normalizeColor(r[colorIdx]) : "",
      size: sizeIdx >= 0 ? String(r[sizeIdx] || "").trim() : "",
    });
  }
  return out;
}

// Matches whatever text is in the Racks sheet's Brand column against the
// brands configured in config.js — by code OR display name, case/whitespace
// -insensitive — and returns the canonical code the rest of the app expects.
// This is what makes "Onitsuka Tiger" in the sheet resolve to the "ONITSUKA"
// code the dropdown actually filters on, instead of silently matching nothing.
function resolveBrandCode(rawBrand) {
  const raw = String(rawBrand || "").trim();
  const rawUpper = raw.toUpperCase();
  const match = APP_CONFIG.brands.find(
    (b) => b.code.toUpperCase() === rawUpper || b.name.toUpperCase() === rawUpper
  );
  return match ? match.code : raw;
}

async function fetchRacks(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Racks fetch failed: " + res.status);
  const rows = parseCSV(await res.text());
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const brandIdx = findCol(header, ["brand"]);
  const rackIdx = findCol(header, ["rack id", "rack", "rackid"]);
  if (brandIdx < 0 || rackIdx < 0) throw new Error('Racks sheet needs "Brand" and "Rack ID" columns');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    const brand = resolveBrandCode(r[brandIdx]);
    const rack = String(r[rackIdx] || "").trim();
    if (!brand || !rack) continue;
    out.push({ brand, rack });
  }
  return out;
}

/* ---------- submission (queue-and-retry, works fully offline) ---------- */
// Firebase key segments can't contain . # $ [ ] / — brand/rack values are
// admin-typed free text, so sanitize before using them as path segments.
function liveKey(s) {
  return String(s || "").replace(/[.#$[\]/]/g, "_");
}

// Best-effort real-time signal to Firebase (optional — only fires if
// config.js has firebaseUrl set). This NEVER affects or blocks the
// authoritative Google Sheets submission in submitAction() below; if it
// fails or firebaseUrl isn't configured, everything still works exactly as
// before, just without the instant push.
function pushLive(path, data, method = "PUT") {
  if (!APP_CONFIG.firebaseUrl || !navigator.onLine) return;
  fetch(`${APP_CONFIG.firebaseUrl.replace(/\/$/, "")}/live/${path}.json`, {
    method,
    keepalive: true, // still goes out if the page is locked/closed right after
    body: method === "DELETE" ? undefined : JSON.stringify(data),
  }).catch(() => {});
}

// Tells the Dashboard "the Sheet just changed — re-read it now". Call only
// after the Apps Script POST has actually succeeded.
function pingDashboard(payload) {
  if (payload && (payload.action === "presence" || payload.action === "scan" || payload.action === "complete")) {
    pushLive(`ping/${liveKey(payload.brand)}_${liveKey(payload.rack)}`, Date.now());
  }
}

// Instant per-scan signal for the Dashboard. The Dashboard reads the Google
// Sheet for its numbers, but the Sheet write takes a few seconds (Apps Script
// round trip). This pushes the scan itself to Firebase the moment it happens,
// so the rack's live count and item list move immediately; the Dashboard drops
// this copy as soon as the same ScanID shows up in the Sheet (no double count).
const livePushed_ = new WeakSet(); // payloads already sent to Firebase (never pushed twice)
function liveScanBody_(payload) {
  return {
    scanId: payload.scanId, brand: payload.brand, rackBrand: payload.rackBrand || payload.brand, rack: payload.rack, counter: payload.counter,
    sessionId: payload.sessionId, method: payload.method, gtin: payload.gtin, article: payload.article,
    desc: payload.desc, color: payload.color, size: payload.size, qty: payload.qty,
    remark: payload.remark || "",
    ts: payload.ts, at: Date.now(),
  };
}
function pushLiveScan(payload) {
  if (!payload || payload.action !== "scan" || !payload.scanId || livePushed_.has(payload)) return;
  livePushed_.add(payload);
  pushLive(`scans/${liveKey(payload.scanId)}`, liveScanBody_(payload));
}
// A whole submission in ONE Firebase request (instead of one request per row) — the Dashboard gets every row in a
// single update, and it goes out before anything slow (saving to the phone, the Apps Script, the Sheet).
function pushLiveScans(payloads) {
  const patch = {};
  let n = 0;
  (payloads || []).forEach((p) => {
    if (!p || p.action !== "scan" || !p.scanId || livePushed_.has(p)) return;
    livePushed_.add(p);
    p.ts = p.ts || nowStamp();
    patch[liveKey(p.scanId)] = liveScanBody_(p);
    n++;
  });
  if (n) pushLive("scans", patch, "PATCH");
}
// Live scans now STAY in Firebase: the Dashboard reads them from there directly (instant, no Apps Script in
// the way) and drops its copy of a scan only when the Sheet snapshot has the same ScanID (never counted twice).
// A reset from the Dashboard clears them. Kept as a no-op so the callers below need no change.
function scheduleLiveScanCleanup(payload) { /* intentionally nothing */ }

async function submitAction(payload, pre) {
  payload.ts = payload.ts || nowStamp();
  // `pre` = the row is already saved in the offline queue (write-ahead) and
  // already pushed live by the batch sender — don't do either a second time.
  if (!pre) pushLiveScan(payload);

  // Presence is pushed instantly (it's ephemeral and needs no Sheets round
  // trip). The "ping" that tells the Dashboard to re-read Sheets is NOT sent
  // here — it's sent by pingDashboard() only AFTER the Sheets write has
  // succeeded. Firing it in parallel (as before) made the Dashboard refresh
  // before the new row existed, read the old data, and then sit stale until
  // its next slow poll.
  if (payload.action === "presence") {
    // "ended" = the counter left this rack (End & Start Over). It is pushed as
    // an explicit status, not deleted, so it out-ranks the last "active" or
    // "break" row still sitting in the Sheet until the Dashboard re-reads it.
    const liveStatus = payload.status === "break" ? "break" : payload.status === "ended" ? "ended" : "counting";
    pushLive(`presence/${liveKey(payload.deviceId)}`, { counter: payload.counter, brand: payload.brand, rack: payload.rack, status: liveStatus, ts: Date.now() });
  } else if (payload.action === "complete") {
    pushLive(`presence/${liveKey(payload.deviceId)}`, { counter: payload.counter, brand: payload.brand, rack: payload.rack, status: "ended", ts: Date.now() });
    // The counter's "I'm done" confirmation, live: the Dashboard shows the counter has left the rack right away.
    pushLive(`completion/${liveKey(payload.brand)}_${liveKey(payload.rack)}_${liveKey(payload.counter)}`, { brand: payload.brand, rack: payload.rack, counter: payload.counter, sessionId: payload.sessionId, deviceId: payload.deviceId, talliedQty: payload.talliedQty || 0, ts: payload.ts || nowStamp(), at: Date.now() });
  }

  // WRITE-AHEAD: a scan row is stored in the phone's offline queue BEFORE
  // any network attempt, and only removed once the server confirms it. The
  // old order (send first, queue only after failing) lost rows whenever the
  // page was locked, closed or killed mid-send — the phone believed the row
  // was sent while it existed nowhere else. Now an interrupted send is
  // simply picked up again by the queue flusher on the next start.
  let qid = null;
  if (pre && payload.action === "scan") {
    qid = pre.qid != null ? pre.qid : null;
  } else if (payload.action === "scan") {
    try {
      const rec = await DB.enqueue({ ...payload });
      qid = rec && rec.result != null ? rec.result : null;
      if (qid != null) inflightQueueIds_.add(qid);
    } catch (e) { qid = null; }
  }
  const settleQueued_ = async () => {
    if (qid != null) { inflightQueueIds_.delete(qid); await DB.dequeue(qid); }
  };

  if (navigator.onLine && APP_CONFIG.submitUrl) {
    // A 200 is NOT proof of a save: Apps Script answers 200 with {ok:false,
    // error:...} when it fails (e.g. its lock times out while many rows arrive
    // at once). So success is judged on the JSON body, failures are retried a
    // few times, and only then queued for the background retry — a row can no
    // longer be silently dropped. The server de-duplicates by scanId, so a
    // retry of a row that actually did land is harmless.
    const attempts = payload.action === "scan" ? 3 : 1;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) payload.retry = true; // the earlier attempt may have landed — server checks the whole sheet
      const r = await postOnce_(payload);
      if (r.ok) {
        await settleQueued_();
        pingDashboard(payload);
        scheduleLiveScanCleanup(payload);
        return r.data;
      }
      if (i < attempts - 1) await new Promise((res) => setTimeout(res, 1200 * (i + 1)));
    }
  }
  if (qid != null) {
    inflightQueueIds_.delete(qid); // already in the queue (write-ahead) — the flusher retries it
  } else {
    await DB.enqueue(payload);
  }
  updatePendingBadge();
  return { ok: false, queued: true };
}

// One POST to the Apps Script. ok=true only if the server itself said ok.
async function postOnce_(payload) {
  // A request on a weak signal can hang forever, which used to freeze the
  // sender (and the rack-complete check waiting on it). Give up after 45s —
  // the row stays safely in the offline queue and is retried; the server
  // ignores it if the first attempt actually landed (same scanId).
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 45000) : null;
  try {
    const res = await fetch(APP_CONFIG.submitUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // avoids a CORS preflight against Apps Script
      body: JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res.ok) return { ok: false };
    let data = null;
    try { data = await res.json(); } catch (e) { return { ok: false }; } // unreadable reply: can't tell it saved
    if (!data || data.ok === false) return { ok: false, error: data && data.error };
    return { ok: true, data };
  } catch (e) {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---- Batched scan sending -------------------------------------------------
// A whole "Submit Scanned Items" (or a backlog from the offline queue) goes to
// the server as ONE request instead of one request per row, so many phones
// no longer queue up behind each other on the sheet lock. Safety is unchanged:
// rows are still written to the phone's offline queue first, removed only once
// the server confirms each one, and the server still de-duplicates by scanId.
// If the deployed Apps Script is an older version that doesn't know "scanBatch",
// this quietly falls back to the old one-row-at-a-time sending.
let batchSupported_ = true;
const BATCH_CHUNK_ = 40;

// One request, many rows. done[i] is true only if the server confirmed row i.
async function postScanChunk_(items) {
  const r = await postOnce_({ action: "scanBatch", rows: items });
  if (r.ok && r.data && Array.isArray(r.data.results)) {
    return { done: items.map((_, i) => !!(r.data.results[i] && r.data.results[i].ok !== false)), results: r.data.results };
  }
  if (r.error && /unknown action/i.test(String(r.error))) batchSupported_ = false;
  return { done: items.map(() => false), results: [] };
}

// Pings the Dashboard once per rack in a set of rows.
function pingDashboardOnce_(items) {
  const seen = {};
  items.forEach((it) => {
    const k = liveKey(it.brand) + "_" + liveKey(it.rack);
    if (!seen[k]) { seen[k] = true; pingDashboard(it); }
  });
}

// Sends `payloads` (all action:"scan") the same way submitAction sends one, but
// in batches. Returns { pending, queued } counts for the caller's toast.
async function submitScanBatch_(payloads) {
  const out = { pending: 0, queued: 0 };
  if (!payloads.length) return out;
  pushLiveScans(payloads); // no-op for rows already pushed by the Confirm handler

  // WRITE-AHEAD, exactly as in submitAction: every row is in the phone's queue before any network attempt.
  const recs = [];
  for (const p of payloads) {
    let qid = null;
    try {
      const rec = await DB.enqueue({ ...p });
      qid = rec && rec.result != null ? rec.result : null;
      if (qid != null) inflightQueueIds_.add(qid);
    } catch (e) { qid = null; }
    recs.push({ p, qid });
  }
  const release_ = (x) => { if (x.qid != null) inflightQueueIds_.delete(x.qid); };

  let todo = recs.slice();
  if (navigator.onLine && APP_CONFIG.submitUrl) {
    for (let attempt = 0; attempt < 3 && todo.length && batchSupported_; attempt++) {
      if (attempt > 0) todo.forEach((x) => { x.p.retry = true; }); // an earlier attempt may have landed — server checks the whole sheet
      const still = [];
      const sent = [];
      for (let i = 0; i < todo.length; i += BATCH_CHUNK_) {
        const chunk = todo.slice(i, i + BATCH_CHUNK_);
        const r = await postScanChunk_(chunk.map((x) => x.p));
        if (!batchSupported_) { still.push(...chunk, ...todo.slice(i + BATCH_CHUNK_)); break; }
        for (let k = 0; k < chunk.length; k++) {
          const x = chunk[k];
          if (r.done[k]) {
            if (x.qid != null) await DB.dequeue(x.qid);
            release_(x);
            if (r.results[k] && r.results[k].pending) out.pending++;
            scheduleLiveScanCleanup(x.p);
            sent.push(x.p);
          } else still.push(x);
        }
      }
      pingDashboardOnce_(sent);
      todo = still;
      if (todo.length && batchSupported_ && attempt < 2) await new Promise((res) => setTimeout(res, 1200 * (attempt + 1)));
    }
    // Older Apps Script (no scanBatch): send the remaining rows one at a time, three at a time, as before.
    if (todo.length && !batchSupported_) {
      const rest = todo; todo = [];
      let next = 0;
      const worker = async () => {
        while (next < rest.length) {
          const x = rest[next++];
          try {
            const result = await submitAction(x.p, { qid: x.qid });
            if (result && result.pending) out.pending++;
            if (result && result.queued) out.queued++;
          } catch (e) { out.queued++; }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    }
  }
  // Anything still unconfirmed is already in the offline queue — the background flusher keeps retrying it.
  for (const x of todo) {
    release_(x);
    if (x.qid == null) { try { await DB.enqueue(x.p); } catch (e) {} }
    out.queued++;
  }
  if (todo.length) updatePendingBadge();
  return out;
}

// Queue ids currently being sent by submitAction — the background flusher
// skips these so the same row is never sent by two paths at once.
const inflightQueueIds_ = new Set();

let flushingQueue_ = false;
async function flushQueue() {
  if (!navigator.onLine || !APP_CONFIG.submitUrl) return;
  // flushQueue fires on start, on "online", and every 20s. If one run is still
  // waiting on a slow request when the next starts, both used to send the SAME
  // queued scan — a double count from a single physical scan.
  if (flushingQueue_) return;
  flushingQueue_ = true;
  try {
  const queue = await DB.getQueue();
  if (!queue.length) return;
  let sent = 0;
  // Queued SCAN rows go out in batches (one request per chunk); if the server
  // script is an older version, or a chunk fails, the one-by-one loop below handles them.
  if (batchSupported_) {
    const scans = queue.filter((it) => it.action === "scan" && !inflightQueueIds_.has(it.id));
    for (let i = 0; i < scans.length && batchSupported_ && navigator.onLine; i += BATCH_CHUNK_) {
      const chunk = scans.slice(i, i + BATCH_CHUNK_);
      chunk.forEach((it) => { it.retry = true; }); // may already be on the Sheet — tell the server to check thoroughly
      const r = await postScanChunk_(chunk);
      const ok = [];
      for (let k = 0; k < chunk.length; k++) {
        if (!r.done[k]) continue;
        await DB.dequeue(chunk[k].id);
        pushLiveScan(chunk[k]);
        scheduleLiveScanCleanup(chunk[k]);
        ok.push(chunk[k]);
        sent++;
      }
      pingDashboardOnce_(ok);
      chunk.forEach((it, k) => { if (r.done[k]) it._sent = true; });
    }
  }
  for (const item of queue) {
    if (item._sent) continue; // already sent in a batch above
    if (inflightQueueIds_.has(item.id)) continue; // submitAction is still sending this one
    item.retry = true; // may already be on the Sheet — tell the server to check thoroughly
    const r = await postOnce_(item);
    if (r.ok) {
      await DB.dequeue(item.id);
      pushLiveScan(item);            // offline scans show up live the moment they finally send
      pingDashboard(item);
      scheduleLiveScanCleanup(item);
      sent++;
    } else if (!navigator.onLine) {
      break;
    }
    // otherwise leave it queued and carry on with the next one; it's retried on the next tick
  }
  if (sent > 0) toast(`✅ Synced ${sent} pending item(s)`);
  updatePendingBadge();
  } finally {
    flushingQueue_ = false;
  }
}

function updatePendingBadge() {
  DB.getQueue().then((q) => {
    if (q.length > 0) {
      onlineStatusEl.textContent = (navigator.onLine ? "● online" : "● offline") + ` — ${q.length} pending · ` + APP_VERSION;
    }
  });
}

/* ---------- session state (persists across a lock, reload, or crash) ---------- */
async function getSession() {
  const session = await DB.getSetting("session", null);
  if (session && !session.batches) session.batches = []; // sessions saved before batch history existed
  return session;
}
async function saveSession(session) {
  return DB.setSetting("session", session);
}
async function clearSession() {
  return DB.clearSetting("session");
}

/* ================= BOOT ================= */
let currentBrandConfig = null;
let racksReady = false;
let racksLoadPromise = null;
let catalogReady = false;
let catalogLoadPromise = null;

(async function boot() {
  updateOnlineStatus();

  // Refresh the rack list in the background if we have signal — never blocks startup.
  // racksLoadPromise lets the Setup screen know when this finishes, so it can
  // show real "still loading" feedback instead of a dead-end "no racks" message.
  if (navigator.onLine && APP_CONFIG.racksCsvUrl) {
    racksLoadPromise = fetchRacks(APP_CONFIG.racksCsvUrl)
      .then((racks) => DB.replaceRacks(racks))
      .catch(() => {})
      .finally(() => { racksReady = true; });
  } else {
    racksReady = true;
    racksLoadPromise = Promise.resolve();
  }

  // Catalog now covers EVERY brand in one combined local download, not just
  // whichever brand a counter's session happens to be assigned — so any
  // item can be recognized regardless of the rack/brand they picked at
  // Setup (see handleScan's cross-brand notice). Only re-downloads if the
  // cache is empty or genuinely stale; otherwise this is instant.
  catalogLoadPromise = ensureAllCatalogsLoaded()
    .catch(() => {})
    .finally(() => { catalogReady = true; });

  flushQueue();
  setInterval(flushQueue, 20000); // keep trying quietly in the background

  // Opened via a rack label's URL (native Camera app, not the in-app
  // scanner) — jump straight past Setup into the name prompt for that rack.
  const qrParsed = parseRackLabel(location.href);
  // Clean ?rack= out of the address bar right away, BEFORE any modal opens.
  // Every modal (including the name prompt below) does its own
  // history.pushState so the phone's back button closes just the modal
  // instead of leaving the app. Doing this cleanup AFTER that pushState —
  // which is what an earlier version of this fix did — overwrote that
  // pushed entry, so tapping "Start Counting" (which calls history.back()
  // to consume it) had nothing correct left to go back to: on some phones
  // that closed the page entirely, right at the moment it should have
  // started the count. Doing it first, before any modal exists, avoids
  // that entirely — and is safe now that the reload below is skipped for
  // this load, so there's no longer a race that could lose ?rack= from a
  // reload landing before this runs.
  if (qrParsed) history.replaceState(null, "", location.pathname);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      if (reg.waiting) reg.waiting.postMessage("skipWaiting");
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            nw.postMessage("skipWaiting");
          }
        });
      });
      reg.update().catch(() => {});
    }).catch(() => {});
    let refreshed = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshed) return;
      refreshed = true;
      // A brand-new service worker taking over normally reloads the page so
      // the fresh code applies right away. But when this load came from a
      // scanned rack label, that reload can land mid-navigation on a phone's
      // Camera app / installed-app hand-off, and on some phones that closes
      // the page outright instead of reloading it. It's not needed here
      // anyway — the counting screen is about to render (or just did) from
      // already-loaded code, and the next ordinary app open picks up the
      // new version automatically. So skip the reload just this once.
      if (qrParsed) return;
      location.reload();
    });
  }

  const session = await getSession();
  if (session && qrParsed && (session.brand !== qrParsed.brand || session.rack !== qrParsed.rack)) {
    // A different rack than the one already in progress — don't silently
    // discard their tally, ask first.
    renderResumePrompt(session, qrParsed);
  } else if (qrParsed && !session) {
    renderNamePrompt(qrParsed.brand, qrParsed.rack, true);
  } else if (session) {
    renderResumePrompt(session);
  } else {
    renderSetup();
  }
})();

/* ================= SETUP ================= */

// Shared by the camera QR modal and the keyboard-wedge listener — both feed
// a raw scanned string in here. Expected payload format: WHC|BRAND|RACKID
// Accepts either the raw payload printed/encoded directly ("WHC|BRAND|RACK" —
// what a USB/Bluetooth wedge scanner types, and what the in-app camera reads
// off a QR image regardless of what that QR's content looks like) OR a full
// URL containing a ?rack=<that payload> parameter (what a phone's OWN Camera
// app hands the browser when it opens a link-style QR code — see boot() and
// rack-qr-generator.html, which now prints URL-style labels for exactly this
// reason: a plain non-URL payload does nothing when scanned outside the app,
// which is what was reported as "scanning takes me to the dashboard" — a
// worker's phone was opening its home page / whatever tab was already open,
// since there was nothing in the QR for the OS to act on).
function parseRackLabel(code) {
  let raw = String(code || "").trim();
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      raw = u.searchParams.get("rack") || "";
    } catch (e) { return null; }
  }
  const parts = raw.split("|");
  if (parts.length !== 3 || parts[0] !== "WHC") return null;
  const [, brand, rack] = parts;
  const brandCfg = APP_CONFIG.brands.find((b) => b.code === brand);
  if (!brandCfg) return null;
  return { brand, rack };
}

async function renderSetup() {
  wedgeCallback = null;
  appEl.innerHTML = "";
  appEl.appendChild(el(`
    <div>
      <h2>Start Counting</h2>
      <div class="card">
        <button class="btn" id="qrBtn">📷 Scan Rack Label</button>
        <p class="muted" style="text-align:center; margin:10px 0;">or set up manually</p>
        <div class="field"><label>Brand</label>
          <select id="brandSelect"><option value="">— Choose brand —</option>
            ${APP_CONFIG.brands.map((b) => `<option value="${b.code}">${b.name}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Rack</label><select id="rackSelect" disabled><option value="">— Choose brand first —</option></select></div>
        <div class="field"><label>Your Name</label><input id="nameInput" placeholder="e.g. Juan D."></div>
        <button class="btn good" id="startBtn">Start Counting</button>
        <p class="muted" style="text-align:center; margin-top:10px;">💻 On a laptop with a USB/Bluetooth barcode scanner: just scan the rack label while this screen is open — no need to tap "Scan Rack Label" or use a camera.</p>
      </div>
      <button class="btn secondary" id="auditBtn" style="margin-top:14px;">🔍 Audit / Recount a Flagged Rack</button>
      <button class="btn secondary" id="auditReportsBtn" style="margin-top:10px;">📋 Audit Reports (check past results)</button>
    </div>
  `));

  const brandSelect = document.getElementById("brandSelect");
  const rackSelect = document.getElementById("rackSelect");

  // Laptop path: a USB/Bluetooth scanner "types" the rack label's code, then
  // Enter — works the instant this screen is showing, no camera involved.
  wedgeCallback = (code) => {
    const parsed = parseRackLabel(code);
    if (!parsed) {
      toast("That doesn't look like a rack label — check the scanner or use manual setup.");
      return;
    }
    wedgeCallback = null;
    renderNamePrompt(parsed.brand, parsed.rack);
  };

  async function populateRacks(brand) {
    if (!brand) {
      rackSelect.disabled = true;
      rackSelect.innerHTML = `<option value="">— Choose brand first —</option>`;
      return;
    }
    let racks = await DB.getRacksForBrand(brand);
    if (racks.length === 0 && !racksReady) {
      // Rack list is still downloading in the background — say so honestly,
      // then wait for it and populate automatically instead of leaving a
      // misleading "No racks loaded" dead end on screen.
      rackSelect.innerHTML = `<option value="">⏳ Still loading racks…</option>`;
      rackSelect.disabled = true;
      await racksLoadPromise;
      if (brandSelect.value !== brand) return; // they picked a different brand while we waited
      racks = await DB.getRacksForBrand(brand);
    }
    if (racks.length === 0) {
      rackSelect.innerHTML = navigator.onLine
        ? `<option value="">No racks found for "${brand}" — check the Brand column in the Racks sheet matches config.js exactly</option>`
        : `<option value="">No racks loaded — need signal once to download the rack list</option>`;
      rackSelect.disabled = true;
      return;
    }
    rackSelect.disabled = false;
    rackSelect.innerHTML = `<option value="">— Choose rack —</option>` + racks.map((r) => `<option value="${r.rack}">${r.rack}</option>`).join("");
  }

  brandSelect.addEventListener("change", () => populateRacks(brandSelect.value));

  document.getElementById("qrBtn").onclick = () => renderQrScanModal();

  document.getElementById("startBtn").onclick = onceAsync_(async () => {
    const brand = brandSelect.value;
    const rack = rackSelect.value;
    const name = document.getElementById("nameInput").value.trim();
    if (!brand || !rack || !name) {
      toast("Pick a brand, a rack, and enter your name");
      return;
    }
    try {
      await startSession(brand, rack, name);
    } catch (e) {
      console.error("startSession failed:", e);
      toast("⚠️ Couldn't start counting: " + (e && e.message ? e.message : e), 5000);
    }
  });

  document.getElementById("auditBtn").onclick = () => renderAuditPicker();
  document.getElementById("auditReportsBtn").onclick = () => renderAuditReportsList();
}

/* ================= AUDIT / RECOUNT ================= */
// Fetches a live snapshot from the same endpoint the Dashboard uses — this
// is the one place the counting app reads instead of only writing, since
// it needs to know which racks are currently flagged for the 25% random
// audit and haven't been confirmed yet.
// Same identity rule as the backend (GTIN, else article|color|size) so the
// phone and the sheet always agree on which item is which.
function auditItemKey_(x) {
  const g = String((x && x.gtin) || "").trim();
  if (g) return g;
  return [(x && x.article) || "", (x && x.color) || "", (x && x.size) || ""].join("|");
}
function parseAuditSample_(raw) {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
function auditInSample_(session, info) {
  if (!session.isAudit || !session.auditSample || session.auditSample.length === 0) return true;
  const k = auditItemKey_(info);
  return session.auditSample.some((x) => x.key === k);
}
function auditSampleChecklistHtml_(session) {
  if (!session.isAudit || !session.auditSample || session.auditSample.length === 0) return "";
  const counted = {};
  session.tally.forEach((t) => { const k = auditItemKey_(t); counted[k] = (counted[k] || 0) + (t.removed ? 0 : t.qty); });
  const done = session.auditSample.filter((x) => counted[x.key] > 0).length;

  // Grouped by where the item was originally captured (its box/remark),
  // shown BEFORE any scanning happens (this renders as soon as the audit
  // screen loads) — so the auditor knows which box to physically open next
  // instead of finding out only after they've already scanned something.
  // Uses the same snapshot downloaded at startAuditSession, so this needs
  // no signal and no per-item lookup.
  const NO_BOX = "No box/remark noted";
  const NOT_ORIGINAL = "Not in original count";
  const groups = {};
  const order = [];
  session.auditSample.forEach((x) => {
    const info = originalInfoFor_(session, x);
    const label = info ? (info.remarks && info.remarks.length ? info.remarks.join(", ") : NO_BOX) : NOT_ORIGINAL;
    if (!groups[label]) { groups[label] = []; order.push(label); }
    groups[label].push(x);
  });
  // Real box labels first (most useful for guiding where to go), the two
  // catch-alls last since there's nowhere specific they point the auditor.
  order.sort((a, b) => {
    const rank = (l) => (l === NOT_ORIGINAL ? 2 : l === NO_BOX ? 1 : 0);
    return rank(a) - rank(b);
  });

  const groupsHtml = order.map((label) => {
    const rows = groups[label].map((x) => {
      const c = counted[x.key] || 0;
      return `<div class="tally-row"><div class="info"><b>${esc_(x.desc || x.article || x.key)}</b><span>${esc_([x.color, x.size].filter(Boolean).join(" / "))}${x.article ? " · " + esc_(x.article) : ""}</span></div><div class="qty-badge">${c > 0 ? "✅ " + c : "—"}</div></div>`;
    }).join("");
    const isRealBox = label !== NO_BOX && label !== NOT_ORIGINAL;
    return `<div style="margin-bottom:10px;"><div style="font-weight:700; font-size:13px; ${isRealBox ? "color:var(--accent);" : "color:var(--muted);"} margin-bottom:2px;">${isRealBox ? "📦 " : ""}${esc_(label)}</div>${rows}</div>`;
  }).join("");

  return `<div class="card" style="margin-bottom:10px;"><div style="font-weight:700; margin-bottom:6px;">Items to recount (${done}/${session.auditSample.length})</div><div class="muted" style="margin-bottom:8px;">Grouped by where each item was originally counted — open that box/location first. Count each one from scratch.</div>${groupsHtml}</div>`;
}

async function fetchAuditableRacks() {
  if (!navigator.onLine || !APP_CONFIG.submitUrl) return { racks: [], error: "No signal — try again once you're online." };
  try {
    const res = await fetch(APP_CONFIG.submitUrl + "?only=audit"); // light endpoint: flagged racks + who counted them (not the whole snapshot)
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Unknown error");
    const flagged = (data.status || []).filter((r) => r.AuditFlag === "yes" && r.AuditConfirmed !== "yes");
    // Who originally counted each rack — used for the "needs a different
    // counter" soft warning when picking an auditor name below.
    const originalCounters = {};
    (data.presence || []).concat(data.counts || []).forEach((r) => {
      const k = r.Brand + "|" + r.Rack;
      originalCounters[k] = originalCounters[k] || new Set();
      if (r.Counter) originalCounters[k].add(r.Counter);
    });
    return { racks: flagged, originalCounters, error: null };
  } catch (e) {
    return { racks: [], error: e.message };
  }
}

async function renderAuditPicker() {
  const modal = openModal(`
    <h2>🔍 Audit / Recount</h2>
    <p class="muted">Completed racks with sampled remarks (boxes) waiting to be recounted.</p>
    <div id="auditPickerList" class="card"><div class="empty"><div class="whc-spinner" style="margin:0 auto 10px;"></div>Loading racks to audit… please wait</div></div>
    <button class="btn secondary" id="auditPickerCancel">Cancel</button>
  `);
  modal.querySelector("#auditPickerCancel").onclick = () => closeModal(modal);
  const { racks, originalCounters, error } = await fetchAuditableRacks();
  const listEl = modal.querySelector("#auditPickerList");
  if (error) {
    listEl.innerHTML = `<div class="empty">⚠️ ${error}</div>`;
    return;
  }
  if (racks.length === 0) {
    listEl.innerHTML = `<div class="empty">Nothing needs an audit recount right now.</div>`;
    return;
  }
  listEl.innerHTML = "";
  racks.forEach((r) => {
    const row = el(`
      <div class="tally-row" style="cursor:pointer;">
        <div class="info"><b>${r.Brand} — ${r.Rack}</b><span>${(() => { const n = parseAuditSample_(r.AuditSample).length; return n ? `Recount ${n} item${n === 1 ? "" : "s"} — whole boxes` : "Full-rack recount"; })()}</span></div>
        <div class="qty-badge">›</div>
      </div>
    `);
    row.onclick = () => {
      closeModal(modal);
      const key = r.Brand + "|" + r.Rack;
      renderAuditNamePrompt(r.Brand, r.Rack, originalCounters[key] || new Set(), parseAuditSample_(r.AuditSample));
    };
    listEl.appendChild(row);
  });
}


/* ================= AUDIT REPORTS (detailed, can be re-opened any time) ================= */
function escA_(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function fmtAuditDate_(iso) { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function fmtSigned_(n) { return (n > 0 ? "+" : "") + n; }

// One row per box/remark that was recounted: how many items it holds, its original qty, and how many of them differ.
function auditBoxRollup_(items) {
  const by = {};
  (items || []).forEach((it) => {
    const boxes = it.boxes && it.boxes.length ? it.boxes : [{ remark: "(no remark)", qty: it.original }];
    boxes.forEach((b) => {
      const g = (by[b.remark] = by[b.remark] || { remark: b.remark, items: 0, originalQty: 0, diffItems: 0 });
      g.items++; g.originalQty += b.qty;
      if (it.variance !== 0) g.diffItems++;
    });
  });
  return Object.values(by).sort((a, b) => String(a.remark).localeCompare(String(b.remark), undefined, { numeric: true }));
}

function auditItemRowsHtml_(items, onlyDiff) {
  const list = items.filter((it) => !onlyDiff || it.variance !== 0);
  if (!list.length) return `<div class="empty">${onlyDiff ? "No differences — every item matched the original count. ✅" : "No items."}</div>`;
  return list.map((it) => {
    const ok = it.variance === 0;
    const color = ok ? "var(--good,#2e8b57)" : "var(--warn,#c0392b)";
    const boxes = (it.boxes || []).map((b) => `${escA_(b.remark)}: ${b.qty}`).join(" · ");
    return `<div class="tally-row" style="align-items:flex-start;">
      <div class="info"><b>${escA_(it.desc || it.article || it.key)}</b>
        <span>${escA_([it.color, it.size].filter(Boolean).join(" / "))}${it.article ? " · " + escA_(it.article) : ""}</span>
        ${boxes ? `<span>📦 ${boxes}</span>` : ""}</div>
      <div style="text-align:right; min-width:92px;">
        <div class="muted" style="font-size:12px;">Orig <b>${it.original}</b> → Recount <b>${it.audited}</b></div>
        <div style="font-weight:700; color:${color};">${ok ? "✅ match" : fmtSigned_(it.variance) + " · " + escA_(it.result)}</div>
      </div></div>`;
  }).join("");
}

function auditReportBodyHtml_(rep) {
  const v = rep.variance;
  const chip = (label, val, color) => `<div style="flex:1; min-width:84px; padding:8px; border:1px solid var(--border,#ddd); border-radius:8px; text-align:center;"><div class="muted" style="font-size:11px;">${label}</div><div style="font-size:18px; font-weight:700; ${color ? "color:" + color : ""}">${val}</div></div>`;
  const boxes = auditBoxRollup_(rep.items);
  return `
    <div class="muted" style="margin-bottom:8px;">${escA_(rep.auditor ? "Audited by " + rep.auditor : "")}${rep.at ? " · " + escA_(fmtAuditDate_(rep.at)) : ""}${rep.sampleInfo ? `<br>${escA_(rep.sampleInfo)}` : ""}</div>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
      ${chip("Original qty", rep.originalQty)}${chip("Recount qty", rep.auditedQty)}
      ${chip("Variance", fmtSigned_(v), v === 0 ? "var(--good,#2e8b57)" : "var(--warn,#c0392b)")}
      ${chip("Items checked", rep.itemsChecked)}${chip("With differences", rep.itemsWithDiff, rep.itemsWithDiff ? "var(--warn,#c0392b)" : "")}
    </div>
    <div style="display:flex; gap:8px; margin-bottom:8px;">
      <button class="btn secondary" id="arAll" style="flex:1; padding:8px;">All items (${rep.items.length})</button>
      <button class="btn" id="arDiff" style="flex:1; padding:8px;">Differences only (${rep.itemsWithDiff})</button>
    </div>
    <div id="arItems"></div>
    <h3 style="margin:16px 0 6px;">Boxes recounted (${boxes.length})</h3>
    ${boxes.map((b) => `<div class="tally-row"><div class="info"><b>📦 ${escA_(b.remark)}</b><span>${b.items} item${b.items === 1 ? "" : "s"} · original qty ${b.originalQty}</span></div>
      <div class="qty-badge" style="${b.diffItems ? "color:var(--warn,#c0392b);" : ""}">${b.diffItems ? b.diffItems + " diff" : "✅"}</div></div>`).join("")}`;
}

function renderAuditReportModal_(rep) {
  const modal = openModal(`
    <h2>📋 Audit Report — ${escA_(rep.brand)} · ${escA_(rep.rack)}</h2>
    ${auditReportBodyHtml_(rep)}
    <button class="btn secondary" id="arClose" style="margin-top:14px;">Close</button>
  `);
  const box = modal.querySelector("#arItems");
  const show = (onlyDiff) => {
    box.innerHTML = auditItemRowsHtml_(rep.items, onlyDiff);
    modal.querySelector("#arAll").className = "btn " + (onlyDiff ? "secondary" : "");
    modal.querySelector("#arDiff").className = "btn " + (onlyDiff ? "" : "secondary");
  };
  modal.querySelector("#arAll").onclick = () => show(false);
  modal.querySelector("#arDiff").onclick = () => show(true);
  modal.querySelector("#arClose").onclick = () => closeModal(modal);
  show(rep.itemsWithDiff > 0); // open on what needs attention; if everything matched, show everything
}

// Kept on this phone too, so past reports open even offline.
async function saveAuditReportLocal_(rep) {
  try {
    const list = (await DB.getSetting("auditReports", [])) || [];
    const next = [rep].concat(list.filter((r) => r.sessionId !== rep.sessionId)).slice(0, 30);
    await DB.setSetting("auditReports", next);
  } catch (e) { /* not critical */ }
}

async function renderAuditReportsList() {
  const modal = openModal(`
    <h2>📋 Audit Reports</h2>
    <p class="muted">Every finished audit, newest first. Tap one for the full item-by-item report.</p>
    <div id="arList" class="card"><div class="empty"><div class="whc-spinner" style="margin:0 auto 10px;"></div>Loading reports…</div></div>
    <button class="btn secondary" id="arListClose">Close</button>
  `);
  modal.querySelector("#arListClose").onclick = () => closeModal(modal);
  let local = [];
  try { local = (await DB.getSetting("auditReports", [])) || []; } catch (e) {}
  let remote = [], failed = false;
  if (APP_CONFIG.submitUrl && navigator.onLine) {
    try {
      const res = await fetch(APP_CONFIG.submitUrl + "?only=auditreports&limit=30&_t=" + Date.now(), { cache: "no-store" });
      const data = await res.json();
      if (data && data.ok) remote = data.reports || []; else failed = true;
    } catch (e) { failed = true; }
  } else failed = true;
  const map = {};
  local.concat(remote).forEach((r) => { map[r.sessionId] = r; }); // the Sheet's copy wins
  const reports = Object.values(map).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const listEl = modal.querySelector("#arList");
  if (!reports.length) { listEl.innerHTML = `<div class="empty">No audit reports yet.${failed ? " (Couldn't reach the Sheet — showing this phone's saved ones.)" : ""}</div>`; return; }
  listEl.innerHTML = "";
  reports.forEach((r) => {
    const row = el(`<div class="tally-row" style="cursor:pointer;">
      <div class="info"><b>${escA_(r.brand)} — ${escA_(r.rack)}</b><span>${escA_(r.auditor || "")} · ${escA_(fmtAuditDate_(r.at))} · ${r.itemsChecked} items</span></div>
      <div class="qty-badge" style="color:${r.variance === 0 ? "var(--good,#2e8b57)" : "var(--warn,#c0392b)"};">${r.variance === 0 ? "✅" : fmtSigned_(r.variance)}</div></div>`);
    row.onclick = () => renderAuditReportModal_(r);
    listEl.appendChild(row);
  });
  if (failed) listEl.appendChild(el(`<div class="muted" style="font-size:12px; padding:8px;">Couldn't reach the Sheet — showing what's saved on this phone.</div>`));
}

function renderAuditNamePrompt(brand, rack, originalCounterSet, sample = []) {
  const modal = openModal(`
    <h2>${brand} — ${rack}</h2>
    <p class="muted">${sample.length ? `Recount the ${sample.length} sampled item${sample.length === 1 ? "" : "s"} (everything in the sampled boxes/remarks — whole boxes are recounted, not just part of them). ` : ""}This is a fresh independent recount — a different person than the original counter should do this, so the audit actually verifies something.</p>
    <div class="field"><label>Your Name (Auditor)</label><input id="auditNameInput" placeholder="e.g. Juan D."></div>
    <div id="auditNameWarning" class="muted" style="color:var(--warn,#c0392b); display:none; margin-bottom:8px;">⚠️ That name matches one of the original counters on this rack — ideally use someone different.</div>
    <button class="btn good" id="auditStartBtn">Start Audit Recount</button>
  `);
  const input = modal.querySelector("#auditNameInput");
  const warn = modal.querySelector("#auditNameWarning");
  input.addEventListener("input", () => {
    const match = [...originalCounterSet].some((n) => n.trim().toLowerCase() === input.value.trim().toLowerCase());
    warn.style.display = match ? "block" : "none";
  });
  modal.querySelector("#auditStartBtn").onclick = async () => {
    const name = input.value.trim();
    if (!name) {
      toast("Enter your name");
      return;
    }
    closeModal(modal);
    await startAuditSession(brand, rack, name, sample);
  };
}

// Downloads the ORIGINAL count for this one rack — one entry per item, qty
// + whatever Remarks it was submitted with — BEFORE the audit starts, keyed
// by the same itemKey_ the server uses. This is what lets each recount scan
// show "originally counted: qty 3 (Box 4 of 6)" INSTANTLY as the auditor
// scans, entirely from what's already on the phone, instead of waiting on a
// round trip to the Sheet for every single item. If there's no signal right
// now, the audit still starts — it just can't show origin info until it can
// fetch; the actual audit comparison always happens server-side on confirm
// regardless, so nothing about correctness depends on this succeeding.
async function fetchOriginalRackCounts_(brand, rack) {
  if (!navigator.onLine || !APP_CONFIG.submitUrl) return {};
  try {
    const url = APP_CONFIG.submitUrl + "?only=rackCounts&brand=" + encodeURIComponent(brand) + "&rack=" + encodeURIComponent(rack);
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Unknown error");
    const byKey = {};
    (data.items || []).forEach((it) => { byKey[it.key || auditItemKey_(it)] = { qty: it.qty || 0, remarks: it.remarks || [] }; });
    return byKey;
  } catch (e) {
    return {};
  }
}

async function startAuditSession(brand, rack, auditor, sample = []) {
  if (!catalogReady) {
    const unsubscribe = renderCatalogProgressScreen(appEl);
    await catalogLoadPromise.catch(() => {});
    unsubscribe();
  }
  const deviceId = (await DB.getSetting("deviceId")) || (await (async () => {
    const id = uid("dev");
    await DB.setSetting("deviceId", id);
    return id;
  })());
  const hideLoading = showLoading_("Preparing the audit…", "Loading the original count for " + rack + ". Please don't close the app.");
  let originalCounts;
  try { originalCounts = await fetchOriginalRackCounts_(brand, rack); } finally { hideLoading(); }
  if (Object.keys(originalCounts).length === 0) {
    toast("ℹ️ Couldn't preload the original count right now — recounting still works, origin info just won't show until you're back online.", 4500);
  }
  const session = {
    brand, rack, counter: auditor, deviceId,
    sessionId: uid("sess"),
    isAudit: true,
    auditSample: sample,
    auditSessionId: uid("audit"),
    originalCounts,
    tally: [], lastItem: null, onBreak: false, openConcern: null, batches: [],
  };
  await saveSession(session);
  renderScan();
}

// Original-count lookup for one tally line, for traceability during an
// audit ("where was this originally captured"). Undefined outside audits or
// when there's no matching original-count entry (a brand-new item the
// original count missed entirely, for instance).
function originalInfoFor_(session, t) {
  if (!session.isAudit || !session.originalCounts) return null;
  return session.originalCounts[auditItemKey_(t)] || null;
}
function originalInfoLabel_(info) {
  if (!info) return "";
  const remarkPart = info.remarks && info.remarks.length ? ` (${info.remarks.map(esc_).join(", ")})` : "";
  return `Orig: qty ${info.qty}${remarkPart}`;
}

function renderQrScanModal() {
  const modal = openModal(`
    <h2>Scan Rack Label</h2>
    <div class="scan-wrap qr-wrap"><video id="qrVideo" muted playsinline></video><div class="scan-band qr-band"></div></div>
    <p class="muted" id="qrMsg">Point the camera at the rack's QR label — hold it further back so the whole square fits in frame. A connected barcode scanner also works here.</p>
    <button class="btn secondary" id="qrCancel">Cancel</button>
  `);
  const cleanup = () => {
    Scanner.stop();
    wedgeCallback = null;
  };
  modal.querySelector("#qrCancel").onclick = () => {
    cleanup();
    closeModal(modal);
  };
  const onRackLabel = (code) => {
    const parsed = parseRackLabel(code);
    if (!parsed) {
      modal.querySelector("#qrMsg").textContent = "That doesn't look like a rack label — try again or use manual setup.";
      return;
    }
    cleanup();
    closeModal(modal);
    renderNamePrompt(parsed.brand, parsed.rack);
  };
  wedgeCallback = onRackLabel;
  const video = modal.querySelector("#qrVideo");
  Scanner.start(video, onRackLabel, { mode: "qr" }).catch((e) => {
    modal.querySelector("#qrMsg").textContent = "⚠️ " + e.message + " — a connected barcode scanner still works on this screen.";
  });
}

function renderNamePrompt(brand, rack, fromLink = false) {
  const modal = openModal(`
    <h2>${brand} — ${rack}</h2>
    <div class="field"><label>Your Name</label><input id="qrNameInput" placeholder="e.g. Juan D."></div>
    <button class="btn good" id="qrStartBtn">Start Counting</button>
  `);
  modal.querySelector("#qrStartBtn").onclick = onceAsync_(async () => {
    const name = modal.querySelector("#qrNameInput").value.trim();
    if (!name) {
      toast("Enter your name");
      return;
    }
    closeModal(modal);
    try {
      await startSession(brand, rack, name, { deferCamera: fromLink });
    } catch (e) {
      console.error("startSession failed:", e);
      toast("⚠️ Couldn't start counting: " + (e && e.message ? e.message : e), 5000);
      renderSetup(); // don't leave a blank/dead screen — give them a working way forward
    }
  });
}

async function startSession(brand, rack, name, opts = {}) {
  const brandCfg = APP_CONFIG.brands.find((b) => b.code === brand);
  const deviceId = (await DB.getSetting("deviceId")) || (await (async () => {
    const id = uid("dev");
    await DB.setSetting("deviceId", id);
    return id;
  })());

  const session = {
    sessionId: uid("sess"),
    brand,
    rack,
    counter: name,
    deviceId,
    onBreak: false,
    tally: [],
    lastItem: null,
    batches: [],
    startedAt: nowStamp(),
  };
  await saveSession(session);

  if (!catalogReady) {
    const unsubscribe = renderCatalogProgressScreen(appEl);
    // A cap on how long this screen waits, even on a very weak connection —
    // without one, a catalog fetch that never settles (some mobile networks
    // neither succeed nor time out on their own for a long while) left this
    // screen showing forever with no way out. Counting can still start:
    // items just won't be recognized from the catalog until it finishes
    // downloading in the background.
    await Promise.race([
      catalogLoadPromise.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 15000)),
    ]);
    unsubscribe();
  }

  // A failed presence ping shouldn't block starting the count — it's just a
  // "someone's here" signal for the Dashboard, and submitAction already
  // queues it for retry if it can't send right away.
  // Not awaited: the Dashboard already gets this instantly through the live
  // channel, and the Sheet write (slow Apps Script round trip) happens in the background.
  submitAction({ action: "presence", brand, rack, counter: name, deviceId, sessionId: session.sessionId, status: "active" }).catch((e) => console.error("presence submit failed:", e));
  renderScan({ deferCamera: !!opts.deferCamera });
}

// Subscribable progress state for the combined catalog download, so any
// screen currently showing "getting ready" can render a live progress bar
// instead of a static message — the download itself may have started back
// at boot, before any screen was even asking to display it.
let catalogProgress = { phase: "idle", brands: {}, savedDone: 0, savedTotal: 0 };
let catalogProgressListeners = [];
function onCatalogProgress(cb) {
  catalogProgressListeners.push(cb);
  cb(catalogProgress);
  return () => { catalogProgressListeners = catalogProgressListeners.filter((l) => l !== cb); };
}
function updateCatalogProgress(patch) {
  catalogProgress = { ...catalogProgress, ...patch };
  catalogProgressListeners.forEach((cb) => cb(catalogProgress));
}

// Downloads EVERY brand's catalog and merges them into one local store, each
// record tagged with which brand it actually belongs to. Replaces the old
// per-brand download (which meant switching brands mid-shift, or scanning
// an item from a different brand than assigned, just silently failed to
// recognize it) — now any item scans correctly regardless of which brand
// the counter is assigned to.
async function ensureAllCatalogsLoaded() {
  const cachedAt = await DB.getSetting("catalogCachedAt");
  if (cachedAt) {
    const count = await DB.catalogCount();
    if (count > 0) {
      updateCatalogProgress({ phase: "done" });
      return; // already have a combined catalog cached locally
    }
  }
  if (!navigator.onLine) {
    if (await DB.catalogCount() === 0) toast("⚠️ No signal — can't download the item catalog yet. Try again once you have signal.");
    updateCatalogProgress({ phase: "offline" });
    return; // nothing cached and no signal — Setup will surface this when they try to scan
  }
  const brandState = {};
  APP_CONFIG.brands.forEach((b) => { brandState[b.code] = { name: b.name, status: "pending", count: 0 }; });
  updateCatalogProgress({ phase: "downloading", brands: brandState, savedDone: 0, savedTotal: 0 });
  try {
    const perBrand = await Promise.all(
      APP_CONFIG.brands.map((b) =>
        fetchCatalog(b.catalogCsvUrl)
          .then((records) => {
            updateCatalogProgress({ brands: { ...catalogProgress.brands, [b.code]: { name: b.name, status: "done", count: records.length } } });
            return records.map((r) => ({ ...r, brand: b.code }));
          })
          .catch(() => {
            // one brand's sheet being briefly unreachable shouldn't block everyone else's
            updateCatalogProgress({ brands: { ...catalogProgress.brands, [b.code]: { name: b.name, status: "error", count: 0 } } });
            return [];
          })
      )
    );
    const combined = perBrand.flat();
    updateCatalogProgress({ phase: "saving", savedTotal: combined.length, savedDone: 0 });
    await DB.clearCatalog();
    await DB.bulkLoadCatalog(combined, (done, total) => {
      updateCatalogProgress({ savedDone: done, savedTotal: total });
    });
    updateCatalogProgress({ phase: "finishing" });
    await DB.getCatalogArray();
    await DB.setSetting("catalogCachedAt", String(Date.now()));
    updateCatalogProgress({ phase: "done" });
  } catch (e) {
    toast("⚠️ Couldn't load the item catalog: " + e.message, 4000);
    updateCatalogProgress({ phase: "error" });
    throw e;
  }
}

// Renders a live progress bar into `container` (usually appEl) — subscribes
// to catalogProgress and updates the DOM directly on every change. Returns
// an unsubscribe function; callers should call it once the catalog is ready
// and they're about to replace the screen anyway (harmless to skip too,
// since a torn-down screen just stops getting updated).
function renderCatalogProgressScreen(container) {
  container.innerHTML = `
    <div class="card">
      <h2>Getting the item catalog ready…</h2>
      <div id="catalogProgressBrands" style="margin:10px 0; font-size:13px; line-height:1.7;"></div>
      <div class="progress-track"><div class="progress-fill" id="catalogProgressFill" style="width:0%;"></div></div>
      <p class="muted" id="catalogProgressStatus" style="margin-top:8px;">Starting…</p>
    </div>
  `;
  const brandsEl = container.querySelector("#catalogProgressBrands");
  const fillEl = container.querySelector("#catalogProgressFill");
  const statusEl = container.querySelector("#catalogProgressStatus");
  return onCatalogProgress((p) => {
    const brandList = Object.values(p.brands || {});
    brandsEl.innerHTML = brandList
      .map((b) => `<div>${b.status === "done" ? "✅" : b.status === "error" ? "⚠️" : "⏳"} ${b.name}${b.status === "done" ? ` — ${b.count.toLocaleString()} items` : b.status === "error" ? " — couldn't load" : "…"}</div>`)
      .join("");
    if (p.phase === "downloading") {
      const total = brandList.length;
      const done = brandList.filter((b) => b.status !== "pending").length;
      fillEl.style.width = total ? `${Math.round((done / total) * 60)}%` : "0%"; // downloading is the first 60% of the bar
      statusEl.textContent = `Downloading catalogs… (${done}/${total} brands)`;
    } else if (p.phase === "saving") {
      const pct = p.savedTotal ? 60 + Math.round((p.savedDone / p.savedTotal) * 35) : 60;
      fillEl.style.width = `${pct}%`;
      statusEl.textContent = `Saving to device… ${p.savedDone.toLocaleString()} / ${p.savedTotal.toLocaleString()} items`;
    } else if (p.phase === "finishing") {
      fillEl.style.width = "97%";
      statusEl.textContent = "Finishing up…";
    } else if (p.phase === "done") {
      fillEl.style.width = "100%";
      statusEl.textContent = "Ready!";
    } else if (p.phase === "offline") {
      statusEl.textContent = "No signal — waiting for connection…";
    } else {
      statusEl.textContent = "Starting…";
    }
  });
}

/* ================= RESUME PROMPT ================= */
function renderResumePrompt(session, scannedElsewhere) {
  const lastItem = session.lastItem;
  const unsent = pendingChanges_(session).length;
  appEl.innerHTML = "";
  appEl.appendChild(el(`
    <div>
      <h2>Welcome back, ${session.counter}</h2>
      <div class="card">
        <p><b>${session.brand}</b> — Rack ${session.rack}</p>
        ${session.onBreak ? `<p class="badge warn">On break</p>` : ""}
        ${lastItem ? `<p class="muted">Last logged: ${lastItem.desc} — ${lastItem.color}/${lastItem.size}, at ${new Date(lastItem.ts).toLocaleTimeString()}${session.isAudit ? (() => { const info = originalInfoFor_(session, lastItem); return info ? ` — ${originalInfoLabel_(info)}` : " — not in original count"; })() : ""}</p>` : `<p class="muted">No items logged yet this session.</p>`}
        <p class="muted">Running tally: ${session.tally.reduce((s, t) => s + effQty_(t), 0)} item(s)</p>
        ${unsent > 0 ? `<p style="color:var(--warn);">📤 ${unsent} scan(s)/change(s) from before haven't been submitted to the Sheet yet.</p>` : ""}
        ${scannedElsewhere ? `<p style="color:var(--warn);">You just scanned <b>${scannedElsewhere.brand} — Rack ${scannedElsewhere.rack}</b> — a different rack than the one in progress above.</p>` : ""}
        <div class="btn-row" style="margin-top:12px;">
          <button class="btn secondary" id="endSessionBtn">End & Start Over</button>
          <button class="btn good" id="resumeBtn">${scannedElsewhere ? "Resume " + session.rack + " instead" : "Resume Counting"}</button>
        </div>
      </div>
    </div>
  `));
  document.getElementById("resumeBtn").onclick = async () => {
    if (!catalogReady) await catalogLoadPromise.catch(() => {});
    session.onBreak = false;
    await saveSession(session);
    submitAction({ action: "presence", brand: session.brand, rack: session.rack, counter: session.counter, deviceId: session.deviceId, sessionId: session.sessionId, status: "resumed" }).catch(() => {});
    renderScan();
  };
  document.getElementById("endSessionBtn").onclick = async () => {
    const warning = unsent > 0
      ? `You have ${unsent} scan(s)/change(s) that were NEVER SUBMITTED — ending now discards them permanently. Continue?`
      : "This discards your current rack session on this device (already-submitted scans stay saved on the server). Continue?";
    if (confirm(warning)) {
      // Tell the Dashboard this counter has left the rack — including from a
      // break. Not awaited, so a slow connection never blocks starting over;
      // if it can't be sent now, submitAction keeps it in the offline queue.
      submitAction({ action: "presence", brand: session.brand, rack: session.rack, counter: session.counter, deviceId: session.deviceId, sessionId: session.sessionId, status: "ended" });
      await clearSession();
      if (scannedElsewhere) renderNamePrompt(scannedElsewhere.brand, scannedElsewhere.rack);
      else renderSetup();
    }
  };
}

/* ================= SCAN SCREEN ================= */
async function renderScan(opts = {}) {
  const session = await getSession();
  const brandCfg = APP_CONFIG.brands.find((b) => b.code === session.brand);
  const confirmMode = !!brandCfg.confirmMode;

  appEl.innerHTML = "";
  appEl.appendChild(el(`
    <div>
      ${session.isAudit ? `<div class="card" style="border-color:var(--signal); background:rgba(180,113,30,0.1); text-align:center; font-weight:700; margin-bottom:10px;">🔍 AUDIT RECOUNT — kept separate from the main count</div>` : ""}
      <div class="row-between" style="margin-bottom:8px;">
        <h2 style="margin:0;">${session.brand} — ${session.rack}</h2>
        <span class="muted">${session.counter}</span>
      </div>
      <div id="concernBannerHost"></div>
      <div class="scan-wrap">
        <video id="scanVideo" muted playsinline></video>
        <div class="scan-band"></div>
        <div class="scan-flash" id="scanFlash"></div>
        <div class="desc-flash" id="descFlash"></div>
        <button type="button" class="scan-reset-btn" id="cameraResetBtn" title="Camera not working? Tap to reset" aria-label="Reset camera">↻</button>
      </div>
      <div id="scanMsg" class="muted" style="margin-bottom:10px;"></div>
      <div class="btn-row" style="margin-bottom:8px;">
        <button class="btn good" id="submitBatchBtn">📤 Submit Scanned Items <span id="submitBatchCount" class="muted"></span></button>
      </div>
      <div class="btn-row" style="margin-bottom:8px;">
        <button class="btn secondary" id="manualBtn">➕ Manual / Unscannable</button>
        <button class="btn secondary" id="undoBtn">↩ Undo Last Scan</button>
      </div>
      <div class="btn-row" style="margin-bottom:8px;">
        <button class="btn secondary" id="breakBtn">⏸ Take a Break</button>
        <button class="btn secondary" id="completeBtn">${session.isAudit ? "✅ Confirm Audit Complete" : "✅ Mark My Rack Complete"}</button>
      </div>
      <div class="btn-row" style="margin-bottom:14px;">
        <button class="btn secondary" id="concernBtn">🚩 Report a Concern (calls a manager)</button>
      </div>
      <h3>This Session — tap an item to edit or remove it</h3>
      <div id="tallyList" class="card"><div class="empty">No items scanned yet.</div></div>
    </div>
  `));
  renderConcernBanner(session);
  // Audit recounts post straight to AuditCounts, never through the batch-submit flow.
  if (session.isAudit) document.getElementById("submitBatchBtn").parentElement.style.display = "none";
  document.getElementById("concernBtn").onclick = () => renderConcernModal(session);

  document.getElementById("manualBtn").onclick = () => renderManualModal(session, brandCfg);
  document.getElementById("undoBtn").onclick = () => undoLastScan(session);
  document.getElementById("submitBatchBtn").onclick = () => renderSubmitBatchModal(session);
  document.getElementById("breakBtn").onclick = () => takeBreak(session);
  document.getElementById("completeBtn").onclick = () => session.isAudit ? renderAuditCompleteModal(session) : renderCompleteModal(session);

  renderTallyList(session);

  // Periodic "still here" ping so the Dashboard's online/active state stays
  // fresh the whole time someone is counting, not just from the one ping at
  // session start/resume. Cleared whenever this screen is torn down (break,
  // complete, navigating away) via clearHeartbeat() below.
  clearHeartbeat();
  heartbeatTimer = setInterval(() => {
    submitAction({ action: "presence", brand: session.brand, rack: session.rack, counter: session.counter, deviceId: session.deviceId, sessionId: session.sessionId, status: "active" });
  }, 3 * 60 * 1000);

  const video = document.getElementById("scanVideo");
  const msgEl = document.getElementById("scanMsg");
  const resetBtn = document.getElementById("cameraResetBtn");

  // Laptop path: a plugged-in USB/Bluetooth barcode scanner works here too,
  // independent of the camera — set up first so it works even if the camera
  // below fails or isn't present at all.
  wedgeCallback = (code) => handleScan(code, session, brandCfg, confirmMode);

  async function startCamera() {
    if (!Scanner.supported()) {
      msgEl.textContent = "📷 No live camera scanning here — a connected barcode scanner still works, or use Manual entry below.";
      return;
    }
    try {
      Scanner.stop(); // no-op if nothing was running — safe to call unconditionally, so this can't double-attach a stream
      await Scanner.start(video, (code) => handleScan(code, session, brandCfg, confirmMode));
      msgEl.textContent = "Scanning… hold a barcode steady inside the band. A connected barcode scanner also works.";
    } catch (e) {
      msgEl.textContent = "⚠️ " + e.message + " — a connected barcode scanner still works on this screen.";
    }
  }

  if (resetBtn) {
    resetBtn.onclick = async () => {
      resetBtn.disabled = true;
      msgEl.textContent = "🔄 Resetting camera…";
      await startCamera();
      resetBtn.disabled = false;
      toast("Camera reset");
    };
  }

  // Sessions started from a rack-label link (phone's own Camera app) don't
  // auto-open the camera: some phones' hand-off from the Camera app is still
  // settling at this moment and opening the camera right then can kill the
  // page. Let the counter tap to start it once the screen is stable.
  if (opts.deferCamera && Scanner.supported()) {
    msgEl.innerHTML = `<button type="button" class="btn good" id="startCamBtn">📷 Tap to start camera</button>`;
    document.getElementById("startCamBtn").onclick = () => startCamera();
    return;
  }
  await startCamera();
}

let heartbeatTimer = null;
function clearHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function flashDescription(text) {
  const d = document.getElementById("descFlash");
  if (!d) return;
  d.textContent = text;
  d.classList.add("show");
  clearTimeout(flashDescription._t);
  flashDescription._t = setTimeout(() => d.classList.remove("show"), 1600);
}

async function handleScan(gtin, session, brandCfg, confirmMode) {
  const flash = document.getElementById("scanFlash");
  if (flash) {
    flash.classList.add("on");
    setTimeout(() => flash.classList.remove("on"), 150);
  }
  const info = await DB.getByGtin(gtin);
  if (!info) {
    toast(`⚠️ ${gtin} not found in the item catalog`);
    renderManualModal(session, brandCfg, gtin);
    return;
  }
  if (!auditInSample_(session, info)) {
    toast(`⚠️ ${info.desc} is not in this audit sample — only recount the listed items.`, 4000);
    return;
  }
  if (info.brand && info.brand !== session.brand) {
    const actualBrandCfg = APP_CONFIG.brands.find((b) => b.code === info.brand);
    toast(`ℹ️ This item is ${actualBrandCfg ? actualBrandCfg.name : info.brand}, not your assigned brand (${brandCfg.name}) — logging it under its real brand.`, 4000);
  }
  if (confirmMode) {
    Scanner.stop();
    renderConfirmCard(session, brandCfg, info);
  } else {
    // For audits, show the original count/remark right in the flash — this
    // is the "checked instantly, before it even reaches the Sheet" part:
    // it's read straight from the snapshot downloaded at startAuditSession,
    // not a fresh lookup, so it's on screen the moment the beep happens.
    const originSuffix = session.isAudit
      ? (() => { const oi = originalInfoFor_(session, info); return oi ? ` — ${originalInfoLabel_(oi)}` : " — not in original count"; })()
      : "";
    flashDescription(`${info.desc} — ${info.color}/${info.size}${originSuffix}`);
    await logItem(session, info, 1, "scanned");
    renderTallyList(session);
  }
}

function renderConfirmCard(session, brandCfg, info) {
  const modal = openModal(`
    <h2>Confirm Item</h2>
    <div class="card">
      <p><b>${info.desc}</b></p>
      <p class="muted">${info.color} / ${info.size} · ${info.article}</p>
      ${session.isAudit ? (() => { const oi = originalInfoFor_(session, info); return `<p class="muted">${oi ? originalInfoLabel_(oi) : "Not in original count"}</p>`; })() : ""}
      <div class="stepper">
        <button id="qtyMinus">−</button>
        <div class="val" id="qtyVal">1</div>
        <button id="qtyPlus">+</button>
      </div>
    </div>
    <div class="btn-row">
      <button class="btn secondary" id="wrongItemBtn">Not the right item</button>
      <button class="btn good" id="confirmBtn">Confirm &amp; Submit</button>
    </div>
  `);
  let qty = 1;
  modal.querySelector("#qtyMinus").onclick = () => { qty = Math.max(1, qty - 1); modal.querySelector("#qtyVal").textContent = qty; };
  modal.querySelector("#qtyPlus").onclick = () => { qty += 1; modal.querySelector("#qtyVal").textContent = qty; };
  modal.querySelector("#wrongItemBtn").onclick = () => {
    closeModal(modal);
    renderManualModal(session, brandCfg);
  };
  modal.querySelector("#confirmBtn").onclick = onceAsync_(async () => {
    await logItem(session, info, qty, "sesm-confirmed");
    closeModal(modal);
    renderTallyList(session);
    const video = document.getElementById("scanVideo");
    if (video) Scanner.start(video, (code) => handleScan(code, session, brandCfg, true)).catch(() => {});
  });
}

// Items are logged to the LOCAL tally immediately (so the phone is always
// the source of truth for what's been scanned), but — for a normal count —
// are NOT sent to the Sheet yet. They sit as "unsubmitted" until the counter
// reviews and confirms a batch via the Submit screen (see
// renderSubmitBatchModal below). This is what lets someone scan a whole box,
// check the summary against what's actually in front of them, and only then
// commit it — instead of every single scan racing to the network unchecked.
// Audits are unaffected: a recount is compared against the original tally as
// it happens, so audit scans still go straight through.
async function logItem(session, info, qty, method) {
  if (!auditInSample_(session, info)) {
    toast("⚠️ That item is not in this audit sample — not counted.", 4000);
    return;
  }
  const entry = { gtin: info.gtin, article: info.article, desc: info.desc, color: info.color, size: info.size, brand: info.brand || session.brand, qty, method, ts: nowStamp(), scanId: uid("scan"), submitted: false, sentQty: 0 };
  session.tally.push(entry);
  session.lastItem = entry;
  // Not awaited: the scan shows on screen immediately; the phone's local save runs right behind it
  // (IndexedDB keeps writes in order, so the newest state always wins).
  saveSession(session).catch((e) => console.error("saveSession failed:", e));
  if (session.isAudit) {
    // Sent in the BACKGROUND, not awaited: the local tally already has the
    // entry (pushed above) and the on-screen "Orig: qty X" comparison is
    // read from the snapshot downloaded at startAuditSession, so there is
    // nothing left for the counter to wait on here. submitAction still does
    // its own retry + offline-queue handling; this just stops that from
    // blocking the next scan from registering while it does so.
    submitAction({
      action: "auditScan",
      brand: session.brand,
      rack: session.rack,
      auditor: session.counter,
      deviceId: session.deviceId,
      auditSessionId: session.auditSessionId,
      ...info,
      qty,
    }).catch(() => {});
    return;
  }
  // Not sent yet — it just joins the local tally as "unsubmitted" until the
  // counter reviews and confirms a batch. updateSubmitBadge (called by
  // renderTallyList right after this) reflects the new unsubmitted count.
}

/* ---------- tally model ----------
   Every line in the local tally tracks three things:
     qty     — what the counter currently wants counted for this line
     removed — true when the counter removed a line the Sheet ALREADY has
               (the removal is only STAGED — see below)
     sentQty — what has been handed to the Sheet for this line (0 = never sent)
   A line has a pending change whenever (removed ? 0 : qty) differs from
   sentQty. NOTHING — new scans, quantity edits, undos or removals — reaches
   the Sheet until the counter reviews it and confirms "Submit Scanned Items".
   After a submit, sentQty always equals what the Dashboard nets to for that
   line, which is what lets the Mark Rack Complete summary match it exactly. */
function sentQty_(t) {
  if (t.sentQty != null) return t.sentQty;
  return t.submitted ? t.qty : 0; // lines saved by an older version of the app
}
function effQty_(t) {
  return t.removed ? 0 : t.qty;
}
function pendingDelta_(t) {
  return effQty_(t) - sentQty_(t);
}
function pendingChanges_(session) {
  if (session.isAudit) return []; // audit scans go straight to AuditCounts, no batch step
  return session.tally.filter((t) => pendingDelta_(t) !== 0);
}
function refreshLastItem_(session) {
  const live = session.tally.filter((t) => !t.removed);
  session.lastItem = live.length ? live[live.length - 1] : null;
}
// Removes a line from the count. A line the Sheet has never seen just
// disappears locally. A line the Sheet already has is only MARKED removed —
// it stays visible (struck through) until the counter submits, and can still
// be restored. Returns true when the removal was staged rather than dropped.
function removeTallyEntry_(session, idx) {
  const t = session.tally[idx];
  let staged = false;
  if (sentQty_(t) === 0) {
    session.tally.splice(idx, 1);
  } else {
    t.removed = true;
    staged = true;
  }
  refreshLastItem_(session);
  return staged;
}

async function undoLastScan(session) {
  let idx = -1;
  for (let i = session.tally.length - 1; i >= 0; i--) {
    if (!session.tally[i].removed) { idx = i; break; }
  }
  if (idx < 0) {
    toast("Nothing to undo");
    return;
  }
  const staged = removeTallyEntry_(session, idx);
  await saveSession(session);
  renderTallyList(session);
  toast(staged ? "Last scan removed — tap Submit Scanned Items to update the Sheet" : "Last scan undone", staged ? 3500 : 2400);
}

function updateSubmitBadge(session) {
  const badge = document.getElementById("submitBatchCount");
  if (!badge) return;
  const n = pendingChanges_(session).length;
  badge.textContent = n > 0 ? `(${n} to send)` : "";
}

function tallyTag_(session, t) {
  if (session.isAudit) {
    const info = originalInfoFor_(session, t);
    if (!info) return ' · <span class="muted">not in original count</span>';
    const match = info.qty === t.qty;
    return ` · <span style="color:${match ? "var(--good)" : "var(--warn)"};">${originalInfoLabel_(info)}</span>`;
  }
  const sent = sentQty_(t);
  if (t.removed && t.removedSent) return ' · <span style="color:var(--bad);">deleted · removed from the Sheet</span>';
  if (t.removed) return ' · <span style="color:var(--bad);">removal not sent yet</span>';
  if (sent === 0) return ' · <span style="color:var(--warn);">not sent yet</span>';
  if (t.qty !== sent) return ` · <span style="color:var(--warn);">change not sent yet (Sheet has ${sent})</span>`;
  return "";
}

function tallyRowHtml_(session, t, index) {
  return `
      <div class="tally-row" data-idx="${index}" style="cursor:pointer;">
        <div class="info"><b${t.removed ? ' style="text-decoration:line-through; opacity:.6;"' : ""}>${esc_(t.desc)}</b><span>${esc_(t.color)}/${esc_(t.size)} · ${esc_(t.article)}${tallyTag_(session, t)}</span></div>
        <div class="qty-badge"${t.removed ? ' style="background:var(--bad); color:#fff;"' : ""}>${t.removed ? "−" + sentQty_(t) : t.qty}</div>
      </div>`;
}

function batchSummaryLabel_(b, deletedSince = 0) {
  const time = new Date(b.submittedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  // Net quantity sent in this submission — the same number the confirm screen
  // showed and the Sheet received (adds + quantity changes − removals).
  const n = b.net != null ? b.net : b.count;
  const count = `${n} item${n === 1 ? "" : "s"}`;
  const del = deletedSince > 0 ? ` · <span style="color:var(--bad);">🗑 ${deletedSince} deleted since</span>` : "";
  return (b.remark ? `${esc_(b.remark)} · ${count} · ${time}` : `${count} · ${time}`) + del;
}

// An "Earlier submissions" block, shown as a ledger of what that submission
// SENT (so its rows always add up to its item count), with anything deleted or
// changed afterwards clearly marked instead of silently vanishing.
function findLineByScanId_(session, scanId) {
  return session.tally.find((t) => t.scanId === scanId || (t.priorScanIds || []).indexOf(scanId) !== -1);
}
function batchBlockHtml_(session, b) {
  if (!b.items) { // submitted by an older version of the app — no ledger was kept
    const items = session.tally.filter((t) => t.batchId === b.id && !t.removed && pendingDelta_(t) === 0);
    if (!items.length) return "";
    return `<details class="batch-block"><summary>${batchSummaryLabel_(b)}</summary>${items.map((t) => tallyRowHtml_(session, t, session.tally.indexOf(t))).join("")}</details>`;
  }
  let deletedSince = 0;
  const rows = b.items.map((x) => {
    const info = `${esc_(x.color)}/${esc_(x.size)} · ${esc_(x.article)}`;
    if (x.kind === "remove") {
      return `<div class="tally-row"><div class="info"><b style="text-decoration:line-through; opacity:.6;">${esc_(x.desc)}</b><span>${info} · <span style="color:var(--bad);">removed from the Sheet</span></span></div><div class="qty-badge" style="background:var(--bad); color:#fff;">${x.qty}</div></div>`;
    }
    if (x.kind === "edit") {
      return `<div class="tally-row"><div class="info"><b>${esc_(x.desc)}</b><span>${info} · <span style="color:var(--warn);">quantity change</span></span></div><div class="qty-badge" style="background:var(--warn-bg); color:var(--warn);">${x.qty > 0 ? "+" : ""}${x.qty}</div></div>`;
    }
    const line = findLineByScanId_(session, x.scanId);
    const idx = line ? session.tally.indexOf(line) : -1;
    const gone = !line || (line.removed && line.removedSent);
    if (gone) deletedSince++;
    let tag = "", nameStyle = "", badgeStyle = "";
    if (gone) {
      tag = ' · <span style="color:var(--bad);">🗑 deleted after this submission</span>';
      nameStyle = ' style="text-decoration:line-through; opacity:.6;"';
      badgeStyle = ' style="background:var(--bad); color:#fff; text-decoration:line-through;"';
    } else if (line && line.removed) {
      tag = ' · <span style="color:var(--bad);">removal not sent yet</span>';
    } else if (line && line.scanId !== x.scanId) {
      tag = ' · <span style="color:var(--warn);">deleted, then re-added</span>';
    } else if (line && effQty_(line) !== x.qty && sentQty_(line) !== x.qty) {
      tag = ` · <span style="color:var(--warn);">now ${effQty_(line)}</span>`;
    }
    const attr = idx >= 0 ? ` data-idx="${idx}" style="cursor:pointer;"` : "";
    return `<div class="tally-row"${attr}><div class="info"><b${nameStyle}>${esc_(x.desc)}</b><span>${info}${tag}</span></div><div class="qty-badge"${badgeStyle}>${x.qty}</div></div>`;
  }).join("");
  return `<details class="batch-block"><summary>${batchSummaryLabel_(b, deletedSince)}</summary>${rows}</details>`;
}

function renderTallyList(session) {
  const wrap = document.getElementById("tallyList");
  updateSubmitBadge(session);
  if (!wrap) return;

  // Audit recounts never go through the submit-batch flow (each scan posts
  // immediately, see logItem) and have no notion of "pending"/"batches" —
  // just show the plain running tally, same as always.
  if (session.isAudit) {
    const checklist = auditSampleChecklistHtml_(session);
    if (session.tally.length === 0) {
      wrap.innerHTML = checklist + `<div class="empty">No items scanned yet.</div>`;
      return;
    }
    const reversed = session.tally.slice().reverse().slice(0, 30);
    wrap.innerHTML = checklist + reversed.map((t, i) => tallyRowHtml_(session, t, session.tally.length - 1 - i)).join("");
    wrap.querySelectorAll(".tally-row").forEach((row) => {
      row.onclick = () => editTallyItem(session, parseInt(row.dataset.idx, 10));
    });
    return;
  }

  if (session.tally.length === 0 && session.batches.length === 0) {
    wrap.innerHTML = `<div class="empty">No items scanned yet.</div>`;
    return;
  }

  // "Not yet submitted" — anything with a pending change, newest first. This
  // is deliberately NOT capped/truncated the way past batches are collapsed
  // below, since this is exactly what the counter needs to review before
  // hitting Submit.
  const pending = pendingChanges_(session).slice().reverse();
  const pendingHtml = pending.length
    ? `<div class="tally-section-label">🟡 Not yet submitted (${pending.length})</div>` +
      pending.map((t) => tallyRowHtml_(session, t, session.tally.indexOf(t))).join("")
    : "";

  // Past submissions — one collapsed block per confirmed batch, newest
  // first, each showing its remark/time/count and expandable to the actual
  // items. Items are looked up by batchId at render time rather than stored
  // per-batch, so an item that's later edited/removed correctly disappears
  // from its old batch's contents and reappears under "not yet submitted"
  // (then under whichever new batch it's next submitted in).
  const historyHtml = session.batches.length
    ? `<div class="tally-section-label" style="margin-top:${pending.length ? "14px" : "0"};">Earlier submissions</div>` +
      session.batches.map((b) => batchBlockHtml_(session, b)).join("")
    : "";

  wrap.innerHTML = pendingHtml + historyHtml || `<div class="empty">No items scanned yet.</div>`;
  wrap.querySelectorAll(".tally-row").forEach((row) => {
    if (row.dataset.idx === undefined) return; // ledger-only rows (removals, quantity changes) aren't editable
    row.onclick = () => editTallyItem(session, parseInt(row.dataset.idx, 10));
  });
}

// Tap-to-edit any item in "This Session". Editing or removing a line the
// Sheet already has is STAGED locally — the correcting row is only sent when
// the counter confirms it on the Submit Scanned Items screen, together with
// any new scans. (A line never sent is simply edited/removed on the phone.)
async function editTallyItem(session, index) {
  const item = session.tally[index];
  if (!item) return;

  if (item.removed) {
    const rm = openModal(`
      <h2>Removed Item</h2>
      <div class="card">
        <p><b>${esc_(item.desc)}</b></p>
        <p class="muted">${esc_(item.color)} / ${esc_(item.size)} · ${esc_(item.article)}</p>
        <p class="muted" style="color:var(--bad);">${item.removedSent ? "Deleted — this removal has already been sent to the Sheet. You can still restore it; it will be sent again as a new scan." : `Marked for removal (the Sheet currently has ${sentQty_(item)}). It stays on the Sheet until you tap <b>Submit Scanned Items</b>.`}</p>
        <button class="btn good" id="eRestoreBtn" style="margin-top:10px;">↩ Restore This Item</button>
        <button class="btn secondary" id="eCancelBtn">Close</button>
      </div>
    `);
    rm.querySelector("#eCancelBtn").onclick = () => closeModal(rm);
    rm.querySelector("#eRestoreBtn").onclick = onceAsync_(async () => {
      if (item.removedSent) {
        // The Sheet already has this line's removal, so bringing it back is a
        // brand-new row. It needs a fresh scanId — the old one is already on
        // the Sheet and the server would (rightly) ignore it as a duplicate.
        item.priorScanIds = (item.priorScanIds || []).concat(item.scanId);
        item.scanId = uid("scan");
        item.removedSent = false;
        item.sentQty = 0;
        item.submitted = false;
      }
      item.removed = false;
      refreshLastItem_(session);
      await saveSession(session);
      closeModal(rm);
      renderTallyList(session);
      toast("Item restored");
    });
    return;
  }

  let qty = item.qty;
  const alreadyOnSheet = !session.isAudit && sentQty_(item) > 0;
  const modal = openModal(`
    <h2>Edit Item</h2>
    <div class="card">
      <p><b>${esc_(item.desc)}</b></p>
      <p class="muted">${esc_(item.color)} / ${esc_(item.size)} · ${esc_(item.article)}${tallyTag_(session, item)}</p>
      <div class="stepper"><button id="eQtyMinus">−</button><div class="val" id="eQtyVal">${qty}</div><button id="eQtyPlus">+</button></div>
      ${alreadyOnSheet ? `<p class="muted" style="text-align:center;">This item is already on the Sheet — changes and removals are only sent when you tap <b>Submit Scanned Items</b>.</p>` : ""}
      <button class="btn good" id="eSaveBtn" style="margin-top:14px;">Save</button>
      <button class="btn danger" id="eRemoveBtn">Remove This Item</button>
      <button class="btn secondary" id="eCancelBtn">Cancel</button>
    </div>
  `);
  const qtyEl = modal.querySelector("#eQtyVal");
  modal.querySelector("#eQtyMinus").onclick = () => { if (qty > 1) { qty--; qtyEl.textContent = qty; } };
  modal.querySelector("#eQtyPlus").onclick = () => { qty++; qtyEl.textContent = qty; };
  modal.querySelector("#eCancelBtn").onclick = () => closeModal(modal);
  modal.querySelector("#eRemoveBtn").onclick = onceAsync_(async () => {
    const staged = removeTallyEntry_(session, index);
    await saveSession(session);
    closeModal(modal);
    renderTallyList(session);
    toast(staged ? "🗑 Removal staged — tap Submit Scanned Items to update the Sheet" : "Item removed", staged ? 3500 : 2400);
  });
  modal.querySelector("#eSaveBtn").onclick = onceAsync_(async () => {
    const changed = qty !== item.qty;
    if (changed) {
      item.qty = qty;
      await saveSession(session);
    }
    closeModal(modal);
    renderTallyList(session);
    toast(!changed ? "No change" : alreadyOnSheet ? "Change staged — tap Submit Scanned Items to update the Sheet" : "Quantity updated", changed && alreadyOnSheet ? 3500 : 2400);
  });
}

/* ================= SUBMIT A BATCH (review before it hits the Sheet) =================
   The counter scans as many items as they like — and may also remove or
   adjust items already on the Sheet — and NOTHING reaches the Sheet yet.
   "Submit Scanned Items" shows exactly what is about to be sent (new scans,
   removals and quantity changes, each labelled) so it can be checked against
   what's physically in front of them before it's committed. Once confirmed,
   it's handed to the network in the background — the counter does NOT wait;
   they can keep scanning immediately. Removals/edits go as correcting rows
   (negative/positive Qty) so the original scan stays on record for audit and
   the Sheet's running total nets out to exactly the counter's tally. */
let submitModalOpen_ = false;
function renderSubmitBatchModal(session) {
  // A double-tap on "Submit Scanned Items" used to open two of these sheets,
  // and confirming both sent the same removals/edits twice.
  if (submitModalOpen_) return;
  let changes = pendingChanges_(session);
  if (changes.length === 0) {
    toast("Nothing new to submit — the Sheet is already up to date.");
    return;
  }
  submitModalOpen_ = true;
  // New scans are grouped just for a readable summary — each underlying scan
  // is still sent as its own row. Removals and edits are listed one by one.
  const addGroups = {};
  const otherRows = [];
  let addScans = 0, removals = 0, edits = 0;
  changes.forEach((t) => {
    const delta = pendingDelta_(t);
    if (sentQty_(t) === 0) {
      const key = [t.gtin, t.article, t.color, t.size].join("|");
      if (!addGroups[key]) addGroups[key] = { desc: t.desc, color: t.color, size: t.size, article: t.article, qty: 0, scans: 0 };
      addGroups[key].qty += delta;
      addGroups[key].scans += 1;
      addScans++;
    } else if (t.removed) {
      otherRows.push({ kind: "remove", t, delta });
      removals++;
    } else {
      otherRows.push({ kind: "edit", t, delta });
      edits++;
    }
  });
  const netChange = changes.reduce((s, t) => s + pendingDelta_(t), 0);
  const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n);
  const parts = [];
  if (addScans) parts.push(`${addScans} new scan(s)`);
  if (removals) parts.push(`${removals} removal(s)`);
  if (edits) parts.push(`${edits} quantity change(s)`);

  wedgeCallback = null;
  Scanner.stop();
  const brandCfg = APP_CONFIG.brands.find((b) => b.code === session.brand);
  const confirmMode = !!brandCfg.confirmMode;
  const resumeScanning = () => {
    wedgeCallback = (code) => handleScan(code, session, brandCfg, confirmMode);
    const video = document.getElementById("scanVideo");
    if (video) Scanner.start(video, (code) => handleScan(code, session, brandCfg, confirmMode)).catch(() => {});
  };
  // onClose fires no matter how the sheet is dismissed — the "Keep Scanning"
  // button, tapping outside, the back button, or a swipe-down — so scanning
  // can never get left paused just because it wasn't closed via the button.
  const rowHtml = (label, r, badge, badgeStyle) => `
        <div class="tally-row">
          <div class="info"><b>${esc_(r.desc)}</b><span>${esc_(r.color)}/${esc_(r.size)} · ${esc_(r.article)}${label}</span></div>
          <div class="qty-badge"${badgeStyle ? ` style="${badgeStyle}"` : ""}>${badge}</div>
        </div>`;
  const modal = openModal(`
    <h2>Confirm This Batch</h2>
    <p class="muted">Check this against what's actually in front of you before sending.</p>
    <div class="card" style="max-height:40vh; overflow-y:auto;">
      ${Object.values(addGroups).map((r) => rowHtml(r.scans > 1 ? ` · ${r.scans} scans` : "", r, r.qty)).join("")}
      ${otherRows.map((o) => o.kind === "remove"
        ? rowHtml(' · <span style="color:var(--bad);">REMOVE from Sheet</span>', o.t, signed(o.delta), "background:var(--bad); color:#fff;")
        : rowHtml(` · <span style="color:var(--warn);">quantity ${sentQty_(o.t)} → ${o.t.qty}</span>`, o.t, signed(o.delta), "background:var(--warn-bg); color:var(--warn);")
      ).join("")}
    </div>
    <div class="card" style="text-align:center;">
      <div class="muted">Net change to the Sheet</div>
      <div style="font-size:28px; font-weight:800;">${signed(netChange)} item(s)</div>
      <div class="muted">${parts.join(" · ")}</div>
    </div>
    <div class="field">
      <label>Remarks <span class="muted">(required — box #, notes, etc.)</span></label>
      <input type="text" id="sbRemark" placeholder="e.g. Box 4 of 6" maxlength="200">
    </div>
    <div class="btn-row">
      <button class="btn secondary" id="sbCancel">⬅ Keep Scanning</button>
      <button class="btn good" id="sbConfirm">✅ Confirm &amp; Send</button>
    </div>
  `, { onClose: () => { submitModalOpen_ = false; resumeScanning(); } });
  modal.querySelector("#sbCancel").onclick = () => closeModal(modal);
  modal.querySelector("#sbConfirm").onclick = onceAsync_(async () => {
    // Re-read what is REALLY still unsent right now, not what it was when the
    // sheet opened — protects against sending anything twice.
    changes = pendingChanges_(session);
    if (changes.length === 0) { closeModal(modal); return; }
    const remark = (modal.querySelector("#sbRemark").value || "").trim();
    if (!remark) { toast("Remarks are required — enter a box # or note", 3000); modal.querySelector("#sbRemark").focus(); return; }
    const batchId = uid("batch");
    // Build the rows to send, then mark everything as handed off and let the
    // counter go — the network part runs in the background, not awaited here.
    const payloads = changes.map((t) => {
      const delta = pendingDelta_(t);
      const base = {
        action: "scan",
        brand: t.brand || session.brand,
        rackBrand: session.brand,
        rack: session.rack,
        counter: session.counter,
        deviceId: session.deviceId,
        sessionId: session.sessionId,
        gtin: t.gtin, article: t.article, desc: t.desc, color: t.color, size: t.size,
        qty: delta,
        // Sent through so it lands on the Sheet, not just kept in this
        // phone's local batch history — this is what lets an auditor later
        // see where/how an item was originally counted (see the audit
        // prefetch in startAuditSession).
        remark: remark,
      };
      if (sentQty_(t) === 0) {
        // a brand-new scan: keeps its own scanId + ORIGINAL scan time (matters for the count-window check)
        return { ...base, method: t.method, scanId: t.scanId, ts: t.ts };
      }
      // a correction to a line the Sheet already has: its own row, original stays on record
      return { ...base, method: t.removed ? "removed" : "edited", scanId: uid("scan"), ts: nowStamp() };
    });
    // FIREBASE FIRST: the Dashboard gets every row right now, before the phone saves anything
    // locally and long before the Apps Script / Sheet write.
    pushLiveScans(payloads);
    // Ledger of exactly what this submission sends, so the block under
    // "Earlier submissions" always adds up to its item count and can show
    // what was later deleted.
    const ledger = changes.map((t, i) => {
      const pl = payloads[i];
      const kind = pl.method === "removed" ? "remove" : pl.method === "edited" ? "edit" : "add";
      return { kind, scanId: kind === "add" ? t.scanId : pl.scanId, desc: t.desc, color: t.color, size: t.size, article: t.article, qty: pl.qty };
    });
    const net = ledger.reduce((sum, x) => sum + x.qty, 0);
    let keptCount = 0;
    changes.forEach((t) => {
      if (t.removed) {
        // Removal is on its way: keep the line (struck through in the earlier
        // submission it came from) instead of erasing it. sentQty 0 = the
        // Sheet nets this line to zero, so it is no longer a pending change.
        t.sentQty = 0; t.removedSent = true;
      } else { t.sentQty = t.qty; t.submitted = true; t.batchId = batchId; keptCount++; }
    });
    // One collapsed entry per confirmed batch, newest shown first — this is
    // what lets a counter glance back at "what was in the last few boxes"
    // without the running list growing unbounded on screen.
    session.batches.unshift({ id: batchId, remark, submittedAt: nowStamp(), count: keptCount, net, items: ledger });
    refreshLastItem_(session);
    await saveSession(session);
    closeModal(modal); // triggers onClose above, which resumes scanning
    renderTallyList(session);
    toast(`📤 Sending ${payloads.length} row(s)… you can keep scanning`, 2500);
    submitBatchInBackground_(session, payloads);
  });
}

// How many background batch sends are still in flight — Mark Rack Complete
// waits for these before it compares against the Dashboard.
let inflightSends_ = 0;

async function submitBatchInBackground_(session, payloads) {
  inflightSends_++;
  let pendingCount = 0;
  let queuedCount = 0;
  let failed = 0;
  try {
    // The whole submission goes to the server as one request (in chunks of a
    // few dozen rows if it is very large) — see submitScanBatch_ above.
    const r = await submitScanBatch_(payloads);
    pendingCount = r.pending;
    queuedCount = r.queued;
  } catch (e) {
    failed++;
  } finally {
    inflightSends_--;
  }
  if (pendingCount > 0) {
    toast(`⏱ ${pendingCount} row(s) in that batch were outside the count window — they need manager approval.`, 4000);
  } else if (queuedCount > 0) {
    toast(`📶 ${queuedCount} row(s) saved offline — they'll sync automatically once you're back online.`, 3500);
  } else if (failed === 0) {
    toast(`✅ Batch sent`, 2000);
  }
  renderTallyList(session); // no-op if this screen isn't showing anymore
}

/* ================= REPORT A CONCERN ================= */
// Calls a manager's attention on the Dashboard right away, without blocking
// counting — the counter keeps scanning normally underneath the banner.
const CONCERN_REASONS = ["Unscannable item", "Missing/torn rack label", "Wrong/mismatched items on rack", "Damaged goods", "Other"];

function renderConcernModal(session) {
  const modal = openModal(`
    <h2>🚩 Report a Concern</h2>
    <p class="muted">This alerts managers on the Dashboard right away. You can keep scanning — this doesn't stop your count.</p>
    <div class="field"><label>What's the issue?</label>
      <select id="concernReason">${CONCERN_REASONS.map((r) => `<option value="${r}">${r}</option>`).join("")}</select>
    </div>
    <div class="field"><label>Details (optional)</label><textarea id="concernNote" rows="3" placeholder="Anything that'll help a manager understand..."></textarea></div>
    <button class="btn good" id="concernSubmitBtn">Send to Managers</button>
    <button class="btn secondary" id="concernCancelBtn">Cancel</button>
  `);
  modal.querySelector("#concernCancelBtn").onclick = () => closeModal(modal);
  modal.querySelector("#concernSubmitBtn").onclick = async () => {
    const reason = modal.querySelector("#concernReason").value;
    const note = modal.querySelector("#concernNote").value.trim();
    const concernId = uid("concern");
    session.openConcern = { concernId, reason, note, ts: Date.now() };
    // Managers see it the instant it's sent; the Sheet copy follows in the background.
    pushLive(`concern/${liveKey(concernId)}`, { brand: session.brand, rack: session.rack, counter: session.counter, reason, note, ts: Date.now(), status: "open" });
    closeModal(modal);
    toast("🚩 Managers have been notified");
    renderConcernBanner(session);
    saveSession(session).catch(() => {});
    submitAction({ action: "concern", brand: session.brand, rack: session.rack, counter: session.counter, deviceId: session.deviceId, sessionId: session.sessionId, concernId, reason, note }).catch(() => {});
  };
}

function renderConcernBanner(session) {
  const host = document.getElementById("concernBannerHost");
  if (!host) return;
  if (!session.openConcern) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `
    <div class="card" style="border-color:var(--warn,#c0392b); background:rgba(192,57,43,0.08); display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px;">
      <div><b>🚩 ${session.openConcern.reason}</b><div class="muted" style="font-size:12px;">Managers notified — you can keep counting.</div></div>
      <button class="btn secondary" id="dismissConcernBtn" style="width:auto; padding:8px 12px;">✕</button>
    </div>`;
  document.getElementById("dismissConcernBtn").onclick = async () => {
    session.openConcern = null;
    await saveSession(session);
    host.innerHTML = "";
    stopWatchingConcern();
  };
  watchConcernResolution(session);
}

// While a concern is open, the counter's banner must disappear the moment a
// manager resolves it. Three independent signals feed the same "clear it"
// path, so one of them failing (phone locked, tab backgrounded, Firebase
// stream silently dropped — all common on mobile) can no longer leave a
// stale banner sitting there:
//   1) Firebase live stream (instant)
//   2) Firebase node re-check every 10s + whenever the app comes back to the
//      foreground / regains signal (cheap, catches a dead stream)
//   3) Google Sheets record every 30s (the authoritative copy, catches a
//      Firebase write that never landed)
let concernWatcherES = null;
let concernPollTimer = null;
let concernSheetsTick = 0;
let concernSheetsSupported = true;
let watchedConcernSession = null;

function stopWatchingConcern() {
  if (concernWatcherES) {
    concernWatcherES.close();
    concernWatcherES = null;
  }
  if (concernPollTimer) {
    clearInterval(concernPollTimer);
    concernPollTimer = null;
  }
  watchedConcernSession = null;
}

function clearResolvedConcern(session, resolvedBy) {
  if (!session.openConcern) return;
  toast(`✅ Concern resolved by ${resolvedBy || "a manager"}`);
  session.openConcern = null;
  saveSession(session);
  stopWatchingConcern();
  renderConcernBanner(session);
}

async function checkConcernNow(session, includeSheets) {
  const open = session.openConcern;
  if (!open || !navigator.onLine) return;
  const id = open.concernId;
  const stillThis = () => session.openConcern && session.openConcern.concernId === id;

  if (APP_CONFIG.firebaseUrl) {
    try {
      const res = await fetch(`${APP_CONFIG.firebaseUrl.replace(/\/$/, "")}/live/concern/${liveKey(id)}.json?_t=${Date.now()}`, { cache: "no-store" });
      const data = await res.json();
      if (stillThis() && data && data.status === "resolved") return clearResolvedConcern(session, data.resolvedBy);
    } catch (e) { /* offline/blip — next tick retries */ }
  }

  if (includeSheets && concernSheetsSupported && APP_CONFIG.submitUrl) {
    try {
      const u = new URL(APP_CONFIG.submitUrl);
      u.searchParams.set("concernId", id);
      u.searchParams.set("_t", Date.now());
      const res = await fetch(u.toString(), { cache: "no-store" });
      const data = await res.json();
      if (!data || !data.ok) return;
      if (data.concern !== undefined) {
        // updated Apps Script: lightweight single-concern answer
        if (stillThis() && data.concern && data.concern.status === "resolved") clearResolvedConcern(session, data.concern.resolvedBy);
      } else if (Array.isArray(data.concerns)) {
        // older Apps Script returns the whole snapshot; too heavy to keep polling
        // every 30s from every phone, so use it this once and stop.
        concernSheetsSupported = false;
        const row = data.concerns.find((r) => r.ConcernID === id);
        if (stillThis() && row && row.Status === "resolved") clearResolvedConcern(session, row.ResolvedBy);
      }
    } catch (e) { /* next tick retries */ }
  }
}

function watchConcernResolution(session) {
  stopWatchingConcern();
  if (!session.openConcern) return;
  watchedConcernSession = session;

  if (APP_CONFIG.firebaseUrl) {
    const id = liveKey(session.openConcern.concernId);
    const url = `${APP_CONFIG.firebaseUrl.replace(/\/$/, "")}/live/concern/${id}.json`;
    const es = new EventSource(url);
    const handle = (raw) => {
      try {
        const { path, data } = JSON.parse(raw);
        const resolved = path === "/status" ? data === "resolved" : !!(data && data.status === "resolved");
        if (resolved) clearResolvedConcern(session, data && data.resolvedBy);
      } catch (e) { /* malformed/keep-alive frame, ignore */ }
    };
    es.addEventListener("put", (e) => handle(e.data));
    es.addEventListener("patch", (e) => handle(e.data));
    es.onerror = () => { if (es.readyState === 2) { try { es.close(); } catch (e) {} setTimeout(() => { if (watchedConcernSession === session && concernWatcherES === es) watchConcernResolution(session); }, 1000); } };
    concernWatcherES = es;
  }

  // Safety net if the live stream silently died (phones do that on weak signal / screen off):
  // a tiny Firebase check every 3s (a few bytes) and the Sheet only every ~30s.
  concernSheetsTick = 0;
  concernPollTimer = setInterval(() => {
    concernSheetsTick++;
    checkConcernNow(session, concernSheetsTick % 10 === 0);
  }, 3000);
  checkConcernNow(session, true);
}

// Phone was locked / app backgrounded / signal came back: the live stream may
// have died silently, so check right now instead of waiting for the next tick.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && watchedConcernSession) checkConcernNow(watchedConcernSession, true);
});
window.addEventListener("online", () => {
  if (watchedConcernSession) checkConcernNow(watchedConcernSession, true);
});

/* ================= MANUAL / UNSCANNABLE ================= */
// Only one Manual / Unscannable window at a time (a barcode that wasn't found
// used to be able to stack several of them while it stayed in front of the camera).
let manualModalOpen_ = false;

function renderManualModal(session, brandCfg, prefill = "") {
  if (manualModalOpen_) return;
  manualModalOpen_ = true;
  // The camera (and a connected barcode scanner) stop scanning the moment this
  // window opens, so nothing can be scanned behind it and the camera isn't
  // running while the counter types.
  wedgeCallback = null;
  Scanner.stop();
  const scanMsgEl = document.getElementById("scanMsg");
  if (scanMsgEl) scanMsgEl.textContent = "⏸ Scanning paused while manual entry is open.";
  const confirmMode_ = !!(brandCfg && brandCfg.confirmMode);
  // onClose fires however the window is dismissed — Add to Count, the ✕, tapping
  // outside, the back button, or a swipe-down — so scanning can never get left
  // stopped just because it wasn't closed via one particular button.
  const resumeAfterManual_ = () => {
    manualModalOpen_ = false;
    if (modalStack.length > 0) return;              // another window is still open on top — it manages scanning
    const video = document.getElementById("scanVideo");
    if (!video) return;                             // the scan screen isn't showing anymore
    wedgeCallback = (code) => handleScan(code, session, brandCfg, confirmMode_);
    if (!Scanner.supported()) return;
    Scanner.stop();
    Scanner.start(video, (code) => handleScan(code, session, brandCfg, confirmMode_))
      .then(() => { const m = document.getElementById("scanMsg"); if (m) m.textContent = "Scanning… hold a barcode steady inside the band. A connected barcode scanner also works."; })
      .catch((e) => { const m = document.getElementById("scanMsg"); if (m) m.textContent = "⚠️ " + e.message + " — a connected barcode scanner still works on this screen."; });
  };
  const modal = openModal(`
    <h2>Manual / Unscannable Entry</h2>
    <div class="field"><label>Search catalog (GTIN, article, description)</label><input id="mSearch" value="${prefill}" placeholder="Type to search…"></div>
    <div id="mResults"></div>
    <div class="divider"></div>
    <p class="muted">Can't find it at all? Log it as unidentified instead:</p>
    <div class="field"><label>Description (whatever you can tell — box label, etc.)</label><input id="mFreeDesc" placeholder="e.g. torn barcode, box says Gel-Kayano size 9"></div>
    <div class="field"><label>Quantity</label><input id="mQty" type="number" value="1" min="1"></div>
    <button class="btn good" id="mSubmitBtn">Add to Count</button>
  `, { onClose: resumeAfterManual_ });
  let selected = null;
  const searchInput = modal.querySelector("#mSearch");
  const resultsEl = modal.querySelector("#mResults");
  let token = 0;

  async function doSearch() {
    const q = searchInput.value;
    if (!q || q.length < 2) {
      resultsEl.innerHTML = "";
      return;
    }
    const myToken = ++token;
    resultsEl.innerHTML = `<div class="muted">Searching…</div>`;
    const results = await DB.searchCatalog(q, 15);
    if (myToken !== token) return;
    resultsEl.innerHTML = "";
    if (results.length === 0) {
      resultsEl.innerHTML = `<div class="muted">No catalog matches — use the unidentified fields below instead.</div>`;
      return;
    }
    results.forEach((r) => {
      const originSuffix = session.isAudit
        ? (() => { const oi = originalInfoFor_(session, r); return ` <span class="muted">· ${oi ? originalInfoLabel_(oi) : "not in original count"}</span>`; })()
        : "";
      const row = el(`<div class="pill" style="display:block; margin-bottom:6px; width:100%;"><b>${r.desc}</b> — ${r.color}/${r.size} <span class="muted">(${r.article})</span>${originSuffix}</div>`);
      row.onclick = () => {
        selected = r;
        resultsEl.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
        row.classList.add("active");
      };
      resultsEl.appendChild(row);
    });
  }
  searchInput.addEventListener("input", () => {
    clearTimeout(searchInput._debounce);
    searchInput._debounce = setTimeout(doSearch, 150);
  });
  if (prefill) doSearch();

  modal.querySelector("#mSubmitBtn").onclick = onceAsync_(async () => {
    const qty = parseInt(modal.querySelector("#mQty").value) || 1;
    const freeDesc = modal.querySelector("#mFreeDesc").value.trim();
    if (!selected && !freeDesc) {
      toast("Pick a catalog match or describe the item");
      return;
    }
    const info = selected || { gtin: "UNKNOWN", article: "UNKNOWN", desc: freeDesc, color: "", size: "" };
    await logItem(session, info, qty, "manual");
    closeModal(modal);
    renderTallyList(session);
    if (info.brand && info.brand !== session.brand) {
      const actualBrandCfg = APP_CONFIG.brands.find((b) => b.code === info.brand);
      toast(`ℹ️ Added — this item is ${actualBrandCfg ? actualBrandCfg.name : info.brand}, not your assigned brand (${brandCfg.name}).`, 4000);
    } else {
      toast("Added to count");
    }
  });
}

/* ================= BREAK / RESUME ================= */
async function takeBreak(session) {
  Scanner.stop();
  clearHeartbeat();
  wedgeCallback = null;
  stopWatchingConcern();
  session.onBreak = true;
  await saveSession(session);
  submitAction({ action: "presence", brand: session.brand, rack: session.rack, counter: session.counter, deviceId: session.deviceId, sessionId: session.sessionId, status: "break" }).catch(() => {});
  renderResumePrompt(session);
}

/* ================= MARK RACK COMPLETE ================= */
function esc_(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
const sleep_ = (ms) => new Promise((r) => setTimeout(r, ms));

// One normalized key for "the same item", used on BOTH sides of the check.
// Google Sheets turns text like "002" into the number 2 when a row is
// appended, so leading zeros / case are ignored — otherwise the phone's
// "002" and the Sheet's 2 would look like two different items.
function normKeyPart_(v) {
  const s = String(v == null ? "" : v).trim();
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, "") : s.toUpperCase();
}
function itemKey_(t) {
  return [t.gtin, t.article, t.color, t.size].map(normKeyPart_).join("␟");
}

// The counter's own tally, netted per item exactly the way the Dashboard nets
// a rack's item list (same GTIN/Article/Color/Size key, net of corrections,
// zero-net lines hidden) — so the two can be compared line by line.
function summarizeTally_(session) {
  const byItem = {};
  let scans = 0;
  session.tally.forEach((t) => {
    const q = sentQty_(t);
    if (!q) return;
    scans++;
    const k = itemKey_(t);
    const g = byItem[k] || (byItem[k] = { key: k, desc: t.desc, article: t.article, color: t.color, size: t.size, qty: 0, scans: 0 });
    g.qty += q;
    g.scans += 1;
  });
  const rows = Object.values(byItem).filter((g) => g.qty !== 0).sort((a, b) => String(a.desc || "").localeCompare(String(b.desc || "")));
  const map = {};
  rows.forEach((g) => { map[g.key] = g; });
  return { rows, map, totalQty: rows.reduce((s, g) => s + g.qty, 0), scans };
}

// Reads the same live snapshot the Dashboard reads and totals THIS counter
// session the way the Dashboard does (scans still "pending" or "rejected" are
// not counted; duplicate ScanIDs count once). Returns
//   { state: "match" | "mismatch" | "unverified", ... }
async function verifyAgainstDashboard_(session, local) {
  // let any batch that's still on its way finish landing first
  for (let i = 0; i < 100 && inflightSends_ > 0; i++) await sleep_(300);
  if (!navigator.onLine || !APP_CONFIG.submitUrl) return { state: "unverified", msg: "You're offline — can't check the Dashboard right now." };
  await flushQueue();
  const waiting = (await DB.getQueue()).length;
  if (waiting > 0) return { state: "unverified", msg: `${waiting} item(s) are still waiting to sync — give them a moment, then recheck.` };

  let data;
  try {
    const u = new URL(APP_CONFIG.submitUrl);
    u.searchParams.set("_t", Date.now());
    // Only this session's rows are needed for the check; an older script just ignores these and sends everything.
    u.searchParams.set("only", "counts");
    u.searchParams.set("sessionId", session.sessionId);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    const res = await fetch(u.toString(), { cache: "no-store", signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error("HTTP " + res.status);
    data = await res.json();
    if (!data.ok) throw new Error(data.error || "endpoint error");
  } catch (e) {
    return { state: "unverified", msg: "Couldn't read the Dashboard data (" + e.message + ")." };
  }

  const seen = new Set();
  const server = {};
  let serverTotal = 0, heldBack = 0;
  (data.counts || []).forEach((r) => {
    if (r.ScanID) {
      const id = String(r.ScanID);
      if (seen.has(id)) return;
      seen.add(id);
    }
    if (r.SessionID !== session.sessionId) return;
    const q = parseFloat(r.Qty) || 0;
    if (r.Status === "rejected") return;
    if (r.Status === "pending") { heldBack += q; return; }
    const k = itemKey_({ gtin: r.GTIN, article: r.Article, color: r.Color, size: r.Size });
    const g = server[k] || (server[k] = { desc: r.Description, article: r.Article, color: r.Color, size: r.Size, qty: 0 });
    g.qty += q;
    serverTotal += q;
  });

  const diffs = [];
  new Set([...Object.keys(local.map), ...Object.keys(server)]).forEach((k) => {
    const mine = local.map[k] ? local.map[k].qty : 0;
    const theirs = server[k] && server[k].qty ? server[k].qty : 0;
    if (mine !== theirs) diffs.push({ desc: (local.map[k] || server[k]).desc, article: (local.map[k] || server[k]).article, mine, theirs });
  });
  const match = serverTotal === local.totalQty && diffs.length === 0;
  return { state: match ? "match" : "mismatch", serverTotal, heldBack, diffs };
}

function renderCompleteModal(session) {
  // Nothing should get marked complete while anything is still sitting
  // unsubmitted on the phone — new scans, staged removals or quantity edits —
  // so route them through the batch-confirm screen first. Once that's done,
  // what's on the phone IS what's on the Sheet, which is what the summary
  // below is checked against.
  const stillPending = pendingChanges_(session);
  if (stillPending.length > 0) {
    toast(`📤 You have ${stillPending.length} scan(s)/change(s) not sent yet — submit them first.`, 3500);
    renderSubmitBatchModal(session);
    return;
  }
  wedgeCallback = null;
  Scanner.stop(); // freeze the tally while it's being summarized
  const brandCfg = APP_CONFIG.brands.find((b) => b.code === session.brand);
  const confirmMode = !!brandCfg.confirmMode;
  const local = summarizeTally_(session);
  let completing = false;
  let verifyState = "checking";

  const modal = openModal(`
    <h2>Mark My Rack Complete</h2>
    <h3 style="margin-top:0;">Summary of what you scanned</h3>
    <div class="card" style="max-height:30vh; overflow-y:auto; padding:8px 14px;">
      ${local.rows.length
        ? local.rows.map((g) => `
        <div class="tally-row">
          <div class="info"><b>${esc_(g.desc)}</b><span>${esc_(g.color)}/${esc_(g.size)} · ${esc_(g.article)}${g.scans > 1 ? ` · ${g.scans} scans` : ""}</span></div>
          <div class="qty-badge">${g.qty}</div>
        </div>`).join("")
        : `<div class="empty">Nothing counted on this rack.</div>`}
    </div>
    <div class="card" style="text-align:center;">
      <div class="muted">Your total for this rack</div>
      <div style="font-size:28px; font-weight:800;">${local.totalQty} item(s)</div>
      <div class="muted">${local.rows.length} item line(s) · ${local.scans} scan(s)</div>
    </div>
    <div class="card" id="cVerify"></div>
    <div class="card">
      <div class="checklist-item"><input type="checkbox" id="c1"><label for="c1">All levels checked, top to bottom</label></div>
      <div class="checklist-item"><input type="checkbox" id="c2"><label for="c2">Loose stock near the rack included</label></div>
      <div class="checklist-item"><input type="checkbox" id="c3"><label for="c3">Anything unscannable already logged</label></div>
    </div>
    <div class="btn-row">
      <button class="btn secondary" id="cCancel">Not Yet</button>
      <button class="btn good" id="cConfirm" disabled>Confirm Complete</button>
    </div>
  `, {
    // however the sheet is dismissed (Not Yet, tap outside, back, swipe), go
    // back to scanning — unless the rack is actually being completed
    onClose: () => {
      if (completing) return;
      wedgeCallback = (code) => handleScan(code, session, brandCfg, confirmMode);
      const video = document.getElementById("scanVideo");
      if (video) Scanner.start(video, (code) => handleScan(code, session, brandCfg, confirmMode)).catch(() => {});
    },
  });

  const verifyEl = modal.querySelector("#cVerify");
  const confirmBtn = modal.querySelector("#cConfirm");

  async function runCheck() {
    verifyState = "checking";
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Checking…";
    confirmBtn.className = "btn secondary";
    verifyEl.innerHTML = `<div class="muted">⏳ Checking your count against the Dashboard…</div>`;
    const res = await verifyAgainstDashboard_(session, local);
    if (!modal.isConnected) return;
    verifyState = res.state;
    const recheck = `<button class="btn secondary small" id="cRecheck" style="margin-top:10px;">🔄 Recheck</button>`;
    if (res.state === "match") {
      verifyEl.innerHTML = `<div style="color:var(--good); font-weight:700;">✅ Matches the Dashboard</div>
        <div class="muted">The Dashboard has ${res.serverTotal} item(s) recorded for you on this rack — the same as your ${local.totalQty}.</div>`;
      confirmBtn.textContent = "Confirm Complete";
      confirmBtn.className = "btn good";
    } else if (res.state === "mismatch") {
      const lines = res.diffs.slice(0, 5).map((d) => `<div class="muted">• ${esc_(d.desc || d.article || "Unknown item")}: you ${d.mine}, Dashboard ${d.theirs}</div>`).join("");
      verifyEl.innerHTML = `<div style="color:var(--bad); font-weight:700;">⚠️ Doesn't match the Dashboard</div>
        <div class="muted">You counted ${local.totalQty}; the Dashboard shows ${res.serverTotal}.</div>
        ${res.heldBack ? `<div class="muted">${res.heldBack} item(s) were scanned outside the count window and are waiting for manager approval — they aren't in the Dashboard's count yet.</div>` : ""}
        ${lines}${res.diffs.length > 5 ? `<div class="muted">…and ${res.diffs.length - 5} more line(s).</div>` : ""}
        ${recheck}`;
      confirmBtn.textContent = "Complete Anyway";
      confirmBtn.className = "btn secondary";
    } else {
      verifyEl.innerHTML = `<div style="color:var(--warn); font-weight:700;">📶 Couldn't check against the Dashboard yet</div>
        <div class="muted">${esc_(res.msg)}</div>${recheck}`;
      confirmBtn.textContent = "Complete Anyway";
      confirmBtn.className = "btn secondary";
    }
    confirmBtn.disabled = false;
    const rb = verifyEl.querySelector("#cRecheck");
    if (rb) rb.onclick = runCheck;
  }
  runCheck();

  modal.querySelector("#cCancel").onclick = () => closeModal(modal);
  confirmBtn.onclick = onceAsync_(async () => {
    if (verifyState === "checking") return;
    if (verifyState !== "match") {
      const why = verifyState === "mismatch" ? "Your count does NOT match the Dashboard." : "Your count hasn't been checked against the Dashboard.";
      if (!confirm(why + " Mark this rack complete anyway?")) return;
    }
    completing = true;
    const hideLoading = showLoading_("Marking rack complete…", "Saving and checking the audit sample. Please don't close the app.");
    try {
    // Total racks registered in the app (all brands) — the backend needs it so
    // the 25% audit sample is 25% of ALL racks, not a coin-flip per rack.
    let totalRacks = 0;
    try {
      totalRacks = new Set((await DB.getRacks()).map((r) => r.brand + "|" + r.rack)).size;
    } catch (e) { /* backend falls back to per-rack 25% */ }
    await submitAction({
      action: "complete",
      totalRacks,
      brand: session.brand,
      rack: session.rack,
      counter: session.counter,
      deviceId: session.deviceId,
      sessionId: session.sessionId,
      talliedQty: local.totalQty,
    });
    Scanner.stop();
    clearHeartbeat();
    stopWatchingConcern();
    await clearSession();
    } finally { hideLoading(); }
    closeModal(modal);
    toast("✅ Rack marked complete on your end");
    renderSetup();
  });
}

function renderAuditCompleteModal(session) {
  wedgeCallback = null;
  const totalQty = session.tally.reduce((s, t) => s + t.qty, 0);
  const modal = openModal(`
    <h2>Confirm Audit Complete</h2>
    <div class="card" style="text-align:center;">
      <div class="muted">You've recounted</div>
      <div style="font-size:28px; font-weight:800;">${totalQty} item(s)</div>
      <div class="muted">across ${session.tally.length} scan(s)</div>
    </div>
    ${(() => { const n = (session.auditSample || []).length; if (!n) return ""; const seen = new Set(session.tally.filter((t) => !t.removed && t.qty > 0).map((t) => auditItemKey_(t))); const left = session.auditSample.filter((x) => !seen.has(x.key)).length; return left ? `<p style="color:var(--warn); font-weight:700;">⚠️ ${left} of ${n} sampled item(s) not recounted yet — they will count as 0.</p>` : `<p class="muted">All ${n} sampled items recounted.</p>`; })()}
    <p class="muted">This will compare your recount of the sampled items against the original tally and mark the audit resolved on the Dashboard.</p>
    <div class="btn-row">
      <button class="btn secondary" id="acCancel">Not Yet</button>
      <button class="btn good" id="acConfirm">Confirm Audit Complete</button>
    </div>
  `);
  modal.querySelector("#acCancel").onclick = () => {
    wedgeCallback = (code) => handleScan(code, session, APP_CONFIG.brands.find((b) => b.code === session.brand), false);
    closeModal(modal);
  };
  modal.querySelector("#acConfirm").onclick = onceAsync_(async () => {
    const hideLoading = showLoading_("Comparing your recount…", "Checking against the original count. Please don't close the app.");
    let result;
    try {
      result = await submitAction({
        action: "confirmAudit",
        brand: session.brand,
        rack: session.rack,
        auditor: session.counter,
        auditSessionId: session.auditSessionId,
      });
      Scanner.stop();
      clearHeartbeat();
      stopWatchingConcern();
      await clearSession();
    } finally { hideLoading(); }
    closeModal(modal);
    if (result && result.ok) {
      const v = result.variance;
      toast(v === 0 ? "✅ Audit confirmed — matches the original count exactly" : `✅ Audit confirmed — variance of ${v > 0 ? "+" : ""}${v} vs. original`, 4000);
    } else {
      toast("✅ Audit submitted (will sync once online, or check the Dashboard shortly)");
    }
    renderSetup();
    // The full result is a proper report you can read now AND open again later (Audit Reports on the start screen).
    if (result && result.ok && result.report) {
      saveAuditReportLocal_(result.report);
      renderAuditReportModal_(result.report);
    }
  });
}
