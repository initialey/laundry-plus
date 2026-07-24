// Laundry+ order intake GAS
// Paste this into the spreadsheet's "Extensions → Apps Script".
// First-time setup: fill in the two TELEGRAM_ constants below, then run
// setupSheet() once from the editor (this also triggers the permission prompt),
// then run testTelegram() to confirm the notification arrives.
// To update an existing deployment WITHOUT changing its URL:
// Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.
//
// NOTE: the column layout changed (FB / Contact Via / Pickup / Delivery /
// Separation / Add-ons / T&C Agreed / Promo Code / Discount / Assigned Rider /
// Rider ID / Distance (km) / Assigned At were added). If you already have an
// "Orders" sheet from an older version, rename it (e.g. "Orders-old") and
// run setupSheet() again so new orders land under the right headers.
// setupSheet() also creates the PromoCodes / Riders / RiderRoster /
// RiderSchedule sheets.
//
// Auto-assign setup: in the Apps Script editor, Project Settings → Script
// Properties → add GEOCODING_API_KEY (a Google Cloud API key with the
// Geocoding API enabled — the same project/key you use for Places is fine
// as long as Geocoding is enabled on it too). Then open admin.html's Riders
// panel to register riders (name, base address, Telegram chat ID) and mark
// who's on duty each day.

// ===== Telegram settings =====
const TELEGRAM_BOT_TOKEN = "PASTE_YOUR_BOT_TOKEN_HERE"; // from @BotFather
const TELEGRAM_CHAT_ID = "PASTE_YOUR_CHAT_ID_HERE";     // from getUpdates

// ===== Admin settings =====
// Shared secret for admin.html (the slot schedule dashboard).
// CHANGE THIS to your own secret, and enter the same value in admin.html's
// key prompt. Anyone who knows it can see bookings and block slots.
const ADMIN_KEY = "CHANGE_ME_ADMIN_KEY";

// ===== Sheet settings =====
const SHEET_NAME = "Orders";
const HEADERS = [
  "Receipt No", "Received At", "Status", "Name", "Phone", "FB", "Contact Via",
  "Address", "Pickup", "Delivery", "Loads", "Bango", "Separation", "Add-ons",
  "T&C Agreed", "Speed", "Notes", "Promo Code", "Discount", "Total (PHP)",
  "Assigned Rider", "Rider ID", "Distance (km)", "Assigned At",
];
const STATUSES = ["NEW", "WASHING", "READY", "PICKED UP", "CANCELLED"];
const STATUS_COLORS = ["#fff3c4", "#cfe8ff", "#d3f2d9", "#e6e6e6", "#ffd6d6"];

// Per-slot capacity = number of riders working that day × SLOTS_PER_RIDER.
// Each rider covers 4 bookings per slot, so 1 rider ⇒ 4/slot, 2 riders ⇒
// 8/slot. Default 2 riders (⇒ 8). Managed from admin.html and stored in the
// Riders sheet (Date, Count, Updated At).
const DEFAULT_RIDERS = 2;
const SLOTS_PER_RIDER = 4;
const RIDERS_SHEET = "Riders";

// Manually closed slots (managed from admin.html). Rows: Date, Slot.
const BLOCKED_SHEET = "BlockedSlots";

// Promo codes (managed from admin.html). Columns:
//   Code / Type / Value / Valid Until / Active / Notes /
//   Max Uses / Used Count / One Time Per Customer
// Type is "percent" (Value = % off) or "fixed" (Value = ₱ off). Valid Until
// is inclusive; blank = no expiry. Max Uses blank/0 = unlimited. Used Count
// is the running total (incremented on order submit). One Time Per Customer
// TRUE ⇒ a phone/email may use the code only once.
const PROMO_SHEET = "PromoCodes";
const PROMO_HEADERS = ["Code", "Type", "Value", "Valid Until", "Active", "Notes", "Max Uses", "Used Count", "One Time Per Customer"];

// ===== Rider roster + daily attendance (auto-assign feature) =====
// IMPORTANT: this is a *different* sheet from "Riders" above. "Riders"
// (RIDERS_SHEET) only stores a per-day headcount used to compute slot
// capacity (headcount × SLOTS_PER_RIDER). This roster/attendance system is
// about WHO the riders are and WHERE they start from, for distance-based
// order assignment — it's independent and uses its own sheet names so the
// two features never collide:
//   RiderRoster   — one row per rider (id, name, Telegram chat id, base
//                   address + geocoded coords, active flag)
//   RiderSchedule — one row per (date, rider) marking who's on duty that day
const RIDER_ROSTER_SHEET = "RiderRoster";
const RIDER_ROSTER_HEADERS = ["Rider ID", "Name", "Telegram Chat ID", "Base Address", "Base Lat", "Base Lng", "Active"];
const RIDER_SCHEDULE_SHEET = "RiderSchedule";
const RIDER_SCHEDULE_HEADERS = ["Date", "Rider ID", "Rider Name", "On Duty", "Registered At"];

