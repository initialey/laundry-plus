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

- 必須: Name / Mobile No. / Address / **City**(ドロップダウン) / **Barangay**(City次第で条件付き必須)
- 任意: **Facebook Profile URL**(`https://www.facebook.com/yourname` 形式)。空欄で送信可。
  ただし `type="url"` のため、**入力した場合のみ**URL形式を検証する(不正な文字列は送信不可)
- Address欄は番地・通りのみ(City/Barangayは別欄で独立)。ジオコーディング(ライダー自動アサイン)は
  Address + Barangay + City を結合した文字列で行う — 外すと同名の通り/バランガイが複数の市に存在する場合に精度が落ちるため
- Best Way to Contact You: Text / SMS(デフォルト)、Facebook Messenger

### §2.1 City / Barangay 選択ロジック

- **City ドロップダウン**(選択肢、この順で表示): Taguig / BGC (Bonifacio Global City) / Makati /
  Mandaluyong / Pasig / Other
- **Taguig / BGC / Makati**: Barangay不要、そのままフォームの続きに進める
- **Mandaluyong**: Barangayドロップダウン(必須)が表示される。選択肢: Barangka Ilaya / Barangka Itaas /
  Barangka Drive / Malamig / Buayang Bato / Highway Hills
- **Pasig**: Barangayドロップダウン(必須)が表示される。選択肢: Kapitolyo / Pineda / Bagong Ilog /
  Buting / Sumilang / Santa Rosa / Oranbo
- **Other**: フォームの続き(Loads以降、T&C、送信ボタンまで)を丸ごと非表示 + `disabled` にし
  (`disabled`属性を付与するため、隠れた必須項目が誤送信されることもない)、以下を表示:
  - "We may be able to service your area! Please contact us via chat so we can check availability."
  - (TL併記)"Maaari kaming makapagbigay ng serbisyo sa inyong lugar! ..."
  - 「Chat with us on Facebook」ボタン → `SHOP_FB_PAGE_URL`(`index.html`内の定数、要デプロイ前設定)
- Barangayフィールドはフェードイン表示(`max-height`+`opacity`トランジション)
- UI順序: Address → City → Barangay(条件付き)→ Facebook Profile URL(全幅)→ Best Way to Contact You

## §3 サービスと料金

### §3.1 Assorted Clothes(Wash + Dry + Fold)— 7kgロード方式

**1ロード = 7kg = ₱240**。7kgを超えた分は **+₱45/kg**(端数切り上げ、0.1kg超でも1kg分)。
ただし**次のフルロード料金を超える場合はフルロード料金を適用**する(超過料金がロード料金より
高くつくことはない)。

```
loads      = ceil(weight / 7)          # 料金の上限計算にのみ使う内部値
baseLoads  = floor(weight / 7)
basePrice  = baseLoads * 240
excessKg   = ceil(weight - baseLoads * 7)
excessPrice= excessKg * 45
total      = max(240, min(basePrice + excessPrice, loads * 240))   # 最低₱240
```

**load数(per-load課金の単位)= `ceil(kg / 9)`(最低1)。洗濯機1台あたり9kgが上限**。
料金の階段(7kg)とロード数の階段(9kg)は**わざと別**である点に注意
(例: 8.5kgは機械1台に収まるので1ロードだが、料金は7kg超過2kg分で ₱330)。
per-load課金(§5のスピード料金、アドオンのBleach等)はこのload数に掛ける。

| 重量 | ロード数 |
|---|---|
| 1–9kg | 1 |
| 9.1–18kg | 2 |
| 18.1–27kg | 3 |
| 27.1–35kg | 4 |

**最低料金 = 1ロード分(₱240)**。7kg未満でも下回らない(例: 3kg = ₱240)。

検証用テストケース(全件が自動テストで検証されている):

