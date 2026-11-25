# Douyin dual-CSV import guard

Douyin dual-CSV import guard prevents refunded livestream orders from being dispatched to weavers by blocking order CSV imports unless a matching after-sale refund CSV is uploaded or the operator explicitly confirms zero refunds today.

## Sub-features

- `csv-block-missing-refund` blocks both Dry-Run preview and formal commit when `#refundCsvJson` is blank and `#chkZeroRefund` is unchecked.
- `csv-dry-run-pass` previews new and merged order counts once `#chkZeroRefund` is checked (or `#refundCsvJson` is provided).
- `csv-commit-persist` imports Douyin orders into `orderPackages` (`confirming`) and writes an immutable `auditLog` entry.

## How to get to it (user POV)

- Click navigation tab `② 抖店双CSV强校验导单` (`button[data-panel="ws-csv"]`).
- Paste order rows in `#orderCsvJson`, optionally paste refund rows in `#refundCsvJson` or check `#chkZeroRefund`, then click `第一步：Dry-Run 预检` (`#btnPreviewCsv`) followed by `第二步：正式导入并进入冷静期队列` (`#btnCommitCsv`).

## Driving it with ego-browser and control-wxtz

Preconditions:

- Console is connected to live `wxtz-api` (`#modeBadge` shows `已连 CloudBase 生产接口`).
- `#refundCsvJson` is empty and `#chkZeroRefund` is unchecked by default.

- **Switch to CSV workspace.** Click `button[data-panel="ws-csv"]` (`{ label: "open douyin csv tab" }`). `#ws-csv.panel.active` becomes visible with 2 prefilled order rows (`DY20261124001`, `DY20261124002`).
- **Verify hard block without refund CSV.** Click `#btnPreviewCsv` (`{ label: "preview csv without refund ack" }`). `#csvResult` displays `⛔ Dry-Run 预检拦截` mentioning the missing refund table. Click `#btnCommitCsv`; `#csvResult` displays `⛔ 强校验拦截：[VALIDATION_ERROR]`.
- **Check zero-refund confirmation and Dry-Run.** Click `#chkZeroRefund` (`{ label: "confirm zero refunds today" }`), then click `#btnPreviewCsv`. `#csvResult` updates to `🔍 Dry-Run 预检通过：新增订单 2 笔`.
- **Formal commit.** Click `#btnCommitCsv` (`{ label: "commit douyin csv import" }`). `#csvResult` updates to `✅ 正式导入成功：新建包裹 2 单`.
- **Mutation proof.** Run `control-wxtz.mjs inspect --run-id <RUN_ID> --collection orderPackages` and `control-wxtz.mjs inspect --run-id <RUN_ID> --collection auditLog`. Confirm 2 new `confirming` packages containing `DY20261124001` and `DY20261124002`, plus a `commitDouyinCsv` audit record. Save screenshot `.verify-artifacts/<RUN_ID>/ws-csv.png`.

## Gotchas

- Excel scientific-notation order IDs (such as `6.9123E+18`) in either `#orderCsvJson` or `#refundCsvJson` are intentionally rejected by `previewDouyinImport` and `commitDouyinImport`.
- Re-clicking `#btnCommitCsv` with the same `externalOrderId` values is idempotent and creates `0` duplicate packages.
