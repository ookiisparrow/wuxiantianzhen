import { callWeaverCloud } from "../../utils/cloud";

declare const wx: any;
declare function getApp(): any;
declare function Page(opts: Record<string, any>): void;

Page({
  data: {
    funnelStage: "apply_entry",
    province: "浙江省",
    city: "杭州市",
    quizCorrectCount: 8,
    portfolioPhotoFileIds: [] as string[],
    ackDepositNotice: false,
    examSampleCode: "EXAM-SAMPLE-NON-SALE-01",
  },

  onShow() {
    this.syncStage();
  },

  async syncStage() {
    try {
      const res = await callWeaverCloud("weaver.dashboard");
      if (res?.user?.funnelStage) {
        this.setData({ funnelStage: res.user.funnelStage });
      }
    } catch {
      // ignore before login
    }
  },

  onRegionChange(e: any) {
    const val = e.detail.value || [];
    this.setData({
      province: val[0] || "浙江省",
      city: val[1] || "杭州市",
    });
  },

  async onUploadPortfolio() {
    const media = await wx.chooseMedia({ count: 3, mediaType: ["image"], sizeType: ["compressed"] });
    const files = media?.tempFiles || [];
    const uploaded: string[] = [];
    for (const f of files) {
      const up = await wx.cloud.uploadFile({
        cloudPath: `funnel-portfolio/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`,
        filePath: f.tempFilePath,
      });
      uploaded.push(up.fileID);
    }
    this.setData({ portfolioPhotoFileIds: uploaded });
  },

  async onSubmitStep1() {
    if (this.data.portfolioPhotoFileIds.length < 3) {
      wx.showToast({ title: "请上传至少 3 张历史钩织作品照", icon: "none" });
      return;
    }
    const res = await callWeaverCloud("weaver.funnelStep1", {
      province: this.data.province,
      city: this.data.city,
      quizCorrectCount: this.data.quizCorrectCount,
      portfolioPhotoFileIds: this.data.portfolioPhotoFileIds,
    });
    wx.showToast({
      title: res.passedQuizAndRegion ? "初筛提交成功！" : res.reason || "暂未通过",
      icon: "none",
    });
    this.syncStage();
  },

  onToggleDepositAck() {
    this.setData({ ackDepositNotice: !this.data.ackDepositNotice });
  },

  async onUnlockExamSample() {
    const res = await callWeaverCloud("weaver.funnelAckDeposit", {
      ackDepositNotice: this.data.ackDepositNotice,
    });
    this.setData({
      funnelStage: res.stage,
      examSampleCode: res.examSampleCode || "EXAM-SAMPLE-NON-SALE-01",
    });
    wx.showToast({ title: "已解锁非售卖考级小样", icon: "success" });
  },

  /**
   * Jumps to `mp-buyer` dedicated cashier page (`pages/deposit-cashier/index`)
   * so the unified e-commerce merchant account collects the 200-Yuan refundable deposit (`LIAB_WEAVER_DEPOSIT`).
   */
  onJumpToDepositCashier() {
    const app = getApp();
    const targetAppId = app?.globalData?.buyerCashierAppId || "wxtz-mp-buyer-placeholder";
    wx.navigateToMiniProgram({
      appId: targetAppId,
      path: "pages/deposit-cashier/index",
    });
  },
});
