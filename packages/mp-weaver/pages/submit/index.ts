import { accumulateWeaverSubscribeQuota, callWeaverCloud } from "../../utils/cloud";

declare const wx: any;
declare function Page(opts: Record<string, any>): void;

Page({
  data: {
    packageId: "",
    status: "making", // 'making' | 'awaiting_seal'
    reviewMode: "required", // 'required' | 'sampled' | 'skip'
    frontOnScaleCard: "",
    backStitch: "",
    sidePlumpness: "",
    bagStickerCode: "",
    sealedPhotoFileId: "",
    pickupWindow: "今日 16:00-18:00",
    selfDropoffTrackingNo: "",
  },

  onLoad(query: Record<string, string>) {
    this.setData({
      packageId: query.packageId || "",
      status: query.status || "making",
      reviewMode: query.reviewMode || "required",
    });
  },

  async chooseAndUpload(slotKey: string) {
    const media = await wx.chooseMedia({ count: 1, mediaType: ["image"], sizeType: ["compressed"] });
    const tempPath = media?.tempFiles?.[0]?.tempFilePath;
    if (!tempPath) return;

    const cloudPath = `weaver-qc/${this.data.packageId}/${slotKey}-${Date.now()}.jpg`;
    const up = await wx.cloud.uploadFile({ cloudPath, filePath: tempPath });
    this.setData({ [slotKey]: up.fileID });
  },

  onPickPhoto(e: any) {
    const slot = e.currentTarget.dataset.slot;
    this.chooseAndUpload(slot);
  },

  onScanBagQr() {
    wx.scanCode({
      onlyFromCamera: true,
      success: (res: any) => {
        this.setData({ bagStickerCode: res.result || "" });
      },
    });
  },

  onInputTracking(e: any) {
    this.setData({ selfDropoffTrackingNo: e.detail.value || "" });
  },

  async onSubmitBareWorkOrMerged() {
    const {
      packageId,
      reviewMode,
      frontOnScaleCard,
      backStitch,
      sidePlumpness,
      bagStickerCode,
      sealedPhotoFileId,
      pickupWindow,
      selfDropoffTrackingNo,
    } = this.data;

    if (!frontOnScaleCard || !backStitch || !sidePlumpness) {
      wx.showToast({ title: "请补齐三视角比例尺卡裸拍图", icon: "none" });
      return;
    }
    if (reviewMode === "skip" && (!bagStickerCode || !sealedPhotoFileId)) {
      wx.showToast({ title: "免审直发单请同时扫袋码并拍封口照", icon: "none" });
      return;
    }

    await accumulateWeaverSubscribeQuota();
    await callWeaverCloud("weaver.submitFinishedWork", {
      packageId,
      photoSlots: { frontOnScaleCard, backStitch, sidePlumpness },
      bagStickerCode: reviewMode === "skip" ? bagStickerCode : undefined,
      sealedPhotoFileId: reviewMode === "skip" ? sealedPhotoFileId : undefined,
      pickupWindow,
      selfDropoffTrackingNo: reviewMode === "skip" && selfDropoffTrackingNo ? selfDropoffTrackingNo : undefined,
    });
    wx.showToast({
      title: reviewMode === "skip" ? "免审封袋直通待发！" : "已送审（2h极速通道）",
      icon: "success",
    });
    setTimeout(() => wx.navigateBack(), 900);
  },

  async onSealPostApproval() {
    const { packageId, bagStickerCode, sealedPhotoFileId, pickupWindow, selfDropoffTrackingNo } = this.data;
    if (!bagStickerCode || !sealedPhotoFileId) {
      wx.showToast({ title: "请扫八边封袋唯一码并上传封签照", icon: "none" });
      return;
    }
    await accumulateWeaverSubscribeQuota();
    await callWeaverCloud("weaver.sealAndSubmit", {
      packageId,
      bagStickerCode,
      sealedPhotoFileId,
      pickupWindow,
      selfDropoffTrackingNo: selfDropoffTrackingNo || undefined,
    });
    wx.showToast({ title: "已进入待发货队列", icon: "success" });
    setTimeout(() => wx.navigateBack(), 900);
  },
});