function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  if (data.action === "block") return handleBlock(data); // from admin.html
  if (data.action === "promo") return handlePromo(data); // from admin.html
  if (data.action === "riders") return handleRiders(data); // from admin.html (slot-capacity headcount)
  if (data.action === "riderRoster") return handleRiderRoster(data); // from admin.html (roster CRUD)
  if (data.action === "riderSchedule") return handleRiderSchedule(data); // from admin.html (daily attendance)
  if (data.action === "reassignRider") return handleReassignRider(data); // from admin.html (manual reassignment)

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);

  // Human-readable summary of the loads (unit is "kg" or "pc")
  const loadsText = (data.loads || [])
    .map(function (l) { return l.label + " " + (l.qty || l.kg) + (l.unit || "kg") + " = P" + l.amount; })
    .join("\n");
  const addonsText = (data.addons || []).join("\n");

  // Re-validate the promo server-side (authoritative). If it no longer holds
  // — used up, already used by this customer, expired — drop the discount so
  // it can't be reused. The customer's own order isn't in the sheet yet, so
  // customerUsedPromo won't self-match.
  let promoCode = data.promoCode || "";
  let discount = Number(data.discount) || 0;
  let total = Number(data.total) || 0;
  let promoOk = false;
  if (promoCode) {
    const v = validatePromo(promoCode, data.phone, data.email);
    if (v.ok) {
      promoOk = true;
    } else {
      total = total + discount; // restore the (now unavailable) discount
      discount = 0;
      promoCode = "";
    }
  }

  // Auto-assign the nearest on-duty rider — best-effort, computed BEFORE the
  // row is appended so the result lands in the same write (no second pass).
  // Any failure here (bad API key, geocoding down, etc.) must never stop the
  // order from being recorded.
  let assign = { ok: false, reason: "error" };
  try {
    const pickupISO = (data.pickup || "").slice(0, 10); // "YYYY-MM-DD HH:MM" -> date part
    assign = pickRiderForOrder(data.address, pickupISO || todayISODate());
  } catch (err) {
    console.error("pickRiderForOrder failed: " + err);
  }

  sheet.appendRow([
    data.receiptNo,
    new Date(data.receivedAt),
    "NEW",
    data.name,
    "'" + data.phone, // keep leading zero by storing as text
    data.fb || "",
    data.contactVia || "",
    data.address,
    // "'"-prefix keeps these as text "YYYY-MM-DD HH:00" — Sheets would
    // otherwise convert them to Date values and break the slot counting below
    data.pickup ? "'" + data.pickup : "",
    data.delivery ? "'" + data.delivery : "",
    loadsText,
    data.bango,
    data.separation || "",
    addonsText,
    data.tncAgreedAt ? new Date(data.tncAgreedAt) : "", // T&C agreement timestamp
    data.speed,
    data.notes,
    promoCode,
    discount,
    total,
    assign.ok ? assign.riderName : "未アサイン",
    assign.ok ? assign.riderId : "",
    assign.ok ? assign.distanceKm.toFixed(2) : "",
    assign.ok ? new Date() : "",
  ]);

  // count the use only after the order is safely recorded
  if (promoOk) {
    try { incrementPromoUse(promoCode); } catch (err) { console.error("promo increment failed: " + err); }
  }

  // Telegram notification — an error here must not break order recording
  try {
    sendTelegram(
      "🧺 New order " + data.receiptNo + "\n" +
      "👤 " + data.name + " / " + data.phone +
      (data.fb ? " / FB: " + data.fb : "") + "\n" +
      "📱 Contact via: " + (data.contactVia || "-") + "\n" +
      "📍 " + data.address + "\n" +
      "🚚 Pickup: " + (data.pickup || "-") + "\n" +
      "🏠 Delivery: " + (data.delivery || "-") + "\n\n" +
      loadsText + "\n\n" +
      "🌸 Bango: " + data.bango + " / ⏱ " + data.speed + "\n" +
      "🧦 Separation: " + (data.separation || "-") +
      (addonsText ? "\n➕ " + (data.addons || []).join(", ") : "") +
      (data.notes ? "\n📝 " + data.notes : "") +
      (promoCode ? "\n🎟 Promo: " + promoCode + " (−P" + discount + ")" : "") + "\n" +
      "💰 Total: P" + total + " (estimate)"
    );
  } catch (err) {
    console.error("Telegram notify failed: " + err);
  }

  // Rider assignment notification (or a "no one on duty" alert to the
  // owner) — separate try/catch so it can never affect order recording or
  // the owner notification above.
  try {
    if (assign.ok) {
      sendTelegramTo(assign.chatId, riderAssignmentMessage(data, assign, loadsText));
    } else if (assign.reason === "no_riders_on_duty") {
      sendTelegramTo(TELEGRAM_CHAT_ID, "⚠️ No riders on duty today!");
    }
  } catch (err) {
    console.error("rider assignment notify failed: " + err);
  }

  return jsonOut({ ok: true });
}

