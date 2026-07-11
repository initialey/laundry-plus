# Laundry+ — Wash + Dry + Fold 受付フォーム

コインランドリー/クリーニング店「Laundry+」のドロップオフ(受付)フォームです。
店頭フライヤーと同じデザイン(スカイブルー×バブルロゴ×雲)で、単一の `index.html` だけで動きます。

![screenshot](docs/screenshot.png)

## 機能

- **Loads**: 品目タイプと重量(kg)を入れると自動で料金計算
  - Assorted Clothes: 240 PHP/load(7kgまで、超過分 +45 PHP/kg)
  - Blankets / Jeans / Towels: 240 PHP/load(最大5kg)
  - Wash Only 150 / Dry Only 150 / Fold Only 80(各 最大7kg)
- **Bango Level**: 香り強さを Less / Normal / Extra / Ultra から選択
- **スピード**: Standard 48hrs(無料)/ 24 Hours(+70/load)/ Rush 同日(+150/load・締切12NN)/ Super Rush 5hrs(+200/load・締切2PM)
- 送信するとクレーム番号(`LP-YYYYMMDD-HHMMSS`)を発行して完了画面を表示

## 使い方(ローカルで開く)

ビルド不要です。どちらかで開けます。

```bash
# 1) ファイルを直接開く
open index.html

# 2) ローカルサーバーで開く(推奨)
python3 -m http.server 8787
# → http://localhost:8787
```

## 料金・品目の変更

`index.html` 内の定数を編集するだけです。

- `LOAD_TYPES` — 品目と料金(base)、込み重量(includedKg)、超過単価(extraPerKg)、上限(maxKg)
- `BANGO` — 香りレベル
- `SPEEDS` — 仕上がりスピードと追加料金(fee)

## Google Apps Script(GAS)連携 ※今後の予定

送信処理は `submitToGAS(payload)` に分離済みです。現在は `GAS_ENDPOINT = ""` のためモック動作
(送信したフリをして完了画面を出す)になっています。連携手順:

1. Googleスプレッドシートを作成 → 拡張機能 → Apps Script
2. 以下のような `doPost` を作成:

   ```js
   function doPost(e) {
     const data = JSON.parse(e.postData.contents);
     const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Orders");
     sheet.appendRow([
       data.receiptNo, data.receivedAt, data.name, data.phone,
       JSON.stringify(data.loads), data.bango, data.speed,
       data.notes, data.total,
     ]);
     return ContentService.createTextOutput(JSON.stringify({ ok: true }))
       .setMimeType(ContentService.MimeType.JSON);
   }
   ```

3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」→ アクセス「全員」でデプロイ
4. 発行されたウェブアプリURLを `index.html` の `GAS_ENDPOINT` に貼り付け

payload の形:

```json
{
  "receiptNo": "LP-20260711-150429",
  "receivedAt": "2026-07-11T06:04:29.000Z",
  "name": "Juan dela Cruz",
  "phone": "0917 123 4567",
  "loads": [{ "type": "assorted", "label": "Assorted Clothes (up to 7kg)", "kg": 7, "amount": 240 }],
  "bango": "normal",
  "speed": "24hrs",
  "notes": "",
  "total": 620
}
```

## GitHub Pages で公開する場合

リポジトリを Public にした上で: Settings → Pages → Branch を `main` / `(root)` にして Save。
数分後に `https://<ユーザー名>.github.io/laundry-plus/` で公開されます。
