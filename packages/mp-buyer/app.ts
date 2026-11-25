declare const wx: any;
declare function App(opts: Record<string, unknown>): void;

App({
  globalData: {
    referrerCreatorId: "",
  },
  onLaunch(opts: any) {
    if (wx.cloud) {
      wx.cloud.init({ traceUser: true });
    }
    if (opts?.query?.ref) {
      this.globalData.referrerCreatorId = String(opts.query.ref);
    }
  },
});