// GET ?action=slots&date=YYYY-MM-DD  (public, used by the booking form)
//   → { cap, counts: { "08:00": 1, ... } } — cap = riders that day; counts are
//     pickups + deliveries per slot (cancelled excluded). Blocked slots report full.
// GET ?action=day&date=YYYY-MM-DD&key=ADMIN_KEY  (admin.html)
//   → { ok, cap, riders, blocked: ["08:00"], bookings: [{slot, type, receipt,
//     name, phone, speed, status}] }
// GET ?action=riders&date=YYYY-MM-DD&key=ADMIN_KEY → { ok, date, riders, cap, perRider, def }
function doGet(e) {
  const p = (e && e.parameter) || {};

  if (p.action === "slots" && p.date) {
    const cap = capacityForDate(p.date);
    const counts = {};
    forEachBookingOn(p.date, function (slot, type, row, idx) {
      if (String(row[idx.status]) === "CANCELLED") return;
      counts[slot] = (counts[slot] || 0) + 1;
    });
    getBlocked(p.date).forEach(function (slot) {
      counts[slot] = Math.max(counts[slot] || 0, cap); // report as full
    });
    return jsonOut({ cap: cap, counts: counts });
  }

  if (p.action === "day" && p.date) {
    if (p.key !== ADMIN_KEY) return jsonOut({ ok: false, error: "wrong key" });
    const bookings = [];
    forEachBookingOn(p.date, function (slot, type, row, idx) {
      bookings.push({
        slot: slot,
        type: type,
        receipt: String(row[idx.receipt]),
        name: String(row[idx.name]),
        phone: String(row[idx.phone]),
        speed: String(row[idx.speed]),
        status: String(row[idx.status]),
        assignedRider: String(row[idx.assignedRider] || ""),
        riderId: String(row[idx.riderId] || ""),
      });
    });
    return jsonOut({ ok: true, cap: capacityForDate(p.date), riders: ridersForDate(p.date), blocked: getBlocked(p.date), bookings: bookings });
  }

  // Admin: read the rider count for a date.
  if (p.action === "riders" && p.date) {
    if (p.key !== ADMIN_KEY) return jsonOut({ ok: false, error: "wrong key" });
    return jsonOut({ ok: true, date: p.date, riders: ridersForDate(p.date), cap: capacityForDate(p.date), perRider: SLOTS_PER_RIDER, def: DEFAULT_RIDERS });
  }

  // Admin: list the rider roster (name, base address, active, etc.) for admin.html.
  if (p.action === "riderRoster") {
    if (p.key !== ADMIN_KEY) return jsonOut({ ok: false, error: "wrong key" });
    return jsonOut({ ok: true, roster: readRiderRoster() });
  }

  // Admin: today's (or any date's) attendance — every roster rider plus
  // whether they're marked on-duty for that date.
  if (p.action === "riderSchedule" && p.date) {
    if (p.key !== ADMIN_KEY) return jsonOut({ ok: false, error: "wrong key" });
    const onDuty = onDutyRiderIdsForDate(p.date);
    const riders = readRiderRoster().map(function (r) {
      return { riderId: r.riderId, name: r.name, active: r.active, onDuty: onDuty.has(r.riderId) };
    });
    return jsonOut({ ok: true, date: p.date, riders: riders, onDutyCount: riders.filter(function (r) { return r.onDuty; }).length });
  }

  // Public: validate a promo code entered on the booking form. phone/email
  // (optional) enable the one-use-per-customer check.
  if (p.action === "promo" && p.code) {
    return jsonOut(validatePromo(p.code, p.phone, p.email));
  }

  // Admin: list all promo codes for admin.html.
  if (p.action === "promos") {
    if (p.key !== ADMIN_KEY) return jsonOut({ ok: false, error: "wrong key" });
    return jsonOut({ ok: true, promos: readPromos() });
  }

  return jsonOut({ ok: true });
}

// Calls cb(slot, "pickup"|"delivery", row, idx) for every booking on `date`.
function forEachBookingOn(date, cb) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return;
  const idx = {
    receipt: HEADERS.indexOf("Receipt No"),
    status: HEADERS.indexOf("Status"),
    name: HEADERS.indexOf("Name"),
    phone: HEADERS.indexOf("Phone"),
    pickup: HEADERS.indexOf("Pickup"),
    delivery: HEADERS.indexOf("Delivery"),
    speed: HEADERS.indexOf("Speed"),
    assignedRider: HEADERS.indexOf("Assigned Rider"),
    riderId: HEADERS.indexOf("Rider ID"),
  };
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues();
  rows.forEach(function (r) {
    [["pickup", r[idx.pickup]], ["delivery", r[idx.delivery]]].forEach(function (pair) {
      const v = String(pair[1] || "");
      if (v.indexOf(date) === 0) cb(v.slice(11, 16), pair[0], r, idx);
    });
  });
}

function getBlockedSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(BLOCKED_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(BLOCKED_SHEET);
    sheet.appendRow(["Date", "Slot"]);
  }
  return sheet;
}

// ===== Riders (per-slot capacity per day) =====
function getRidersSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(RIDERS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(RIDERS_SHEET);
    sheet.appendRow(["Date", "Count", "Updated At"]);
  }
  return sheet;
}

// Rider count for a date; DEFAULT_RIDERS if unset.
function ridersForDate(date) {
  const sheet = getRidersSheet();
  if (sheet.getLastRow() > 1) {
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) === date) {
        const n = Number(rows[i][1]);
        return n > 0 ? n : DEFAULT_RIDERS;
      }
    }
  }
  return DEFAULT_RIDERS;
}

// Per-slot capacity for a date = riders × SLOTS_PER_RIDER.
function capacityForDate(date) {
  return ridersForDate(date) * SLOTS_PER_RIDER;
}

// POST { action:"riders", key, date, count } — set the rider count for a day.
function handleRiders(data) {
  if (data.key !== ADMIN_KEY) return jsonOut({ ok: false, error: "wrong key" });
  if (!data.date) return jsonOut({ ok: false, error: "missing date" });
  const count = Math.max(0, Math.min(8, Math.round(Number(data.count))));
  const sheet = getRidersSheet();
  let rowNum = -1;
  if (sheet.getLastRow() > 1) {
    const dates = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    for (let i = 0; i < dates.length; i++) {
      if (String(dates[i][0]) === data.date) { rowNum = i + 2; break; }
    }
  }
  // storing DEFAULT is fine, but keep the sheet tidy: a default value removes the override
  const now = new Date();
  if (count === DEFAULT_RIDERS) {
    if (rowNum > 0) sheet.deleteRow(rowNum);
  } else if (rowNum > 0) {
    sheet.getRange(rowNum, 2, 1, 2).setValues([[count, now]]);
  } else {
    sheet.appendRow(["'" + data.date, count, now]);
  }
  return jsonOut({ ok: true, date: data.date, riders: ridersForDate(data.date), cap: capacityForDate(data.date), perRider: SLOTS_PER_RIDER, def: DEFAULT_RIDERS });
}

function getBlocked(date) {
  const sheet = getBlockedSheet();
  const out = [];
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(function (r) {
      if (String(r[0]) === date) out.push(String(r[1]));
    });
  }
  return out;
}

// POST { action: "block", key, date, slot, blocked: true|false }
function handleBlock(data) {
  if (data.key !== ADMIN_KEY) return jsonOut({ ok: false, error: "wrong key" });
  const sheet = getBlockedSheet();
  if (data.blocked) {
    if (getBlocked(data.date).indexOf(data.slot) === -1) {
      sheet.appendRow(["'" + data.date, "'" + data.slot]); // text, not Date/time values
    }
  } else {
    const rows = sheet.getDataRange().getValues();
    for (let i = rows.length - 1; i >= 1; i--) {
      if (String(rows[i][0]) === data.date && String(rows[i][1]) === data.slot) {
        sheet.deleteRow(i + 1);
      }
    }
  }
  return jsonOut({ ok: true, blocked: getBlocked(data.date) });
}

// ===== Rider roster, attendance & auto-assignment =====
// See the constants block near the top for why this is a separate sheet
// pair from "Riders" (slot-capacity headcount).

function todayISODate() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function getRiderRosterSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(RIDER_ROSTER_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(RIDER_ROSTER_SHEET);
    sheet.appendRow(RIDER_ROSTER_HEADERS);
  }
  return sheet;
}

function getRiderScheduleSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(RIDER_SCHEDULE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(RIDER_SCHEDULE_SHEET);
    sheet.appendRow(RIDER_SCHEDULE_HEADERS);
  }
  return sheet;
}

// Returns [{ riderId, name, chatId, baseAddress, baseLat, baseLng, active }]
function readRiderRoster() {
  const sheet = getRiderRosterSheet();
  const out = [];
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, RIDER_ROSTER_HEADERS.length).getValues().forEach(function (r) {
      if (!String(r[0]).trim()) return;
      out.push({
        riderId: String(r[0]).trim(),
        name: String(r[1] || ""),
        chatId: String(r[2] || ""),
        baseAddress: String(r[3] || ""),
        baseLat: r[4] === "" ? null : Number(r[4]),
        baseLng: r[5] === "" ? null : Number(r[5]),
        active: promoTruthy(r[6]),
      });
    });
  }
  return out;
}

