/** Normal child's durable perps bridge. The parent alone owns the database and DEK. */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { isHostedMode } from "../../../packages/core/src/index";
import { wrapSqlite } from "../db";
import { merrymenHome } from "../home";
import { captureFinancialStream, validateFinancialStream } from "./hosted-financial-stream";
import { sendCheckpointStream } from "./hosted-checkpoint-ipc";

let seq = 0, listening = false;
const waits = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
let tail: Promise<void> = Promise.resolve();
function rpc(kind: "perp-checkpoint" | "perp-checkpoint-begin" | "perp-checkpoint-page" | "perp-checkpoint-commit" | "perp-fence", account: string, payload?: string): Promise<void> {
 if (!process.send || !process.connected) return Promise.reject(new Error("hosted perps durable parent is unavailable"));
 if (!listening) {
  listening = true;
  process.on("message", raw => {
   if (!raw || typeof raw !== "object") return;
   const msg = raw as { kind?: string; id?: number; ok?: boolean };
   if (msg.kind !== "perp-ack" || typeof msg.id !== "number") return;
   const pending = waits.get(msg.id); if (!pending) return;
   waits.delete(msg.id); clearTimeout(pending.timer);
   msg.ok === true ? pending.resolve() : pending.reject(new Error("hosted perps durable parent refused authority"));
  });
  process.on("disconnect", () => { for (const wait of waits.values()) { clearTimeout(wait.timer); wait.reject(new Error("hosted perps parent disconnected")); } waits.clear(); });
 }
 return new Promise((resolve, reject) => {
  const id = ++seq; const timer = setTimeout(() => { waits.delete(id); reject(new Error("hosted perps durable acknowledgement timed out")); }, 15_000);
  waits.set(id, { resolve, reject, timer }); process.send!({ kind, id, account: account.toLowerCase(), payload });
 });
}
export async function hostedPerpSendFence(agentId: string): Promise<void> {
 if (isHostedMode()) { await persist(agentId); await rpc("perp-fence", agentId); }
}
function persist(agentId: string): Promise<void> {
 const run = tail.then(async () => {
  const raw = new DatabaseSync(path.join(merrymenHome(), "merrymen.db"));
  try {
   const db = wrapSqlite(raw);
   // One SQLite snapshot includes domain rows and their committed journal.
   await db.tx(tx => sendCheckpointStream(validateFinancialStream(captureFinancialStream(tx, agentId), agentId, { scope: "financial" }),
    (kind, payload) => rpc(`perp-checkpoint-${kind}`, agentId, payload), merrymenHome()));
  } finally { raw.close(); }
 });
 tail = run.catch(() => {}); return run;
}
export function durableHostedPerpStore<T extends object>(store: T): T {
 const reads = new Set(["getPerpRecoveryContext", "perpFillRecoveryAcknowledged", "getPerpOrder", "listSubmittedPerpOrders", "perpOrderByCoi", "listOpenPerpTransfers", "getPerpPositions", "getPerpAccount", "getNonceHighWater", "perpNonceRecorded", "perpLaneLedgerFacts"]);
 return new Proxy(store, { get(target, key) {
  const fn = Reflect.get(target, key);
  if (typeof fn !== "function" || reads.has(String(key))) return fn;
  return async (...args: unknown[]) => {
   const result = await (fn as (...args: unknown[]) => unknown)(...args);
   if (isHostedMode()) {
    const first = args[0]; const account = typeof first === "string" ? first : (first as { agentId?: unknown } | null)?.agentId;
    if (typeof account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(account)) throw new Error("hosted perps checkpoint account unread");
    await persist(account);
   }
   return result;
  };
 } });
}
