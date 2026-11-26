// Global ambient typing shim for WeChat Mini-Program runtime (`wx`, `App`, `Page`)
declare const wx: any;
declare function App(opts: Record<string, unknown>): void;

App({
  globalData: {
    cloudEnvId: "", // Leave empty to bind default CloudBase env configured in WeChat DevTools
    // Local Mac full-stack dev switch (`npm run dev:local`). Set `enabled: false` before deploying to CloudBase.
    localDev: {
      enabled: true,
      apiUrl: "http://127.0.0.1:3880/wxtz-api",
      openid: "oid_w_live_01", // Seeded primary weaver WV-JZH-001; switch to oid_w_mp_02 to test 2nd weaver
    },
    buyerCashierAppId: "wxtz-mp-buyer-placeholder",
    subscribeTemplates: {
      dispatchOffer: "TPL_WEAVER_OFFER_PLACEHOLDER",
      reviewResult: "TPL_WEAVER_REVIEW_PLACEHOLDER",
      yarnDispatched: "TPL_WEAVER_YARN_PLACEHOLDER",
    },
    user: null,
  },

  onLaunch() {
    if (!this.globalData.localDev.enabled && wx.cloud) {
      wx.cloud.init({
        traceUser: true,
      });
    }
  },
});