// "rider_1", "rider_2", ... — next unused id in the roster.
function nextRiderId() {
  const used = readRiderRoster().map(function (r) { return r.riderId; });
  let n = 1;
  while (used.indexOf("rider_" + n) !== -1) n++;
  return "rider_" + n;
}

// Geocode a free-text address via the Google Geocoding API.
// Returns { lat, lng } or null (missing key / no match / request failure).
function geocodeAddress(address) {
  const key = PropertiesService.getScriptProperties().getProperty("GEOCODING_API_KEY");
  if (!key || !address) return null;
  const url = "https://maps.googleapis.com/maps/api/geocode/json?address="
    + encodeURIComponent(address) + "&key=" + encodeURIComponent(key);
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const json = JSON.parse(res.getContentText());
    if (json.status !== "OK" || !json.results || !json.results.length) {
      console.error("Geocoding failed for '" + address + "': " + json.status);
      return null;
    }
    const loc = json.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng };
  } catch (err) {
    console.error("Geocoding request failed: " + err);
    return null;
  }
}

// Great-circle distance in km between two lat/lng points.
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth radius, km
  const toRad = function (d) { return d * Math.PI / 180; };
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Rider IDs marked On Duty=TRUE for a given date (most recent row per
// rider/date wins, in case attendance was toggled more than once).
function onDutyRiderIdsForDate(date) {
  const sheet = getRiderScheduleSheet();
  const state = {}; // riderId -> boolean, last value seen wins
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, RIDER_SCHEDULE_HEADERS.length).getValues().forEach(function (r) {
      if (String(r[0]) !== date) return;
      state[String(r[1])] = promoTruthy(r[3]);
    });
  }
  const out = new Set();
  Object.keys(state).forEach(function (riderId) { if (state[riderId]) out.add(riderId); });
  return out;
}

// Core assignment logic: geocode the order address, then pick the nearest
// active + on-duty (for `dateISO`) rider with known base coordinates.
// Returns { ok:true, riderId, riderName, chatId, distanceKm, lat, lng }
// or { ok:false, reason: "no_geocode" | "no_riders_on_duty" }.
function pickRiderForOrder(address, dateISO) {
  const loc = geocodeAddress(address);
  if (!loc) return { ok: false, reason: "no_geocode" };

  const onDuty = onDutyRiderIdsForDate(dateISO);
  const candidates = readRiderRoster().filter(function (r) {
    return r.active && onDuty.has(r.riderId) && r.baseLat != null && r.baseLng != null;
  });
  if (!candidates.length) return { ok: false, reason: "no_riders_on_duty" };

  let best = null, bestKm = Infinity;
  candidates.forEach(function (r) {
    const km = haversineKm(loc.lat, loc.lng, r.baseLat, r.baseLng);
    if (km < bestKm) { bestKm = km; best = r; }
  });
  return { ok: true, riderId: best.riderId, riderName: best.name, chatId: best.chatId, distanceKm: bestKm, lat: loc.lat, lng: loc.lng };
}

// Telegram message sent to the assigned rider.
function riderAssignmentMessage(data, assign, loadsText) {
  return "🛵 New Order Assigned!\n" +
    "👤 Customer: " + data.name + "\n" +
    "📍 Address: " + data.address + "\n" +
    "📦 Order: " + loadsText + "\n" +
    "🕐 Pickup: " + (data.pickup || "-") + "\n" +
    "🕐 Delivery: " + (data.delivery || "-") + "\n" +
    "💰 Total: ₱" + data.total + "\n" +
    "📌 Map: https://maps.google.com/?q=" + assign.lat + "," + assign.lng;
}

// POST { action:"riderRoster", key, op:"save"|"toggle"|"delete", riderId,
//        name, chatId, baseAddress, active }
// "save" upserts (riderId omitted ⇒ new rider, auto-assigned an id); the
// base address is (re-)geocoded whenever it's provided on save.
function handleRiderRoster(data) {
  if (data.key !== ADMIN_KEY) return jsonOut({ ok: false, error: "wrong key" });
  const sheet = getRiderRosterSheet();

  let rowNum = -1;
  if (data.riderId && sheet.getLastRow() > 1) {
    const ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === data.riderId) { rowNum = i + 2; break; }
    }
  }

  if (data.op === "delete") {
    if (rowNum > 0) sheet.deleteRow(rowNum);
  } else if (data.op === "toggle") {
    if (rowNum > 0) {
      const cur = promoTruthy(sheet.getRange(rowNum, 7).getValue());
      sheet.getRange(rowNum, 7).setValue(!cur);
    }
  } else { // save (upsert)
    const riderId = data.riderId || nextRiderId();
    // keep existing coords if the address wasn't changed; re-geocode if it was
    let lat = "", lng = "";
    if (rowNum > 0) {
      const existing = sheet.getRange(rowNum, 1, 1, RIDER_ROSTER_HEADERS.length).getValues()[0];
      lat = existing[4]; lng = existing[5];
    }
    const addressChanged = rowNum < 0 || String(data.baseAddress || "") !== (rowNum > 0 ? String(sheet.getRange(rowNum, 4).getValue()) : "");
    if (data.baseAddress && addressChanged) {
      const loc = geocodeAddress(data.baseAddress);
      if (loc) { lat = loc.lat; lng = loc.lng; }
      else { lat = ""; lng = ""; } // couldn't geocode — leave blank rather than stale
    }
    const row = [
      riderId,
      data.name || "",
      data.chatId || "",
      data.baseAddress || "",
      lat,
      lng,
      data.active === false ? false : true,
    ];
    if (rowNum > 0) sheet.getRange(rowNum, 1, 1, RIDER_ROSTER_HEADERS.length).setValues([row]);
    else sheet.appendRow(row);
  }
  return jsonOut({ ok: true, roster: readRiderRoster() });
}