| kg | 料金 | ロード数 |
|---|---|---|
| 3.0 | ₱240 | 1 |
| 6.5 | ₱240 | 1 |
| 7.0 | ₱240 | 1 |
| 7.5 | ₱285 | 1 |
| 8.5 | ₱330 | 1 |
| 9.0 | ₱330 | 1 |
| 9.5 | ₱375 | 2 |
| 13.0 | ₱480 | 2 |
| 13.5 | ₱480 | 2 |
| 14.5 | ₱525 | 2 |
| 20.5 | ₱720 | 3 |
| 27.5 | ₱960 | 4 |
| 34.5 | ₱1,200 | 4 |

> **注**: 元の価格ガイドは 34.5kg を5ロードとしていたが、スタッフ確認により
> 「洗濯機は1台9kgまで」が正で、34.5kg は**4ロード**が正しいと訂正された。

入力上限: 36kg。

### §3.2 Blankets / Jeans / Towels(Wash + Dry + Fold)

- **₱240 / 5kgロード**。5kgを超えるごとに新しいロード(= `ceil(kg / 5) × 240`)。
- 例: 6kg = 2ロード = ₱480、12kg = 3ロード = ₱720。load数 = `ceil(kg / 5)`。

### §3.3 Single Services — 7kgロード方式(§3.1と同一構造)

§3.1と同じ式で、base / excess_rate のみサービスごとに異なる:

| サービス | base(7kgまで) | excess_rate(超過/kg・切り上げ) |
|---|---|---|
| Wash Only | ₱150 | +₱30/kg |
| Dry Only | ₱150 | +₱30/kg |
| Fold Only | ₱80 | +₱15/kg |

```
loads     = ceil(weight / 7)
baseLoads = floor(weight / 7)
total     = max(base, min(baseLoads * base + ceil(weight - baseLoads * 7) * excess_rate, loads * base))
```

load数 = `ceil(kg / 9)`(最低1)、最低料金は各サービスの base(Wash/Dry ₱150・Fold ₱80)。入力上限36kg。

検証用テストケース:

| kg | Wash/Dry Only | Fold Only |
|---|---|---|
| 7 | ₱150 | ₱80 |
| 7.5 | ₱180 | ₱95 |
| 13 | ₱300(2ロードで頭打ち) | ₱160(同) |

### §3.4 Wash + Dry + Press / Press Only

- Wash + Dry + Press: **₱210/kg**(48–72時間仕上げ)
- Press Only(per kg): **₱155/kg**
- **kg単価の端数はkgを切り上げて計算**(§3.1と同じルール。例: 1.5kg → 2kg × 155 = ₱310)
- 枚数単価: Tops ₱40 / Bottoms ₱55 / Simple Dress ₱80 / Long Dress ₱105 / Jacket ₱105 /
  Hanger w/ Dust Bag ₱20(整数枚)

## §4 Bango / Separate Laundry Preference / Add-ons

- **Bango Level**(香り): None / Less / Normal(デフォルト・推奨)/ Extra / Ultra
- **Separate Laundry Preference**(洗い分け): **複数選択可(チェックボックス)。選択なしも許容**(必須ではない)。
  選択肢: Whites & Colored / Beddings & Clothes / Beddings & Towels / Per Bag / Mixed。
  - 選択した項目は**カンマ区切り**で Ordersシートの Separation 列・Telegram通知に記録
  - **料金は「洗い分け1項目につき +1ロード」**。分けるということは洗濯機をもう1回まわすため。
    - **Mixed は +0ロード**(全部まとめて洗うので追加なし)
    - **Per Bag は +(N−1)ロード**(N袋 = N回まわす。3袋なら +2ロード)
    - 複数選択した場合は合算(例: Whites & Colored + Per Bag 3袋 = 1 + 2 = **+3ロード**)
  - **追加ロードの単価は「注文したサービスのロード単価」**。注文内の
    ロード課金行のうち**最も高いbase**を使う(Assorted ₱240 / Wash・Dry Only ₱150 / Fold Only ₱80)。
    Press系のみの注文には複製すべき洗濯機ロードが無いため、洗い分けの追加料金は**₱0**。
  - **追加ロードはスピード料金・アドオンのper-load計算には含めない**(それらは実際に持ち込まれた
    重量ベースのロード数で計算する)。
    例: Assorted 7kg + Whites & Colored + 24 Hours = 240 + 240 + 70 = **₱550**
  - 合計欄には「Separation (N extra loads)」の行が出る
  - Whites & Colored は「⭐ (Our Recommendation)」表記+カードを黄色系にハイライト(おすすめ)
  - Mixed の補足: "Assorted loads may include UP TO 2KG of towels, jeans, or bedding."
  - セクション下部の注記: "Any additional fees will be confirmed by our staff upon receiving your laundry."
  - Per Bag 選択時は **No. of Bags が必須**になり、「Per Bag × N bags」として記録。
    シートに記録される値は素のラベル(例: "Whites & Colored")で、⭐等の装飾は含まない。
