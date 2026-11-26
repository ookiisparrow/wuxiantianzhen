declare const wx: any;
declare function App(opts: Record<string, unknown>): void;

App({
  globalData: {
    referrerCreatorId: "",
    // Local Mac full-stack dev switch (`npm run dev:local`). Set `enabled: false` before deploying to CloudBase.
    localDev: {
      enabled: true,
      apiUrl: "http://127.0.0.1:3880/wxtz-api",
      devOrigin: "http://127.0.0.1:3880",
      openid: "oid_b_demo_01", // Seeded buyer & volunteer demo account (phone 13955556666)
    },
  },
  onLaunch(opts: any) {
    if (!this.globalData.localDev.enabled && wx.cloud) {
      wx.cloud.init({ traceUser: true });
    }
    if (opts?.query?.ref) {
      this.globalData.referrerCreatorId = String(opts.query.ref);
    }
  },
});
