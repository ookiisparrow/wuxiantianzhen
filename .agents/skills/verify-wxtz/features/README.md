# wuxiantianzhen verification map

This directory is the maintained source for verifying user-facing and operator-facing behavior of **无限天真 (`wuxiantianzhen`)**. Read this index before driving the app, then follow the matching feature recipe.

## Baseline preconditions

- Launch an isolated instance with `control-wxtz.mjs launch --run-id <RUN_ID>` so `/tmp/wxtz-verify-<RUN_ID>` holds disposable seeded state and `.verify-artifacts/<RUN_ID>` holds persistent proof artifacts.
- Run `control-wxtz.mjs doctor --run-id <RUN_ID>` and require `ok: true` with matching `gitHead` and `dataDir`.
- Baseline seeded entities created by `verify-server.ts`:
  - Yarns: `YARN-WHITE-01` (`JZH-4P-001`, 50g, ¥4.00) and `YARN-PINK-02` (`JZH-4P-002`, 50g, ¥4.20).
  - Styles & Products: `TZ-SASA-01` (90 min, `prod_sasa_ready` + `prod_sasa_mto`) and `TZ-PAPA-01` (110 min, `prod_papa_mto`).
  - Active weavers: `usr_w_live_01` (`WV-JZH-001`, `live` pool, 2 units `TZ-SASA-01` ready stock, ¥25.00 net payable accrued, confirmed `2026W48` yarn claim) and `usr_w_mp_02` (`WV-JZH-002`, `mp` pool, 1 unit `TZ-SASA-01` ready stock).
  - Funnel candidate: `usr_hz_candidate_01` at `pending_deposit` (ready for Step 4 ¥200 deposit approval as `WV-JZH-018`).
  - Operational queue: `pkg_ready_seed_01` (`ready_to_ship`), `pkg_hold_seed_01` (`manual_hold`), and `rev_sla_seed_01` (`needs_admin` for `pkg_review_seed_01`).
- In `ego-browser`, always fill `#endpointInput` and `#jwtInput` first and confirm `#modeBadge` reads `已连 CloudBase 生产接口`. Never verify backend behavior while `#modeBadge` reads `本地交互沙盒模式`.

## Driving conventions

- Start each journey from a fresh `--run-id` baseline unless chaining non-conflicting workspaces purposefully.
- Drive web UI interactions via `/Users/sparrow/.local/bin/ego-browser nodejs` using exact IDs and `data-panel` attributes from `packages/admin/index.html`.
- Drive Mini-Program, webhook, and cron calls via `control-wxtz.mjs api --run-id <RUN_ID>`.
- Confirm persisted state via `control-wxtz.mjs inspect --run-id <RUN_ID> --collection <name>`.
- Always close the `ego-browser` `taskSpace` with `await task.finish({ keep: [] })` and run `control-wxtz.mjs cleanup --run-id <RUN_ID>` at the end.

## Proof and skip reporting

- Capture both the user action and the resulting state.
- UI proof requires a semantic snapshot (`.snapshot.txt`) and a PNG screenshot (`.png`) showing `#modeBadge` (`已连 CloudBase 生产接口`) plus the workspace result.
- Mutation proof requires a `control-wxtz.mjs inspect` readout confirming stored database documents and `auditLog` / `ledgerEntries` rows.
- Report any unreachable path with the attempted command and unmet precondition; never report local static sandbox mode as live backend verification.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing user-visible behavior, followed by four H2 sections in order:
1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with ego-browser and control-wxtz`
4. `Gotchas`

## Features

- [Live safe stock calculator](./live-safe-stock.md) covers Workspace ① (`ws-stock`) dual-bucket live capacity calculation across shared yarn and time horizons.
- [Douyin dual-CSV import guard](./douyin-dual-csv.md) covers Workspace ② (`ws-csv`) zero-refund hard block, dry-run preview, formal import, and `orderPackages` persistence.
- [Shipping overview, 10s arbitration, and funnel approval](./funnel-and-arbitration.md) covers Workspaces ③ (`ws-ship`) and ④ (`ws-funnel`) live overview rendering, 2h SLA photo arbitration, and ¥200 deposit weaver activation.
- [Weekly JZH yarn CSV and 14-day bank payout](./yarn-and-payout-csv.md) covers Workspaces ⑤ (`ws-yarn`) and ⑥ (`ws-payout`) supplier CSV download, corporate bank payout batch export, and remittance confirmation.
- [Mini-Program to cloud full lifecycle](./mp-and-cloud-lifecycle.md) covers `mp-buyer` order & ready-stock lock, `webhook.wxpay`, `cron.dispatchTick`, `mp-weaver` offer acceptance & seal, and `cron.dailySettleAndReconcile` zero-diff ledger check.
