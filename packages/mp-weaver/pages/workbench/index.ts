import { accumulateWeaverSubscribeQuota, callWeaverCloud, fenToYuanText } from "../../utils/cloud";

declare const wx: any;
declare function Page(opts: Record<string, any>): void;

Page({
  data: {
    loading: false,
    weaverNo: "",
    payableYuan: "0.00",
    yarnPoolYuan: "0.00",
    depositYuan: "0.00",
    packages: [] as any[],
    skeinCheckItem: null as { yarnCode: string; expectedSkeins: number } | null,
    reportedSkeins: 0,
  },

  onShow() {
    this.refreshDashboard();
  },

  async refreshDashboard() {
    this.setData({ loading: true });
    try {
      const data = await callWeaverCloud("weaver.dashboard");
      const user = data.user || {};
      const acc = data.account || {};
      const inv = user.yarnInventory || {};

      // Check if any yarn color hit 50g cumulative consumption check
      let skeinCheckItem: { yarnCode: string; expectedSkeins: number } | null = null;
      for (const [yarnCode, st] of Object.entries(inv) as Array<[string, any]>) {
        if (st?.needsCheck) {
          skeinCheckItem = { yarnCode, expectedSkeins: st.wholeSkeins ?? 0 };
          break;
        }
      }

      this.setData({
        weaverNo: user.weaverNo || "待认证织女",
        payableYuan: fenToYuanText(acc.payableBalanceFen),
        yarnPoolYuan: fenToYuanText(acc.yarnPoolBalanceFen),
        depositYuan: fenToYuanText(acc.depositFen),
        packages: data.packages || [],
        skeinCheckItem,
        reportedSkeins: skeinCheckItem ? skeinCheckItem.expectedSkeins : 0,
      });
    } catch {
      // Unbound users can bind phone first
    } finally {
      this.setData({ loading: false });
    }
  },

  async onRespondOffer(e: any) {
    const { id, decision } = e.currentTarget.dataset;
    await accumulateWeaverSubscribeQuota();
    await callWeaverCloud("weaver.respondOffer", { packageId: id, decision });
    wx.showToast({ title: decision === "accept" ? "已接单入列" : "已婉拒改派", icon: "success" });
    this.refreshDashboard();
  },

  onOpenHeadPattern(e: any) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/pattern/index?packageId=${encodeURIComponent(id)}` });
  },

  onOpenSubmit(e: any) {
    const { id, status, reviewmode } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/submit/index?packageId=${encodeURIComponent(id)}&status=${status}&reviewMode=${reviewmode}`,
    });
  },

  async onVoluntaryRelease(e: any) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: "接单 12 小时内无责转单",
      content: "确认释放该包裹让系统改派给其他空档织女吗？不扣信用分。",
      success: async (m: any) => {
        if (!m.confirm) return;
        await callWeaverCloud("weaver.releaseOrder", { packageId: id });
        wx.showToast({ title: "已无责释放", icon: "success" });
        this.refreshDashboard();
      },
    });
  },

  onAdjustReportedSkeins(e: any) {
    const delta = Number(e.currentTarget.dataset.delta || 0);
    const next = Math.max(0, this.data.reportedSkeins + delta);
    this.setData({ reportedSkeins: next });
  },

  async onConfirmSkeinCheck() {
    const item = this.data.skeinCheckItem;
    if (!item) return;
    await callWeaverCloud("weaver.confirmSkeinCheck", {
      yarnCode: item.yarnCode,
      reportedWholeSkeins: this.data.reportedSkeins,
    });
    wx.showToast({ title: "余线校准完成", icon: "success" });
    this.refreshDashboard();
  },
});