// Editor utility: bulk-geocode any roster rows missing coordinates (handy
// if base addresses were typed directly into the sheet instead of via
// admin.html). Run manually from the Apps Script editor.
function geocodeAllRiderBases() {
  const sheet = getRiderRosterSheet();
  if (sheet.getLastRow() < 2) return;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, RIDER_ROSTER_HEADERS.length).getValues();
  rows.forEach(function (r, i) {
    const address = String(r[3] || "");
    const hasCoords = r[4] !== "" && r[5] !== "";
    if (!address || hasCoords) return;
    const loc = geocodeAddress(address);
    if (loc) sheet.getRange(i + 2, 5, 1, 2).setValues([[loc.lat, loc.lng]]);
  });
}

// POST { action:"riderSchedule", key, date, entries: [{riderId, onDuty}] }
// Replaces the day's attendance rows with the given entries.
function handleRiderSchedule(data) {
  if (data.key !== ADMIN_KEY) return jsonOut({ ok: false, error: "wrong key" });
  if (!data.date || !Array.isArray(data.entries)) return jsonOut({ ok: false, error: "missing date/entries" });

  const sheet = getRiderScheduleSheet();
  // drop any existing rows for this date, then write fresh ones — simplest
  // way to guarantee one row per rider per day with no stale duplicates
  if (sheet.getLastRow() > 1) {
    const all = sheet.getRange(2, 1, sheet.getLastRow() - 1, RIDER_SCHEDULE_HEADERS.length).getValues();
    for (let i = all.length - 1; i >= 0; i--) {
      if (String(all[i][0]) === data.date) sheet.deleteRow(i + 2);
    }
  }
  const roster = readRiderRoster();
  const now = new Date();
  const newRows = data.entries.map(function (en) {
    const r = roster.filter(function (x) { return x.riderId === en.riderId; })[0];
    return ["'" + data.date, en.riderId, r ? r.name : "", en.onDuty === true, now];
  });
  if (newRows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, RIDER_SCHEDULE_HEADERS.length).setValues(newRows);
  }
  const onDuty = onDutyRiderIdsForDate(data.date);
  return jsonOut({ ok: true, date: data.date, onDutyCount: onDuty.size });
}

// POST { action:"reassignRider", key, receiptNo, riderId }
// Manually reassign an order to a different rider; re-geocodes the order's
// stored address (coordinates aren't persisted per-order) and re-sends the
// assignment Telegram message to the newly chosen rider.
function handleReassignRider(data) {
  if (data.key !== ADMIN_KEY) return jsonOut({ ok: false, error: "wrong key" });
  if (!data.receiptNo || !data.riderId) return jsonOut({ ok: false, error: "missing receiptNo/riderId" });

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return jsonOut({ ok: false, error: "no orders" });
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues();
  let rowNum = -1, orderRow = null;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][HEADERS.indexOf("Receipt No")]) === data.receiptNo) { rowNum = i + 2; orderRow = rows[i]; break; }
  }
  if (rowNum < 0) return jsonOut({ ok: false, error: "order not found" });

  const rider = readRiderRoster().filter(function (r) { return r.riderId === data.riderId; })[0];
  if (!rider) return jsonOut({ ok: false, error: "rider not found" });

  const address = String(orderRow[HEADERS.indexOf("Address")]);
  const loc = geocodeAddress(address);
  const distanceKm = (loc && rider.baseLat != null && rider.baseLng != null)
    ? haversineKm(loc.lat, loc.lng, rider.baseLat, rider.baseLng) : null;

  const iAssignedRider = HEADERS.indexOf("Assigned Rider");
  sheet.getRange(rowNum, iAssignedRider + 1, 1, 4).setValues([[
    rider.name,
    rider.riderId,
    distanceKm != null ? distanceKm.toFixed(2) : "",
    new Date(),
  ]]);

  // re-notify the newly assigned rider — best-effort
  try {
    if (rider.chatId && loc) {
      const fakeOrder = {
        name: String(orderRow[HEADERS.indexOf("Name")]),
        address: address,
        pickup: String(orderRow[HEADERS.indexOf("Pickup")]),
        delivery: String(orderRow[HEADERS.indexOf("Delivery")]),
        total: String(orderRow[HEADERS.indexOf("Total (PHP)")]),
      };
      const loadsText = String(orderRow[HEADERS.indexOf("Loads")]);
      sendTelegramTo(rider.chatId, riderAssignmentMessage(fakeOrder, { lat: loc.lat, lng: loc.lng }, loadsText));
    }
  } catch (err) {
    console.error("reassign notify failed: " + err);
  }

  return jsonOut({ ok: true, riderName: rider.name, riderId: rider.riderId, distanceKm: distanceKm });
}

