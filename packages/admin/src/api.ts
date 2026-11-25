/**
 * Strongly-typed Admin Web Console client targeting CloudBase HTTP Access Service (`wxtz-api`)
 * with short-lived HMAC-SHA256 JWT (`Authorization` / `adminToken`, docs/07 §2.3).
 */
export interface AdminClientOptions {
  endpointUrl: string;
  getToken: () => string | undefined;
  fetchImpl?: typeof fetch;
}

export interface SafeStockEntry {
  readyStock: number;
  craftCapacity: number;
  totalSafeQty: number;
}

export function createAdminApiClient(opts: AdminClientOptions) {
  const fetcher = opts.fetchImpl ?? fetch;

  async function invoke<T = any>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const adminToken = opts.getToken();
    const res = await fetcher(opts.endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action,
        adminToken,
        payload,
      }),
    });
    const body = (await res.json()) as { ok: boolean; data?: T; code?: string; message?: string };
    if (!body.ok) {
      throw new Error(`[${body.code ?? "ERROR"}] ${body.message ?? "后台请求失败"}`);
    }
    return body.data as T;
  }

  return {
    invoke,
    getOverview: () => invoke("admin.overview"),
    getLiveSafeStockPlan: (params: { horizonDays?: number; shareWeights?: Record<string, number> }) =>
      invoke<Record<string, SafeStockEntry>>("admin.liveSafeStockPlan", params),
    previewDouyinCsv: (params: {
      orderRows: unknown[];
      refundRows?: unknown[];
      confirmZeroRefundsToday?: boolean;
    }) => invoke("admin.previewDouyinCsv", params),
    commitDouyinCsv: (params: {
      orderRows: unknown[];
      refundRows?: unknown[];
      confirmZeroRefundsToday?: boolean;
      dispatchableAtMs?: number;
    }) => invoke("admin.commitDouyinCsv", params),
    arbitratePhotoReview: (params: { reviewId: string; approve: boolean }) =>
      invoke("admin.arbitratePhotoReview", params),
    funnelSampleInspect: (params: {
      userId: string;
      trackingNo: string;
      passed: boolean;
      shippingModeConfirmed?: "pickup" | "self_dropoff";
    }) => invoke("admin.funnelSampleInspect", params),
    funnelApproveDeposit: (params: {
      userId: string;
      weaverNo: string;
      dailyCapacityMin?: number;
      base12Codes: string[];
      depositChannel: "mp_buyer_cashier" | "bank_or_wx_voucher";
      depositRefId: string;
    }) => invoke("admin.funnelApproveDeposit", params),
    promoteWeaverPool: (params: { userId: string; pool: "mp" | "live" }) =>
      invoke("admin.promoteWeaverPool", params),
    exportSupplierYarnCsv: (weekKey: string) => invoke("admin.exportSupplierYarnCsv", { weekKey }),
    exportBankPayoutCsv: () => invoke("admin.exportBankPayoutCsv"),
    confirmBankPayoutPaid: (batchId: string) => invoke("admin.confirmBankPayoutPaid", { batchId }),
  };
}
