/** Self-hosted Spot + Perps processes. No grants or keys are copied between homes. */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { grantPurpose, isHostedMode, type GrantPurpose } from "../../packages/core/src/index";
import { merrymenHome } from "./home";

export function localWorkerEnv(home: string, purpose: GrantPurpose, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const workerHome = purpose === "perps" ? path.join(home, "accounts", "perps") : home;
  const env: NodeJS.ProcessEnv = { ...base, MERRYMEN_HOME: workerHome, MERRYMEN_WALLET_PURPOSE: purpose,
    MERRYMEN_LOCAL_SUPERVISED: "1", MERRYMEN_GRANT_FILE: path.join(workerHome, "grant.json"),
    MERRYMEN_SETTINGS_FILE: path.join(workerHome, "settings.json") };
  // Recovery owner authority is never a worker credential. A Perps child must
  // also never inherit the Spot bot, holder wallet or a shared database URL.
  delete env.MERRYMEN_RECOVER_OWNER_KEY;
  if (purpose === "perps") {
    for (const key of ["DATABASE_URL", "MERRYMEN_STORE_DEK", "MERRYMEN_SESSION_SECRET", "MERRYMEN_TELEGRAM_BOT_TOKEN", "MERRYMEN_HOLDER_ADDRESS"]) delete env[key];
    env.MERRYMEN_TG_GROUPS = "0";
  }
  return env;
}

type Slot = { child: ChildProcess | null; startedAt: number; restarts: number; nextAt: number; wanted: boolean };
export class LocalWorkers {
  private stopping = false;
  private slots: Record<GrantPurpose, Slot> = {
    spot: { child: null, startedAt: 0, restarts: 0, nextAt: 0, wanted: true },
    perps: { child: null, startedAt: 0, restarts: 0, nextAt: 0, wanted: false },
  };
  constructor(private opts: { home: string; env?: NodeJS.ProcessEnv; spawn?: typeof spawn; now?: () => number; log?: (line: string) => void }) {}
  private log(line: string) { (this.opts.log ?? console.log)(`[local-workers] ${line}`); }
  private readyPerps(): boolean {
    try {
      const grant = JSON.parse(readFileSync(path.join(this.opts.home, "accounts", "perps", "grant.json"), "utf8"));
      if (grantPurpose(grant) !== "perps" || !/^0x[0-9a-f]{40}$/i.test(grant.smartAccount)) return false;
      let spot: { smartAccount?: string } | null = null;
      try { spot = JSON.parse(readFileSync(path.join(this.opts.home, "grant.json"), "utf8")); } catch { /* Spot can be absent. */ }
      return spot?.smartAccount?.toLowerCase() !== grant.smartAccount.toLowerCase();
    } catch { return false; }
  }
  /** Polling notices a wallet created after the application started. */
  reconcile(): void {
    if (this.stopping) return;
    // Keep a once-started worker alive after grant removal so its existing
    // protective/stand-down loop can finish. It independently disarms on disk.
    this.slots.perps.wanted ||= this.readyPerps();
    for (const purpose of ["spot", "perps"] as const) {
      const slot = this.slots[purpose], now = (this.opts.now ?? Date.now)();
      if (!slot.wanted || slot.child || slot.restarts > 8 || now < slot.nextAt) continue;
      const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
      const child = (this.opts.spawn ?? spawn)(process.execPath, ["--import", "tsx", entry], {
        cwd: path.resolve(path.dirname(entry), "../.."), env: localWorkerEnv(this.opts.home, purpose, this.opts.env),
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      slot.child = child; slot.startedAt = now;
      this.log(`${purpose} worker started`);
      child.on("error", () => this.log(`${purpose} worker could not start`));
      child.once("close", () => {
        if (slot.child !== child) return;
        slot.child = null;
        if (this.stopping) return;
        const endedAt = (this.opts.now ?? Date.now)();
        if (endedAt - slot.startedAt > 60_000) slot.restarts = 0;
        slot.restarts++;
        slot.nextAt = endedAt + Math.min(30_000, 1_000 * 2 ** Math.min(slot.restarts, 5));
        this.log(slot.restarts > 8 ? `${purpose} worker repeatedly failed; fix its error and restart Merrymen` : `${purpose} worker stopped; restart ${slot.restarts} waits for backoff`);
      });
    }
  }
  stop(signal: NodeJS.Signals = "SIGTERM"): void {
    this.stopping = true;
    for (const slot of Object.values(this.slots)) slot.child?.kill(signal);
  }
  get running(): boolean { return Object.values(this.slots).some(slot => slot.child !== null); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (isHostedMode()) throw new Error("hosted workers must run through start:orchestrator");
  const workers = new LocalWorkers({ home: merrymenHome() });
  workers.reconcile();
  const timer = setInterval(() => workers.reconcile(), 2_000);
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true; clearInterval(timer); workers.stop();
    const drain = setInterval(() => { if (!workers.running) { clearInterval(drain); process.exit(0); } }, 50);
    setTimeout(() => { workers.stop("SIGKILL"); }, 10_000).unref();
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  process.on("exit", () => workers.stop());
}
