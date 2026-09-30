/**
 * THE TWO LEDGER STATEMENTS THE LIVE RECONCILER NEEDS AND store.ts DOES NOT
 * YET HAVE (docs/perps.md rules 9, 10, 16 and the Ledger's "Hosted" bullet).
 *
 * Both take the store's own `Db` — the putPerpPosition(db, …) shape — so
 * store.ts wires each in one line with its private connection:
 *
 *     export const insertAdoptedPerpOrder = (a: AdoptedPerpOrderInput) => insertAdoptedPerpOrderRow(getDb(), a);
 *     export const perpNonceRecorded = (…) => perpNonceRecordedRow(getDb(), …);
 *
 * and a test runs them against the same sqlite file through a second
 * connection. They live here, beside reconcile.ts, rather than inside
 * store.ts only because this stage's scope is the reconciler; nothing in them
 * depends on anything but db.ts and the ledger's vocabulary, so moving them
 * into store.ts's perp section is a cut and paste.
 *
 * WHY AN ADOPTED ROW IS ITS OWN WRITER AND NOT insertPerpOrderSubmitted. That
 * function is rule 9's persist-before-send: it demands the exact signed bytes,
 * a nonce reserved against the high-water, and stamps `created_at` with NOW.
 * An adopted row is the opposite case — a tx the venue shows that the ledger
 * lost (a hosted redeploy wipes the child's sqlite; redeploy-restart-
 * lifecycle (b)) — so it has no bytes to keep and nothing to send, and its
 * `created_at` MUST be the venue's own time: the day's opening notional is
 * rebuilt from these rows (rule 6, "the daily cap survives a wipe"), and an
 * open stamped at ingest time would count against the wrong 24 hours.
 *
 * THE NONCE IS THE ROW'S IDENTITY, as it is for every perp_orders row (the
 * unique index on agent, account, key, nonce). An adopted row's id is derived
 * from it, so adopting the same venue tx twice — a re-read, a second process,
 * a seeded row from shared storage — finds the row and writes nothing. A row
 * of OUR OWN at that nonce always wins: it is never overwritten or relabelled.
 */

import type { Db } from "../db";
import {
  PERP_LEG_ROLES,
  PERP_LEG_STATUSES,
  intText,
  type PerpLegRole,
  type PerpLegStatus,
} from "../perp-ledger-rules";
import { PERP_COI_MAX } from "../../../packages/core/src/perps";

/** `perp_orders.reason` on every adopted row — how rule 10's `orphan-order` provenance is found again. */
export const ADOPTED_REASON = "adopted";

/** The deterministic id of the adopted row for one (account, key, nonce): one venue tx, one row, however often it is adopted. */
export function adoptedOrderId(accountIndex: number, apiKeyIndex: number, nonce: number | bigint): string {
  return `adopted:${accountIndex}:${apiKeyIndex}:${nonce}`;
}

export interface AdoptedPerpLeg {
  role: PerpLegRole;
  /** nonce × 8 + leg — the scheme is what made the order recognisably ours (rule 9). */
  clientOrderIndex: number;
  venueOrderIndex: string | null;
  status: PerpLegStatus;
  /** The venue's own status word, verbatim (perp_order_legs.venue_status). */
  venueStatus: string | null;
}

export interface AdoptedPerpOrderInput {
  agentId: string;
  /** Used only when the agents row cannot be read (a ledger that has not armed) — addFlow's fallback. */
  epoch: number;
  accountIndex: number;
  apiKeyIndex: number;
  nonce: number;
  /** Known when the adoption came through /tx by hash; null when it came from an order read. */
  txHash: string | null;
  txType: number | null;
  /** `executed` while the main order still rests; its final word otherwise. */
  status: "executed" | "filled" | "partial" | "cancelled";
  /** `open` exactly when something in the tx was not reduce-only (the budget reads `reduce_only`, never this label). */
  effect: "open" | "close";
  reduceOnly: boolean;
  marketId: number;
  /** What the daily cap holds while the row is unresolved: base × worst price at the venue's own terms. */
  worstNotionalMicro: bigint;
  filledBase: bigint | null;
  filledQuoteMicro: bigint | null;
  /** The VENUE's time for the tx, unix seconds — never the ingest time (see the header). */
  createdAtSec: number;
  legs: readonly AdoptedPerpLeg[];
}

function fail(msg: string): never {
  throw new RangeError(`perp ledger (adopt): ${msg}`);
}

function int(v: unknown, what: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) fail(`${what} ${String(v)} is not an integer in [${min}, ${max}]`);
  return v;
}

/**
 * WRITE ONE ADOPTED perp_orders ROW AND ITS LEGS, or find the row already
 * there. `exists` when ANY row holds that (agent, account, key, nonce) — ours,
 * a seeded copy, or an earlier adoption — and then nothing is written except
 * legs the row did not yet have (an order read that shows a child the first
 * adoption did not). One transaction; throws on a malformed input or a failed
 * write, so a caller never books a fill against a row that is not there.
 */
