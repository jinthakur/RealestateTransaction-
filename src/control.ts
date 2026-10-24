// Start/stop the deal agent and the check services from the UI. Local demo only.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AGENT_LOG, ROOT } from "./config.js";

const LOGS = path.join(ROOT, "run-logs");
type Name = "agent" | "services";
const procs: Partial<Record<Name, ChildProcess>> = {};

const running = (n: Name) => Boolean(procs[n]) && procs[n]!.exitCode === null && procs[n]!.signalCode === null;
const paymentsAp4m = () => (process.env.PAYMENTS ?? "").toLowerCase() === "ap4m";

function launch(n: Name, script: string, args: string[] = []) {
  fs.mkdirSync(LOGS, { recursive: true });
  const out = fs.openSync(path.join(LOGS, `${n}.log`), "w");
  const c = spawn(process.execPath, ["--import", "tsx", script, ...args], { cwd: ROOT, env: process.env, stdio: ["ignore", out, out], windowsHide: true });
  procs[n] = c;
  c.on("exit", () => { if (procs[n] === c) delete procs[n]; });
}

function stop(n: Name) {
  const c = procs[n];
  if (!c || !c.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"]);
  else c.kill();
  delete procs[n];
}

function tail(n: Name) {
  try { return fs.readFileSync(path.join(LOGS, `${n}.log`), "utf8").split("\n").filter((l) => l.trim() && !/ExperimentalWarning|trace-warnings/.test(l)).slice(-6).join("\n").slice(-700); } catch { return ""; }
}

export function controlStatus() {
  return {
    agentRunning: running("agent"), servicesRunning: running("services"),
    payments: paymentsAp4m() ? "AP4M (RLUSD vouchers)" : "native XRP (x402)", agentMode: process.env.AGENT_MODE ?? "rules",
    agentTail: running("agent") ? "" : tail("agent"), servicesTail: running("services") ? "" : tail("services"),
  };
}

function resetPortalData() {
  for (const f of ["portal-data.json", "agent-log.jsonl"]) fs.rmSync(path.join(ROOT, f), { force: true });
  fs.rmSync(path.join(ROOT, "uploads"), { recursive: true, force: true });
}

/** Runs scripts/deploy.ts with a fresh escrow and returns its output. */
function deploy(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--import", "tsx", "scripts/deploy.ts", "1"], {
      cwd: ROOT, env: { ...process.env, REDEPLOY: "1" }, windowsHide: true,
    });
    let output = "";
    c.stdout.on("data", (d) => (output += d));
    c.stderr.on("data", (d) => (output += d));
    c.on("exit", (code) => resolve({ ok: code === 0, output: output.split("\n").filter((l) => /deployed|deposits|rror|\] /.test(l)).join("\n").slice(-900) }));
  });
}

export async function control(action: string, dealId = "1"): Promise<{ ok: boolean; message: string }> {
  switch (action) {
    case "services-start":
      if (running("services")) return { ok: true, message: "Check services are already running." };
      launch("services", paymentsAp4m() ? "src/ap4m-merchant.ts" : "src/service.ts");
      return { ok: true, message: `Starting check services (${paymentsAp4m() ? "AP4M merchants" : "XRP service"}).` };
    case "services-stop": stop("services"); return { ok: true, message: "Check services stopped." };
    case "agent-start":
      if (running("agent")) return { ok: true, message: "The deal agent is already running." };
      if (!running("services")) await control("services-start");
      launch("agent", "src/orchestrator.ts", [dealId]);
      return { ok: true, message: `Deal agent started for deal ${dealId} (${process.env.AGENT_MODE ?? "rules"} mode). Watch Agent activity below.` };
    case "agent-stop": stop("agent"); return { ok: true, message: "Deal agent stopped." };
    case "reset": stop("agent"); resetPortalData(); return { ok: true, message: "Portal data and agent log cleared." };
    case "new-deal": {
      stop("agent");
      resetPortalData();
      const r = await deploy();
      return { ok: r.ok, message: r.ok ? `New deal ready: the buyer deposited 10% into a fresh escrow.\n${r.output}` : `Deploy failed:\n${r.output}` };
    }
    default: return { ok: false, message: "unknown action" };
  }
}

export const agentLogFile = AGENT_LOG;
