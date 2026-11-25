import { callBuyerCloud } from "../../utils/cloud";

declare const wx: any;
declare function getApp(): any;
declare function Page(opts: Record<string, any>): void;

Page({
  data: {
    productId: "",
    receiverAddrId: "addr_buyer_default",
    currentOrderId: "",
    orderStatus: "",
    refundReason: "拍错重拍",
  },

  onLoad(query: Record<string, string>) {
    if (query.productId) {
      this.setData({ productId: query.productId });
    }
  },

  async onPayOrder() {
    if (!this.data.productId) {
      wx.showToast({ title: "请先从天真市集选择款式", icon: "none" });
      return;
    }
    const app = getApp();
    const res = await callBuyerCloud("buyer.createOrder", {
      productId: this.data.productId,
      receiverAddrId: this.data.receiverAddrId,
      qty: 1,
      referrerCreatorId: app?.globalData?.referrerCreatorId || undefined,
    });
    this.setData({
      currentOrderId: res.order?._id || "",
      orderStatus: "paid_waiting_dispatch",
    });

    if (wx.requestPayment && res.prepay?.payParams) {
      wx.requestPayment({
        ...res.prepay.payParams,
        success: () => wx.showToast({ title: "支付成功！", icon: "success" }),
      });
    }
  },

  async onInstantCancelPreDispatch() {
    if (!this.data.currentOrderId) return;
    await callBuyerCloud("buyer.requestRefund", {
      orderId: this.data.currentOrderId,
      reason: this.data.refundReason,
      trigger: "buyer_pre_dispatch",
    });
    this.setData({ orderStatus: "refunded_instant" });
    wx.showToast({ title: "手艺人未接单 · 已秒级原路全额退款", icon: "success" });
  },

  async onAfterSaleApply() {
    if (!this.data.currentOrderId) return;
    await callBuyerCloud("buyer.requestRefund", {
      orderId: this.data.currentOrderId,
      reason: this.data.refundReason,
      trigger: "buyer_in_making",
    });
    this.setData({ orderStatus: "refund_pending_review" });
    wx.showToast({ title: "已提交售后协商（保障手艺人工时）", icon: "none" });
  },
});