// ===== Promo codes =====
function getPromoSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(PROMO_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(PROMO_SHEET);
    sheet.appendRow(PROMO_HEADERS);
  }
  return sheet;
}

function promoToISO(v) {
  if (!v) return "";
  if (Object.prototype.toString.call(v) === "[object Date]") {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return String(v).slice(0, 10); // already "YYYY-MM-DD"
}

function promoTruthy(v) {
  const s = String(v).toUpperCase();
  return v === true || s === "TRUE" || s === "YES" || s === "1" || s === "✓";
}

// Returns [{ code, type, value, validUntil, active, notes, maxUses, usedCount, oncePerCustomer }]
// (older 6-column sheets read maxUses/usedCount = 0 and oncePerCustomer = false.)
function readPromos() {
  const sheet = getPromoSheet();
  const out = [];
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, PROMO_HEADERS.length).getValues().forEach(function (r) {
      if (!String(r[0]).trim()) return;
      out.push({
        code: String(r[0]).trim().toUpperCase(),
        type: String(r[1]).trim().toLowerCase() === "fixed" ? "fixed" : "percent",
        value: Number(r[2]) || 0,
        validUntil: promoToISO(r[3]),
        active: promoTruthy(r[4]),
        notes: String(r[5] || ""),
        maxUses: Number(r[6]) || 0,          // 0 / blank = unlimited
        usedCount: Number(r[7]) || 0,
        oncePerCustomer: promoTruthy(r[8]),
      });
    });
  }
  return out;
}

// Normalise a phone (digits only) for customer matching.
function normPhone(p) { return String(p || "").replace(/\D/g, ""); }

// Has this customer (phone or email) already used this promo code? Scans Orders.
function customerUsedPromo(code, phone, email) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return false;
  const iPhone = HEADERS.indexOf("Phone");
  const iPromo = HEADERS.indexOf("Promo Code");
  const iEmail = HEADERS.indexOf("Email"); // -1 unless an Email column exists
  const wantPhone = normPhone(phone);
  const wantEmail = String(email || "").trim().toLowerCase();
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][iPromo]).trim().toUpperCase() !== code) continue;
    if (wantPhone && normPhone(rows[i][iPhone]) === wantPhone) return true;
    if (wantEmail && iEmail >= 0 && String(rows[i][iEmail]).trim().toLowerCase() === wantEmail) return true;
  }
  return false;
}

// Public validation used by the booking form. phone/email are optional; when
// present they enable the per-customer check.
function validatePromo(codeRaw, phone, email) {
  const code = String(codeRaw).trim().toUpperCase();
  const promo = readPromos().filter(function (p) { return p.code === code; })[0];
  if (!promo) return { ok: false, reason: "Code not found." };
  if (!promo.active) return { ok: false, reason: "This code is no longer active." };
  if (promo.validUntil) {
    const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
    if (promo.validUntil < today) return { ok: false, reason: "This code has expired." };
  }
  // ① total usage cap (0 / blank = unlimited)
  if (promo.maxUses > 0 && promo.usedCount >= promo.maxUses) {
    return { ok: false, reason: "This promo code has already been used." };
  }
  // ② one use per customer (only checkable once we know phone/email)
  if (promo.oncePerCustomer && (phone || email) && customerUsedPromo(code, phone, email)) {
    return { ok: false, reason: "This code can only be used once per customer." };
  }
  return { ok: true, code: promo.code, type: promo.type, value: promo.value, validUntil: promo.validUntil };
}

// Increment the Used Count for a code (called on a valid order submit).
function incrementPromoUse(codeRaw) {
  const code = String(codeRaw).trim().toUpperCase();
  const sheet = getPromoSheet();
  if (sheet.getLastRow() < 2) return;
  const codes = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < codes.length; i++) {
    if (String(codes[i][0]).trim().toUpperCase() === code) {
      const cell = sheet.getRange(i + 2, 8); // Used Count column
      cell.setValue((Number(cell.getValue()) || 0) + 1);
      return;
    }
  }
}

