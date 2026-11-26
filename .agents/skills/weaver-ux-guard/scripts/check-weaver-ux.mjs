#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const runBrowser = args.includes("--browser");
const targetArg = args.find((a) => !a.startsWith("--")) || "design/weaver-funnel-prototype-v2.html";
const absTarget = path.resolve(process.cwd(), targetArg);

if (!fs.existsSync(absTarget)) {
  console.error(`[weaver-ux-guard] File not found: ${absTarget}`);
  process.exit(1);
}

const src = fs.readFileSync(absTarget, "utf8");
const failures = [];

/* ===== 1. Static Checks (Emil Motion + /mobile-native + Emoji Ban) ===== */
const styleBlocks = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
const cssNoComments = styleBlocks.replace(/\/\*[\s\S]*?\*\//g, "");

if (/\bease-in\b(?![-a-z])/i.test(cssNoComments)) {
  failures.push("STATIC_EASE_IN: Found forbidden 'ease-in' timing function; use custom ease-out (<300ms).");
}

if (/\bscale\(\s*0(?:\.0+)?\s*\)/i.test(cssNoComments)) {
  failures.push("STATIC_SCALE_ZERO: Found forbidden 'scale(0)'; start from scale(0.92..0.96) instead.");
}

function stripHoverMediaBlocks(css) {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const m = css.slice(i).match(/^@media[^{]*hover:\s*hover[^{]*\{/i);
    if (m) {
      let depth = 1;
      i += m[0].length;
      while (i < css.length && depth > 0) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") depth--;
        i++;
      }
    } else {
      out += css[i++];
    }
  }
  return out;
}

if (/:hover\b/.test(stripHoverMediaBlocks(cssNoComments))) {
  failures.push("STATIC_UNPROTECTED_HOVER: Found ':hover' outside '@media (hover: hover)', which sticks on touch screens.");
}

if (!/prefers-reduced-motion:\s*reduce/i.test(cssNoComments)) {
  failures.push("STATIC_REDUCED_MOTION: Missing '@media (prefers-reduced-motion: reduce)' rule.");
}

if (!/touch-action:\s*manipulation/i.test(cssNoComments)) {
  failures.push("STATIC_TOUCH_ACTION: Missing 'touch-action: manipulation' on interactive controls.");
}

const srcNoComments = src.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
if (/[\u{1F300}-\u{1FAFF}]/u.test(srcNoComments)) {
  failures.push("STATIC_EMOJI_BAN: Found pictographic emoji in UI source; use clean SVG strokes instead.");
}

if (!/--font-body:\s*17px/i.test(cssNoComments) || !/--font-h1:\s*22px/i.test(cssNoComments)) {
  failures.push("STATIC_WEUI_TOKENS: Missing WeUI font scale tokens (--font-h1: 22px, --font-body: 17px).");
}

/* Rule 7 ("四不出现" Copy Leak Guard): scan weaver-facing UI surface only (exclude reviewer sidebar & reviewer script) */
const weaverFacingSrc = srcNoComments
  .replace(/<aside[^>]*class=["'][^"']*reviewer[^"']*["'][^>]*>[\s\S]*?<\/aside>/gi, "")
  .replace(/function\s+renderReviewer\s*\([\s\S]*?(?=\n\/\*|\nfunction\s+(?!renderReviewer))/g, "")
  .replace(/\/\*\s*Reviewer Simulators[\s\S]*$/g, "")
  .replace(/const\s+SCREENS\s*=\s*\[[\s\S]*?\];/g, "")
  .replace(/const\s+POOL_MODES\s*=\s*\[[\s\S]*?\];/g, "");

const FORBIDDEN_WEAVER_COPY = [
  "防盗图",
  "免拍身份证",
  "仓库扫码",
  "无需写纸条",
  "免纸条",
  "不设门槛",
  "无门槛",
  "纳入织女库",
  "自动绑定",
  "排期评估",
  "开单排期",
  "已入档",
  "拉起",
  "手艺人档案",
  "防损专户",
  "在途订单",
  "不计入平台收费",
  "证明本人作品",
  "防重号",
  "绝不丢件",
  "织女入驻",
  "毛线周转保证金",
  "派单进度",
  "收线地址",
  "起步毛线",
  "质检组",
  "挺括",
  "茜红",
  "免费配线",
  "随时退押",
  "正式开单",
  "新名额"
];

const leakedTerms = FORBIDDEN_WEAVER_COPY.filter((term) => weaverFacingSrc.includes(term));
if (leakedTerms.length > 0) {
  failures.push(
    `STATIC_WEAVER_COPY_LEAK: Found internal/confusing/non-actionable copy in weaver UI: ${leakedTerms.join("、")}`
  );
}

console.log(`[weaver-ux-guard] Static check scanned ${path.relative(process.cwd(), absTarget)} (${failures.length} issue(s))`);

/* ===== 2. Optional Live Chromium Multi-Width & Touch Target Audit ===== */
if (runBrowser) {
  const egoBin = "/Users/sparrow/.local/bin/ego-browser";
  const fileUrl = `file://${absTarget}`;
  const browserScript = `
const task = await taskSpace("weaver-ux-guard audit");
const page = task.page("p1");
await page.goto(${JSON.stringify(fileUrl)});

await page.cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

const allowedFonts = new Set([12, 14, 15, 17, 22, 34]);
const viewports = [
  { width: 375, height: 667, label: "375x667" },
  { width: 320, height: 620, label: "320x620" }
];

const report = { overflows: [], offRampFonts: [], smallTargets: [], btnDrift: [], lowContrast: [] };

for (const vp of viewports) {
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: 2,
    mobile: true
  });

  const vpRes = await page.evaluate((vpLabel) => {
    // Disable transitions during synchronous DOM measurement so settled colors & geometry are read accurately
    let noAnim = document.getElementById("__ux_guard_no_anim");
    if (!noAnim) {
      noAnim = document.createElement("style");
      noAnim.id = "__ux_guard_no_anim";
      noAnim.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
      document.head.appendChild(noAnim);
    }
    const cv = document.createElement("canvas");
    cv.width = 1; cv.height = 1;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    const toRgb = (c) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const lum = ([r, g, b]) => {
      const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const contrast = (a, b) => {
      const l1 = lum(toRgb(a)), l2 = lum(toRgb(b));
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };

    const overflows = [];
    const fonts = new Set();
    const smallTargets = [];
    const btnTops = new Set();
    let ctaContrast = 99;

    for (const s of SCREENS) {
      jump(s.id, "instant");
      const scr = document.getElementById("screen");
      const vOv = Math.round(scr.scrollHeight - scr.clientHeight);
      const hOv = Math.round(scr.scrollWidth - scr.clientWidth);
      if (vOv > 0 || hOv > 0) overflows.push(\`\${vpLabel}:\${s.id}(v=\${vOv},h=\${hOv})\`);

      const btnEl = document.getElementById("nextBtn");
      btnTops.add(Math.round(btnEl.getBoundingClientRect().top));
      if (!btnEl.disabled) {
        const cs = getComputedStyle(btnEl);
        ctaContrast = Math.min(ctaContrast, Math.round(contrast(cs.color, cs.backgroundColor) * 100) / 100);
      }

      [...scr.querySelectorAll("*")].forEach((el) => {
        if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
          fonts.add(Math.round(parseFloat(getComputedStyle(el).fontSize)));
        }
      });

      if (vpLabel === "375x667") {
        [...scr.querySelectorAll("button, input, .upload-area, .check-card, .scan-card, .addr-tap, .stitch-row")].forEach((el) => {
          const r = el.getBoundingClientRect();
          // Account for ::after hit-area expansion on .speak-btn
          const afterCs = getComputedStyle(el, "::after");
          let hitH = r.height;
          if (afterCs && afterCs.content && afterCs.content !== "none") {
            const top = parseFloat(afterCs.top) || 0;
            const bottom = parseFloat(afterCs.bottom) || 0;
            if (top < 0 || bottom < 0) hitH = r.height - top - bottom;
          }
          if (hitH > 0 && hitH < 40) {
            smallTargets.push(\`\${s.id}:\${el.className || el.tagName}(\${Math.round(hitH)}px)\`);
          }
        });
      }
    }
    return {
      overflows,
      fonts: [...fonts],
      smallTargets,
      btnTopCount: btnTops.size,
      ctaContrast
    };
  }, vp.label);

  report.overflows.push(...vpRes.overflows);
  vpRes.fonts.forEach((f) => { if (!allowedFonts.has(f)) report.offRampFonts.push(\`\${vp.label}:\${f}px\`); });
  report.smallTargets.push(...vpRes.smallTargets);
  if (vpRes.btnTopCount > 1) report.btnDrift.push(\`\${vp.label}:buttonTopPositions=\${vpRes.btnTopCount}\`);
  if (vpRes.ctaContrast < 4.5) report.lowContrast.push(\`\${vp.label}:ctaContrast=\${vpRes.ctaContrast}\`);
}

await page.cdp("Emulation.clearDeviceMetricsOverride");
await page.cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
console.log("AUDIT_JSON:" + JSON.stringify({ spaceId: task.spaceId, report }));
`;

  const proc = spawnSync(egoBin, ["nodejs", "-e", browserScript], { encoding: "utf8" });
  const combined = `${proc.stdout || ""}\n${proc.stderr || ""}`;
  const line = combined.split("\n").find((l) => l.includes("AUDIT_JSON:"));
  if (!line) {
    failures.push("BROWSER_AUDIT_NO_OUTPUT: Failed to parse ego-browser output.");
  } else {
    const jsonStr = line.slice(line.indexOf("AUDIT_JSON:") + "AUDIT_JSON:".length).trim();
    const { spaceId, report } = JSON.parse(jsonStr);
    spawnSync(egoBin, ["nodejs", "-e", `const t = await taskSpace(${spaceId}); await t.finish({ keep: [] });`], {
      encoding: "utf8"
    });
    if (report.overflows.length) failures.push(`VIEWPORT_OVERFLOW: ${report.overflows.join(", ")}`);
    if (report.offRampFonts.length) failures.push(`NON_WEUI_FONT: ${[...new Set(report.offRampFonts)].join(", ")}`);
    if (report.smallTargets.length) failures.push(`SMALL_TOUCH_TARGET(<40px): ${report.smallTargets.join(", ")}`);
    if (report.btnDrift.length) failures.push(`NEXT_BTN_DRIFT: ${report.btnDrift.join(", ")}`);
    if (report.lowContrast.length) failures.push(`LOW_CONTRAST(<4.5:1): ${report.lowContrast.join(", ")}`);
    console.log(`[weaver-ux-guard] Browser check complete across 375x667 & 320x620 (${SCREENS_INFO(report)})`);
  }
}

function SCREENS_INFO(r) {
  return `overflows=${r.overflows.length}, nonWeuiFonts=${r.offRampFonts.length}, smallTargets=${r.smallTargets.length}, btnDrift=${r.btnDrift.length}`;
}

if (failures.length > 0) {
  console.error("[weaver-ux-guard] FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

console.log("[weaver-ux-guard] OK — all low-literacy, older-adult, WeUI, and Emil motion guards passed.");
