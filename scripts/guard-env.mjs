#!/usr/bin/env node
/**
 * Guard against accidentally connecting to the legacy "小棉鸭" production environment.
 * Mirrors docs/07 §1.2 (3 mandatory checks: envId, appid, @ldrw/* scope).
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const FORBIDDEN = [
  { label: "Legacy CloudBase envId", token: "cloudbase-d4gcssqbv06865479" },
  { label: "Legacy MiniProgram appId", token: "wxcbd2fb68b81bcfb1" },
  { label: "Legacy package scope", token: "@ldrw/" },
];

const SCAN_DIRS = ["packages", "scripts", "package.json", "cloudbaserc.json"];
const IGNORE_DIRS = new Set(["node_modules", "dist", ".git", "docs", "archive"]);

const hits = [];

function scanFile(filePath) {
  const rel = path.relative(ROOT, filePath);
  if (rel === "scripts/guard-env.mjs") return;
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const rule of FORBIDDEN) {
    if (content.includes(rule.token)) {
      hits.push({ file: rel, label: rule.label, token: rule.token });
    }
  }
}

function walk(target) {
  if (!fs.existsSync(target)) return;
  const st = fs.statSync(target);
  if (st.isFile()) {
    scanFile(target);
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    walk(path.join(target, entry.name));
  }
}

for (const entry of SCAN_DIRS) {
  walk(path.join(ROOT, entry));
}

if (hits.length > 0) {
  console.error("[guard:env] FAILED — forbidden legacy identifiers detected:");
  for (const h of hits) {
    console.error(`  - ${h.file}: ${h.label} (${h.token})`);
  }
  process.exit(1);
}

console.log("[guard:env] OK — zero legacy environment identifiers found.");
