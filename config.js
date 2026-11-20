/* config.js — the ONLY file an admin needs to edit for the Warehouse Count app.

   ALL data sources below are Google Sheets, read with zero sign-in required
   (published-to-web CSV links), and the one write path (submitUrl) is a
   Google Apps Script Web App, also zero sign-in required for counters.
   See README.md for how to set each of these up.
*/
window.APP_CONFIG = {
  // Apps Script Web App URL (ends in /exec) — handles every scan, break,
  // resume, and rack-completion submission. One endpoint for everything.
  submitUrl: "https://script.google.com/macros/s/AKfycbxlk8xO8XcunMyf9zEc87uoHpg0314HDLNnlGSz8FdxBN2twiwk3OXGpJWOC3-NxTekBQ/exec",

  // One shared Sheet, published as CSV, listing every rack for every brand.
  // Expected columns: Brand, Rack ID  (one row per rack; brands can have
  // different numbers of racks — nothing here assumes they're equal).
  racksCsvUrl: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRn4lKGkL0lzm9l8-oLp4Kuw681wxK2rkvCP8SUe5DF6ObZZUQ16WGGTfARK__yQSg9gXetlu9CNIMi/pub?output=csv",

  // The SAP location code this specific deployment represents (must match
  // the "Lctn" column's value in your Current Balance CSV exactly, e.g.
  // "SM CEBU"). One deployment = one location — if your Current Balance
  // sheet contains other locations too, this is how the Dashboard knows to
  // ignore them and only compare against your own. Leave "" to use every
  // row in the sheet unfiltered (only safe if the sheet already contains
  // just your location).
  myLocation: "",

  // SAP Current Balance, read as CSV — the baseline the Dashboard's
  // "Reports" tab compares actual scanned totals against. Expects SAP's
  // standard export columns: Article, Plant, Lctn, SLoc, SL, BUn,
  // Unrestricted, Transit/Transf., Quality Inspection, Restricted-Use,
  // Blocked, Returns, Value Unrestricted, Val. in Trans./Tfr,
  // Value in QualInsp., Value Restricted, Value BlockedStock,
  // Value Rets Blocked (only Article + Unrestricted are strictly required;
  // everything else — Plant and the six Value columns included — is used
  // if present, skipped if not, matched by header name rather than
  // position). Plant drives Plant→Brand matching (1100=SESM,
  // 1101=Onitsuka Tiger, 1102=ASICS) so records from different plants are
  // never mixed. Only used by dashboard.html — the counting app itself
  // never reads this. This URL is the sheet's CSV export link (works for
  // any sheet shared "anyone with the link can view", no separate
  // Publish-to-web step needed) — built from gid=0 of the sheet below.
  currentBalanceCsvUrl: "https://docs.google.com/spreadsheets/d/1042JNDFcIXsxCZstgbtFJc9RhCtBF_N3gt9tUB8g0Nk/export?format=csv&gid=0",

  // OPTIONAL — the actual Google Sheet URL (not the CSV export link) for
  // the Current Balance data, so the Dashboard's "Reports" tab can show an
  // "Open Sheet" link straight to it. Leave "" to hide that link.
  currentBalanceSheetUrl: "https://docs.google.com/spreadsheets/d/1042JNDFcIXsxCZstgbtFJc9RhCtBF_N3gt9tUB8g0Nk/edit?gid=0#gid=0",

  // How long (minutes) a counter can go without any activity before the
  // Dashboard calls it "silent" instead of "counting" — a break doesn't
  // count against this, since that's a distinct, declared state.
  silentAfterMinutes: 20,

  // OPTIONAL — enables real-time push updates on the Dashboard (presence
  // shows up instantly, and a scan on any phone triggers an immediate
  // refresh instead of waiting for the next poll). Paste in your Firebase
  // Realtime Database URL (Firebase Console → Realtime Database → Data tab,
  // the URL shown at the top — looks like
  // "https://your-project-default-rtdb.firebaseio.com"). Leave as "" to
  // skip this entirely — the app works exactly as before, just polling
  // instead of pushing. See README.md "Real-time updates (optional)".
  firebaseUrl: "https://warehouse-count-9e07c-default-rtdb.firebaseio.com",

  // One entry per brand. confirmMode:true means every scan shows a
  // confirm-quantity-and-match card before submitting (SESM's behavior);
  // omit or set false for instant-tally scanning (ASICS/Onitsuka's behavior).
  brands: [
    { code: "ASICS", name: "ASICS", catalogCsvUrl: "https://docs.google.com/spreadsheets/d/e/2PACX-1vSDxWjzgWmA0IieHnWq5JQUxjnVYZ4KqI5pLpWKNN2aK9WgBE8s4Vg7qVPNO-ctn3RBi7FGwnP04Qx0/pub?output=csv" },
    { code: "ONITSUKA", name: "Onitsuka Tiger", catalogCsvUrl: "https://docs.google.com/spreadsheets/d/e/2PACX-1vT5I0F5CYzb2GL7Rplh5bMNmX0EY4Hq9DINOeFFFrQNwkfRUnfSq98rBEZAkwN8qdhQ7yjYQpJqBedQ/pub?output=csv" },
    { code: "SESM", name: "SESM", catalogCsvUrl: "https://docs.google.com/spreadsheets/d/e/2PACX-1vT6YP6aOT9W9znHwYsPVSjoPxptLtZf7EtMqN5NtTCLbyHZA3IobfJTxnffZqK0d_gTjhZQXcqLPXmf/pub?output=csv", confirmMode: true },
    { code: "ABC", name: "ABC Mart", catalogCsvUrl: "https://docs.google.com/spreadsheets/d/e/2PACX-1vSHkb1jMOjCLbCFGRjhLu0TcCDo3KFsNAbhDHfx3lMwtsaeOQePyOoTzay04ePb1yB9U-LfLUftg59G/pub?output=csv" },
  ],
};
