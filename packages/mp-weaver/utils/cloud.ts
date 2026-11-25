declare const wx: any;
declare function getApp(): any;

export interface CloudApiResult<T = any> {
  ok: boolean;
  data?: T;
  code?: string;
  message?: string;
}

/**
 * Calls unified CloudBase router `wxtz-api` with `app: 'mp-weaver'`.
 */
export async function callWeaverCloud<T = any>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const res = await wx.cloud.callFunction({
    name: "wxtz-api",
    data: {
      action,
      app: "mp-weaver",
      payload,
    },
  });
  const body = (res?.result ?? {}) as CloudApiResult<T>;
  if (!body.ok) {
    const msg = body.message || "请求失败，请稍后重试";
    wx.showToast({ title: msg, icon: "none", duration: 2600 });
    throw new Error(msg);
  }
  return body.data as T;
}

/**
 * Piggybacks `wx.requestSubscribeMessage` onto high-frequency weaver button taps
 * (accepting offers, submitting photos, claiming yarn) so subscribe message quota never runs dry.
 */
export function accumulateWeaverSubscribeQuota(): Promise<void> {
  return new Promise((resolve) => {
    const app = getApp();
    const tpls = app?.globalData?.subscribeTemplates ?? {};
    const tmplIds = [tpls.dispatchOffer, tpls.reviewResult, tpls.yarnDispatched].filter(Boolean);
    if (!tmplIds.length || !wx.requestSubscribeMessage) {
      resolve();
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds,
      complete: () => resolve(),
    });
  });
}

export function fenToYuanText(fen: number | undefined | null): string {
  const n = typeof fen === "number" && Number.isFinite(fen) ? fen : 0;
  return (n / 100).toFixed(2);
}
