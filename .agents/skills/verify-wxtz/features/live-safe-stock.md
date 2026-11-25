# Live safe stock calculator

Live safe stock calculator lets an operator compute tonight's Douyin livestream sellable ceiling per style from active `live`-pool weavers' free hours, shared yarn inventory, and ready stock without double-selling shared capacity.

## Sub-features

- `stock-connect-live` switches the Admin Console from local demo mode to the live `wxtz-api` backend.
- `stock-calc-weights` computes `readyStock`, `craftCapacity`, and `totalSafeQty` for `TZ-SASA-01` and `TZ-PAPA-01` across custom horizon days and share weights.
- `stock-api-parity` returns the identical `SafeStockEntry` map from `admin.liveSafeStockPlan` via CLI.

## How to get to it (user POV)

- Open the Admin Console root URL (`/`), which lands on tab `① 开播安全库存 & 免税水位` (`ws-stock`) by default, or click `button[data-panel="ws-stock"]`.
- Enter `#endpointInput` and `#jwtInput`, set `#horizonDays`, `#weightSasa`, `#weightPapa`, and click `一键试算今晚可挂库存` (`#btnCalcStock`).

## Driving it with ego-browser and control-wxtz

Preconditions:

- `control-wxtz.mjs doctor --run-id <RUN_ID>` reports `ok: true`.
- `usr_w_live_01` (`live` pool) has 6 skeins `YARN-WHITE-01`, 4 skeins `YARN-PINK-02`, and 2 units `TZ-SASA-01` in `weaverStock`.

- **Connect live backend.** Open `baseUrl` in `ego-browser`, fill `#endpointInput` with `meta.apiUrl` and `#jwtInput` with `meta.adminToken`. Wait until `#modeBadge` text includes `已连 CloudBase 生产接口`.
- **Calculate safe stock.** Fill `#horizonDays` with `"5"`, `#weightSasa` with `"70"`, `#weightPapa` with `"30"`, and click `#btnCalcStock` (`{ label: "calculate live safe stock" }`). Wait until `#stockResult` contains `TZ-SASA-01` and `TZ-PAPA-01`. Observe `TZ-SASA-01` showing `余货直发 3` (2 on `usr_w_live_01` + 1 on `usr_w_mp_02`) plus positive `排产净产能`.
- **CLI parity check.** Run `control-wxtz.mjs api --run-id <RUN_ID> --role admin --action admin.liveSafeStockPlan --payload '{"horizonDays":5,"shareWeights":{"TZ-SASA-01":70,"TZ-PAPA-01":30}}'`. Exit code `0` and JSON `data["TZ-SASA-01"].totalSafeQty` match the rendered browser numbers.
- **Proof.** Capture `page.snapshot({ scope: "full_page" })` to `.verify-artifacts/<RUN_ID>/ws-stock.snapshot.txt` and `page.screenshot({ path: ".../ws-stock.png" })`.

## Gotchas

- Leaving `#endpointInput` empty computes a hardcoded demo formula (`余货直发 4`) instead of querying `@wxtz/cloud`. Always verify `#modeBadge` reads `已连 CloudBase 生产接口`.
- `admin.liveSafeStockPlan` requires a valid Admin JWT; an empty `#jwtInput` renders `[FORBIDDEN] 缺少运营后台登录凭证` inside `#stockResult`.
