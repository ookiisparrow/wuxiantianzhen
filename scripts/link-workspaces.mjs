#!/usr/bin/env node
/**
 * Creates local workspace symlinks under node_modules/@wxtz/* so Node native ESM
 * resolves `@wxtz/shared` and `@wxtz/cloud` cleanly without external network installs.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const scopeDir = path.join(ROOT, "node_modules", "@wxtz");
fs.mkdirSync(scopeDir, { recursive: true });

for (const pkg of ["shared", "cloud", "admin", "mp-buyer", "mp-weaver"]) {
  const target = path.join(ROOT, "packages", pkg);
  const linkPath = path.join(scopeDir, pkg);
  if (!fs.existsSync(target)) continue;
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink() || st.isDirectory()) {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  } catch {}
  fs.symlinkSync(path.relative(scopeDir, target), linkPath, "dir");
}

console.log("[link:workspaces] OK — linked @wxtz/* packages.");
