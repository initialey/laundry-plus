// Laundry+ order intake GAS
// Paste this into the spreadsheet's "Extensions → Apps Script", then deploy as a
// web app (access: Anyone). Put the web app URL into GAS_ENDPOINT in index.html.
// To update an existing deployment WITHOUT changing its URL:
// Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.

const SHEET_NAME = "Orders";

function doPost(e) {
  const data = JSON.parse(e.postData.contents);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  // Write the header row if the sheet is empty
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      "Receipt No", "Received At", "Name", "Phone", "Address",
      "Loads", "Bango", "Speed", "Notes", "Total (PHP)",
    ]);
  }

  // Human-readable summary of the loads
  const loadsText = (data.loads || [])
    .map(function (l) { return l.label + " " + l.kg + "kg = P" + l.amount; })
    .join("\n");

  sheet.appendRow([
    data.receiptNo,
    new Date(data.receivedAt),
    data.name,
    "'" + data.phone, // keep leading zero by storing as text
    data.address,
    loadsText,
    data.bango,
    data.speed,
    data.notes,
    data.total,
  ]);

  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
