/** Dedicated hosted shutdown entrypoint. Deliberately imports no strategy, grant, wallet or UserOp executor. */
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../db";
import { merrymenHome } from "../home";
import * as ledger from "../store";
import { createLighterApi } from "./api";
import { openLiveHandle, type LiveHandleStore } from "./live-handle";
import { loadSigner } from "./signer";
import { runStanddown, type StanddownResult } from "./standdown";
import { captureFinancialStream } from "./hosted-financial-stream";
import { sendCheckpointStream } from "./hosted-checkpoint-ipc";

export interface StanddownRunnerConfig {
 id: string; smartAccount: `0x${string}`; apiPublicKey: `0x${string}`; apiKeyIndex: number;
 reason: "kill" | "expiry"; expiresAtMs: number;
}
/** Results carry facts only; arbitrary executor errors and key material never cross IPC. */
export function publicStanddownResult(r: StanddownResult): Record<string, unknown> {
 return { outcome: r.outcome, ingested: r.ingested, finishedAt: r.finishedAt,
  ordersLeft: r.ordersLeft, openPositions: r.residual.length,
  collateralMicro: r.venue?.final ? (r.venue.collateralMicro + r.venue.isolatedMarginMicro).toString() : null,
  withdrawRequestedMicro: r.withdrawRequestedMicro?.toString() ?? null,
  residual: r.residual.map(p => ({ marketId: p.marketId, side: p.side, baseAmount: p.baseAmount.toString(), stopResting: p.stopResting })) };
}

/** Every mutation completes durably before its caller can sign/send or advance an ingest cursor. */
export function durableStanddownStore<T extends object>(store: T, persist: () => Promise<void>): T {
 const reads = new Set(["getPerpOrder", "listSubmittedPerpOrders", "perpOrderByCoi", "listOpenPerpTransfers", "getPerpPositions", "getPerpAccount", "getNonceHighWater", "perpNonceRecorded"]);
 return new Proxy(store, { get(target, key) {
  const fn = Reflect.get(target, key);
  if (typeof fn !== "function" || reads.has(String(key))) return fn;
  return async (...args: unknown[]) => { const out = await (fn as (...args: unknown[]) => unknown)(...args); await persist(); return out; };
 } });
}

/** Replay can follow an earlier failed mutation ACK, so every send re-checkpoints. */
export function durableStanddownSendFence(persist: () => Promise<void>, fence: () => Promise<void>): () => Promise<void> {
 return async () => { await persist(); await fence(); };
}