- **Add-ons**(表示順、固定): Bleach (White) +₱20/load / Bleach (Color Safe) +₱20/load /
  Extra Detergent +₱10/load / Extra Fabcon +₱10/load / Extra Rinse +₱50/load /
  Laundry+ Bag +₱200(注文につき1回)。
  (load課金のものはいずれもload数×料金。load数は§3の定義。GAS・管理画面には
  ハードコードされたAdd-onsリストが無く、フォームが送信した内容をそのまま記録・表示するため、
  この順序変更・改名はフォーム側の `ADDONS` 配列のみで完結する)

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
- **利用回数制限(1回限り対応)**:
  - **Max Uses**: 累計使用可能回数(0/空欄=無制限)。`Used Count >= Max Uses` で拒否 →
    "This promo code has already been used."
  - **One Time Per Customer**: TRUE の場合、Ordersシートを phone(または email)+ promoCode で
    照合し、既に使用済みなら拒否 → "This code can only be used once per customer."
    顧客識別は phone を数字のみ正規化して比較(Email列があれば email も照合)。
  - **検証タイミング**: Apply時(`?action=promo&code=&phone=`)と**注文確定時(doPost)**の両方で検証。
    確定時に無効なら割引を外して記録(不正な二重利用を防止)。有効だった場合のみ **Used Count を +1**。
- **管理は admin.html の Promo Codes パネル**で行う(コード追加/更新、ON/OFF、Used Countリセット↺、削除、
  Max Uses入力、Once-per-customerトグル)。コードは Google スプレッドシートの **PromoCodes シート**
  (Code / Type / Value / Valid Until / Active / Notes / **Max Uses / Used Count / One Time Per Customer**)
  に保存。同名コードは上書き(編集時は Used Count を保持)。
  - 初期データ: `FIRSTORDER`(percent 10% / 2026-08-31まで / Max Uses 1 / One Time Per Customer TRUE)。
  - 旧6列シートは Max Uses=0・Used Count=0・Once=FALSE として読むため、既存コードは影響なし。

## §5 スピードオプション

| ID | 表示 | 追加料金 | デリバリー |
|---|---|---|---|
| standard | Standard | 無料 | 集荷の2日後以降(時間下限なし) |
| 24hrs | 24 Hours | **+₱70/load** | 集荷の翌日以降 **かつ 集荷日時+24時間以降** |
| rush | Rush (Same Day) | +₱150/load | 集荷日以降 **かつ 集荷日時+8時間以降** |
| superrush | Super Rush (5hrs) | +₱200/load | 集荷日以降 **かつ 集荷日時+5時間以降** |

- per-load料金は**全行のload数合計**に掛ける。
  load数: Assorted・Wash Only・Dry Only・Fold Only = `ceil(kg/9)`(最低1、§3.1・§3.3)、
  Blankets = `ceil(kg/5)`(§3.2)、kg/枚数単価サービス = 1。
  例: Assorted 9.5kg = 2ロード → 24 Hours は +₱140。8.5kg = 1ロード → +₱70。
