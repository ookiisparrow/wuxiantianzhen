import { createMockExternalPorts, type ExternalPorts } from "./ports/index.ts";
import { dispatchCloudAction, type ApiResponse } from "./runtime/router.ts";
import { WxCloudDbAdapter, type WxCloudDatabase } from "./runtime/wxCloudAdapter.ts";
import type { MiniProgramApp } from "./kit/auth.ts";

export interface CloudBaseEvent {
  action: string;
  payload?: Record<string, unknown>;
  app?: MiniProgramApp;
  adminToken?: string;
}

export interface CloudBaseSdkLike {
  DYNAMIC_CURRENT_ENV: string | symbol;
  init(opts: { env: string | symbol }): void;
  database(opts?: { env?: string | symbol }): WxCloudDatabase;
  getWXContext(): { OPENID?: string; UNIONID?: string; APPID?: string };
}

/**
 * Factory creating the CloudBase `exports.main` handler without hardcoding any `envId` or `appid`.
 * In CloudBase runtime, pass `require('wx-server-sdk')` and production `ExternalPorts`.
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
    const wxCtx = deps.wxCloud.getWXContext();
    const resolvedApp: MiniProgramApp | undefined =
      event.app ?? (wxCtx.APPID && deps.appByAppId ? deps.appByAppId[wxCtx.APPID] : undefined);
    const adminJwtSecret = deps.adminJwtSecret ?? process.env.WXTZ_ADMIN_JWT_SECRET ?? "";

    return dispatchCloudAction(
      {
        db,
        ports,
        app: resolvedApp,
        openid: wxCtx.OPENID,
        adminJwtSecret,
        adminToken: event.adminToken,
      },
      event.action,
      (event.payload as Record<string, any>) ?? {},
    );
  };
}
