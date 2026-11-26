declare const wx: any;
declare function getApp(): any;

export interface CloudApiResult<T = any> {
  ok: boolean;
  data?: T;
  code?: string;
  message?: string;
}

function postLocalDev<T>(
  apiUrl: string,
  body: Record<string, unknown>,
): Promise<CloudApiResult<T>> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: apiUrl,
      method: "POST",
      header: { "Content-Type": "application/json" },
      data: body,
      success(res: any) {
        resolve((res?.data ?? {}) as CloudApiResult<T>);
      },
      fail(err: any) {
        reject(new Error(err?.errMsg || "无法连接本机联调服务，请先运行 npm run dev:local"));
      },
    });
  });
}

/**
 * Calls unified CloudBase router `wxtz-api` with `app: 'mp-weaver'`.
 * Automatically routes via `wx.request` when `app.globalData.localDev.enabled` is true.
 */
export async function callWeaverCloud<T = any>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const localDev = typeof getApp === "function" ? getApp()?.globalData?.localDev : undefined;
  let body: CloudApiResult<T>;
  if (localDev?.enabled && localDev.apiUrl) {
    body = await postLocalDev<T>(localDev.apiUrl, {
      action,
      app: "mp-weaver",
      openid: localDev.openid || "oid_w_live_01",
      payload,
    });
  } else {
    const res = await wx.cloud.callFunction({
      name: "wxtz-api",
      data: {
        action,
        app: "mp-weaver",
        payload,
      },
    });
    body = (res?.result ?? {}) as CloudApiResult<T>;
  }
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

export async function ensureWeaverLoggedIn(phone?: string, nickname?: string): Promise<any> {
  return callWeaverCloud("auth.login", {
    ...(phone ? { phone } : {}),
    ...(nickname ? { nickname } : {}),
  });
}

export function fenToYuanText(fen: number | undefined | null): string {
  const n = typeof fen === "number" && Number.isFinite(fen) ? fen : 0;
  return (n / 100).toFixed(2);
}