- Standard / 24 Hours のデリバリーは指定日数後の日付から**全スロットを自由選択**(§6の絞り込みなし)。
- Rush / Super Rush はデリバリー日を**固定しない**(集荷日以降を自由に選択可)。
  - **同日デリバリー**を選んだ場合のみ §6.1 の固定対応表を適用し、該当枠が無ければ Lalamove を自動選択。
  - **後日デリバリー**(集荷日より後)を選んだ場合はその日の全スロットから自由選択(Standard等と同様)。
  - 例: 今夜ピックアップ + 翌朝デリバリーでも Rush を選べる。
  旧「集荷と同日に固定」ロジックは廃止。

## §6 集配スケジュール

- 日付は英語表記のプルダウン(当日から14日先まで)。
- **時間スロットは曜日で異なる**:
  - **平日(8AM–9PM・8枠)**: 8:00–9:00 AM / 9:00–10:30 AM / 11:00–12:30 PM / 1:00–2:30 PM /
    3:00–4:30 PM / 5:00–6:30 PM / 7:00–8:30 PM / **8:30–9:00 PM(最終・⚠️Limited)**。
    内部値: 08:00 / 09:00 / 11:00 / 13:00 / 15:00 / 17:00 / 19:00 / 20:30
  - **週末(土日・9AM–7PM・6枠)**: 9:00–10:30 AM / 11:00–12:30 PM / 1:00–2:30 PM / 3:00–4:30 PM /
    5:00–6:30 PM / **6:30–7:00 PM(最終・⚠️Limited)**。内部値: 09:00 / 11:00 / 13:00 / 15:00 / 17:00 / 18:30
  - 週末は営業時間外(8AM台・7PM以降)のスロットを非表示。
  - 各曜日の最終スロットはライダーの稼働終了時刻に近いため、意図的に **⚠️ (Limited) バッジ**を
    フォーム・管理画面の両方に表示する(選択・予約自体は可能)。
- 当日スロットは現在時刻+1時間以降のみ表示。
- **スロット上限 = そのスロットのライダー人数 × そのスロットの「1ライダーあたりの枠数」**。
  1ライダーあたりの枠数は通常 **4** だが、**スロットごとに個別設定**できる
  (`gas/Code.gs` の `SLOTS_PER_RIDER_BY_SLOT`)。現在の例外は **8:30–9:00 PM = 2**
  (30分枠のため、1ライダーで4件は現実的でない)。
  **ライダー人数もタイムスロットごとに個別設定**でき、デフォルトは以下:

  | 曜日 | タイムスロット | ライダー数 | 1ライダーあたり | 上限枠 |
  |---|---|---|---|---|
  | 月〜金 | 8:00–9:00 / 9:00–10:30 / 7:00–8:30 PM | 1 | 4 | 4 |
  | 月〜金 | **8:30–9:00 PM(30分枠)** | 1 | **2** | **2** |
  | 月〜金 | 上記以外 | 2 | 4 | 8 |
  | **土・日** | **全スロット** | — (無関係) | — | **4(固定)** |

  管理画面でライダー数を変更した場合も、8:30–9:00 PM は **ライダー数 × 2** で計算される
  (例: 2人 → 上限4)。`SlotRiders` シートの D列(Capacity)にもこの計算結果が書き込まれる。
