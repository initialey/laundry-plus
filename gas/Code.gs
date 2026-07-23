// Laundry+ order intake GAS
// Paste this into the spreadsheet's "Extensions → Apps Script".
// First-time setup: fill in the two TELEGRAM_ constants below, then run
// setupSheet() once from the editor (this also triggers the permission prompt),
// then run testTelegram() to confirm the notification arrives.
// To update an existing deployment WITHOUT changing its URL:
// Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.
//
// NOTE: the column layout changed (FB / Contact Via / Pickup / Delivery /
// Separation / Add-ons / T&C Agreed / Promo Code / Discount were added).
// If you already have an "Orders" sheet from an older version, rename it
// (e.g. "Orders-old") and run setupSheet() again so new orders land under
// the right headers. setupSheet() also creates the PromoCodes sheet.

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

// Promo codes (managed from admin.html). Columns: Code / Type / Value /
// Valid Until / Active / Notes. Type is "percent" (Value = % off) or
// "fixed" (Value = ₱ off). Valid Until is inclusive; blank = no expiry.
const PROMO_SHEET = "PromoCodes";
const PROMO_HEADERS = ["Code", "Type", "Value", "Valid Until", "Active", "Notes"];

function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  if (data.action === "block") return handleBlock(data); // from admin.html
  if (data.action === "promo") return handlePromo(data); // from admin.html
  if (data.action === "riders") return handleRiders(data); // from admin.html

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);

  // Human-readable summary of the loads (unit is "kg" or "pc")
  const loadsText = (data.loads || [])
    .map(function (l) { return l.label + " " + (l.qty || l.kg) + (l.unit || "kg") + " = P" + l.amount; })
    .join("\n");
  const addonsText = (data.addons || []).join("\n");

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
    data.promoCode || "",
    data.discount || 0,
    data.total,
  ]);

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
      (data.promoCode ? "\n🎟 Promo: " + data.promoCode + " (−P" + (data.discount || 0) + ")" : "") + "\n" +
      "💰 Total: P" + data.total + " (estimate)"
    );
  } catch (err) {
    console.error("Telegram notify failed: " + err);
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
      });
    });
    return jsonOut({ ok: true, cap: capacityForDate(p.date), riders: ridersForDate(p.date), blocked: getBlocked(p.date), bookings: bookings });
  }

  // Admin: read the rider count for a date.
  if (p.action === "riders" && p.date) {
    if (p.key !== ADMIN_KEY) return jsonOut({ ok: false, error: "wrong key" });
    return jsonOut({ ok: true, date: p.date, riders: ridersForDate(p.date), cap: capacityForDate(p.date), perRider: SLOTS_PER_RIDER, def: DEFAULT_RIDERS });
  }

  // Public: validate a promo code entered on the booking form.
  if (p.action === "promo" && p.code) {
    return jsonOut(validatePromo(p.code));
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

// Returns [{ code, type, value, validUntil, active, notes }]
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
      });
    });
  }
  return out;
}

// Public validation used by the booking form.
function validatePromo(codeRaw) {
  const code = String(codeRaw).trim().toUpperCase();
  const promo = readPromos().filter(function (p) { return p.code === code; })[0];
  if (!promo) return { ok: false, reason: "Code not found." };
  if (!promo.active) return { ok: false, reason: "This code is no longer active." };
  if (promo.validUntil) {
    const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
    if (promo.validUntil < today) return { ok: false, reason: "This code has expired." };
  }
  return { ok: true, code: promo.code, type: promo.type, value: promo.value, validUntil: promo.validUntil };
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
  } else { // save (upsert)
    const type = String(data.type).toLowerCase() === "fixed" ? "fixed" : "percent";
    const row = [
      "'" + code,
      type,
      Number(data.value) || 0,
      data.validUntil ? "'" + String(data.validUntil).slice(0, 10) : "",
      data.active === false ? false : true,
      data.notes || "",
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

function sendTelegram(text) {
  if (TELEGRAM_BOT_TOKEN.indexOf("PASTE_") === 0 || TELEGRAM_CHAT_ID.indexOf("PASTE_") === 0) return;
  UrlFetchApp.fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "post",
    payload: { chat_id: TELEGRAM_CHAT_ID, text: text },
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
  getRidersSheet();  // create the Riders sheet too

  // PromoCodes sheet with a disabled example row so the format is clear
  const promo = getPromoSheet();
  if (promo.getLastRow() === 1) {
    promo.appendRow(["'WELCOME50", "fixed", 50, "", false, "Example: ₱50 off (inactive)"]);
  }
  promo.setFrozenRows(1);

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
