/** Chain payout allocation and its partial remainder commit with the transfers they settle. */
import type { Db } from "../db";
import type { PerpTransferInput, PerpTransferOutcome, PerpTransferRow } from "../store";
import { LIGHTER_ROUTE_V1 } from "../../../packages/core/src/index";
import { payoutKey, recordPayouts, type CarriedPayout, type Payout, type RecordPayoutsResult } from "./payouts";

export const PERP_PAYOUT_SCHEMA = `CREATE TABLE IF NOT EXISTS perp_payouts (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, mode TEXT NOT NULL, epoch INTEGER NOT NULL,
  chain_id INTEGER NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
  block_number TEXT NOT NULL, amount_micro TEXT NOT NULL, remaining_micro TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (agent_id, chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS perp_payouts_updated ON perp_payouts(updated_at);`;

type Allocation = { tx_hash: string; log_index: number; block_number: string; amount_micro: string; remaining_micro: string };
const payoutOf = (r: Allocation): Payout => ({ txHash: r.tx_hash as `0x${string}`, logIndex: r.log_index,
  blockNumber: BigInt(r.block_number), amountMicro: BigInt(r.amount_micro) });

/** The caller supplies transaction-local readers/writers; none may open another transaction. */
export async function bookPayoutsAtomically(db: Db, agentId: string, payouts: readonly Payout[], io: {
  epoch(tx: Db): Promise<number>;
  owed(tx: Db): Promise<PerpTransferRow[]>;
  upsert(tx: Db, t: Omit<PerpTransferInput, "agentId" | "mode">): Promise<PerpTransferOutcome>;
}): Promise<RecordPayoutsResult> {
  const account = agentId.toLowerCase(), chain = LIGHTER_ROUTE_V1.chainId;
  return db.tx(async tx => {
    const epoch = await io.epoch(tx);
    const carried = await tx.prepare("SELECT * FROM perp_payouts WHERE agent_id = ? AND mode = 'live' AND remaining_micro <> '0'").all(account) as Allocation[];
    const carry: CarriedPayout[] = carried.map(r => ({ payout: payoutOf(r), remainingMicro: BigInt(r.remaining_micro) }));
    const fresh = new Map<string, Payout>(), known: string[] = [];
    for (const p of payouts) {
      // The pure allocator validates the complete shape before any writes.
      const key = payoutKey(p);
      const saved = await tx.prepare("SELECT * FROM perp_payouts WHERE agent_id = ? AND chain_id = ? AND tx_hash = ? AND log_index = ?")
        .get(account, chain, p.txHash.toLowerCase(), p.logIndex) as Allocation | undefined;
      const held = saved ? payoutOf(saved) : fresh.get(key);
      if (held && (held.amountMicro !== p.amountMicro || held.blockNumber !== p.blockNumber)) throw new Error("payout identity changed its amount or block");
      if (saved) known.push(key); else fresh.set(key, p);
    }
    // Legacy partial allocations cannot be reconstructed from a paid row's
    // amount alone. Refuse valuation until their chain history is recovered.
    const orphan = await tx.prepare(`SELECT 1 FROM perp_transfers t WHERE t.agent_id = ? AND t.mode = 'live'
      AND t.direction = 'withdraw' AND t.state = 'paid' AND t.tx_hash IS NOT NULL AND t.log_index IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM perp_payouts p WHERE p.agent_id = t.agent_id AND p.chain_id = t.chain_id
        AND p.tx_hash = t.tx_hash AND p.log_index = t.log_index) LIMIT 1`).get(account);
    if (orphan) throw new Error("payout allocation history is incomplete; venue transit remains unread");
    const result = await recordPayouts({ owedWithdrawals: () => io.owed(tx), upsertTransfer: t => io.upsert(tx, t) }, [...fresh.values()], { carry });
    if (result.refused.length || result.alreadyBooked.length) throw new Error("payout allocation contradicted the transfer ledger");
    const remaining = new Map(result.carry.map(c => [payoutKey(c.payout), c.remainingMicro]));
    for (const c of carry) await tx.prepare("UPDATE perp_payouts SET remaining_micro = ?, updated_at = unixepoch() WHERE agent_id = ? AND chain_id = ? AND tx_hash = ? AND log_index = ?")
      .run(String(remaining.get(payoutKey(c.payout)) ?? 0n), account, chain, c.payout.txHash.toLowerCase(), c.payout.logIndex);
    for (const [key, p] of fresh) await tx.prepare(`INSERT INTO perp_payouts
      (id, agent_id, mode, epoch, chain_id, tx_hash, log_index, block_number, amount_micro, remaining_micro)
      VALUES (?, ?, 'live', ?, ?, ?, ?, ?, ?, ?)`)
      .run(`${account}:${chain}:${key}`, account, epoch, chain, p.txHash.toLowerCase(), p.logIndex,
        String(p.blockNumber), String(p.amountMicro), String(remaining.get(key) ?? 0n));
    result.alreadyBooked.push(...known);
    return result;
  });
}
