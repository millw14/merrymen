/** Kill switches reach the separate Solana worker through the tenant's binding. */
import { statSync } from "node:fs";
import { isHostedMode } from "../../packages/core/src/hosted";
import { getSolanaBindingStore, type SolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { solanaRuntimeDbFile } from "./solana-runtime-db";

/**
 * No accounts file (ENOENT): nothing Solana can be running here. Anything else
 * that stops it being read (EACCES on a home another user owns, say) throws,
 * so the kill says the Solana half could not be stopped instead of none.
 */
function noAccountsFile(): boolean {
  try {
    statSync(solanaRuntimeDbFile());
    return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
}

/**
 * "Kill all agents" and Telegram /kill stop the tenant's Solana strategy too.
 * Throws when it cannot be stopped, so the caller reports the kill incomplete.
 * Without a database there is nothing that could trade: hosted Solana refuses
 * to run without the shared database, and a self-hosted install that never
 * used Solana has no accounts file (none is created here). With one, the
 * binding store first looks its table up read-only and answers "none" when it
 * is absent (MERRYMEN_SOLANA off, or never used): a Robinhood kill writes no
 * Solana schema and takes no Solana lock (SqlSolanaBindingStore killDb).
 */
export async function stopSolanaForKill(tenant: `0x${string}`, store: SolanaBindingStore = getSolanaBindingStore()): Promise<"stopped" | "none"> {
  if (!process.env.DATABASE_URL && (isHostedMode() || noAccountsFile())) return "none";
  return await store.disableForKill(tenant) ? "stopped" : "none";
}
/**
 * A self-hosted kill's Solana half (Telegram /kill, `merrymen kill`, run before
 * the Robinhood grant is touched): "stopped" when a strategy was on, null when
 * none was, "not-stopped" when it could not be stopped, so the kill is said to
 * be incomplete instead of done.
 */
export async function selfHostedSolanaKill(store?: SolanaBindingStore): Promise<"stopped" | "not-stopped" | null> {
  try { return await stopLocalSolanaForKill(store) === "stopped" ? "stopped" : null; } catch { return "not-stopped"; }
}
/** Self-hosted is one owner's install: its kill stops every local strategy. */
export async function stopLocalSolanaForKill(store: SolanaBindingStore = getSolanaBindingStore()): Promise<"stopped" | "none"> {
  if (isHostedMode()) throw new Error("A hosted kill names its tenant.");
  if (!process.env.DATABASE_URL && noAccountsFile()) return "none";
  let stopped = false;
  for (const tenant of await store.strategyTenants()) stopped = await store.disableForKill(tenant) || stopped;
  return stopped ? "stopped" : "none";
}
