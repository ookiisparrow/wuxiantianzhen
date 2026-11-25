import { callBuyerCloud, ensureBuyerLoggedIn } from "../../utils/cloud";

declare const wx: any;
declare function getApp(): any;
declare function Page(opts: Record<string, any>): void;

Page({
  data: {
    productId: "",
    receiverAddrId: "",
    contactName: "默认收件人",
    contactPhone: "13900000000",
    province: "浙江省",
    city: "杭州市",
    district: "西湖区",
    detail: "默认收货地址",
    currentOrderId: "",
    orderStatus: "",
    refundReason: "拍错重拍",
  },

  onLoad(query: Record<string, string>) {
    if (query.productId) {
      this.setData({ productId: query.productId });
    }
  },

  async onBindPhoneAndSaveAddress(phone?: string) {
    await ensureBuyerLoggedIn(phone || this.data.contactPhone);
    const saved = await callBuyerCloud("buyer.saveAddress", {
      contactName: this.data.contactName,
      contactPhone: phone || this.data.contactPhone,
      province: this.data.province,
      city: this.data.city,
      district: this.data.district,
      detail: this.data.detail,
      isDefault: true,
    });
    this.setData({ receiverAddrId: saved._id });
    return saved._id as string;
  },

  async onPayOrder() {
    if (!this.data.productId) {
      wx.showToast({ title: "请先从天真市集选择款式", icon: "none" });
      return;
    }
    await ensureBuyerLoggedIn();
    let addrId = this.data.receiverAddrId;
    if (!addrId || addrId === "addr_buyer_default") {
      const saved = await callBuyerCloud("buyer.saveAddress", {
        contactName: this.data.contactName,
        contactPhone: this.data.contactPhone,
        province: this.data.province,
        city: this.data.city,
        district: this.data.district,
        detail: this.data.detail,
        isDefault: true,
      });
      addrId = saved._id;
      this.setData({ receiverAddrId: addrId });
    }

    const app = getApp();
    const res = await callBuyerCloud("buyer.createOrder", {
      productId: this.data.productId,
      receiverAddrId: addrId,
      qty: 1,
      referrerCreatorId: app?.globalData?.referrerCreatorId || undefined,
    });
    this.setData({
      currentOrderId: res.order?._id || "",
      orderStatus: "pending_pay",
    });

    if (wx.requestPayment && res.prepay?.payParams) {
      wx.requestPayment({
        ...res.prepay.payParams,
        success: () => {
          this.setData({ orderStatus: "paid_waiting_dispatch" });
          wx.showToast({ title: "支付成功！", icon: "success" });
        },
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
