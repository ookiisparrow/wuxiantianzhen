declare const wx: any;

export async function callBuyerCloud<T = any>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const res = await wx.cloud.callFunction({
    name: "wxtz-api",
    data: {
      action,
      app: "mp-buyer",
      payload,
    },
  });
  const body = res?.result ?? {};
  if (!body.ok) {
    const msg = body.message || "请求失败，请稍后重试";
    wx.showToast({ title: msg, icon: "none", duration: 2600 });
    throw new Error(msg);
  }
  return body.data as T;
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
