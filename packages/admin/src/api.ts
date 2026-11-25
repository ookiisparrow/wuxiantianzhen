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
      shippingModeConfirmed?: "auto_pickup" | "self_dropoff" | "pickup";
    }) => invoke("admin.funnelSampleInspect", params),
    funnelApproveDeposit: (params: {
      userId: string;
      weaverNo: string;
      dailyCapacityMin?: number;
      base12Codes: string[];
      depositChannel: "mp_buyer_cashier" | "manual_transfer_verify";
      depositRefId: string;
    }) => invoke("admin.funnelApproveDeposit", params),
    promoteWeaverPool: (params: { userId: string; pool: "mp" | "live" }) =>
      invoke("admin.promoteWeaverPool", params),
    exportSupplierYarnCsv: (weekKey: string) => invoke("admin.exportSupplierYarnCsv", { weekKey }),
    exportBankPayoutCsv: () => invoke("admin.exportBankPayoutCsv"),
    confirmBankPayoutPaid: (batchId: string) => invoke("admin.confirmBankPayoutPaid", { batchId }),
    importDouyinLogistics: (params: {
      rows: Array<{ externalOrderId: string; trackingNo?: string; carrierCode?: string; signedAtMs?: number }>;
    }) => invoke("admin.importDouyinLogistics", params),
    upsertYarn: (params: Record<string, unknown>) => invoke("admin.upsertYarn", params),
    upsertPatternModule: (params: Record<string, unknown>) => invoke("admin.upsertPatternModule", params),
    upsertPattern: (params: Record<string, unknown>) => invoke("admin.upsertPattern", params),
    upsertStyle: (params: Record<string, unknown>) => invoke("admin.upsertStyle", params),
    upsertProduct: (params: Record<string, unknown>) => invoke("admin.upsertProduct", params),
    generateBagStickers: (params: { weaverId: string; batchId: string; codes: string[] }) =>
      invoke("admin.generateBagStickers", params),
    setConfig: (params: { key: string; value: Record<string, unknown> }) => invoke("admin.setConfig", params),
    getConfig: (key: string) => invoke("admin.getConfig", { key }),
    reassignManualHold: (params: { packageId: string; targetWeaverId?: string }) =>
      invoke("admin.reassignManualHold", params),
    listTickets: (params: { status?: "open" | "processing" | "resolved"; userId?: string; role?: "buyer" | "weaver" } = {}) =>
      invoke("admin.listTickets", params),
    resolveTicket: (params: { ticketId: string; reply: string; nextStatus?: "processing" | "resolved" }) =>
      invoke("admin.resolveTicket", params),
  };
}
