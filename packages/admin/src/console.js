const endpointInput = document.getElementById("endpointInput");
const jwtInput = document.getElementById("jwtInput");
const modeBadge = document.getElementById("modeBadge");

function updateModeBadge() {
  const live = Boolean(endpointInput.value.trim());
  modeBadge.textContent = live ? "已连 CloudBase 生产接口" : "本地交互沙盒模式";
  modeBadge.className = `badge ${live ? "badge-live" : "badge-demo"}`;
  if (live && jwtInput.value.trim()) {
    refreshOverview().catch(() => {});
  }
}
endpointInput.addEventListener("input", updateModeBadge);
jwtInput.addEventListener("input", updateModeBadge);
jwtInput.addEventListener("change", updateModeBadge);

// Tab navigation across all 6 operational workspaces
document.getElementById("workspaceNav").addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-tab");
  if (!btn) return;
  document.querySelectorAll(".nav-tab").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById(btn.dataset.panel)?.classList.add("active");
  if (
    (btn.dataset.panel === "ws-ship" || btn.dataset.panel === "ws-funnel") &&
    endpointInput.value.trim() &&
    jwtInput.value.trim()
  ) {
    refreshOverview().catch(() => {});
  }
});

/**
 * Calls live CloudBase HTTP endpoint if configured, otherwise executes deterministic sandbox simulation
 * matching `@wxtz/cloud` `dispatchCloudAction` contracts 1:1.
 */
async function callAdmin(action, payload = {}) {
  const url = endpointInput.value.trim();
  if (url) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        adminToken: jwtInput.value.trim(),
        payload,
      }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`[${json.code}] ${json.message}`);
    return json.data;
  }

  // Deterministic local sandbox preview
  switch (action) {
    case "admin.liveSafeStockPlan": {
      const wSasa = Number(payload.shareWeights?.["TZ-SASA-01"] ?? 70);
      const wPapa = Number(payload.shareWeights?.["TZ-PAPA-01"] ?? 30);
      const totalW = Math.max(1, wSasa + wPapa);
      const days = Number(payload.horizonDays ?? 5);
      const poolUnits = days * 16; // 18 active JZH live weavers
      const sasaCraft = Math.floor(((poolUnits * wSasa) / totalW) * 0.85);
      const papaCraft = Math.floor(((poolUnits * wPapa) / totalW) * 0.85);
      return {
        "TZ-SASA-01": { readyStock: 4, craftCapacity: sasaCraft, totalSafeQty: 4 + sasaCraft },
        "TZ-PAPA-01": { readyStock: 2, craftCapacity: papaCraft, totalSafeQty: 2 + papaCraft },
      };
    }
    case "admin.previewDouyinCsv": {
      const hasRefunds = payload.refundRows !== undefined;
      const valid = hasRefunds || Boolean(payload.confirmZeroRefundsToday);
      return {
        valid,
        blockingErrors: valid ? [] : ["尚未上传今日售后退款表（若今日确实 0 退款，请勾选“确认今日 0 退款”后再导入）"],
        newOrderCount: Array.isArray(payload.orderRows) ? payload.orderRows.length : 0,
        mergedIntoExistingPkgCount: 0,
      };
    }
    case "admin.commitDouyinCsv": {
      if (payload.refundRows === undefined && !payload.confirmZeroRefundsToday) {
        throw new Error("[VALIDATION_ERROR] 请同时上传抖店退单CSV，或勾选【确认今日0退单】后再执行导单！");
      }
      const count = Array.isArray(payload.orderRows) ? payload.orderRows.length : 0;
      return {
        createdPackages: count,
        mergedOrders: 0,
        cancelledPreMake: payload.refundRows?.length ?? 0,
      };
    }
    case "admin.exportSupplierYarnCsv":
      return {
        exportBatchId: `yexp_${payload.weekKey}`,
        exportedClaimCount: 12,
        csvContent: [
          "claimId,weaverNo,recipient,phone,address,supplierSkuCode,qty",
          "claim_usr_01_2026-W48,WV-JZH-001,苏杭巧手,13800001111,浙江省嘉兴市南湖区***,JZH-4P-001,4",
          "claim_usr_02_2026-W48,WV-JZH-002,姑苏织造,13900002222,江苏省苏州市吴中区***,JZH-ACC-STD,2",
        ].join("\n"),
      };
    case "admin.exportBankPayoutCsv":
      return {
        batchId: "settle_20261124",
        payeeCount: 14,
        totalAmountFen: 486200,
        csvContent: [
          "batchId,weaverNo,bankAccountName,bankName,cardNo,netPayableYuan,memo",
          "settle_20261124,WV-JZH-001,林**,招商银行杭州分行,6214********8821,392.00,无限天真14天净工价结算",
        ].join("\n"),
      };
    case "admin.confirmBankPayoutPaid":
      return { paidPayees: 14, settledPackages: 168 };
    case "admin.funnelApproveDeposit":
      return { _id: payload.userId, weaverNo: payload.weaverNo, funnelStage: "approved", pool: "mp" };
    default:
      return { ok: true };
  }
}

