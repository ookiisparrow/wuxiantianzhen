import { callBuyerCloud } from "../../utils/cloud";

declare const wx: any;
declare function Page(opts: Record<string, any>): void;

/**
 * Dedicated hidden cashier page jumped to from `mp-weaver` (`wx.navigateToMiniProgram`)
 * so a single unified e-commerce WeChat Pay merchant account (`mchId`) handles both
 * mall sales (`REV_PRODUCT_SALES`) and refundable weaver cooperative deposits (`LIAB_WEAVER_DEPOSIT`).
 */
Page({
  data: {
    outTradeNo: "",
    paid: false,
  },

  async onPayDeposit() {
    const res = await callBuyerCloud("buyer.payWeaverDeposit", {});
    this.setData({ outTradeNo: res.outTradeNo });

    if (wx.requestPayment && res.prepay?.payParams) {
      wx.requestPayment({
        ...res.prepay.payParams,
        success: () => {
          this.setData({ paid: true });
          wx.showToast({ title: "保证金缴付成功！", icon: "success" });
        },
      });
    }
  },

  onBackToWeaverMp() {
    if (wx.navigateBackMiniProgram) {
      wx.navigateBackMiniProgram({
        extraData: {
          depositOutTradeNo: this.data.outTradeNo,
          paid: this.data.paid,
        },
      });
    }
  },
});
