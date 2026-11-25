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
      const inventoryList = Object.entries(inv).map(([yarnCode, st]: [string, any]) => {
        const isLow = st.status === "low" || st.status === "empty" || (st.wholeSkeins ?? 0) <= 1;
        return {
          yarnCode,
          wholeSkeins: st.wholeSkeins ?? 0,
          usedSinceCheckG: st.usedSinceCheckG ?? 0,
          lowStock: isLow,
          claimQty: isLow ? 3 : 0,
        };
      });
      this.setData({
        yarnPoolYuan: fenToYuanText(acc.yarnPoolBalanceFen),
        defaultSendAddrId: user.defaultSendAddrId || "",
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
    let sendAddrId = this.data.defaultSendAddrId;
    if (!sendAddrId) {
      const saved = await callWeaverCloud("weaver.saveAddress", {
        contactName: "织女默认收线人",
        contactPhone: "13800000000",
        province: "浙江省",
        city: "杭州市",
        district: "西湖区",
        detail: "默认收线地址",
        isDefault: true,
      });
      sendAddrId = saved._id;
      this.setData({ defaultSendAddrId: sendAddrId });
    }
    await callWeaverCloud("weaver.submitYarnClaim", {
      sendAddrId,
      items,
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