function downloadTextFile(filename, content) {
  const blob = new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// ① Safe Stock Calculator
document.getElementById("btnCalcStock").addEventListener("click", async () => {
  const box = document.getElementById("stockResult");
  try {
    const horizonDays = Number(document.getElementById("horizonDays").value || 5);
    const wSasa = Number(document.getElementById("weightSasa").value || 70);
    const wPapa = Number(document.getElementById("weightPapa").value || 30);
    const plan = await callAdmin("admin.liveSafeStockPlan", {
      horizonDays,
      shareWeights: { "TZ-SASA-01": wSasa, "TZ-PAPA-01": wPapa },
    });
    box.innerHTML = Object.entries(plan)
      .map(
        ([sku, v]) =>
          `<div><strong>${sku}</strong>：建议挂车安全上限 <strong>${v.totalSafeQty} 件</strong>（余货直发 ${v.readyStock} + 排产净产能 ${v.craftCapacity}）</div>`,
      )
      .join("");
  } catch (err) {
    box.textContent = err.message;
  }
});

// ② Douyin Dual-CSV Guard
async function runCsvFlow(action) {
  const box = document.getElementById("csvResult");
  try {
    const orderRows = JSON.parse(document.getElementById("orderCsvJson").value || "[]");
    const rawRefund = document.getElementById("refundCsvJson").value.trim();
    const refundRows = rawRefund ? JSON.parse(rawRefund) : undefined;
    const confirmZeroRefundsToday = document.getElementById("chkZeroRefund").checked;
    const res = await callAdmin(action, { orderRows, refundRows, confirmZeroRefundsToday });
    if (action === "admin.previewDouyinCsv") {
      box.textContent = res.valid
        ? `🔍 Dry-Run 预检通过：新增订单 ${res.newOrderCount} 笔，合并入现有包裹 ${res.mergedIntoExistingPkgCount} 笔。`
        : `⛔ Dry-Run 预检拦截：${res.blockingErrors.join("；")}`;
    } else {
      box.textContent = `✅ 正式导入成功：新建包裹 ${res.createdPackages} 单，同买家合并 ${res.mergedOrders} 单，自动秒拦未开工退单 ${res.cancelledPreMake} 单。`;
    }
  } catch (err) {
    box.textContent = `⛔ 强校验拦截：${err.message}`;
  }
}
document.getElementById("btnPreviewCsv").addEventListener("click", () => runCsvFlow("admin.previewDouyinCsv"));
document.getElementById("btnCommitCsv").addEventListener("click", () => runCsvFlow("admin.commitDouyinCsv"));

// ③ Seed Grouped Ready-to-Ship & Arbitrate Demos (and live refresh when connected)
async function refreshOverview() {
  const data = await callAdmin("admin.overview");
  if (!data || !Array.isArray(data.readyPackages)) return;
  document.getElementById("readyShipGroups").innerHTML =
    data.readyPackages.length === 0
      ? `<div class="list-item"><span class="muted">当前暂无待打单包裹</span></div>`
      : data.readyPackages
          .map(
            (p) =>
              `<div class="list-item"><div><strong>包裹 ${p._id}</strong><div class="muted" style="margin:2px 0 0">织女 ${p.assignedWeaverId || "-"}</div></div><span class="badge badge-live">待打单</span></div>`,
          )
          .join("");
  document.getElementById("manualHoldList").innerHTML =
    (data.manualHoldPackages || [])
      .map(
        (p) =>
          `<div class="list-item"><div><strong>包裹 ${p._id}</strong> · 人工挂起</div><span class="badge badge-demo">待人工指派</span></div>`,
      )
      .join("") || `<div class="list-item"><span class="muted">当前暂无人工挂起包裹</span></div>`;
  document.getElementById("arbitrateList").innerHTML =
    (data.escalatedReviews || [])
      .map(
        (r) =>
          `<div class="list-item" data-review-id="${r._id}"><div><strong>${r._id}</strong> · 超时升级待仲裁</div><div class="btn-group"><button class="btn-primary" data-approve="true" data-rev="${r._id}">10秒通过</button><button class="btn-ghost" data-approve="false" data-rev="${r._id}">打回返修</button></div></div>`,
      )
      .join("") || `<div class="list-item"><span class="muted">当前暂无超时待仲裁审照单</span></div>`;
}

document.getElementById("readyShipGroups").innerHTML = [
  { alias: "织女001-嘉兴南湖", count: 5, bagCodes: "BAG-8801..8805" },
  { alias: "织女006-苏州吴中", count: 3, bagCodes: "BAG-9102..9104" },
]
  .map(
    (g) =>
      `<div class="list-item"><div><strong>退货地址别名：${g.alias}</strong><div class="muted" style="margin:2px 0 0">待打单 ${g.count} 包（袋码 ${g.bagCodes}）</div></div><span class="badge badge-live">中通吉批量打单就绪</span></div>`,
  )
  .join("");

document.getElementById("manualHoldList").innerHTML = `<div class="list-item"><div><strong>包裹 pkg_hold_demo_01</strong> · 连续 3 次邀约未接</div><span class="badge badge-demo">待人工指派</span></div>`;

document.getElementById("arbitrateList").innerHTML = `<div class="list-item" id="arbRow1"><div><strong>rev_pkg_092_1 (TZ-SASA-01)</strong> · 满2h仅1票(5分)自动升级</div><div class="btn-group"><button class="btn-primary" data-approve="true">10秒通过</button><button class="btn-ghost" data-approve="false">打回返修</button></div></div>`;

document.getElementById("arbitrateList").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-approve]");
  if (!btn) return;
  const approve = btn.dataset.approve === "true";
  const reviewId = btn.dataset.rev || "rev_pkg_092_1";
  const row = btn.closest(".list-item") || document.getElementById("arbRow1");
  try {
    await callAdmin("admin.arbitratePhotoReview", { reviewId, approve });
    if (row) {
      row.innerHTML = `<span>✅ 已完成 10 秒仲裁 (${reviewId})：${approve ? "通过并解锁扫码装袋" : "已退回返修"}</span>`;
    }
  } catch (err) {
    if (row) {
      row.innerHTML = `<span>⛔ 仲裁失败：${err.message}</span>`;
    }
  }
});

