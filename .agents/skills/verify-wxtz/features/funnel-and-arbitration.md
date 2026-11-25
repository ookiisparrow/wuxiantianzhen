# Shipping overview, 10s arbitration, and funnel approval

Shipping overview, 10s arbitration, and funnel approval let operations view live ready-to-ship and manual-hold parcels, resolve 2-hour SLA escalated blind photo reviews in one click, and activate Step 4 candidate weavers upon ¥200 deposit verification.

## Sub-features

- `ship-live-overview` renders live `ready_to_ship` (`pkg_ready_seed_01`) and `manual_hold` (`pkg_hold_seed_01`) packages from `admin.overview`.
- `funnel-10s-arbitrate` approves escalated review `rev_sla_seed_01`, moving `pkg_review_seed_01` from `photo_review` to `awaiting_seal`.
- `funnel-approve-deposit` posts `20000` Fen into `LIAB_WEAVER_DEPOSIT` (`deposit_in:usr_hz_candidate_01`) and activates `usr_hz_candidate_01` as `WV-JZH-018` in the `mp` pool.

## How to get to it (user POV)

- Click `③ 中通吉分组待打单 & 卡单` (`button[data-panel="ws-ship"]`) to inspect `#readyShipGroups` and `#manualHoldList`.
- Click `④ 漏斗实检/保证金 & 10s仲裁` (`button[data-panel="ws-funnel"]`) to click `10秒通过` in `#arbitrateList` and `确认 ¥200 保证金入负债专户 · 正式开通织女` (`#btnApproveWeaver`).

## Driving it with ego-browser and control-wxtz

Preconditions:

- Console is connected to live `wxtz-api`.
- Baseline seed includes `pkg_ready_seed_01`, `pkg_hold_seed_01`, `rev_sla_seed_01` (`needs_admin`), and `usr_hz_candidate_01` (`pending_deposit`).

- **Inspect Workspace ③.** Click `button[data-panel="ws-ship"]` (`{ label: "open shipping workspace" }`). Wait until `#readyShipGroups` contains `pkg_ready_seed_01` and `#manualHoldList` contains `pkg_hold_seed_01`.
- **10-second SLA arbitration in Workspace ④.** Click `button[data-panel="ws-funnel"]` (`{ label: "open funnel and arbitration tab" }`). Wait until `#arbitrateList` shows `rev_sla_seed_01`. Click `button[data-rev="rev_sla_seed_01"][data-approve="true"]` (`{ label: "approve escalated photo review" }`). The row updates to `✅ 已完成 10 秒仲裁 (rev_sla_seed_01)：通过并解锁扫码装袋`.
- **Approve ¥200 weaver deposit.** Verify `#funnelUserId` is `usr_hz_candidate_01` and `#funnelWeaverNo` is `WV-JZH-018`, then click `#btnApproveWeaver` (`{ label: "approve weaver deposit" }`). `#funnelResult` updates to `🎉 已入账 ¥200 负债专户并正式开通织女 WV-JZH-018（初始排产池：mp）！`.
- **Mutation proof.** Run `control-wxtz.mjs inspect --run-id <RUN_ID> --collection orderPackages --id pkg_review_seed_01` (`status === "awaiting_seal"`), `--collection users --id usr_hz_candidate_01` (`funnelStage === "approved"`, `weaverNo === "WV-JZH-018"`), and `--collection weaverAccounts --id acc_usr_hz_candidate_01` (`depositFen === 20000`). Capture screenshot `.verify-artifacts/<RUN_ID>/ws-funnel.png`.

## Gotchas

- Clicking `button[data-panel="ws-funnel"]` triggers `refreshOverview()`, which re-renders `#arbitrateList` from live `admin.overview`. Wait for `button[data-rev="rev_sla_seed_01"]` before clicking so the refresh does not replace the DOM node mid-click.
- `admin.funnelApproveDeposit` requires the candidate's `recruitFunnel.stage` to be `"pending_deposit"`; calling it a second time on an already-approved user returns `INVALID_STATE_TRANSITION`.
