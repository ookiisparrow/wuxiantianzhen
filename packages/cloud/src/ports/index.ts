import type { AddressDoc, Fen } from "@wxtz/shared";

/**
 * Hexagonal Ports & Adapters layer for all external 3rd-party gateways.
 * Business services never call WeChat Pay, Kuaidi100, SMS, or Content Security HTTP APIs directly;
 * swapping providers (e.g., Kuaidi100 -> SF/Cainiao, or switching sole-prop mchId -> company mchId)
 * requires only swapping the adapter implementation.
 */

export interface PaymentPort {
  createJsapiPrepay(params: {
    mchId: string;
    outTradeNo: string;
    buyerOpenid: string;
    amountFen: Fen;
    description: string;
  }): Promise<{ prepayId: string; payParams: Record<string, string> }>;

  initiateRefund(params: {
    mchId: string;
    outTradeNo: string;
    outRefundNo: string;
    refundFen: Fen;
    totalFen: Fen;
    reason: string;
  }): Promise<{ wxRefundId: string }>;
}

export interface LogisticsPort {
  scheduleDoorstepPickup(params: {
    packageId: string;
    sender: Pick<AddressDoc, "contactName" | "contactPhone" | "province" | "city" | "district" | "detail">;
    receiver: Pick<AddressDoc, "contactName" | "contactPhone" | "province" | "city" | "district" | "detail">;
    pickupWindow?: string;
    privacyWaybill: boolean; // MUST be true to hide buyer plaintext phone/name from weaver
    insuredValueFen?: Fen;
  }): Promise<{ taskId: string; carrierCode: string }>;

  cancelPickup(taskId: string, reason: string): Promise<void>;
}

export interface NotificationPort {
  sendMiniProgramSubscribe(params: {
    openid: string;
    templateId: string;
    page: string;
    data: Record<string, { value: string }>;
  }): Promise<{ delivered: boolean }>;

  sendUrgentSms(params: {
    phone: string;
    templateCode: string;
    params: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

export interface ContentSecurityPort {
  /** Mirrors WeChat `security.mediaCheckAsync` mandatory UGC image review */
  submitImageCheckAsync(params: {
    openid: string;
    mediaUrl: string;
    scene: 1 | 2 | 3 | 4;
  }): Promise<{ traceId: string }>;

  checkTextSafe(params: { openid: string; content: string }): Promise<{ pass: boolean }>;
}

export interface ExternalPorts {
  payment: PaymentPort;
  logistics: LogisticsPort;
  notify: NotificationPort;
  contentSec: ContentSecurityPort;
}

/**
 * Deterministic in-memory mock ports for local testing & dry-run environments.
 */
export function createMockExternalPorts(): ExternalPorts & {
  logs: {
    prepays: unknown[];
    refunds: unknown[];
    pickups: unknown[];
    notifications: unknown[];
    imageChecks: unknown[];
  };
} {
  const logs = {
    prepays: [] as unknown[],
    refunds: [] as unknown[],
    pickups: [] as unknown[],
    notifications: [] as unknown[],
    imageChecks: [] as unknown[],
  };

  return {
    logs,
    payment: {
      async createJsapiPrepay(p) {
        logs.prepays.push(p);
        return { prepayId: `prepay_${p.outTradeNo}`, payParams: { package: `prepay_id=prepay_${p.outTradeNo}` } };
      },
      async initiateRefund(p) {
        logs.refunds.push(p);
        return { wxRefundId: `wxref_${p.outRefundNo}` };
      },
    },
    logistics: {
      async scheduleDoorstepPickup(p) {
        logs.pickups.push(p);
        return { taskId: `kd100_${p.packageId}`, carrierCode: "zhongtong" };
      },
      async cancelPickup(taskId, reason) {
        logs.pickups.push({ cancel: taskId, reason });
      },
    },
    notify: {
      async sendMiniProgramSubscribe(p) {
        logs.notifications.push({ type: "subscribe", ...p });
        return { delivered: true };
      },
      async sendUrgentSms(p) {
        logs.notifications.push({ type: "sms", ...p });
        return { messageId: `sms_${Date.now()}` };
      },
    },
    contentSec: {
      async submitImageCheckAsync(p) {
        logs.imageChecks.push(p);
        return { traceId: `sec_${Date.now()}` };
      },
      async checkTextSafe() {
        return { pass: true };
      },
    },
  };
}
