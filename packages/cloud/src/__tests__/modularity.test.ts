import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMockExternalPorts } from "../index.ts";
import { asFen } from "@wxtz/shared";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_SRC = path.resolve(HERE, "..");
const SERVICES_DIR = path.join(CLOUD_SRC, "services");

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("Modularity architecture guard: zero relative cross-package imports and zero horizontal service-to-service imports", () => {
  const allCloudFiles = walkTsFiles(CLOUD_SRC).filter((f) => !f.endsWith("modularity.test.ts"));
  for (const file of allCloudFiles) {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(CLOUD_SRC, file);
    assert.equal(
      /from\s+["'](?:\.\.\/)+shared\//.test(src),
      false,
      `${rel} must import from "@wxtz/shared", not relative ../shared/*`,
    );
  }

  const serviceFiles = walkTsFiles(SERVICES_DIR);
  assert.ok(serviceFiles.length >= 6);
  for (const file of serviceFiles) {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(SERVICES_DIR, file);
    assert.equal(
      /from\s+["']\.\/[^"']+["']/.test(src),
      false,
      `Service ${rel} must not horizontally import another service; push shared primitives to kit/ or @wxtz/shared`,
    );
  }
});

test("External hexagonal ports work cleanly with mock adapter", async () => {
  const ports = createMockExternalPorts();
  const prepay = await ports.payment.createJsapiPrepay({
    mchId: "MCH_01",
    outTradeNo: "OUT_1",
    buyerOpenid: "oid_1",
    amountFen: asFen(5800),
    description: "天真宝宝挂件",
  });
  assert.equal(prepay.prepayId, "prepay_OUT_1");

  const pickup = await ports.logistics.scheduleDoorstepPickup({
    packageId: "pkg_1",
    sender: {
      contactName: "林织女",
      contactPhone: "13600002222",
      province: "浙江省",
      city: "杭州市",
      district: "余杭区",
      detail: "良渚18号",
    },
    receiver: {
      contactName: "陈买家",
      contactPhone: "13933334444",
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
      detail: "淮海中路99号",
    },
    privacyWaybill: true,
  });
  assert.equal(pickup.taskId, "kd100_pkg_1");
  assert.equal(ports.logs.prepays.length, 1);
  assert.equal(ports.logs.pickups.length, 1);
});
