/** Parent-side shutdown supervisor. All DB/DEK access stays here, outside the venue-only child. */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { wrapSqlite, type Db } from "../db";
import { applyLedgerSchema } from "../store";
import { MIRROR_STATE_DDL, mirrorPerpLedger, openChildLedger } from "../ledger-mirror";
import { openPerpKey } from "./key-seal";
import { HostedStanddownStore, type HostedStanddownJob, STANDDOWN_CHECKPOINT_MAX } from "./hosted-standdown-store";
import { captureStanddownLedger, STANDDOWN_TABLES } from "./hosted-standdown-ledger";
import type { StanddownRunnerConfig } from "./hosted-standdown-runner";
import { CheckpointFrameReceiver, clearCheckpointUploads } from "./hosted-checkpoint-ipc";
import { captureFinancialStream, inspectFinancialStream, restoreFinancialStream, validateFinancialStream, type FinancialChunks } from "./hosted-financial-stream";

export function hostedStanddownAvailable(env: Record<string, string | undefined> = process.env): boolean {
 // Shared transactional storage is part of the mechanism, not an opt-in bypass.
 const key = env.MERRYMEN_STORE_DEK;
 return !!env.DATABASE_URL && !!key && Buffer.from(key, "base64").length === 32;
}
export function standdownChildEnv(home: string, fleetHome: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
 const out: NodeJS.ProcessEnv = { NODE_ENV: "production", MERRYMEN_HOME: home, MERRYMEN_FLEET_HOME: fleetHome, MERRYMEN_HOSTED: "1" };
 // Allowlist only runtime essentials. No RPC/bundler/model/Telegram/session/owner/store secrets.
 for (const k of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT", "WINDIR", "LANG", "TZ"]) if (env[k]) out[k] = env[k];
 return out;
}
type Running = { job: HostedStanddownJob; proc: ChildProcess; home: string; deadline: NodeJS.Timeout; frames: CheckpointFrameReceiver };
export interface StanddownSupervisorOptions {
 db: Db; dek: Buffer; home: string; normalHome(tenant: string): string;
 acquire(tenant: `0x${string}`): Promise<boolean>; healthy(tenant: string): boolean;
 /** Resolves only after the previous normal process has actually exited. */
 stopNormal(tenant: string): Promise<boolean>;
 log(message: string): void;
 /** Tests substitute an inert IPC process; production always uses node:child_process. */
 spawnRunner?: typeof spawn;
}

export class HostedStanddownSupervisor {
 private store: HostedStanddownStore;
 private running = new Map<string, Running>();
 private claimant = randomUUID();
 private busy = false;
 constructor(private o: StanddownSupervisorOptions) { this.store = new HostedStanddownStore(o.db, o.dek); }
 async reconcile(): Promise<Set<string>> {
  if (this.busy) return new Set((await this.store.list()).map(j => j.tenant));
  this.busy = true;
  try {
   await this.store.init(); await this.store.expire();
   const jobs = await this.store.list();
   for (const job of jobs) if (job.state === "done" || job.state === "expired") this.wipeJobKeys(job.id);
   const blocked = new Set(jobs.map(j => j.tenant));
   for (const run of [...this.running.values()]) {
    if (!this.o.healthy(run.job.tenant) || Date.now() >= run.job.expiresAtMs || !jobs.some(j => j.id === run.job.id && j.state === "running")) this.stop(run);
   }
   for (const job of jobs) {
    if (!(await this.o.acquire(job.tenant))) continue;
    if (!(await this.o.stopNormal(job.tenant))) continue;
    // Session authority ends with the kill. Only the sealed job can recover
    // the venue key; the normal home keeps ledger evidence until final mirror.
    for (const file of ["grant.json", "perp-key.json"]) rmSync(path.join(this.o.normalHome(job.tenant), file), { force: true });
    clearCheckpointUploads(this.o.normalHome(job.tenant));
    this.retireHomeReplay(this.o.normalHome(job.tenant));
    if (this.running.has(job.id)) continue;
    if (job.state === "done" || job.state === "expired") { await this.finishMirror(job); continue; }
    if (!this.o.healthy(job.tenant)) continue;
    const claimed = await this.store.claim(job.id, this.claimant);
    if (!claimed) continue;
    try { await this.start(claimed); }
    catch { this.o.log(`${job.tenant}: hosted perps shutdown remains pending; preparation failed`); }
   }
   return blocked;
  } finally { this.busy = false; }
 }
 stopAll(): void { for (const run of [...this.running.values()]) this.stop(run); }
 private wipeJobKeys(id: string): void {
  const root = path.join(this.o.home, "perp-standdowns");
  let homes: string[] = []; try { homes = readdirSync(root); } catch { return; }
  for (const home of homes) if (home.startsWith(`${id}-`) && /^\d+$/.test(home.slice(id.length + 1))) {
   try { rmSync(path.join(root, home, "perp-key.json"), { force: true }); } catch {}
   clearCheckpointUploads(path.join(root, home));
   this.retireHomeReplay(path.join(root, home));
  }
 }
 private retireHomeReplay(home: string): void {
  const file = path.join(home, "merrymen.db"); if (!existsSync(file)) return;
  // Synchronous cleanup is deliberately separate from accounting: nonce/hash
  // and journal evidence remain, while persisted signed replay authority ends.
  let raw: DatabaseSync | null = null;
  try { raw = new DatabaseSync(file); raw.prepare("UPDATE perp_orders SET tx_info = NULL WHERE mode = 'live'").run(); }
  catch { /* The durable capability is already fenced; retry local cleanup on the next pass. */ }
  finally { raw?.close(); }
 }
 private stop(run: Running): void {
  clearTimeout(run.deadline);
  run.frames.close();
  // Keep the map entry until exit: a successor never starts beside a live predecessor.
  run.proc.kill("SIGKILL");
  clearCheckpointUploads(run.home);
  try { rmSync(path.join(run.home, "perp-key.json"), { force: true }); } catch {}
  this.retireHomeReplay(run.home);
 }
 private async withFreshLedger<T>(job: HostedStanddownJob, consume: (chunks: FinancialChunks) => Promise<T>): Promise<T> {
  if (job.checkpoint) return consume(this.store.loadStream(job));
  if ((job.state === "done" || job.state === "expired") && job.generation > 1) {
   // Once a drainer may have sent, the old normal book cannot establish its
   // final nonce or fills. Corrupt/missing durable evidence remains blocked.
   throw new Error("shutdown completion has no verified checkpoint");
  }
  const local = openChildLedger(this.o.normalHome(job.tenant));
  if (local) {
   try { return await local.db.tx(tx => consume(captureFinancialStream(tx, job.smartAccount, { scope: "standdown" }))); }
   finally { local.close(); }
  }
  // A shared mirror cannot prove missing local journal history. Only an empty
  // baseline can start here; existing unverifiable histories stay unresolved.
  for (const table of ["journal", ...STANDDOWN_TABLES]) {
   if (await this.o.db.prepare(`SELECT 1 FROM ${table} WHERE lower(agent_id) = ?${table === "journal" ? "" : " AND mode = 'live'"} LIMIT 1`).get(job.smartAccount)) throw new Error("shutdown history has no verified recovery snapshot");
  }
  return consume([await captureStanddownLedger(this.o.db, job.smartAccount)]);
 }
 private async start(job: HostedStanddownJob): Promise<void> {
  if (!this.o.healthy(job.tenant) || !(await this.store.fence(job))) throw new Error("shutdown lease lost");
  const home = path.join(this.o.home, "perp-standdowns", `${job.id}-${job.generation}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const raw = new DatabaseSync(path.join(home, "merrymen.db"));
  try {
   const db = wrapSqlite(raw); await applyLedgerSchema(db);
   await this.withFreshLedger(job, chunks => restoreFinancialStream(db, chunks, job.smartAccount, { scope: "standdown" }));
   await db.tx(tx => this.store.checkpointStream(job, captureFinancialStream(tx, job.smartAccount, { scope: "standdown" })));
  }
  finally { raw.close(); }
  chmodSync(path.join(home, "merrymen.db"), 0o600);
  const config: StanddownRunnerConfig = { id: job.id, smartAccount: job.smartAccount, apiPublicKey: job.apiPublicKey,
   apiKeyIndex: job.apiKeyIndex, reason: job.reason, expiresAtMs: job.expiresAtMs };
  writeFileSync(path.join(home, "standdown.json"), JSON.stringify(config), { mode: 0o600 });
  const keyExpiry = setTimeout(() => { this.wipeJobKeys(job.id); }, Math.max(1, job.expiresAtMs - Date.now()));
  let registered = false;
  try {
  const privateKey = openPerpKey(job.sealedKey!, { tenant: job.tenant, smartAccount: job.smartAccount, apiPublicKey: job.apiPublicKey, apiKeyIndex: job.apiKeyIndex }, this.o.dek);
  writeFileSync(path.join(home, "perp-key.json"), JSON.stringify({ v: 1, publicKey: job.apiPublicKey, privateKey }), { mode: 0o600 });
  if (!this.o.healthy(job.tenant) || !(await this.store.fence(job))) { rmSync(path.join(home, "perp-key.json"), { force: true }); throw new Error("shutdown authority expired"); }
  const entry = fileURLToPath(new URL("./hosted-standdown-runner.ts", import.meta.url));
  const proc = (this.o.spawnRunner ?? spawn)(process.execPath, ["--max-old-space-size=384", "--import", "tsx", entry], {
   cwd: path.resolve(path.dirname(entry), "../../.."), env: standdownChildEnv(home, this.o.home), stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const run: Running = { job, proc, home, frames: new CheckpointFrameReceiver(home), deadline: setTimeout(() => this.stop(run), Math.max(1, job.expiresAtMs - Date.now())) };
  this.running.set(job.id, run);
  registered = true;
  let tail = Promise.resolve();
  proc.on("message", (msg: unknown) => { tail = tail.then(() => this.message(run, msg)).catch(() => this.stop(run)); });
  proc.on("error", () => this.stop(run));
  proc.on("exit", () => {
   run.frames.close();
   clearCheckpointUploads(home);
   clearTimeout(run.deadline);
   if (this.running.get(job.id) === run) this.running.delete(job.id);
   try { rmSync(path.join(home, "perp-key.json"), { force: true }); } catch {}
  });
  } finally {
   if (!registered) rmSync(path.join(home, "perp-key.json"), { force: true });
   clearTimeout(keyExpiry);
  }
 }
 private async message(run: Running, raw: unknown): Promise<void> {
  if (!raw || typeof raw !== "object") throw new Error("invalid shutdown message");
  const msg = raw as { id?: number; kind?: string; payload?: string };
  if (!Number.isSafeInteger(msg.id)) throw new Error("invalid shutdown message id");
  let ok = false;
  try {
   if (this.running.get(run.job.id) !== run || !this.o.healthy(run.job.tenant) || !(await this.store.fence(run.job))) throw new Error("shutdown fenced");
   if (msg.kind?.startsWith("checkpoint-")) {
    await run.frames.acceptStream(msg.kind.slice("checkpoint-".length), msg.payload, async chunks => {
     await this.store.checkpointStream(run.job, validateFinancialStream(chunks, run.job.smartAccount, { scope: "standdown" }));
    });
   } else if (msg.kind === "checkpoint") {
    if (typeof msg.payload !== "string" || msg.payload.length > STANDDOWN_CHECKPOINT_MAX * 1.4) throw new Error("shutdown checkpoint too large");
    await this.store.checkpoint(run.job, Buffer.from(msg.payload, "base64"));
   } else if (msg.kind === "close-capacity") {
    if (typeof msg.payload !== "string" || msg.payload.length > 128) throw new Error("shutdown close capacity refused");
    const marketId = JSON.parse(msg.payload) as number;
    const remainingCloseAttempts = await this.store.remainingCloseAttempts(run.job, marketId);
    if (!this.o.healthy(run.job.tenant) || !(await this.store.fence(run.job))) throw new Error("shutdown close capacity fenced");
    if (run.proc.connected) run.proc.send({ id: msg.id, ok: true, remainingCloseAttempts });
    return;
   } else if (msg.kind === "close-budget") {
    if (typeof msg.payload !== "string" || msg.payload.length > 1024) throw new Error("shutdown close identity refused");
    const close = JSON.parse(msg.payload) as { marketId: number; txHash: string };
    const reserved = await this.store.reserveClose(run.job, close);
    if (!this.o.healthy(run.job.tenant) || !(await this.store.fence(run.job))) throw new Error("shutdown close budget fenced");
    // An exhausted market budget refuses that close; other markets, cancels
    // and withdrawal can still complete under the same bounded shutdown.
    if (run.proc.connected) run.proc.send({ id: msg.id, ok: reserved });
    return;
   } else if (msg.kind === "result") {
    const result = safeResult(msg.payload);
    if (!result) throw new Error("shutdown result refused");
    ok = await this.store.finish(run.job, JSON.stringify(result));
    try { rmSync(path.join(run.home, "perp-key.json"), { force: true }); } catch {}
    if (run.proc.connected) run.proc.send({ id: msg.id, ok });
    return;
   } else if (msg.kind !== "fence") throw new Error("shutdown message kind refused");
   ok = this.o.healthy(run.job.tenant) && await this.store.fence(run.job);
  } catch { ok = false; }
  if (run.proc.connected) run.proc.send({ id: msg.id, ok });
  if (!ok) this.stop(run);
 }
 private async finishMirror(job: HostedStanddownJob): Promise<void> {
  if (!this.o.healthy(job.tenant)) return;
  const mirrorHome = path.join(this.o.home, "perp-standdowns", `${job.id}-mirror`);
  mkdirSync(mirrorHome, { recursive: true, mode: 0o700 });
  const raw = new DatabaseSync(path.join(mirrorHome, "merrymen.db"));
  chmodSync(path.join(mirrorHome, "merrymen.db"), 0o600);
  let completed = false;
  try {
   const db = wrapSqlite(raw); await applyLedgerSchema(db); await this.withFreshLedger(job, chunks => restoreFinancialStream(db, chunks, job.smartAccount, { scope: "standdown" }));
   await this.o.db.exec(MIRROR_STATE_DDL);
   const failed: Record<string, string> = {};
   const mirrorTenant = `${job.tenant}:standdown:${job.id}`;
   await mirrorPerpLedger({ child: db, shared: this.o.db, tenant: mirrorTenant, nowSec: Math.floor(Date.now() / 1000), batch: 512, copied: {}, failed });
   if (Object.keys(failed).length) throw new Error("shutdown mirror incomplete");
   if (!(await this.mirrorCaughtUp(db, mirrorTenant))) return;
   await this.o.db.exec("CREATE INDEX IF NOT EXISTS journal_agent_epoch_hash ON journal(agent_id, epoch, hash)");
   await this.o.db.tx(shared => db.tx(async snapshot => {
    await inspectFinancialStream(captureFinancialStream(snapshot, job.smartAccount, { scope: "standdown" }), job.smartAccount, { scope: "standdown", onRow: async (table, row) => {
     if (table !== "journal" || !["perp-fill", "funding", "margin", "perp-carry"].includes(String(row.kind))) return;
     if (!(await shared.prepare("SELECT 1 FROM journal WHERE lower(agent_id) = ? AND epoch = ? AND hash = ?").get(job.smartAccount, row.epoch, row.hash))) {
      await shared.prepare("INSERT INTO journal (agent_id, epoch, kind, payload_json, prev_hash, hash, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(row.agent_id, row.epoch, row.kind, row.payload_json, row.prev_hash, row.hash, row.at);
     }
    } });
   }));
   if (!this.o.healthy(job.tenant)) return;
   rmSync(path.join(this.o.home, "perp-standdowns", `${job.id}-${job.generation}`), { recursive: true, force: true });
   // No newer grant is admitted while this job was unmirrored.
   rmSync(this.o.normalHome(job.tenant), { recursive: true, force: true });
   await this.store.mirrored(job);
   completed = true;
  } catch { this.o.log(`${job.tenant}: hosted perps shutdown accounting is waiting for its final mirror`); }
  finally { raw.close(); if (completed) rmSync(mirrorHome, { recursive: true, force: true }); }
 }
 private async mirrorCaughtUp(child: Db, tenant: string): Promise<boolean> {
  for (const table of STANDDOWN_TABLES.filter(t => !["perp_accounts", "perp_positions"].includes(t))) {
   const stamp = ["perp_fills", "perp_funding", "perp_carries"].includes(table) ? "created_at" : "updated_at";
   const cursor = await this.o.db.prepare("SELECT last_id, last_stamp FROM mirror_state WHERE tenant = ? AND table_name = ?").get(tenant, table) as { last_id: number; last_stamp: number } | undefined;
   if (await child.prepare(`SELECT 1 FROM ${table} WHERE ${stamp} > ? OR (${stamp} = ? AND rowid > ?) LIMIT 1`).get(cursor?.last_id ?? 0, cursor?.last_id ?? 0, cursor?.last_stamp ?? -1)) return false;
  }
  return true;
 }
}

function safeResult(raw: unknown): Record<string, unknown> | null {
 if (typeof raw !== "string" || raw.length > 8192) return null;
 const r = JSON.parse(raw) as Record<string, unknown>;
 if (!["done", "residual", "unreachable"].includes(String(r.outcome)) || typeof r.ingested !== "boolean") return null;
 const nonnegative = (v: unknown) => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
 const amount = (v: unknown) => v === null || (typeof v === "string" && /^\d{1,50}$/.test(v));
 if (!nonnegative(r.ordersLeft) || !nonnegative(r.openPositions) || !nonnegative(r.finishedAt) || !nonnegative(r.otherAccounts) || !amount(r.collateralMicro) || !amount(r.withdrawRequestedMicro)) return null;
 // Residuals remain a count here; untrusted free text and all key-shaped fields are discarded.
 const unresolved = r.otherAccounts === null || r.openPositions === null || r.ordersLeft === null || r.collateralMicro === null || r.ingested !== true;
 const remains = Number(r.otherAccounts) > 0 || Number(r.openPositions) > 0 || Number(r.ordersLeft) > 0 || (typeof r.collateralMicro === "string" && BigInt(r.collateralMicro) > 0n);
 const outcome = r.outcome === "done" ? unresolved ? "unreachable" : remains ? "residual" : "done" : r.outcome;
 return { outcome, ingested: r.ingested, ordersLeft: r.ordersLeft, openPositions: r.openPositions,
  finishedAt: r.finishedAt, collateralMicro: r.collateralMicro, withdrawRequestedMicro: r.withdrawRequestedMicro, otherAccounts: r.otherAccounts };
}
