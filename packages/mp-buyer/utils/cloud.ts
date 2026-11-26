declare const wx: any;
declare function getApp(): any;

function postLocalJson(url: string, data: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method: "POST",
      header: { "Content-Type": "application/json" },
      data,
      success(res: any) {
        resolve(res?.data ?? {});
      },
      fail(err: any) {
        reject(new Error(err?.errMsg || "无法连接本机联调服务，请先运行 npm run dev:local"));
      },
    });
  });
}

export async function callBuyerCloud<T = any>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const localDev = typeof getApp === "function" ? getApp()?.globalData?.localDev : undefined;
  let body: any;
  if (localDev?.enabled && localDev.apiUrl) {
    body = await postLocalJson(localDev.apiUrl, {
      action,
      app: "mp-buyer",
      openid: localDev.openid || "oid_b_demo_01",
      payload,
    });
  } else {
    const res = await wx.cloud.callFunction({
      name: "wxtz-api",
      data: {
        action,
        app: "mp-buyer",
        payload,
      },
    });
    body = res?.result ?? {};
  }
  if (!body.ok) {
    const msg = body.message || "请求失败，请稍后重试";
    wx.showToast({ title: msg, icon: "none", duration: 2600 });
    throw new Error(msg);
  }
  return body.data as T;
}

/**
 * Invokes real WeChat Pay in CloudBase production, or triggers local dev `webhook.wxpay`
 * after user confirmation when `app.globalData.localDev.enabled` is true.
 */
export function requestBuyerPayment(params: {
  orderId: string;
  payParams?: Record<string, unknown>;
  onPaid: () => void;
}): void {
  const localDev = typeof getApp === "function" ? getApp()?.globalData?.localDev : undefined;
  if (localDev?.enabled && localDev.devOrigin) {
    const triggerWebhook = async () => {
      const res = await postLocalJson(`${localDev.devOrigin}/__dev/simulate-wxpay`, {
        orderId: params.orderId,
      });
      if (res?.ok) {
        params.onPaid();
      } else {
        wx.showToast({ title: res?.message || "本地模拟支付失败", icon: "none" });
      }
    };
    if (wx.showModal) {
      wx.showModal({
        title: "本机联调模拟微信支付",
        content: `确认模拟支付单号 ${params.orderId} 并触发 webhook.wxpay？`,
        confirmText: "模拟付款",
        success(modalRes: any) {
          if (modalRes?.confirm) {
            triggerWebhook().catch(() => {});
          }
        },
      });
    } else {
      triggerWebhook().catch(() => {});
    }
    return;
  }

  if (wx.requestPayment && params.payParams) {
    wx.requestPayment({
      ...params.payParams,
      success: () => params.onPaid(),
    });
  }
}

export async function ensureBuyerLoggedIn(phone?: string, nickname?: string): Promise<any> {
  return callBuyerCloud("auth.login", {
    ...(phone ? { phone } : {}),
    ...(nickname ? { nickname } : {}),
  });
}

export function fenToYuanText(fen: number | undefined | null): string {
  const n = typeof fen === "number" && Number.isFinite(fen) ? fen : 0;
  return (n / 100).toFixed(2);
}
