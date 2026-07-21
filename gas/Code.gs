// Laundry+ order intake GAS
// Paste this into the spreadsheet's "Extensions → Apps Script".
// First-time setup: fill in the two TELEGRAM_ constants below, then run
// setupSheet() once from the editor (this also triggers the permission prompt),
// then run testTelegram() to confirm the notification arrives.
// To update an existing deployment WITHOUT changing its URL:
// Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.
//
// NOTE: the column layout changed (FB / Contact Via / Pickup / Delivery /
// Separation / Add-ons / T&C Agreed were added). If you already have an
// "Orders" sheet from an older version, rename it (e.g. "Orders-old") and
// run setupSheet() again so new orders land under the right headers.

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
  "T&C Agreed", "Speed", "Notes", "Total (PHP)",
];
const STATUSES = ["NEW", "WASHING", "READY", "PICKED UP", "CANCELLED"];
const STATUS_COLORS = ["#fff3c4", "#cfe8ff", "#d3f2d9", "#e6e6e6", "#ffd6d6"];

// How many pickups/deliveries the rider can handle in one hourly slot.
// The form asks GET ?action=slots&date=YYYY-MM-DD and disables full slots.
const SLOT_CAP = 2;

// Manually closed slots (managed from admin.html). Rows: Date, Slot.
const BLOCKED_SHEET = "BlockedSlots";

function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  if (data.action === "block") return handleBlock(data); // from admin.html

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
      (data.notes ? "\n📝 " + data.notes : "") + "\n" +
      "💰 Total: P" + data.total + " (estimate)"
    );
  } catch (err) {
    console.error("Telegram notify failed: " + err);
  }

  return jsonOut({ ok: true });
}

// GET ?action=slots&date=YYYY-MM-DD  (public, used by the booking form)
//   → { cap, counts: { "08:00": 1, ... } } — pickups + deliveries per hourly
//     slot (cancelled orders excluded). Manually blocked slots report as full.
// GET ?action=day&date=YYYY-MM-DD&key=ADMIN_KEY  (admin.html)
//   → { ok, cap, blocked: ["08:00"], bookings: [{slot, type, receipt, name,
//     phone, speed, status}] }
function doGet(e) {
  const p = (e && e.parameter) || {};

  if (p.action === "slots" && p.date) {
    const counts = {};
    forEachBookingOn(p.date, function (slot, type, row, idx) {
      if (String(row[idx.status]) === "CANCELLED") return;
      counts[slot] = (counts[slot] || 0) + 1;
    });
    getBlocked(p.date).forEach(function (slot) {
      counts[slot] = Math.max(counts[slot] || 0, SLOT_CAP); // report as full
    });
    return jsonOut({ cap: SLOT_CAP, counts: counts });
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
    return jsonOut({ ok: true, cap: SLOT_CAP, blocked: getBlocked(p.date), bookings: bookings });
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
