---
name: verify-wxtz
description: >-
  Drive and verify the wuxiantianzhen (无限天真 / 织女平台) Admin Web Console
  (packages/admin, 6 operational workspaces) and unified wxtz-api cloud router
  (@wxtz/cloud across admin, mp-weaver, mp-buyer, volunteer, webhook, and cron).
  Use this skill whenever proving UI, API, dispatch, CSV import/export, funnel,
  or double-entry ledger behavior in this repository.
---

# Verify wuxiantianzhen (`verify-wxtz`)

This skill drives the real `packages/admin` operational web console in `ego-browser` connected to a live local `wxtz-api` HTTP server backed by `@wxtz/cloud` (`dispatchCloudAction`), and verifies side effects via an independent read-only DB snapshot inspector. Read [features/README.md](./features/README.md) first to select the journey(s) matching your change.

On this machine, invoke Node v22 via `/Users/sparrow/.local/share/pi-node/node-v22.23.1-darwin-arm64/bin/node` (or `node` if Node >= 22 is on `PATH`), and invoke `ego-browser` via `/Users/sparrow/.local/bin/ego-browser`. When an agent sandbox restricts local port binding, `~/.local/share/pi-node`, or macOS XPC (`ego lite.app`), retry `control-wxtz.mjs` and `ego-browser nodejs` with full host access (`BypassSandbox: true`).

## Launch

Start an isolated verification instance with its own disposable data directory (`/tmp/wxtz-verify-<RUN_ID>`), ephemeral OS-assigned port (`--port 0`), seeded baseline fixtures, and persistent proof directory (`.verify-artifacts/<RUN_ID>/`):

```bash
/Users/sparrow/.local/share/pi-node/node-v22.23.1-darwin-arm64/bin/node \
  .agents/skills/verify-wxtz/scripts/control-wxtz.mjs launch --run-id <RUN_ID>
```

`launch` links workspace packages, starts [verify-server.ts](./scripts/verify-server.ts) in the background, waits until both `GET /__doctor` and an authenticated `POST /wxtz-api` (`admin.overview`) succeed, and prints JSON containing `pid`, `baseUrl`, `apiUrl`, `adminToken`, `dataDir`, and `artifactsDir`. Multiple runs with distinct `--run-id` values run side by side without port or state collisions.

## Doctor

Before driving an instance (or whenever behavior looks unexpected), run the read-only health check:

```bash
/Users/sparrow/.local/share/pi-node/node-v22.23.1-darwin-arm64/bin/node \
  .agents/skills/verify-wxtz/scripts/control-wxtz.mjs doctor --run-id <RUN_ID>
```

`doctor` verifies four invariants:
1. The recorded `pid` in `/tmp/wxtz-verify-<RUN_ID>/instance.json` is alive.
2. `GET /__doctor` answers with `service: "wxtz-verify-server"` and the exact expected `dataDir`.
3. `gitHead` on the running server matches `git rev-parse --short HEAD` of the checkout.
4. `POST /wxtz-api` (`admin.overview`) succeeds with the instance's `adminToken`.

Never drive a port that fails `doctor`.

## Drive

### 1. Browser surface (`packages/admin` 6-workspace console via `ego-browser`)

First run `/Users/sparrow/.local/bin/ego-browser skill` once per session if you have not loaded the `ego-browser` API guide. Then open a `taskSpace`, load `baseUrl`, and bind the console to the live `wxtz-api` backend by filling `#endpointInput` with `apiUrl` and `#jwtInput` with `adminToken`:

```bash
/Users/sparrow/.local/bin/ego-browser nodejs <<'EOF'
const fs = await import("node:fs");
const meta = JSON.parse(fs.readFileSync("/tmp/wxtz-verify-<RUN_ID>/instance.json", "utf8"));
const task = await taskSpace("verify-wxtz-<RUN_ID>");
const page = task.page("p1");
await page.goto(meta.baseUrl);
await page.fill("#endpointInput", meta.apiUrl);
await page.fill("#jwtInput", meta.adminToken);
await page.waitForFunction(
  () => document.querySelector("#modeBadge")?.textContent?.includes("已连 CloudBase 生产接口"),
  undefined,
  { timeout: 5000 },
);
console.log({ taskSpaceId: task.spaceId, page: page.label });
console.log(await page.snapshot({ scope: "full_page" }));
EOF
```

Stable handles in `packages/admin/index.html`:
- Topbar auth: `#endpointInput`, `#jwtInput`, `#modeBadge` (must read `已连 CloudBase 生产接口`; if left blank, the page runs local static demo data instead of hitting `@wxtz/cloud`!).
- Workspace tabs (`#workspaceNav`):
  - `button[data-panel="ws-stock"]` — ① 开播安全库存 & 免税水位 (`#horizonDays`, `#weightSasa`, `#weightPapa`, `#btnCalcStock`, `#stockResult`, `#taxCurrentText`)
  - `button[data-panel="ws-csv"]` — ② 抖店双CSV强校验导单 (`#orderCsvJson`, `#refundCsvJson`, `#chkZeroRefund`, `#btnPreviewCsv`, `#btnCommitCsv`, `#csvResult`)
  - `button[data-panel="ws-ship"]` — ③ 中通吉分组待打单 & 卡单 (`#readyShipGroups`, `#manualHoldList`)
  - `button[data-panel="ws-funnel"]` — ④ 漏斗实检/保证金 & 10s仲裁 (`#arbitrateList`, `button[data-approve="true"]`, `#funnelUserId`, `#funnelWeaverNo`, `#funnelDepositRef`, `#btnApproveWeaver`, `#funnelResult`)
  - `button[data-panel="ws-yarn"]` — ⑤ 江浙沪周度线材ERP导出 (`#yarnWeekKey`, `#btnExportYarnCsv`, `#yarnCsvPreview`)
  - `button[data-panel="ws-payout"]` — ⑥ 14天网银结款 & 账本对账 (`#btnExportBankCsv`, `#btnConfirmBankPaid`, `#bankCsvPreview`, `#reconcileBanner`)

