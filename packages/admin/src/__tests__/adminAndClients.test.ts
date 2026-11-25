import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createAdminApiClient } from "../api.ts";
import {
  InMemoryDb,
  createMockExternalPorts,
  dispatchCloudAction,
  signAdminJwt,
} from "@wxtz/cloud";

const ROOT = process.cwd();
const SECRET = "wxtz-admin-client-integration-secret-2026";

test("Admin API client integrates end-to-end with CloudBase router JWT & error contract", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const now = 1_764_000_000_000;
  let currentToken: string | undefined;

  const fakeFetch: typeof fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const result = await dispatchCloudAction(
      {
        db,
        ports,
        adminJwtSecret: SECRET,
        adminToken: body.adminToken,
        nowUtcMs: now,
      },
      body.action,
      body.payload ?? {},
    );
    return {
      async json() {
        return result;
      },
    } as Response;
  }) as typeof fetch;

  const client = createAdminApiClient({
    endpointUrl: "https://wxtz-cloudbase.example.com/wxtz-api",
    getToken: () => currentToken,
    fetchImpl: fakeFetch,
  });

  // Without JWT -> throws FORBIDDEN
  await assert.rejects(() => client.getOverview(), /FORBIDDEN/);

  // With valid short-lived JWT -> succeeds
  currentToken = signAdminJwt({ sub: "usr_admin_01", role: "admin", exp: now + 600_000 }, SECRET);
  const overview = await client.getOverview();
  assert.equal(overview.readyToShipCount, 0);

  // Douyin dual-CSV guard blocks missing refund confirmation
  const badPreview = await client.previewDouyinCsv({ orderRows: [] });
  assert.equal(badPreview.valid, false);
  await assert.rejects(() => client.commitDouyinCsv({ orderRows: [] }), /VALIDATION_ERROR/);

  const okPreview = await client.previewDouyinCsv({ orderRows: [], confirmZeroRefundsToday: true });
  assert.equal(okPreview.valid, true);
  assert.equal(okPreview.newOrderCount, 0);
});

test("mp-weaver & mp-buyer pages exist and enforce Lyric Pattern Companion & 8s Blind Review specs", () => {
  // 1. Verify all registered pages in mp-weaver/app.json exist
  const weaverAppJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, "packages/mp-weaver/app.json"), "utf8"),
  ) as { pages: string[]; navigateToMiniProgramAppIdList: string[] };
  assert.equal(weaverAppJson.pages.length, 5);
  for (const pg of weaverAppJson.pages) {
    for (const ext of [".ts", ".wxml", ".wxss", ".json"]) {
      assert.ok(
        fs.existsSync(path.join(ROOT, "packages/mp-weaver", `${pg}${ext}`)),
        `Missing mp-weaver file: ${pg}${ext}`,
      );
    }
  }

  // 2. Verify Lyric Pattern Companion Rules (docs/07 §2.4): screen-on, vibrateShort, anti-capture, zero audio theft
  const patternTs = fs.readFileSync(
    path.join(ROOT, "packages/mp-weaver/pages/pattern/index.ts"),
    "utf8",
  );
  const cleanCode = patternTs
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.match(cleanCode, /setKeepScreenOn\(\{\s*keepScreenOn:\s*true\s*\}\)/);
  assert.match(cleanCode, /vibrateShort\(\{\s*type:\s*"light"\s*\}\)/);
  assert.match(cleanCode, /setVisualEffectOnCapture/);
  assert.doesNotMatch(cleanCode, /createInnerAudioContext|getBackgroundAudioManager/);

  // 3. Verify all registered pages in mp-buyer/app.json exist + 8s volunteer countdown + deposit cashier
  const buyerAppJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, "packages/mp-buyer/app.json"), "utf8"),
  ) as { pages: string[] };
  assert.equal(buyerAppJson.pages.length, 4);
  for (const pg of buyerAppJson.pages) {
    for (const ext of [".ts", ".wxml", ".wxss", ".json"]) {
      assert.ok(
        fs.existsSync(path.join(ROOT, "packages/mp-buyer", `${pg}${ext}`)),
        `Missing mp-buyer file: ${pg}${ext}`,
      );
    }
  }

  const volunteerTs = fs.readFileSync(
    path.join(ROOT, "packages/mp-buyer/pages/volunteer/index.ts"),
    "utf8",
  );
  assert.match(volunteerTs, /countdownSec:\s*8/);
  assert.match(volunteerTs, /Math\.max\(8000,/);

  const cashierTs = fs.readFileSync(
    path.join(ROOT, "packages/mp-buyer/pages/deposit-cashier/index.ts"),
    "utf8",
  );
  assert.match(cashierTs, /buyer\.payWeaverDeposit/);

  // 4. Verify Admin HTML console exists
  assert.ok(fs.existsSync(path.join(ROOT, "packages/admin/index.html")));
  assert.ok(fs.existsSync(path.join(ROOT, "packages/admin/src/console.js")));
});