- **土日は一律4枠固定**(`WEEKEND_SLOT_CAP`)。土曜・日曜は上のライダー数計算を一切使わず、
  **全スロットの上限が4**になる。週末最終の 6:30–7:00 PM(30分枠)も **4**。
  管理画面でライダー数を変えても土日の上限は動かず、`SlotRiders` シートの D列にも **4** が記録される。
  手動調整(+1 / −1・数値入力)と日単位の Slot Capacity Override は土日でも有効
  (Override は「管理者が明示的に数値を入れる操作」なので固定値より優先される)。
  管理画面の土日表示には「Weekend: 4 slots (fixed)」の注記が出る。
  今後スロットごとの枠数を変えたい場合は `SLOTS_PER_RIDER_BY_SLOT` に1行足すだけでよい。
  > **注**: 週末最終の 6:30–7:00 PM(18:30)も30分枠だが、今回の指示が 8:30–9:00 PM のみ
  > だったため **4のまま**にしてある。揃える場合は `SLOTS_PER_RIDER_BY_SLOT` に `"18:30": 2` を追加。

  保存先は **`SlotRiders` シート**(Date / Time Slot / Riders / Capacity / Updated At)。
  設定が無い日付・スロットは上記デフォルトにフォールバックする。
  > **注**: 指示票では `RiderSchedule` シートに保存するとあったが、同シートは
  > **ライダーの日次出勤(誰が出勤か)**を保持しており自動アサイン機能が使用中のため、
  > 構造を変えると既存データが壊れる。per-slot容量は別シート `SlotRiders` に分離した。

  優先順位(平日): ①該当(日付, スロット)のライダー数設定 × そのスロットの1ライダーあたり枠数 →
  ②日単位の Slot Capacity Override → ③スロット既定のライダー数 × そのスロットの1ライダーあたり枠数。
  優先順位(土日): ①日単位の Slot Capacity Override → ②`WEEKEND_SLOT_CAP`(=4)。ライダー数は見ない。
  (①が入ったことで、従来の「日単位のライダー人数」は容量計算に使われなくなった —
  全スロットに一律適用されてしまうのが今回直した問題そのもののため)
  ライダー人数を変えるとその日の全スロット上限が連動。GASの **Riders シート**
  (Date / Count / Updated At)に日付ごとの人数と更新日時を保存し、未設定の日は DEFAULT_RIDERS(=2)。
  予約数(集荷+配達、CANCELLED除外)がそのスロットの上限以上、または管理画面でBLOCKされたスロットは
  「FULL」表示で選択不可(フォームは `?action=slots` の `caps` を読むだけなので自動追従する)。
- ライダー人数は **admin.html の Rider Management パネル**で日付ごとに設定(1/2)。フォームは
  `?action=slots` の `caps`(= 人数×1ライダーあたり枠数、または下記の手動上書き値)を読むだけなので、
  変更に自動追従(フォーム側の改修不要)。
- **Slot Capacity Override**: 日単位で全スロットの上限を手動で上書きできる
  (admin.html の Rider Management パネル内)。`Riders` シートの4列目(Capacity Override)に保存。
  per-slotのライダー数設定があるスロットではそちらが優先される。

### §6.1 デリバリー時刻の下限(仕上がり時間ルール)

旧「固定対応表」は廃止。**集荷日時 + そのスピードの所要時間**を下限とし、それ以降に始まるスロットのみ選択可能。

| スピード | 下限 |
|---|---|
| Super Rush | 集荷日時 + **5時間** |
| Rush | 集荷日時 + **8時間**(自称の仕上がり「8–10 hrs」に合わせる) |
| 24 Hours | 集荷日時 + **24時間** |
| Standard | 時間下限なし(従来の「集荷2日後以降」の日数ルールのみ) |

例:
- 24 Hours・集荷 8/25 13:00 → **8/26 13:00 以降**のみ(8/26 09:00 は不可 ← 報告された不具合)
- Rush・集荷 8/25 13:00 → 8/25 21:00 以降
- Super Rush・集荷 8/25 13:00 → **8/25 18:00 以降**

実装:
- 条件を満たさないスロットは **`disabled`(グレーアウト)** で「— too soon」を付けて表示。非表示にはしない
- 集荷日時を変更するとデリバリースロットを**リアルタイムで再計算**し、条件を外れた選択は自動で解除
- Rush / Super Rush で**同日**を選び、その日に条件を満たす枠が1つも無い場合は
  **Lalamove(customer arranges/pays separately)** に自動切替(案内のみ・自動手配はしない)
