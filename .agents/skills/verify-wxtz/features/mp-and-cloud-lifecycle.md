# Mini-Program to cloud full lifecycle

Mini-Program to cloud full lifecycle verifies end-to-end cross-role state transitions through `POST /wxtz-api`: a buyer logs in, saves an address, orders a ready-stock item, completes WeChat Pay webhook confirmation, triggers dispatch to a weaver, the weaver accepts (`offered -> awaiting_seal` with zero double yarn deduction) and seals with a bag QR sticker (`ready_to_ship`), and daily reconciliation confirms zero ledger discrepancy.

## Sub-features

- `mp-buyer-order-lock` logs in an `mp-buyer` user, saves a `buyer_recv` address, creates a `ready_stock` order locking 1 unit on `weaverStock`, and commits payment via `webhook.wxpay`.
- `mp-dispatch-stock-reuse` dispatches the paid order at `stock` tier (`isReadyStockReuse: true`) via `cron.dispatchTick`.
- `mp-weaver-accept-and-seal` accepts the offer on `mp-weaver` (jumping directly to `awaiting_seal` without deducting `yarnInventory`) and seals with a `bagStickers` code into `ready_to_ship`.
- `mp-client-boundary-guard` rejects direct `mp-buyer` / `mp-weaver` client attempts to invoke `webhook.wxpay` or `cron.*`.

## How to get to it (user POV)

- Buyer uses `mp-buyer` (`auth.login` -> `buyer.saveAddress` -> `buyer.createOrder`).
- WeChat Pay gateway posts to `webhook.wxpay`, and CloudBase timer triggers `cron.dispatchTick`.
- Weaver uses `mp-weaver` (`weaver.dashboard` -> `weaver.respondOffer` -> `weaver.sealAndSubmit`), then operations views the newly sealed package in Admin Workspace ③ (`ws-ship`).

## Driving it with ego-browser and control-wxtz

Preconditions:

- `control-wxtz.mjs doctor --run-id <RUN_ID>` reports `ok: true`.
- `prod_sasa_ready` is on sale with ready stock on `usr_w_live_01` and `usr_w_mp_02`.

- **Buyer login & address.** Run `control-wxtz.mjs api --run-id <RUN_ID> --role mp-buyer --openid oid_b_e2e --action auth.login --payload '{"phone":"13955556666"}'` and `--action buyer.saveAddress --payload '{"contactName":"陈买家","contactPhone":"13955556666","province":"浙江省","city":"杭州市","district":"西湖区","detail":"文三路 99 号","isDefault":true}'`. Record returned address `_id`.
- **Verify client boundary guard.** Run `control-wxtz.mjs api --run-id <RUN_ID> --role mp-buyer --openid oid_b_e2e --action cron.dispatchTick --allow-error true`. Confirm `ok: false` and `code: "FORBIDDEN"`.
- **Create order & pay webhook.** Run `control-wxtz.mjs api --run-id <RUN_ID> --role mp-buyer --openid oid_b_e2e --action buyer.createOrder --payload '{"productId":"prod_sasa_ready","receiverAddrId":"<ADDR_ID>","qty":1}'`. Then run `--role internal --action webhook.wxpay --payload '{"orderId":"<ORD_ID>","wxTransactionId":"WX_VERIFY_01"}'`.
- **Dispatch & weaver accept.** Run `--role internal --action cron.dispatchTick`. Inspect the created package to note `assignedWeaverId` (`usr_w_live_01` or `usr_w_mp_02`), then call `--role mp-weaver --openid <WEAVER_OPENID> --action weaver.respondOffer --payload '{"packageId":"<PKG_ID>","decision":"accept"}'`. Confirm returned `status === "awaiting_seal"`.
- **Ledger reconciliation check.** Run `control-wxtz.mjs api --run-id <RUN_ID> --role internal --action cron.dailySettleAndReconcile` and confirm `mismatches: []`.

## Gotchas

- `mp-buyer` and `mp-weaver` share unified `users` (`usr_<id>`) by phone, and anti-self-order blocks a weaver from being dispatched her own buyer order (`assertNotSelfOrder`). Use a distinct buyer phone when testing normal fulfillment.
- `ready_stock` locks are committed (`paid: true`) on `webhook.wxpay` and consumed (`availableQty` / `reservedQty` decremented via CAS) when `weaver.respondOffer` accepts.
