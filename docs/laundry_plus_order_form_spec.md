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

### §3.3 Single Services — 12kgブロック方式(§3.1と同一構造)

§3.1と同じ12kgブロックリセット方式で、base / excess_rate のみサービスごとに異なる:

| サービス | base(7kgまで) | excess_rate(超過/kg・切り上げ) | ブロック上限額 |
|---|---|---|---|
| Wash Only | ₱150 | +₱30/kg | ₱300 |
| Dry Only | ₱150 | +₱30/kg | ₱300 |
| Fold Only | ₱80 | +₱15/kg | ₱155 |

```
total = 0; remaining = kg
while remaining > 0:
    block = min(remaining, 12)
    total += base + max(0, ceil(block - 7)) * excess_rate
    remaining -= block
```

load数 = ブロック数 = `ceil(kg / 12)`(§5のper-load課金に連動)。入力上限36kg。

検証用テストケース:

| kg | Wash/Dry Only | Fold Only |
|---|---|---|
| 5 | ₱150 | ₱80 |
| 7 | ₱150 | ₱80 |
| 7.1 | ₱180 | ₱95 |
| 12 | ₱300 | ₱155 |
| 12.1 | ₱450 | ₱235 |
| 19 | ₱450 | ₱235 |
| 20 | ₱480 | ₱250 |
| 24 | ₱600 | ₱310 |
| 24.1 | ₱750 | ₱390 |

### §3.4 Wash + Dry + Press / Press Only

- Wash + Dry + Press: **₱210/kg**(48–72時間仕上げ)
- Press Only(per kg): **₱155/kg**
- **kg単価の端数はkgを切り上げて計算**(§3.1と同じルール。例: 1.5kg → 2kg × 155 = ₱310)
- 枚数単価: Tops ₱40 / Bottoms ₱55 / Simple Dress ₱80 / Long Dress ₱105 / Jacket ₱105 /
  Hanger w/ Dust Bag ₱20(整数枚)

## §4 Bango / Separate load by / Add-ons

- **Bango Level**(香り): None / Less / Normal(デフォルト・推奨)/ Extra / Ultra
- **Separate Laundry Option or Preference**(洗い分け): Whites & Colored / Beddings & Clothes /
  Beddings & Towels / Per Bag / Mixed(デフォルト・無料)。Mixed以外は Additional Charge 表示。
  - Whites & Colored は「⭐ (Our Recommendation)」表記+カードを黄色系にハイライト(おすすめ)
  - Mixed の補足: "Assorted loads may include UP TO 2KG of towels, jeans, or bedding."
  - セクション下部の注記: "Any additional fees will be confirmed by our staff upon receiving your laundry."
  - Per Bag 選択時は **No. of Bags が必須**になり、「Per Bag × N bags」として記録。
    シートに記録される値は素のラベル(例: "Whites & Colored")で、⭐等の装飾は含まない。
- **Add-ons**: Bleach +₱20/load、Extra Detergent +₱10/load(いずれもload数×料金。load数は§3の定義)、
  Laundry+ Bag +₱200(注文につき1回)

### §4.1 Terms & Conditions 同意(必須)

- 送信ボタン直前に **T&C同意チェックボックス**を配置。チェックするまで送信ボタンは disabled。
- T&C本文は折りたたみ(アコーディオン)で英語+タガログ語を併記:
  色落ち・縮み・**退色(fading)**・デリケート/ラベルなし衣類の損傷について Laundry+ は免責。
  予約により、**特別な取り扱いを依頼しない限り**標準的な洗濯処理に適した品であることを確認したものとする。
