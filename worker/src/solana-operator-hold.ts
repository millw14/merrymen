/**
 * Operator holds for Solana trading, kept in the shared database so web
 * admission and the separate Solana worker read the same answer within one
 * tick, with no redeploy. A hold refuses every new trade (paper or live,
 * manual or automatic, buy or sell) for one tenant or, with "all", everyone.
 * Receipt recovery and owner revoke, withdraw and resume transactions continue.
 */
import type { Db } from "./db";
import { ensureSolanaTradingSchema, SOLANA_OPERATOR_HOLD_ALL } from "./solana-trading-store";

export class SolanaOperatorHoldError extends Error {
  constructor(message: string) { super(message); this.name = "SolanaOperatorHoldError"; }
}
export interface SolanaOperatorHold { scope: string; reason: string; createdAtMs: number }
export const SOLANA_HOLD_USAGE = "Usage: npm run solana:hold -- list | set <tenant|all> --reason \"why\" | release <tenant|all>";

/** CLI input: a lowercase tenant address, or "all". */
export function solanaHoldScope(value: string | undefined): string {
  return stored(value === "all" ? SOLANA_OPERATOR_HOLD_ALL : value);
}
function stored(scope: string | undefined): string {
  if (scope === SOLANA_OPERATOR_HOLD_ALL || (scope && /^0x[0-9a-f]{40}$/.test(scope))) return scope;
  throw new SolanaOperatorHoldError("Name a lowercase 0x tenant address, or all.");
}
function reasonOf(value: string | undefined): string {
  if (!value || value.trim() !== value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SolanaOperatorHoldError("Give a one-line reason of at most 200 characters.");
  }
  return value;
}

export async function listSolanaOperatorHolds(db: Db, postgres = false): Promise<SolanaOperatorHold[]> {
  await ensureSolanaTradingSchema(db, postgres);
  const rows = await db.prepare("SELECT scope,reason,created_at_ms FROM solana_operator_holds ORDER BY scope").all() as Array<{ scope: string; reason: string; created_at_ms: number | string }>;
  return rows.map(r => ({ scope: r.scope, reason: r.reason, createdAtMs: Number(r.created_at_ms) }));
}
export async function setSolanaOperatorHold(db: Db, scope: string, reason: string, nowMs: number, postgres = false): Promise<void> {
  const key = stored(scope), why = reasonOf(reason);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new SolanaOperatorHoldError("Invalid clock.");
  await ensureSolanaTradingSchema(db, postgres);
  await db.prepare(`INSERT INTO solana_operator_holds(scope,reason,created_at_ms) VALUES(?,?,?)
    ON CONFLICT(scope) DO UPDATE SET reason=excluded.reason`).run(key, why, nowMs);
}
export async function releaseSolanaOperatorHold(db: Db, scope: string, postgres = false): Promise<boolean> {
  const key = stored(scope);
  await ensureSolanaTradingSchema(db, postgres);
  return (await db.prepare("DELETE FROM solana_operator_holds WHERE scope=?").run(key)).changes === 1;
}

/** The CLI's whole behaviour, so it can be tested without a process. */
export async function runSolanaHoldCommand(db: Db, argv: readonly string[], nowMs: number, postgres = false): Promise<string> {
  const [command, target, ...rest] = argv;
  if (command === "list" && argv.length === 1) {
    const holds = await listSolanaOperatorHolds(db, postgres);
    return holds.length ? holds.map(h => `${h.scope === SOLANA_OPERATOR_HOLD_ALL ? "all" : h.scope}\t${new Date(h.createdAtMs).toISOString()}\t${h.reason}`).join("\n")
      : "No Solana operator holds.";
  }
  if (command === "set" && rest.length === 2 && rest[0] === "--reason") {
    const scope = solanaHoldScope(target);
    await setSolanaOperatorHold(db, scope, rest[1]!, nowMs, postgres);
    return `Solana trading held for ${target}. New trades are refused; recovery and owner actions continue.`;
  }
  if (command === "release" && rest.length === 0) {
    return await releaseSolanaOperatorHold(db, solanaHoldScope(target), postgres)
      ? `Solana hold released for ${target}.` : `No Solana hold was set for ${target}.`;
  }
  throw new SolanaOperatorHoldError(SOLANA_HOLD_USAGE);
}