- **GAS側でも `deliveryWindowError()` で同じ検証**を行い、条件違反のpayloadは
  `{ok:false, reload:true}` を返して**記録しない**(古いタブ・改竄対策)。
  Lalamove配達や解析できない日時は対象外

> **注**: 指示票では「Rush(24時間)」と書かれていたが、本アプリの `rush` は「Same Day (8–10 hrs)」で
> あり、24時間は別スピード `24hrs` である。`rush` に24時間を適用すると同日配達が成立しなくなるため、
> **24時間は `24hrs` に、`rush` には自身の仕上がり時間である8時間**を適用した。

### §6.2 スロットの手動 +1 / −1 調整

フォーム外で受けた予約(電話・店頭・LINE等)も枠を消費させるための仕組み。

- admin.html のスケジュール一覧で、各日付・各タイムスロットに **+1 / −1 ボタン**と
  **数値入力欄**を表示。カウント表示は「使用数 / 上限数」(例: `3 / 8`)で、手動調整分を含んだ数値。
- **数値入力欄**にはそのスロットの**合計予約数**を直接入力する(0以上・そのスロットの上限以下)。
  保存時は「入力値 − フォーム経由の実予約数」を調整値として `SlotAdjustments` に記録する。
  実予約数を下回る値は拒否(実予約はステータス変更でしか減らせないため)。
- **調整値は「追加の予約数」としてカウントする**:
  **実質空き = 上限 − フォーム予約数 − 手動調整数**
  つまり **+1 = 枠を1つ消費**(手動予約を入れた)、**−1 = 枠を1つ戻す**(その手動予約を取り消した)。
- 調整値は **0未満にならない**(自分で足した分だけ戻せる)。フォーム経由の実予約の取り消しは
  従来通り Orders シートの Status を `CANCELLED` にすることで枠が戻る(調整機能とは独立)。
- 保存先は **`SlotAdjustments` シート**(Date / Time Slot / Adjustment / Updated At)。
  調整値が0になった行は削除してシートを綺麗に保つ。
- 公開エンドポイント `?action=slots` の `counts` に調整数を加算して返すため、
  **予約フォーム側は改修不要で自動追従**する(手動調整だけで上限に達したスロットも FULL 表示になる)。

## §7 見積もりの注意

- フォームの金額はすべて概算。確定金額は店頭で計量後に決定(フォーム・完了画面に明記)。

## §8 データ連携(GAS)

- 注文POST → 「Orders」シートに記録(Status列)+Telegram通知。
- **ステータスは4種に統一**: `NEW`(新規注文時のデフォルト)→ `ENCODED` → `PICKED UP` → `DELIVERED`。
  admin.htmlのドロップダウンとSheetsのデータ入力規則(ドロップダウン)を同じ4種に設定する。
  データ入力規則は `allowInvalid: true` — 旧値(WASHING / READY / CANCELLED)が残っている
  既存行を弾いたりフラグを立てたりしないため。**既存の注文データのStatus値は書き換えない**。
  > **注**: 4種に統一した結果 `CANCELLED` が選べなくなった。キャンセル枠を戻す運用は
  > §6.2 の手動 −1 調整で代替できる。CANCELLED を残したい場合は要相談。