- 同意時刻を `tncAgreedAt`(ISO)として送信し、Ordersシートの **「T&C Agreed」列**にタイムスタンプ記録。
- T&C直後に**デリケート品の事前申告を促す一文**(EN/TL)を表示。「notes」リンクをクリックすると
  Step 8 の自由記入欄(#notes)へスクロール+フォーカスする導線とする。
- 旧「Preferences」チェック(デリケート品/色落ち)は廃止。

### §4.2 プロモコード

- 合計カード内に **Promo Code 入力欄 + Apply ボタン**。Applyで GAS
  `GET ?action=promo&code=` に問い合わせて検証。
- 割引タイプ2種: **percent(%オフ)** / **fixed(₱オフ)**。有効期限(Valid Until、含む日まで)と
  有効/無効(Active)を持つ。無効・期限切れ・未登録は理由付きで拒否。
- 割引額 = percent: `round(gross × value/100)` / fixed: `min(value, gross)`
  (gross = loads + speed + add-ons)。合計は `gross − discount`(₱0未満にはならない)。
- ロード・スピード・アドオンを変更すると割引も自動再計算。コード欄を編集すると適用は解除。
- 送信データに `promoCode` と `discount` を含め、Ordersシートの **「Promo Code」「Discount」列**に記録。
- **管理は admin.html の Promo Codes パネル**で行う(コード追加/更新、ON/OFF、削除)。
  コードは Google スプレッドシートの **PromoCodes シート**(Code / Type / Value / Valid Until /
  Active / Notes)に保存。同名コードは上書き。

## §5 スピードオプション

| ID | 表示 | 追加料金 | デリバリー |
|---|---|---|---|
| standard | Standard | 無料 | 集荷の2日後以降(自由選択) |
| 24hrs | 24 Hours | **+₱70/load** | 集荷の翌日以降(自由選択) |
| rush | Rush (Same Day) | +₱150/load | 当日・§6.1の固定対応表で絞り込み |
| superrush | Super Rush (5hrs) | +₱200/load | 当日・§6.1の固定対応表で絞り込み |

- per-load料金の**「load数」はブロック数と同義**。全行のload数合計に料金を掛ける。
  load数: Assorted・Wash Only・Dry Only・Fold Only = `ceil(kg/12)`(§3.1・§3.3)、
  Blankets = `ceil(kg/5)`(§3.2)、kg/枚数単価サービス = 1。
  例: Assorted 14kg = 2ブロック → 24 Hours は +₱140。Wash Only 14kg = 2ブロック → +₱140。
- Standard / 24 Hours のデリバリーは指定日数後の日付から**全スロットを自由選択**(§6の絞り込みなし)。
- Rush / Super Rush は**当日配達**で、選べる配達枠は§6.1の対応表で決まる(集荷時刻依存)。
  旧「集荷時刻+仕上がり時間の自動計算」およびRushのピックアップ締切(4PM)ロジックは**廃止**。

## §6 集配スケジュール

- 日付は英語表記のプルダウン(当日から14日先まで)。
- **時間は固定スロット(全曜日共通)**。平日/週末の区別は廃止:
  8:00–9:00 AM / 9:00–10:30 AM / 11:00–12:30 PM / 1:00–2:30 PM / 3:00–4:30 PM /
  5:00–6:30 PM / 7:00–8:30 PM ＋ 特別枠 **9:00 PM(最終枠・optional、⚠️(Limited)バッジ表示)**。
  内部値は開始時刻 "HH:MM"(08:00 / 09:00 / 11:00 / 13:00 / 15:00 / 17:00 / 19:00 / 21:00)。
- 当日スロットは現在時刻+1時間以降のみ表示。
- スロット上限: 1枠あたり **SLOT_CAP = 2件**(集荷+配達の合計、GAS側で管理)。
  満枠・管理画面でBLOCKされたスロットは「FULL」表示で選択不可。

### §6.1 Rush / Super Rush 配達枠 固定対応表(ルックアップ)

集荷スロット → 選択可能な当日配達枠。9PM(21:00)は常に optional/最終枠(⚠️バッジ)。
該当枠が無い集荷スロットは「当日配達枠なし」→ **Lalamove(customer arranges/pays separately)** 案内に切替
(自動手配はしない・案内のみ)。

**RUSH(8〜10時間仕上げ)**

| 集荷スロット | 選択可能な配達枠 |
|---|---|
| 8:00–9:00 AM | 5:00–6:30 PM / 7:00–8:30 PM / 9:00 PM* |
| 9:00–10:30 AM | 7:00–8:30 PM / 9:00 PM* |
| 11:00–12:30 PM | 9:00 PM* のみ |
| 1:00–2:30 PM 以降 | なし → Lalamove |

**SUPER RUSH(5時間〜仕上げ)**

| 集荷スロット | 選択可能な配達枠 |
|---|---|
| 8:00–9:00 AM | 1:00–2:30 PM / 3:00–4:30 PM / 5:00–6:30 PM / 7:00–8:30 PM / 9:00 PM* |
| 9:00–10:30 AM | 3:00–4:30 PM / 5:00–6:30 PM / 7:00–8:30 PM / 9:00 PM* |
| 11:00–12:30 PM | 5:00–6:30 PM / 7:00–8:30 PM / 9:00 PM* |
| 1:00–2:30 PM | 7:00–8:30 PM / 9:00 PM* |
| 3:00–4:30 PM | 9:00 PM* のみ |
| 5:00–6:30 PM 以降 | なし → Lalamove |

（*=9:00 PM 特別枠・optional）Lalamove配達時は注文データの delivery を
`Via Lalamove (customer-arranged)` として記録。

## §7 見積もりの注意

- フォームの金額はすべて概算。確定金額は店頭で計量後に決定(フォーム・完了画面に明記)。

## §8 データ連携(GAS)

- 注文POST → 「Orders」シートに記録(Status列でNEW→WASHING→READY→PICKED UP/CANCELLEDを管理)+Telegram通知。
- **料金計算はフォーム(index.html)側のみ**で行い、GASは `total` を記録するだけ(計算ロジックの二重管理をしない)。
- `GET ?action=slots&date=` … スロット空き状況(公開)/ `GET ?action=day&date=&key=` … 管理画面用の予約一覧(要ADMIN_KEY)/ `POST {action:"block"}` … スロットのBLOCK/UNBLOCK。
- `GET ?action=promo&code=` … プロモコード検証(公開)/ `GET ?action=promos&key=` … コード一覧(要ADMIN_KEY)/ `POST {action:"promo", op:"save"|"toggle"|"delete"}` … コード管理。PromoCodesシートに保存。
- `setupSheet()` は Orders / BlockedSlots / PromoCodes の各シートを作成。