When finished with browser actions in a reply, close the `taskSpace` cleanly in a separate final script:

```bash
/Users/sparrow/.local/bin/ego-browser nodejs -e 'const task = await taskSpace(<SPACE_ID>); await task.finish({ keep: [] });'
```

### 2. Cloud API & Mini-Program surface (`control-wxtz.mjs api`)

Exercise `mp-weaver`, `mp-buyer`, `volunteer`, `admin`, `webhook.wxpay`, and `cron.*` routes against the exact same live server state:

```bash
# Admin route
/Users/sparrow/.local/share/pi-node/node-v22.23.1-darwin-arm64/bin/node \
  .agents/skills/verify-wxtz/scripts/control-wxtz.mjs api \
  --run-id <RUN_ID> --role admin --action admin.overview

# Buyer Mini-Program route
/Users/sparrow/.local/share/pi-node/node-v22.23.1-darwin-arm64/bin/node \
  .agents/skills/verify-wxtz/scripts/control-wxtz.mjs api \
  --run-id <RUN_ID> --role mp-buyer --openid oid_b_verify_01 \
  --action auth.login --payload '{"phone":"13966668888"}'

# Internal webhook / cron trigger
/Users/sparrow/.local/share/pi-node/node-v22.23.1-darwin-arm64/bin/node \
  .agents/skills/verify-wxtz/scripts/control-wxtz.mjs api \
  --run-id <RUN_ID> --role internal --action cron.dispatchTick
```

### 3. Read-only second view (`control-wxtz.mjs inspect`)

Verify persisted mutations directly from `/tmp/wxtz-verify-<RUN_ID>/db.json`:

```bash
# Collection counts + external port call logs (prepays, refunds, imageChecks, pickups)
/Users/sparrow/.local/share/pi-node/node-v22.23.1-darwin-arm64/bin/node \
  .agents/skills/verify-wxtz/scripts/control-wxtz.mjs inspect --run-id <RUN_ID>

# Inspect a specific collection or document
/Users/sparrow/.local/share/pi-node/node-v22.23.1-darwin-arm64/bin/node \
  .agents/skills/verify-wxtz/scripts/control-wxtz.mjs inspect \
  --run-id <RUN_ID> --collection auditLog
```

## Evidence

Store all proof artifacts under `/Users/sparrow/wuxiantianzhen/.verify-artifacts/<RUN_ID>/` (gitignored so proofs survive teardown without dirtying `git status`):
- **UI proof**: Save both a semantic accessibility snapshot (`<feature>.snapshot.txt`) and a visual PNG screenshot (`<feature>.png` via `page.screenshot({ path: "/Users/sparrow/wuxiantianzhen/.verify-artifacts/<RUN_ID>/<feature>.png" })`) showing `#modeBadge` (`已连 CloudBase 生产接口`) and the resulting state.
- **Download proof**: When testing CSV export buttons (`#btnExportYarnCsv`, `#btnExportBankCsv`), arm `page.waitForEvent("download")` before clicking and call `await download.saveAs(...)` into `.verify-artifacts/<RUN_ID>/`.
- **Mutation proof**: Pair every mutating UI or API action with `control-wxtz.mjs inspect --run-id <RUN_ID> --collection <col>` saved to `.verify-artifacts/<RUN_ID>/<feature>.db.json` confirming actual stored rows (`orderPackages`, `photoReviews`, `recruitFunnel`, `weaverAccounts`, `ledgerEntries`, `yarnClaims`, `settlementBatches`, `auditLog`).
- **Stand-in boundaries**: `verify-server.ts` executes the real `@wxtz/shared` + `@wxtz/cloud` TypeScript code and serves the real `packages/admin` frontend over local HTTP using `InMemoryDb` and `createMockExternalPorts()`. It does NOT verify live Tencent CloudBase collection indexes/permissions, real WeChat Mini-Program WebView rendering, live WeChat Pay V3 RSA signatures, Kuaidi100 webhooks, or ZTO Ji (`service_id=50`) production credentials.

## Cleanup

Always tear down the instance after verification (including after failed iterations):

```bash
/Users/sparrow/.local/share/pi-node/node-v22.23.1-darwin-arm64/bin/node \
  .agents/skills/verify-wxtz/scripts/control-wxtz.mjs cleanup --run-id <RUN_ID>
```

`cleanup` sends `SIGTERM` only to the exact `pid` recorded in `/tmp/wxtz-verify-<RUN_ID>/instance.json` (never killing processes by name), deletes `/tmp/wxtz-verify-<RUN_ID>`, and verifies that `/Users/sparrow/wuxiantianzhen/.verify-artifacts/<RUN_ID>/` and all captured proof files remain intact on disk.

## Helpers

- [control-wxtz.mjs](./scripts/control-wxtz.mjs): Lifecycle & inspection CLI (`launch`, `doctor`, `api`, `inspect`, `cleanup`).
- [verify-server.ts](./scripts/verify-server.ts): Disposable local HTTP server hosting `packages/admin` static assets, `POST /wxtz-api` (`dispatchCloudAction`), `GET /__doctor`, and atomic `db.json` state snapshots.
- [features/README.md](./features/README.md): Maintained index of user-facing journeys across all 6 Admin Console workspaces and `wxtz-api` cross-end flows.