- **料金はGAS側で再計算する(サーバーが正)**。フォームはリアルタイム見積もりを表示するが、
  シートに記録されるのは `recomputeGross()` が明細から再導出した金額であり、クライアントの
  `total` は信用しない。`gas/Code.gs` の `PRICE_LOAD_TYPES` / `PRICE_SPEEDS` / `PRICE_ADDONS` は
  `index.html` の `LOAD_TYPES` / `SPEEDS` / `ADDONS` の写しで、**両者が一致することを自動テストで検証**している
  (片方だけ変更すると即座にテストが落ちる)。
  - 再計算には明細の `type` id が必要。アドオンは表示文字列に加えて `addonIds` を送信する。
  - 未知の `type` / `speed` / アドオンidを含むなど**再導出できないpayloadはクライアント値にフォールバック**する
    (0円で記録して取りこぼすより安全側に倒す)。ログに警告を残す。
  - 割引もサーバー側grossから再計算し、**プロモコード無しで `discount` だけ申告された場合は無視**する。
- `GET ?action=slots&date=` … スロット空き状況(公開)/ `GET ?action=day&date=&key=` … 管理画面用の予約一覧(要ADMIN_KEY)/ `POST {action:"block"}` … スロットのBLOCK/UNBLOCK。
- `GET ?action=promo&code=` … プロモコード検証(公開)/ `GET ?action=promos&key=` … コード一覧(要ADMIN_KEY)/ `POST {action:"promo", op:"save"|"toggle"|"delete"}` … コード管理。PromoCodesシートに保存。
- `GET ?action=riders&date=&key=` … その日のライダー人数・スロット上限・手動上書き値取得(要ADMIN_KEY、`capOverride` を含む)/
  `POST {action:"riders", date, count?, capOverride?}` … 人数設定・スロット上限の手動上書き。count/capOverrideは
  どちらか一方だけ送っても他方は変更されない(count省略でcapOverrideだけ更新、など)。Ridersシートに保存
  (DEFAULT人数かつ上書きなしの場合は行ごと削除)。
- `GET ?action=riderRoster&key=` … ライダー名簿取得(要ADMIN_KEY)/ `POST {action:"riderRoster", op:"save"|"toggle"|"delete", riderId?, name, chatId, baseAddress}` … 名簿の登録・編集・有効/無効切替・削除。RiderRosterシートに保存(住所変更時のみ再ジオコード)。
- `GET ?action=riderSchedule&date=&key=` … 指定日の全ライダーと出勤状況(要ADMIN_KEY)/ `POST {action:"riderSchedule", date, entries:[{riderId, onDuty}]}` … その日の出勤を保存(RiderScheduleシート、同日は上書き)。
- `POST {action:"reassignRider", receiptNo, riderId}` … 注文の担当ライダーを手動で再アサインし、新しい担当者にTelegram再通知(要ADMIN_KEY)。
- `POST {action:"updateStatus", receiptNo, status, updatedBy}` … 注文のStatusを変更し、`Status Updated By` /
  `Status Updated At` に担当者名と日時を記録(要ADMIN_KEY、`status` はSTATUSESのいずれかでない場合は拒否)。
  `GET ?action=day` のbookingsに `statusUpdatedBy` / `statusUpdatedAt` として返る。
- `POST {action:"slotRiders", date, slot, riders}` … そのスロットのライダー数を設定
  (上限枠 = riders × そのスロットの1ライダーあたり枠数)。riders 0 で設定を消してデフォルトに戻す。
  土日は riders の値によらず D列(Capacity)に **4** を記録する。
  `SlotRiders` シートに保存(要ADMIN_KEY)。`GET ?action=day` は各スロットの1ライダーあたり枠数を
  `slotsPerRider:{slot:n}` として返すので、管理画面は上限を正しく逆算できる。
  さらに `weekend:true|false` と `weekendCap:4` を返し、管理画面はこれで土日の注記を出す。
- `POST {action:"slotAdjust", date, slot, adjustment}` … 手動調整値を**絶対値で**設定(数値入力欄用)。
  従来の `delta: 1|-1` も引き続き使える。
- `POST {action:"orderPhoto", receiptNo, name, fileName, mimeType, data(base64)}` … 洗濯物写真を
  Driveに保存し、Ordersシートの `Photo URL` 列に追記、担当ライダーへTelegram通知(§8.2)。
