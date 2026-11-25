#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const SERVER_SCRIPT = path.join(HERE, "verify-server.ts");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (cur.startsWith("--")) {
      const key = cur.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    } else {
      out._.push(cur);
    }
  }
  return out;
}

function getRunPaths(runId) {
  if (!runId || !/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new Error("Pass a valid --run-id <alphanumeric-id>");
  }
  const dataDir = path.join("/tmp", `wxtz-verify-${runId}`);
  const instanceFile = path.join(dataDir, "instance.json");
  const dbFile = path.join(dataDir, "db.json");
  const logFile = path.join(dataDir, "server.log");
  const artifactsDir = path.join(REPO_ROOT, ".verify-artifacts", runId);
  return { dataDir, instanceFile, dbFile, logFile, artifactsDir };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function currentGitHead() {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function cmdLaunch(args) {
  const runId = args["run-id"] ?? "local";
  const port = args.port ?? "0";
  const paths = getRunPaths(runId);

  if (fs.existsSync(paths.instanceFile)) {
    const prev = JSON.parse(fs.readFileSync(paths.instanceFile, "utf8"));
    if (isPidAlive(prev.pid)) {
      throw new Error(
        `Instance ${runId} is already running (PID ${prev.pid} at ${prev.baseUrl}). Run cleanup first or pick another --run-id.`,
      );
    }
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  }

  // Ensure workspace symlinks exist before starting server
  execSync(`"${process.execPath}" "${path.join(REPO_ROOT, "scripts/link-workspaces.mjs")}"`, {
    cwd: REPO_ROOT,
    stdio: "ignore",
  });

  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(paths.artifactsDir, { recursive: true });

  const outFd = fs.openSync(paths.logFile, "a");
  const child = spawn(
    process.execPath,
    [SERVER_SCRIPT, "--run-id", runId, "--port", String(port), "--data-dir", paths.dataDir],
    {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ["ignore", outFd, outFd],
    },
  );
  child.unref();
  fs.closeSync(outFd);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(paths.instanceFile)) {
      const meta = JSON.parse(fs.readFileSync(paths.instanceFile, "utf8"));
      try {
        const docRes = await fetch(`${meta.baseUrl}/__doctor`);
        const docJson = await docRes.json();
        const ovRes = await fetch(meta.apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "admin.overview", adminToken: meta.adminToken, payload: {} }),
        });
        const ovJson = await ovRes.json();
        if (docJson.ok && ovJson.ok) {
          console.log(
            JSON.stringify(
              {
                ok: true,
                ...meta,
                artifactsDir: paths.artifactsDir,
                seededReadyToShip: ovJson.data.readyToShipCount,
              },
              null,
              2,
            ),
          );
          return;
        }
      } catch {
        // still starting
      }
    }
    await sleep(120);
  }

  const logs = fs.existsSync(paths.logFile) ? fs.readFileSync(paths.logFile, "utf8") : "";
  throw new Error(`Timed out waiting for verify-server (${runId}) to become ready.\n${logs}`);
}