// POST { action:"promo", key, op:"save"|"delete"|"toggle", code, type, value, validUntil, active }
function handlePromo(data) {
  if (data.key !== ADMIN_KEY) return jsonOut({ ok: false, error: "wrong key" });
  const sheet = getPromoSheet();
  const code = String(data.code || "").trim().toUpperCase();
  if (!code) return jsonOut({ ok: false, error: "missing code" });

  // find existing row (1-based, header on row 1)
  let rowNum = -1;
  if (sheet.getLastRow() > 1) {
    const codes = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    for (let i = 0; i < codes.length; i++) {
      if (String(codes[i][0]).trim().toUpperCase() === code) { rowNum = i + 2; break; }
    }
  }

  if (data.op === "delete") {
    if (rowNum > 0) sheet.deleteRow(rowNum);
  } else if (data.op === "toggle") {
    if (rowNum > 0) {
      const cur = promoTruthy(sheet.getRange(rowNum, 5).getValue());
      sheet.getRange(rowNum, 5).setValue(!cur);
    }
  } else if (data.op === "reset") {
    if (rowNum > 0) sheet.getRange(rowNum, 8).setValue(0); // reset Used Count
  } else { // save (upsert)
    const type = String(data.type).toLowerCase() === "fixed" ? "fixed" : "percent";
    // preserve the running Used Count when editing an existing code
    const usedCount = rowNum > 0 ? (Number(sheet.getRange(rowNum, 8).getValue()) || 0) : 0;
    const row = [
      "'" + code,
      type,
      Number(data.value) || 0,
      data.validUntil ? "'" + String(data.validUntil).slice(0, 10) : "",
      data.active === false ? false : true,
      data.notes || "",
      Math.max(0, Math.round(Number(data.maxUses) || 0)),
      usedCount,
      data.oncePerCustomer === true,
    ];
    if (rowNum > 0) sheet.getRange(rowNum, 1, 1, PROMO_HEADERS.length).setValues([row]);
    else sheet.appendRow(row);
  }
  return jsonOut({ ok: true, promos: readPromos() });
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Sends to the shop-owner chat (TELEGRAM_CHAT_ID) — unchanged behaviour.
function sendTelegram(text) {
  sendTelegramTo(TELEGRAM_CHAT_ID, text);
}

// Sends to an arbitrary chat id (e.g. a rider's Telegram chat), using the
// same bot. No-op if the bot token or the target chat id is unset/blank/
// still the placeholder value.
function sendTelegramTo(chatId, text) {
  if (TELEGRAM_BOT_TOKEN.indexOf("PASTE_") === 0) return;
  if (!chatId || String(chatId).indexOf("PASTE_") === 0) return;
  UrlFetchApp.fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "post",
    payload: { chat_id: chatId, text: text },
    muteHttpExceptions: true,
  });
}

// Run this once from the editor: creates the Orders sheet with headers,
// adds the Status dropdown (column C) and status colors, freezes the header row.
function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
  sheet.setFrozenRows(1);
  getBlockedSheet(); // create the BlockedSlots sheet too
  getRidersSheet();  // create the Riders sheet too (slot-capacity headcount)

  // PromoCodes sheet — seed the FIRSTORDER code + a disabled example
  const promo = getPromoSheet();
  if (promo.getLastRow() === 1) {
    // Code, Type, Value, Valid Until, Active, Notes, Max Uses, Used Count, One Time Per Customer
    promo.appendRow(["'FIRSTORDER", "percent", 10, "'2026-08-31", true, "10% off, first order only", 1, 0, true]);
    promo.appendRow(["'WELCOME50", "fixed", 50, "", false, "Example: ₱50 off (inactive)", 0, 0, false]);
  }
  promo.setFrozenRows(1);

  // RiderRoster sheet — seed 2 placeholder riders (edit these in admin.html
  // or directly in the sheet; base address needs geocoding — either save it
  // once from admin.html, or type it in and run geocodeAllRiderBases()).
  const roster = getRiderRosterSheet();
  if (roster.getLastRow() === 1) {
    roster.appendRow(["rider_1", "Rider 1 (edit me)", "PASTE_RIDER1_CHAT_ID", "", "", "", true]);
    roster.appendRow(["rider_2", "Rider 2 (edit me)", "PASTE_RIDER2_CHAT_ID", "", "", "", true]);
  }
  roster.setFrozenRows(1);
  getRiderScheduleSheet(); // create the RiderSchedule sheet too

  const statusRange = sheet.getRange("C2:C1000");
  statusRange.setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(false).build()
  );

  sheet.setConditionalFormatRules(STATUSES.map(function (s, i) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(s)
      .setBackground(STATUS_COLORS[i])
      .setRanges([statusRange])
      .build();
  }));
}

// Run this once from the editor to check your Telegram settings.
function testTelegram() {
  sendTelegram("✅ Laundry+ notification test — it works!");
}
