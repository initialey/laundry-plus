# Laundry+ 注文フォーム仕様書 (laundry_plus_order_form_spec)

対象: `index.html`(予約フォーム)/ `admin.html`(管理画面)/ `gas/Code.gs`(バックエンド)

> 料金・時間などの数値はすべて `index.html` の定数(`LOAD_TYPES` / `BANGO` / `SEPARATION` /
> `ADDONS` / `SPEEDS` / `slotHours`)で管理する。本書はその仕様の正本。
> フォームの金額は**概算(estimate)**であり、確定金額は店頭での計量後に決まる。

## §1 概要

- お客さんがWebフォームで洗濯物の内容・集荷/配達日時を指定して予約(Book for Pickup)する。
- 送信時にクレーム番号 `LP-YYYYMMDD-HHMMSS` を発行し、Googleスプレッドシートに記録、Telegramに通知する。
- 営業時間: 毎日 5AM–11PM。集配時間: 平日 8AM–9PM / 週末 9AM–7PM。

## §2 顧客情報

- 必須: Name / Mobile No. / Address
- 任意: Facebook(Name or Link)— ただし連絡手段に Facebook Messenger を選んだ場合は必須
- Best Way to Contact You: Text / SMS(デフォルト)、Facebook Messenger

## §3 サービスと料金

### §3.1 Assorted Clothes(Wash + Dry + Fold)— 12kgブロック方式

重量を**12kgずつのブロック**に分割し、各ブロックを以下で計算して合算する:

- ブロック内の最初の7kgまで: **₱240**
- 7kgを超えた分: **+₱45/kg**(端数は切り上げ。超過0.1kgでも+₱45)
- ブロック上限は12kg(ブロック最大額 = 240 + 5 × 45 = **₱465**)

擬似コード:

```
total = 0; remaining = kg
while remaining > 0:
    block = min(remaining, 12)
    total += 240 + max(0, ceil(block - 7)) * 45
    remaining -= block
```

「load数」は**ブロック数**と同義(= `ceil(kg / 12)`)。per-load課金(§5のスピード料金、
アドオンのBleach/Extra Detergent)はこのload数に掛ける。

検証用テストケース:

| kg | 概算 | 内訳 |
|---|---|---|
| 5 | ₱240 | 1ブロック |
| 7 | ₱240 | 1ブロック |
| 7.1 | ₱285 | 240 + 45 |
| 8 | ₱285 | 240 + 45 |
| 12 | ₱465 | 240 + 5×45 |
| 12.1 | ₱705 | 465 + 240 |
| 13 | ₱705 | 465 + 240 |
| 14 | ₱705 | 465 + 240 |
| 19 | ₱705 | 465 + 240 |
| 20 | ₱750 | 465 + 285 |
| 24 | ₱930 | 465 + 465 |
| 24.1 | ₱1,170 | 465 + 465 + 240 |

入力上限: 36kg(3ブロック)。

### §3.2 Blankets / Jeans / Towels(Wash + Dry + Fold)

- **₱240 / 5kgロード**。5kgを超えるごとに新しいロード(= `ceil(kg / 5) × 240`)。
- 例: 6kg = 2ロード = ₱480、12kg = 3ロード = ₱720。load数 = `ceil(kg / 5)`。

### §3.3 Single Services

- Wash Only ₱150 / Dry Only ₱150 / Fold Only ₱80(いずれも1ロード最大7kg)。load数 = 1。

### §3.4 Wash + Dry + Press / Press Only

- Wash + Dry + Press: **₱210/kg**(48–72時間仕上げ)
- Press Only(per kg): **₱155/kg**
- **kg単価の端数はkgを切り上げて計算**(§3.1と同じルール。例: 1.5kg → 2kg × 155 = ₱310)
- 枚数単価: Tops ₱40 / Bottoms ₱55 / Simple Dress ₱80 / Long Dress ₱105 / Jacket ₱105 /
  Hanger w/ Dust Bag ₱20(整数枚)

## §4 Bango / Separate load by / Add-ons

- **Bango Level**(香り): None / Less / Normal(デフォルト・推奨)/ Extra / Ultra
- **Separate load by**(洗い分け): Whites & Colored / Beddings & Clothes / Beddings & Towels /
  Per Bag / Mixed(デフォルト・無料)。Mixed以外は Additional Charge(店頭確認)。
  Per Bag 選択時は **No. of Bags が必須**になり、「Per Bag × N bags」として記録。
- **Add-ons**: Bleach +₱20/load、Extra Detergent +₱10/load(いずれもload数×料金。load数は§3の定義)、
  Laundry+ Bag +₱200(注文につき1回)

### §4.1 Terms & Conditions 同意(必須)

- 送信ボタン直前に **T&C同意チェックボックス**を配置。チェックするまで送信ボタンは disabled。
- T&C本文は折りたたみ(アコーディオン)で英語+タガログ語を併記:
  色落ち・縮み・デリケート/ラベルなし生地の損傷について Laundry+ は免責、予約により
  標準的な洗濯処理に安全な品であることを確認したものとする。
- 同意時刻を `tncAgreedAt`(ISO)として送信し、Ordersシートの **「T&C Agreed」列**にタイムスタンプ記録。
- 旧「Preferences」チェック(デリケート品/色落ち)は廃止。

## §5 スピードオプション

| ID | 表示 | 追加料金 | 仕上がり時間(hours) | ピックアップ締切(cutoff) |
|---|---|---|---|---|
| standard | Standard | 無料 | 48h | なし |
| 24hrs | 24 Hours | **+₱70/load** | 24h | なし |
| rush | Rush (Same Day) | +₱150/load | 6h | 4PM(16時の集荷スロットまで) |
| superrush | Super Rush (5hrs) | +₱200/load | 5h | なし |

- per-load料金の**「load数」はブロック数と同義**(§3.1)。全行のload数合計に料金を掛ける。
  例: Assorted 14kg = 2ブロック → 24 Hours は +₱140。Blankets 6kg = 2ロード → +₱140。
- **最短デリバリー = 集荷時刻 + hours**。例: 11AM集荷 + Super Rush → 同日16:00スロットから。
- cutoffを過ぎた集荷時刻ではそのスピードが選択不可(グレーアウト)。選択中に不可となった
  場合は Standard に自動フォールバック(高額オプションへの自動切替はしない)。

## §6 集配スケジュール

- 日付は英語表記のプルダウン(当日から14日先まで)。デリバリー日は§5の最短デリバリー以降のみ。
- 時間は1時間スロット。平日 8:00–21:00 / 週末 9:00–19:00(スロット開始時刻)。
- 当日スロットは現在時刻+1時間以降のみ表示。
- スロット上限: 1時間あたり **SLOT_CAP = 2件**(集荷+配達の合計、GAS側で管理)。
  満枠・管理画面でBLOCKされたスロットは「FULL」表示で選択不可。

## §7 見積もりの注意

- フォームの金額はすべて概算。確定金額は店頭で計量後に決定(フォーム・完了画面に明記)。

## §8 データ連携(GAS)

- 注文POST → 「Orders」シートに記録(Status列でNEW→WASHING→READY→PICKED UP/CANCELLEDを管理)+Telegram通知。
- **料金計算はフォーム(index.html)側のみ**で行い、GASは `total` を記録するだけ(計算ロジックの二重管理をしない)。
- `GET ?action=slots&date=` … スロット空き状況(公開)/ `GET ?action=day&date=&key=` … 管理画面用の予約一覧(要ADMIN_KEY)/ `POST {action:"block"}` … スロットのBLOCK/UNBLOCK。
