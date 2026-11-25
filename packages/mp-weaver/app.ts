// Global ambient typing shim for WeChat Mini-Program runtime (`wx`, `App`, `Page`)
declare const wx: any;
declare function App(opts: Record<string, unknown>): void;

App({
  globalData: {
    cloudEnvId: "", // Leave empty to bind default CloudBase env configured in WeChat DevTools
    buyerCashierAppId: "wxtz-mp-buyer-placeholder",
    subscribeTemplates: {
      dispatchOffer: "TPL_WEAVER_OFFER_PLACEHOLDER",
      reviewResult: "TPL_WEAVER_REVIEW_PLACEHOLDER",
      yarnDispatched: "TPL_WEAVER_YARN_PLACEHOLDER",
    },
    user: null,
  },

  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({
        traceUser: true,
      });
    }
  },
});
