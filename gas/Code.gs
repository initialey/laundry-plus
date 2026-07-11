// Laundry+ 注文受付 GAS
// スプレッドシートの「拡張機能 → Apps Script」にこのファイルの中身を貼り付けて、
// 「デプロイ → 新しいデプロイ → ウェブアプリ(アクセス: 全員)」でデプロイする。
// 発行されたウェブアプリURLを index.html の GAS_ENDPOINT に設定する。

const SHEET_NAME = "Orders";

function doPost(e) {
  const data = JSON.parse(e.postData.contents);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  // シートが空なら1行目に見出しを書く
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["受付番号", "受付日時", "名前", "電話", "注文内容", "香り", "スピード", "メモ", "合計(PHP)"]);
  }

  // 注文内容(loads)を読みやすいテキストにする
  const loadsText = (data.loads || [])
    .map(function (l) { return l.label + " " + l.kg + "kg = P" + l.amount; })
    .join("\n");

  sheet.appendRow([
    data.receiptNo,
    new Date(data.receivedAt),
    data.name,
    "'" + data.phone, // 先頭の0が消えないように文字列として保存
    loadsText,
    data.bango,
    data.speed,
    data.notes,
    data.total,
  ]);

  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
