// Laundry+ order intake GAS
// Paste this into the spreadsheet's "Extensions → Apps Script".
// First-time setup: fill in the two TELEGRAM_ constants below, then run
// setupSheet() once from the editor (this also triggers the permission prompt),
// then run testTelegram() to confirm the notification arrives.
// To update an existing deployment WITHOUT changing its URL:
// Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.

// ===== Telegram settings =====
const TELEGRAM_BOT_TOKEN = "PASTE_YOUR_BOT_TOKEN_HERE"; // from @BotFather
const TELEGRAM_CHAT_ID = "PASTE_YOUR_CHAT_ID_HERE";     // from getUpdates

// ===== Sheet settings =====
const SHEET_NAME = "Orders";
const HEADERS = [
  "Receipt No", "Received At", "Status", "Name", "Phone", "Address",
  "Loads", "Bango", "Speed", "Notes", "Total (PHP)",
];
const STATUSES = ["NEW", "WASHING", "READY", "PICKED UP", "CANCELLED"];
const STATUS_COLORS = ["#fff3c4", "#cfe8ff", "#d3f2d9", "#e6e6e6", "#ffd6d6"];

function doPost(e) {
  const data = JSON.parse(e.postData.contents);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);

  // Human-readable summary of the loads (unit is "kg" or "pc")
  const loadsText = (data.loads || [])
    .map(function (l) { return l.label + " " + (l.qty || l.kg) + (l.unit || "kg") + " = P" + l.amount; })
    .join("\n");

  sheet.appendRow([
    data.receiptNo,
    new Date(data.receivedAt),
    "NEW",
    data.name,
    "'" + data.phone, // keep leading zero by storing as text
    data.address,
    loadsText,
    data.bango,
    data.speed,
    data.notes,
    data.total,
  ]);

  // Telegram notification — an error here must not break order recording
  try {
    sendTelegram(
      "🧺 New order " + data.receiptNo + "\n" +
      "👤 " + data.name + " / " + data.phone + "\n" +
      "📍 " + data.address + "\n\n" +
      loadsText + "\n\n" +
      "🌸 Bango: " + data.bango + " / ⏱ " + data.speed +
      (data.notes ? "\n📝 " + data.notes : "") + "\n" +
      "💰 Total: P" + data.total + " (estimate)"
    );
  } catch (err) {
    console.error("Telegram notify failed: " + err);
  }

  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
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
