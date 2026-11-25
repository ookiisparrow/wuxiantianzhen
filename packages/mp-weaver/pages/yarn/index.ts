import { accumulateWeaverSubscribeQuota, callWeaverCloud, fenToYuanText } from "../../utils/cloud";

declare const wx: any;
declare function Page(opts: Record<string, any>): void;

Page({
  data: {
    yarnPoolYuan: "0.00",
    defaultSendAddrId: "",
    inventoryList: [] as Array<{
      yarnCode: string;
      wholeSkeins: number;
      usedSinceCheckG: number;
      lowStock: boolean;
      claimQty: number;
    }>,
    claims: [] as any[],
  },

  onShow() {
    this.loadYarnState();
  },

  async loadYarnState() {
    try {
      const data = await callWeaverCloud("weaver.dashboard");
      const user = data.user || {};
      const acc = data.account || {};
      const inv = user.yarnInventory || {};
      const inventoryList = Object.entries(inv).map(([yarnCode, st]: [string, any]) => ({
        yarnCode,
        wholeSkeins: st.wholeSkeins ?? 0,
        usedSinceCheckG: st.usedSinceCheckG ?? 0,
        lowStock: Boolean(st.lowStock) || (st.wholeSkeins ?? 0) <= 1,
        claimQty: st.lowStock ? 3 : 0,
      }));
      this.setData({
        yarnPoolYuan: fenToYuanText(acc.yarnPoolBalanceFen),
        defaultSendAddrId: user.defaultSendAddrId || "addr_default",
        inventoryList,
        claims: data.yarnClaims || [],
      });
    } catch {
      // ignore if not logged in
    }
  },

  onAdjustClaimQty(e: any) {
    const { idx, delta } = e.currentTarget.dataset;
    const list = [...this.data.inventoryList];
    const row = list[Number(idx)];
    if (!row) return;
    row.claimQty = Math.max(0, row.claimQty + Number(delta));
    this.setData({ inventoryList: list });
  },

  async onSubmitWeeklyClaim() {
    const items = this.data.inventoryList
      .filter((r) => r.claimQty > 0)
      .map((r) => ({ yarnCode: r.yarnCode, qty: r.claimQty }));
    const totalSkeins = items.reduce((s, i) => s + i.qty, 0);
    if (totalSkeins < 3) {
      wx.showToast({ title: "江浙沪主仓直发每次满 3 团起申领", icon: "none" });
      return;
    }
    await accumulateWeaverSubscribeQuota();
    await callWeaverCloud("weaver.submitYarnClaim", {
      sendAddrId: this.data.defaultSendAddrId,
      items,
      shippingFeeFen: 250,
    });
    wx.showToast({ title: "申领成功，待周度集单直发", icon: "success" });
    this.loadYarnState();
  },

  async onConfirmReceived(e: any) {
    const { id } = e.currentTarget.dataset;
    await callWeaverCloud("weaver.confirmYarnReceived", { claimId: id });
    wx.showToast({ title: "已入库并刷新余线团数", icon: "success" });
    this.loadYarnState();
  },
});