export async function insertAdoptedPerpOrderRow(db: Db, a: AdoptedPerpOrderInput): Promise<{ id: string; outcome: "inserted" | "exists" }> {
  if (typeof a.agentId !== "string" || a.agentId.trim() === "") fail("an agent id is required");
  const agent = a.agentId.toLowerCase();
  const accountIndex = int(a.accountIndex, "account index", 1);
  const apiKeyIndex = int(a.apiKeyIndex, "api key index", 0, 254);
  const nonce = int(a.nonce, "nonce", 1);
  const epochFallback = int(a.epoch, "epoch", 1);
  const marketId = int(a.marketId, "market id", 0, 65_535);
  const createdAt = int(a.createdAtSec, "created at", 1);
  const txType = a.txType === null ? null : int(a.txType, "tx type", 0, 255);
  const txHash = a.txHash === null ? null : a.txHash.toLowerCase().replace(/^0x/, "");
  if (txHash !== null && !/^[0-9a-f]{80}$/.test(txHash)) fail("tx hash is not 80 hex");
  if (a.status !== "executed" && a.status !== "filled" && a.status !== "partial" && a.status !== "cancelled") fail(`status ${String(a.status)}`);
  if (a.effect !== "open" && a.effect !== "close") fail(`effect ${String(a.effect)}`);
  if (typeof a.reduceOnly !== "boolean") fail("reduceOnly must be a boolean");
  // Rule 8's union, the same as insertPerpOrderSubmitted's: an open is never
  // reduce-only and a close always is.
  if ((a.effect === "open") === a.reduceOnly) fail(`an adopted ${a.effect} with reduceOnly ${a.reduceOnly}`);
  const worst = intText(a.worstNotionalMicro, "worst notional", { min: 0n });
  const filledBase = a.filledBase === null ? null : intText(a.filledBase, "filled base", { min: 0n });
  const filledQuote = a.filledQuoteMicro === null ? null : intText(a.filledQuoteMicro, "filled quote", { min: 0n });
  if (a.status !== "executed" && (filledBase === null || filledQuote === null)) fail("a final adopted row carries its filled amounts");
  if (a.legs.length === 0) fail("an adopted order has at least one leg");
  const seen = new Set<number>();
  const legs = a.legs.map((l) => {
    if (!(PERP_LEG_ROLES as readonly string[]).includes(l.role)) fail(`leg role ${String(l.role)}`);
    if (!(PERP_LEG_STATUSES as readonly string[]).includes(l.status)) fail(`leg status ${String(l.status)}`);
    const coi = int(l.clientOrderIndex, "client order index", 1, Number(PERP_COI_MAX));
    if (seen.has(coi)) fail(`client order index ${coi} appears twice`);
    seen.add(coi);
    const venueOrderIndex = l.venueOrderIndex === null ? null : intText(l.venueOrderIndex, "venue order index", { min: 0n });
    const venueStatus = l.venueStatus === null ? null : /^[A-Za-z0-9:._-]{1,128}$/.test(l.venueStatus) ? l.venueStatus : fail("venue status");
    return { role: l.role, coi, venueOrderIndex, status: l.status, venueStatus };
  });
  const id = adoptedOrderId(accountIndex, apiKeyIndex, nonce);
  const final = a.status !== "executed";

  return db.tx(async (tx) => {
    const held = (await tx
      .prepare(`SELECT id FROM perp_orders WHERE agent_id = ? AND account_index = ? AND api_key_index = ? AND nonce = ?`)
      .get(agent, accountIndex, apiKeyIndex, nonce)) as { id: string } | undefined;
    const rowId = held?.id ?? id;
    let outcome: "inserted" | "exists" = "exists";
    if (held === undefined) {
      // The epoch the agents row is in, as every perp writer books (store.ts
      // perpBookingOf); the caller's only when there is no agents row yet.
      const ag = (await tx.prepare(`SELECT epoch FROM agents WHERE LOWER(smart_account) = LOWER(?)`).get(a.agentId)) as { epoch: number } | undefined;
      const epoch = ag ? Number(ag.epoch) : epochFallback;
      await tx
        .prepare(
          `INSERT INTO perp_orders (id, agent_id, mode, epoch, account_index, api_key_index, nonce, tx_hash, tx_type, tx_info,
                                    expired_at, status, effect, reduce_only, market_id, worst_notional_micro, filled_base,
                                    filled_quote_micro, decision_id, reason, created_at, resolved_at, updated_at)
           VALUES (?, ?, 'live', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ${final ? "unixepoch()" : "NULL"}, unixepoch())`,
        )
        .run(id, agent, epoch, accountIndex, apiKeyIndex, nonce, txHash, txType, a.status, a.effect, a.reduceOnly ? 1 : 0, marketId, worst,
          filledBase, filledQuote, ADOPTED_REASON, createdAt);
      outcome = "inserted";
    }
    // Legs by client order index, never twice (the table's primary key). A
    // leg another row already holds is that row's, not this one's.
    for (const l of legs) {
      await tx
        .prepare(
          `INSERT INTO perp_order_legs (agent_id, mode, order_id, role, client_order_index, venue_order_index, status, venue_status)
           VALUES (?, 'live', ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(agent, rowId, l.role, l.coi, l.venueOrderIndex, l.status, l.venueStatus);
    }
    return { id: rowId, outcome };
  });
}

/**
 * Does ANY perp_orders row — sent, rejected, expired, adopted — hold this
 * (account, key, nonce)? Rule 16(a)'s "a nonce we recorded". Throws on a read
 * failure: an unreadable answer is not "no".
 */
export async function perpNonceRecordedRow(db: Db, agentId: string, accountIndex: number, apiKeyIndex: number, nonce: number | bigint): Promise<boolean> {
  if (typeof agentId !== "string" || agentId.trim() === "") fail("an agent id is required");
  const n = typeof nonce === "bigint" ? nonce : BigInt(int(nonce, "nonce", 0));
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) return false;
  const row = await db
    .prepare(`SELECT 1 AS ok FROM perp_orders WHERE agent_id = ? AND account_index = ? AND api_key_index = ? AND nonce = ? LIMIT 1`)
    .get(agentId.toLowerCase(), int(accountIndex, "account index", 1), int(apiKeyIndex, "api key index", 0, 254), Number(n));
  return row !== undefined;
}
