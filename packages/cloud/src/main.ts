import { createMockExternalPorts, type ExternalPorts } from "./ports/index.ts";
import { dispatchCloudAction, type ApiResponse } from "./runtime/router.ts";
import { WxCloudDbAdapter, type WxCloudDatabase } from "./runtime/wxCloudAdapter.ts";
import type { MiniProgramApp } from "./kit/auth.ts";

export interface CloudBaseEvent {
  action?: string;
  payload?: Record<string, unknown>;
  app?: MiniProgramApp;
  adminToken?: string;
  // Standard Tencent CloudBase Timer trigger fields (`cloudbaserc.json`)
  Type?: string;
  TriggerName?: string;
  Time?: string;
}

export interface CloudBaseSdkLike {
  DYNAMIC_CURRENT_ENV: string | symbol;
  init(opts: { env: string | symbol }): void;
  database(opts?: { env?: string | symbol }): WxCloudDatabase;
  getWXContext(): { OPENID?: string; UNIONID?: string; APPID?: string };
}

const TIMER_TRIGGER_TO_ACTION: Record<string, string> = {
  dispatchTickEveryMinute: "cron.dispatchTick",
  dispatchHourly: "cron.dispatchTick",
  fiveMinWatchdog: "cron.fiveMinuteWatchdog",
  dailySettle0200: "cron.dailySettleAndReconcile",
  dueAndStockAlertDaily9am: "cron.dailyDueAndStockAlert",
  weeklyGovernanceMonday9am: "cron.weeklyGovernance",
};

/**
 * Factory creating the CloudBase `exports.main` handler without hardcoding any `envId` or `appid`.
 * Server-verified `wxCtx.APPID` and `wxCtx.UNIONID` always override untrusted client fields.
 */
export function createCloudMainHandler(deps: {
  wxCloud: CloudBaseSdkLike;
  ports?: ExternalPorts;
  adminJwtSecret?: string;
  appByAppId?: Record<string, MiniProgramApp>;
}) {
  deps.wxCloud.init({ env: deps.wxCloud.DYNAMIC_CURRENT_ENV });
  const db = new WxCloudDbAdapter(deps.wxCloud.database({ env: deps.wxCloud.DYNAMIC_CURRENT_ENV }));
  const ports = deps.ports ?? createMockExternalPorts();

  return async function main(event: CloudBaseEvent): Promise<ApiResponse> {
    const wxCtx = deps.wxCloud.getWXContext() ?? {};
    const isRealTimer = !wxCtx.OPENID && event?.Type === "Timer" && Boolean(event.TriggerName);

    const resolvedAction = isRealTimer
      ? (TIMER_TRIGGER_TO_ACTION[event.TriggerName!] ?? `cron.${event.TriggerName}`)
      : String(event?.action ?? "");

    // Server-verified APPID strictly takes precedence over client-supplied `event.app`
    const resolvedApp: MiniProgramApp | undefined = wxCtx.APPID
      ? deps.appByAppId?.[wxCtx.APPID]
      : event?.app;

    const invocationSource = isRealTimer
      ? "timer"
      : wxCtx.OPENID
        ? "mp_client"
        : "http_gateway";

    const adminJwtSecret = deps.adminJwtSecret ?? process.env.WXTZ_ADMIN_JWT_SECRET ?? "";

    return dispatchCloudAction(
      {
        db,
        ports,
        app: resolvedApp,
        openid: wxCtx.OPENID,
        unionid: wxCtx.UNIONID,
        invocationSource,
        adminJwtSecret,
        adminToken: event?.adminToken,
      },
      resolvedAction,
      (event?.payload as Record<string, any>) ?? {},
    );
  };
}