// ④ Funnel Deposit Approval
document.getElementById("btnApproveWeaver").addEventListener("click", async () => {
  const box = document.getElementById("funnelResult");
  try {
    const res = await callAdmin("admin.funnelApproveDeposit", {
      userId: document.getElementById("funnelUserId").value.trim(),
      weaverNo: document.getElementById("funnelWeaverNo").value.trim(),
      base12Codes: ["YARN-WHITE-01"],
      depositChannel: "mp_buyer_cashier",
      depositRefId: document.getElementById("funnelDepositRef").value.trim(),
    });
    box.textContent = `🎉 已入账 ¥200 负债专户并正式开通织女 ${res.weaverNo}（初始排产池：${res.pool}）！`;
  } catch (err) {
    box.textContent = err.message;
  }
});

// ⑤ Weekly Supplier Yarn CSV Export
document.getElementById("btnExportYarnCsv").addEventListener("click", async () => {
  const preview = document.getElementById("yarnCsvPreview");
  try {
    const weekKey = document.getElementById("yarnWeekKey").value.trim();
    const res = await callAdmin("admin.exportSupplierYarnCsv", { weekKey });
    preview.textContent = res.csvContent;
    downloadTextFile(`jzh-supplier-yarn-${weekKey}.csv`, res.csvContent);
  } catch (err) {
    preview.textContent = `⛔ 导出失败：${err.message}`;
  }
});

// ⑥ 14-Day Corporate Bank Batch Payout CSV
let latestBatchId = "settle_20261124";
document.getElementById("btnExportBankCsv").addEventListener("click", async () => {
  const preview = document.getElementById("bankCsvPreview");
  try {
    const res = await callAdmin("admin.exportBankPayoutCsv");
    latestBatchId = res.batchId;
    preview.textContent = res.csvContent;
    downloadTextFile(`bank-payout-${res.batchId}.csv`, res.csvContent);
  } catch (err) {
    preview.textContent = `⛔ 导出失败：${err.message}`;
  }
});

document.getElementById("btnConfirmBankPaid").addEventListener("click", async () => {
  const preview = document.getElementById("bankCsvPreview");
  try {
    const res = await callAdmin("admin.confirmBankPayoutPaid", { batchId: latestBatchId });
    preview.textContent =
      `✅ 批次 ${latestBatchId} 已核销：共完成 ${res.paidPayees} 位织女汇款（结清 ${res.settledPackages} 个订单包）。`;
  } catch (err) {
    preview.textContent = `⛔ 核销失败：${err.message}`;
  }
});