async function cmdDoctor(args) {
  const runId = args["run-id"] ?? "local";
  const paths = getRunPaths(runId);
  if (!fs.existsSync(paths.instanceFile)) {
    throw new Error(`Missing instance metadata at ${paths.instanceFile}. Launch first.`);
  }
  const meta = JSON.parse(fs.readFileSync(paths.instanceFile, "utf8"));
  if (!isPidAlive(meta.pid)) {
    throw new Error(`Process PID ${meta.pid} for run ${runId} is dead.`);
  }

  const docRes = await fetch(`${meta.baseUrl}/__doctor`);
  const docJson = await docRes.json();
  if (!docJson.ok || docJson.service !== "wxtz-verify-server") {
    throw new Error(`Port ${meta.port} is NOT owned by wxtz-verify-server.`);
  }
  if (docJson.dataDir !== paths.dataDir) {
    throw new Error(`DataDir mismatch: expected ${paths.dataDir}, got ${docJson.dataDir}`);
  }
  const head = currentGitHead();
  if (head !== "unknown" && docJson.gitHead !== "unknown" && docJson.gitHead !== head) {
    throw new Error(`Git revision drift: server at ${docJson.gitHead}, repo HEAD at ${head}`);
  }

  const authRes = await fetch(meta.apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "admin.overview", adminToken: meta.adminToken, payload: {} }),
  });
  const authJson = await authRes.json();
  if (!authJson.ok) {
    throw new Error(`Admin JWT auth check failed: ${JSON.stringify(authJson)}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        runId,
        pid: meta.pid,
        baseUrl: meta.baseUrl,
        apiUrl: meta.apiUrl,
        gitHead: docJson.gitHead,
        dataDir: docJson.dataDir,
        artifactsDir: paths.artifactsDir,
        counts: docJson.counts,
      },
      null,
      2,
    ),
  );
}

async function cmdApi(args) {
  const runId = args["run-id"] ?? "local";
  const action = args.action;
  if (!action) throw new Error("Pass --action <cloudAction>");
  const role = args.role ?? "admin";
  const payload = args.payload ? JSON.parse(args.payload) : {};
  const paths = getRunPaths(runId);
  const meta = JSON.parse(fs.readFileSync(paths.instanceFile, "utf8"));

  const reqBody = { action, payload };
  if (role === "admin") {
    reqBody.adminToken = meta.adminToken;
  } else if (role === "mp-weaver" || role === "mp-buyer") {
    reqBody.app = role;
    reqBody.openid = args.openid ?? (role === "mp-weaver" ? "oid_w_live_01" : "oid_b_verify_01");
    if (args.unionid) reqBody.unionid = args.unionid;
  } else if (role === "internal") {
    reqBody.internalKey = "wxtz-verify-internal";
  }
  if (args["now-ms"]) {
    reqBody.nowUtcMs = Number(args["now-ms"]);
  }

  const res = await fetch(meta.apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
  });
  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
  if (!json.ok && args["allow-error"] !== "true") {
    process.exitCode = 1;
  }
}

async function cmdInspect(args) {
  const runId = args["run-id"] ?? "local";
  const paths = getRunPaths(runId);
  if (!fs.existsSync(paths.dbFile)) {
    throw new Error(`Missing DB snapshot at ${paths.dbFile}`);
  }
  const snap = JSON.parse(fs.readFileSync(paths.dbFile, "utf8"));
  const col = args.collection;
  if (!col) {
    console.log(JSON.stringify({ updatedAt: snap.updatedAt, counts: snap.counts, portLogs: snap.portLogs }, null, 2));
    return;
  }
  const docs = snap.collections?.[col] ?? [];
  if (args.id) {
    const match = docs.find((d) => d._id === args.id) ?? null;
    console.log(JSON.stringify(match, null, 2));
    return;
  }
  console.log(JSON.stringify(docs, null, 2));
}

async function cmdCleanup(args) {
  const runId = args["run-id"] ?? "local";
  const paths = getRunPaths(runId);
  let killedPid = null;

  if (fs.existsSync(paths.instanceFile)) {
    const meta = JSON.parse(fs.readFileSync(paths.instanceFile, "utf8"));
    if (isPidAlive(meta.pid)) {
      process.kill(meta.pid, "SIGTERM");
      killedPid = meta.pid;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && isPidAlive(meta.pid)) {
        await sleep(80);
      }
      if (isPidAlive(meta.pid)) {
        process.kill(meta.pid, "SIGKILL");
      }
    }
  }

  if (fs.existsSync(paths.dataDir)) {
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  }

  const artifactsIntact = fs.existsSync(paths.artifactsDir);
  const artifactFiles = artifactsIntact ? fs.readdirSync(paths.artifactsDir) : [];

  console.log(
    JSON.stringify(
      {
        ok: true,
        runId,
        killedPid,
        scratchRemoved: !fs.existsSync(paths.dataDir),
        artifactsDir: paths.artifactsDir,
        artifactsIntact,
        artifactFiles,
      },
      null,
      2,
    ),
  );
}

const parsed = parseArgs(process.argv.slice(2));
const sub = parsed._[0];

try {
  if (sub === "launch") await cmdLaunch(parsed);
  else if (sub === "doctor") await cmdDoctor(parsed);
  else if (sub === "api") await cmdApi(parsed);
  else if (sub === "inspect") await cmdInspect(parsed);
  else if (sub === "cleanup") await cmdCleanup(parsed);
  else {
    console.error("Usage: control-wxtz.mjs <launch|doctor|api|inspect|cleanup> --run-id <id> [options]");
    process.exit(1);
  }
} catch (err) {
  console.error(`[control-wxtz:${sub ?? "unknown"}] ERROR:`, err.message);
  process.exit(1);
}