async function main(): Promise<void> {
 const home = merrymenHome();
 if (!process.send || !process.connected || process.env.DATABASE_URL || process.env.MERRYMEN_STORE_DEK) throw new Error("stand-down runner isolation refused");
 const config = JSON.parse(readFileSync(path.join(home, "standdown.json"), "utf8")) as StanddownRunnerConfig;
 if (!/^0x[0-9a-f]{40}$/.test(config.smartAccount) || !Number.isSafeInteger(config.expiresAtMs) || config.expiresAtMs <= Date.now()) throw new Error("stand-down runner deadline or account refused");
 const wipe = () => { try { rmSync(path.join(home, "perp-key.json"), { force: true }); } catch {} };
 const hardStop = setTimeout(() => { wipe(); process.exit(1); }, config.expiresAtMs - Date.now());
 process.on("disconnect", () => { wipe(); process.exit(1); });
 process.on("SIGTERM", () => { wipe(); process.exit(1); });
 let seq = 0;
 const waiting = new Map<number, { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
 process.on("message", (raw: unknown) => {
  if (!raw || typeof raw !== "object") return;
  const msg = raw as { id?: number; ok?: boolean };
  const wait = typeof msg.id === "number" ? waiting.get(msg.id) : undefined;
  if (!wait) return;
  waiting.delete(msg.id!); clearTimeout(wait.timer);
  msg.ok === true ? wait.resolve() : wait.reject(new Error("stand-down parent refused durable authority"));
 });
 const rpc = (kind: "fence" | "close-budget" | "checkpoint" | "checkpoint-begin" | "checkpoint-page" | "checkpoint-commit" | "result", payload?: string): Promise<void> => new Promise((resolve, reject) => {
  if (!process.connected || Date.now() >= config.expiresAtMs) { reject(new Error("stand-down deadline or parent lost")); return; }
  const id = ++seq;
  const timer = setTimeout(() => { waiting.delete(id); reject(new Error("stand-down durable acknowledgement timed out")); }, Math.min(15_000, config.expiresAtMs - Date.now()));
  waiting.set(id, { resolve, reject, timer });
  process.send!({ id, kind, payload });
 });
 await ledger.initStore();
 const raw = new DatabaseSync(path.join(home, "merrymen.db"));
 const db = wrapSqlite(raw);
 let checkpointTail = Promise.resolve();
 const persist = (): Promise<void> => {
  const run = checkpointTail.then(async () => {
   await db.tx(tx => sendCheckpointStream(captureFinancialStream(tx, config.smartAccount, { scope: "standdown" }), (kind, payload) => rpc(`checkpoint-${kind}`, payload), home));
  });
  checkpointTail = run.catch(() => {}); return run;
 };
 const store: LiveHandleStore = durableStanddownStore({
  insertPerpOrderSubmitted: ledger.insertPerpOrderSubmitted, resolvePerpOrder: ledger.resolvePerpOrder,
  updatePerpLegStatus: ledger.updatePerpLegStatus, upsertPerpTransfer: ledger.upsertPerpTransfer,
  listSubmittedPerpOrders: ledger.listSubmittedPerpOrders, perpOrderByCoi: ledger.perpOrderByCoi,
  insertPerpFill: ledger.insertPerpFill, insertPerpFunding: ledger.insertPerpFunding,
  listOpenPerpTransfers: ledger.listOpenPerpTransfers, setPerpPositions: ledger.setPerpPositions,
  getPerpPositions: ledger.getPerpPositions, getPerpAccount: ledger.getPerpAccount,
  patchPerpAccount: ledger.patchPerpAccount, bumpNonceHighWater: ledger.bumpNonceHighWater,
  getNonceHighWater: ledger.getNonceHighWater, insertAdoptedPerpOrder: ledger.insertAdoptedPerpOrder,
  perpNonceRecorded: ledger.perpNonceRecorded, getPerpOrder: ledger.getPerpOrder,
 }, persist);
 try {
  await rpc("fence");
  const publicApi = createLighterApi({ home, budgetKey: "public" });
  const accounts = await publicApi.accountsByL1Address(config.smartAccount, { exit: true });
  if (!accounts.ok || accounts.value.nextCursor !== null) throw new Error("venue account identity unread");
  const master = accounts.value.accounts.filter(a => a.accountType === 0);
  if (master.length !== 1) throw new Error("venue master account ambiguous");
  const held = await ledger.getPerpAccount(config.smartAccount, "live");
  const agent = await db.prepare("SELECT epoch FROM agents WHERE lower(smart_account) = ?").get(config.smartAccount) as { epoch: number } | undefined;
  if (!agent || !Number.isSafeInteger(agent.epoch) || agent.epoch < 1) throw new Error("shutdown accounting epoch unread");
  if (held?.accountIndex != null && held.accountIndex !== master[0]!.accountIndex) throw new Error("venue account identity changed");
  const opened = await openLiveHandle({ agentId: config.smartAccount, smartAccount: config.smartAccount,
   accountIndex: master[0]!.accountIndex, sealedPubKey: config.apiPublicKey, home,
   api: createLighterApi({ home, budgetKey: config.smartAccount }), publicApi, store, feed: () => null,
   now: Date.now, epoch: () => agent.epoch, loadSigner, standdownOnly: true, deadlineMs: config.expiresAtMs,
   beforeSend: tx => durableStanddownSendFence(persist, async () => {
    if (tx.txType === 14) {
     if (!tx.reduceOnly || tx.marketId === null) throw new Error("shutdown close identity unread");
     await rpc("close-budget", JSON.stringify({ txHash: tx.txHash, marketId: tx.marketId }));
    }
    await rpc("fence");
   })() });
  if (!opened.ok) throw new Error("venue shutdown handle unavailable");
  const handle = opened.handle; handle.exitReads = true;
  const result = await runStanddown({ reason: config.reason, deadlineMs: config.expiresAtMs - 1000,
   now: Date.now, executor: handle.standdownExecutor(async () => {}), reconcile: handle.standdownReconcile(), settings: { maxSlippageBps: 150 } });
  await persist();
  const summary = publicStanddownResult(result);
  summary.otherAccounts = accounts.value.accounts.length - 1;
  if (accounts.value.accounts.length > 1 && summary.outcome === "done") summary.outcome = "residual";
  await rpc("result", JSON.stringify(summary));
 } catch {
  // The parent retains the last committed checkpoint for retry until the fixed deadline.
  process.exitCode = 1;
 } finally {
  wipe(); raw.close(); ledger.closeStoreForTest(); clearTimeout(hardStop);
  for (const wait of waiting.values()) { clearTimeout(wait.timer); wait.reject(new Error("stand-down runner stopped")); }
  process.disconnect();
 }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 void main().catch(() => { process.exitCode = 1; process.disconnect?.(); });
}
