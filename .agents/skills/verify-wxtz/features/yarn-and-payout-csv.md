# Weekly JZH yarn CSV and 14-day bank payout

Weekly JZH yarn CSV and 14-day bank payout let operations export supplier-ready yarn fulfillment CSVs (atomically marking weekly claims `dispatched`) and generate/confirm corporate bank batch payout CSVs (settling accruedweaver craft fees while preserving zero-diff double-entry accounting).

## Sub-features

- `yarn-export-csv` exports `2026W48` confirmed yarn claims with `supplierSkuCode` (`JZH-4P-001`), triggers browser CSV download, and transitions claims to `dispatched`.
- `payout-export-csv` creates a `settlementBatches` document from accrued net craft fees (`EXP_CRAFT_COST` strictly separated from yarn) and downloads the bank CSV.
- `payout-confirm-paid` marks the batch `paid`, transitions covered packages to `settled`, debits `LIAB_WEAVER_PAYABLE`, and maintains `0 Fen` reconciliation diff.

## How to get to it (user POV)

- Click `⑤ 江浙沪周度线材ERP导出` (`button[data-panel="ws-yarn"]`), confirm `#yarnWeekKey` (`2026W48`), and click `#btnExportYarnCsv`.
- Click `⑥ 14天网银批量结款 & 账本对账` (`button[data-panel="ws-payout"]`), click `#btnExportBankCsv`, then click `#btnConfirmBankPaid`.

## Driving it with ego-browser and control-wxtz

Preconditions:

- Console is connected to live `wxtz-api`.
- Baseline seed includes confirmed claim `claim_usr_w_live_01_2026W48` and accrued package `pkg_settled_seed_01` (`2500` Fen net craft payable on `usr_w_live_01`).

- **Export weekly supplier yarn CSV.** Click `button[data-panel="ws-yarn"]` (`{ label: "open yarn export workspace" }`). Arm `const dl1 = page.waitForEvent("download", { timeout: 10000 })`, click `#btnExportYarnCsv` (`{ label: "export supplier yarn csv" }`), and save download via `await (await dl1).saveAs("/Users/sparrow/wuxiantianzhen/.verify-artifacts/<RUN_ID>/jzh-yarn-2026W48.csv")`. `#yarnCsvPreview` displays CSV rows containing `WV-JZH-001` and `JZH-4P-001`.
- **Export 14-day bank payout CSV.** Click `button[data-panel="ws-payout"]` (`{ label: "open bank payout workspace" }`). Arm `const dl2 = page.waitForEvent("download", { timeout: 10000 })`, click `#btnExportBankCsv` (`{ label: "export bank payout csv" }`), and save download via `await (await dl2).saveAs("/Users/sparrow/wuxiantianzhen/.verify-artifacts/<RUN_ID>/bank-payout.csv")`. `#bankCsvPreview` displays `林织巧,6214830012348821,25.00` and `共1包`.
- **Confirm bank remittance.** Click `#btnConfirmBankPaid` (`{ label: "confirm bank batch paid" }`). `#bankCsvPreview` updates to `✅ 批次 ... 已核销：共完成 1 位织女汇款（结清 1 个订单包）。`
- **Mutation & reconciliation proof.** Run `control-wxtz.mjs inspect --run-id <RUN_ID> --collection yarnClaims` (`status === "dispatched"`), `--collection orderPackages --id pkg_settled_seed_01` (`status === "settled"`), and `control-wxtz.mjs api --run-id <RUN_ID> --role internal --action cron.dailySettleAndReconcile` (`mismatches: []`). Capture screenshot `.verify-artifacts/<RUN_ID>/ws-payout.png`.

## Gotchas

- Both `#btnExportYarnCsv` and `#btnExportBankCsv` trigger `<a download>` file downloads in Chromium; arm `page.waitForEvent("download")` before clicking and call `saveAs()` before the `ego-browser` script round ends.
- Exporting the same `weekKey` a second time returns `exportedClaimCount: 0` because claims already moved from `confirmed` to `dispatched`.