- `GET ?action=slots&date=` は `{cap, caps:{slot:上限}, counts}` を返す。**`caps` がスロット別の正**で、
  `cap` は旧クライアント向けのフォールバック。
- `setupSheet()` は Orders / BlockedSlots / SlotAdjustments / SlotRiders / PromoCodes / Riders /
  RiderRoster / RiderSchedule の各シートを作成。

### §8.2 洗濯物の写真アップロード(任意)

- **タイミング**: 注文送信完了後の Thank you 画面。注文自体は既に確定している。
- 説明文(EN/TL併記)と「Choose photo(s)」ボタンを表示。
  - EN: "If you'll be leaving your laundry at your building's pickup area, upload a photo so our rider can identify it easily."
  - TL: "Kung iiwan mo ang labada sa pickup area ng inyong building, mag-upload ng larawan para madali itong makilala ng aming rider."
- 対応形式 JPG / PNG / HEIC、1枚最大10MB、**最大3枚**、スキップ可。
- **1リクエスト1枚**で順次送信する(base64で約1.33倍に膨らむため、3枚同時はGASのPOSTサイズ上限に触れる)。
- 保存先: `DRIVE_FOLDER_ID`(Script Properties)配下の `YYYY-MM / [注文ID]_[顧客名]`。
  注文IDから年月を取り出せない場合は `unfiled` に入れる。顧客名のパス禁止文字は除去。
- ファイルは「リンクを知っている全員が閲覧可」に設定(ライダーがGoogleログイン無しで開けるようにするため)。
- Ordersシートの **`Photo URL` 列**に追記(複数枚はカンマ区切り)。
- 担当ライダーのTelegramへ `📷 Customer uploaded laundry photo(s): [リンク]` を送信。
- アップロード中はローディング表示、完了時は成功メッセージ。**失敗しても注文は成立している**旨を明示する。

### §8.1 ライダー自動アサイン機能

- 注文が確定すると、**Address + Barangay + City を結合した文字列**を Google Geocoding API で座標変換し、その日
  **Active かつ出勤中(On Duty)** のライダーのうち拠点座標から直線距離(Haversine)が最も近い1人へ自動アサインする
  (Barangay/Cityを含めないと同名の通り/バランガイが複数都市に存在する場合に誤った座標になりうるため必ず結合する)。
  Ordersシートの Address列自体にはBarangay/Cityを結合せず、Address/Barangay/Cityは別列のまま保存する。
- Ordersシートに `Assigned Rider` / `Rider ID` / `Distance (km)` / `Assigned At` / `City` /
  `Status Updated By` / `Status Updated At` / `Barangay` の各列を追加記録し(いずれも既存データを壊さないよう末尾に追加)、
  アサインされたライダーへ以下のフォーマットでTelegram通知を送信する(住所欄はAddress+Barangay+Cityの結合値):
  ```
  🛵 New Order Assigned!
  👤 Customer: [名前] 📍 Address: [住所, Barangay, City] 📦 Order: [サービス内容] 🕐 Pickup: [日時] 🕐 Delivery: [日時] 💰 Total: ₱[金額]
  📌 Map: https://maps.google.com/?q=[緯度],[経度]
  ```
- 住所が座標変換できない場合、またはその日 出勤中のライダーが0人の場合は `未アサイン` として記録し、
  注文自体の記録・オーナーへの既存通知は通常どおり行われる(アサイン処理の失敗が注文記録をブロックしない)。
  出勤中ライダーが0人のときはオーナーのTelegramに `⚠️ No riders on duty today!` を送信する。
  Script Properties に `GEOCODING_API_KEY` が未設定の場合も同様に `未アサイン` になる。
  座標変換に失敗した場合(住所不明・APIエラー)は自動アサインをスキップするのみで、注文の記録・通知は継続する。
- admin.html の Riders パネルからライダー名簿の登録・編集・出勤管理・手動での再アサインができる(§「管理画面」参照)。
