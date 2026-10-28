/**
 * THE PERP LEDGER'S VOCABULARY — its statuses, which way is forward, and what
 * the budgets count. docs/perps.md ("Ledger", rules 9, 10 and 12) is the
 * contract; this file is the one place it is spelled.
 *
 * PURE, AND SHARED BY THREE WRITERS. store.ts writes rows by these rules,
 * ledger-mirror.ts copies them up to the shared database by them, and
 * paper-checkpoint.ts validates a paper book by them. Three spellings of "is
 * `executed` ahead of `submitted`" is how a stale child comes to regress a
 * resolved order in shared storage, so there is exactly one. No database, no
 * clock, no import beyond core.
 */

// ── modes ───────────────────────────────────────────────────────────────────

/**
 * WHICH RAIL a perp row belongs to. Every perp table carries it, and no query
 * ever sums across it: a paper fill counting against the live day's notional
 * is the 2026-07-15 ops-cap incident (store.ts BudgetRail) in a new table.
 */
export type PerpMode = "paper" | "live";
export const PERP_MODES: readonly PerpMode[] = Object.freeze(["paper", "live"]);
export function isPerpMode(x: unknown): x is PerpMode {
  return x === "paper" || x === "live";
}

// ── perp_orders: one row per signed venue tx ────────────────────────────────

/**
 * `submitted` is the rule-9 row written BEFORE sendTx. `executed` is the venue
 * saying the tx ran (status 2..5) while the order's outcome — its fills — is
 * not yet booked; for a tx that is not an order (leverage, cancel, withdraw)
 * it is where the row ends. The six after it are FINAL: `partial` is an IOC
 * that filled some and had the rest cancelled (the amount says how much), not a
 * resting order part-way through; `app-error` is the venue executing the tx
 * and its application refusing it (`event_info.ae`), which is a refusal and
 * never an execution.
 */
export const PERP_ORDER_STATUSES = Object.freeze([
  "submitted",
  "executed",
  "filled",
  "partial",
  "cancelled",
  "rejected",
  "expired",
  "app-error",
] as const);
export type PerpOrderStatus = (typeof PERP_ORDER_STATUSES)[number];
export function isPerpOrderStatus(x: unknown): x is PerpOrderStatus {
  return typeof x === "string" && (PERP_ORDER_STATUSES as readonly string[]).includes(x);
}

/** A row in one of these is never rewritten — by the resolver or by the mirror. */
export const PERP_ORDER_TERMINAL: ReadonlySet<PerpOrderStatus> = new Set([
  "filled",
  "partial",
  "cancelled",
  "rejected",
  "expired",
  "app-error",
]);

/**
 * WHICH WAY IS FORWARD. A status may only move to a strictly higher rank, and
 * every terminal status shares the top rank so no final answer can replace
 * another. That is the whole guard against a late duplicate — a resolver
 * racing a restart, or a stale child ledger reaching the mirror after a fresh
 * one — turning `filled` back into `submitted` or `expired` into `filled`.
 */
export const PERP_ORDER_RANK: Readonly<Record<PerpOrderStatus, number>> = Object.freeze({
  submitted: 0,
  executed: 1,
  filled: 2,
  partial: 2,
  cancelled: 2,
  rejected: 2,
  expired: 2,
  "app-error": 2,
});

export const PERP_ORDER_EFFECTS = Object.freeze([
  "open",
  "reduce",
  "close",
  "leverage",
  "cancel",
  "withdraw",
  "standdown",
] as const);
export type PerpOrderEffect = (typeof PERP_ORDER_EFFECTS)[number];
export function isPerpOrderEffect(x: unknown): x is PerpOrderEffect {
  return typeof x === "string" && (PERP_ORDER_EFFECTS as readonly string[]).includes(x);
}

// ── perp_order_legs: one row per client order index inside a tx ────────────

export const PERP_LEG_ROLES = Object.freeze(["entry", "sl", "tp", "close"] as const);
export type PerpLegRole = (typeof PERP_LEG_ROLES)[number];
export function isPerpLegRole(x: unknown): x is PerpLegRole {
  return typeof x === "string" && (PERP_LEG_ROLES as readonly string[]).includes(x);
}

/**
 * A leg lives longer than its tx: a stop child rests at the venue for up to 28
 * days after the entry's tx is final. `pending` is a child waiting on its
 * parent or its trigger; `open` is resting on the book. Unlike perp_orders,
 * `partial` here is a leg that ENDED part-filled. The venue's own status word
 * rides beside this in `venue_status`, verbatim — two vocabularies, never
 * mixed (the trades.settlement_status precedent).
 */
export const PERP_LEG_STATUSES = Object.freeze([
  "submitted",
  "pending",
  "open",
  "filled",
  "partial",
  "cancelled",
  "expired",
  "rejected",
] as const);
export type PerpLegStatus = (typeof PERP_LEG_STATUSES)[number];
export function isPerpLegStatus(x: unknown): x is PerpLegStatus {
  return typeof x === "string" && (PERP_LEG_STATUSES as readonly string[]).includes(x);
}
export const PERP_LEG_RANK: Readonly<Record<PerpLegStatus, number>> = Object.freeze({
  submitted: 0,
  pending: 1,
  open: 2,
  filled: 3,
  partial: 3,
  cancelled: 3,
  expired: 3,
  rejected: 3,
});

// ── perp_fills / perp_funding ───────────────────────────────────────────────

/** The venue's four trade types (research: fill-and-funding-identity). */
export const PERP_TRADE_TYPES = Object.freeze(["trade", "liquidation", "deleverage", "market-settlement"] as const);
export type PerpTradeType = (typeof PERP_TRADE_TYPES)[number];

/**
 * HOW A FILL CAME TO BE ON OUR ACCOUNT — provenance, rule 10 and rule 16.
 *   intent        an order of ours, from a perp_orders row.
 *   venue-forced  liquidation, deleverage or settlement no intent produced:
 *                 alerted and fed to the breaker.
 *   venue-stop    our own resting stop or take-profit child firing.
 *   orphan-order  signed with our key index, no ledger row (adopted at arm):
 *                 never fed to the breaker as a liquidation.
 *   owner-recover the owner's L1 escape hatch (recover).
 *   venue-unknown matches nothing of ours — an incident, still booked.
 */
export const PERP_ATTRIBUTIONS = Object.freeze([
  "intent",
  "venue-forced",
  "venue-stop",
  "orphan-order",
  "owner-recover",
  "venue-unknown",
] as const);
export type PerpAttribution = (typeof PERP_ATTRIBUTIONS)[number];

// ── perp_transfers ──────────────────────────────────────────────────────────

export const PERP_TRANSFER_DIRECTIONS = Object.freeze(["deposit", "withdraw"] as const);
export type PerpTransferDirection = (typeof PERP_TRANSFER_DIRECTIONS)[number];
export const PERP_TRANSFER_INITIATORS = Object.freeze(["agent", "owner", "standdown"] as const);
export type PerpTransferInitiator = (typeof PERP_TRANSFER_INITIATORS)[number];

/**
 * deposit:  submitted → landed (our UserOp's receipt carries the proxy's
 *           Deposit) → credited (the venue shows it) | failed
 * withdraw: submitted → executed (our L2 Withdraw ran) → paid (a
 *           WithdrawPending to this account) | failed | refunded
 * (the margin-in-transit amendment, 12a.)
 */
export const PERP_TRANSFER_STATES = Object.freeze([
  "submitted",
  "landed",
  "credited",
  "executed",
  "paid",
  "failed",
  "refunded",
] as const);
export type PerpTransferState = (typeof PERP_TRANSFER_STATES)[number];

export const PERP_TRANSFER_RANK: Readonly<Record<PerpTransferState, number>> = Object.freeze({
  submitted: 0,
  landed: 1,
  executed: 1,
  credited: 2,
  paid: 2,
  failed: 2,
  refunded: 2,
});

const DEPOSIT_STATES: ReadonlySet<PerpTransferState> = new Set(["submitted", "landed", "credited", "failed"]);
const WITHDRAW_STATES: ReadonlySet<PerpTransferState> = new Set(["submitted", "executed", "paid", "failed", "refunded"]);

/** A deposit is never `paid` and a withdrawal is never `credited`: the two machines do not share states. */
export function perpTransferStateFits(direction: PerpTransferDirection, state: PerpTransferState): boolean {
  return (direction === "deposit" ? DEPOSIT_STATES : WITHDRAW_STATES).has(state);
}

/** Money is in transit in exactly these: a deposit that left the account and a withdrawal that left the venue. */
export function perpTransferInTransit(direction: PerpTransferDirection, state: PerpTransferState): boolean {
  return direction === "deposit" ? state === "landed" : state === "executed";
}

/**
 * DID THIS TRANSITION MOVE MONEY? The `margin` journal entry is written exactly
 * when it did (rule 10: "the ledger records it once").
 *
 * Nothing moves until a transfer leaves `submitted`: a deposit whose UserOp
 * never landed, or a withdrawal the venue refused, took no money anywhere, so
 * `submitted → failed` (and a row born `submitted` or `failed`) journals
 * nothing. Every other step does — into transit, out of it into the venue or
 * the account, or back out of it when the venue fails or refunds.
 */
export function perpTransferMovesMoney(prev: PerpTransferState | null, next: PerpTransferState): boolean {
  const idle = (s: PerpTransferState | null) => s === null || s === "submitted";
  if (idle(prev) && (next === "submitted" || next === "failed")) return false;
  return prev !== next;
}

// ── budgets ─────────────────────────────────────────────────────────────────

/**
 * WHAT COUNTS AS AN OP. An allow-list, like store.ts RAIL_STATUSES, so a status
 * added later counts toward no cap until someone decides it should. `rejected`
 * never reached the sequencer's book, `expired` was never sequenced, and an
 * `app-error` was refused by the venue's application.
 */
export const PERP_OPS_ORDER_STATUSES: readonly PerpOrderStatus[] = Object.freeze([
  "submitted",
  "executed",
  "filled",
  "partial",
  "cancelled",
]);
/** A withdrawal request the venue has not yet refused. */
export const PERP_OPS_WITHDRAW_STATES: readonly PerpTransferState[] = Object.freeze(["submitted", "executed"]);

/**
 * WHICH ORDER ROWS STILL COUNT THEIR WORST NOTIONAL. A `submitted` row's fills
 * are unknown, and so are an `executed` row's until they are booked onto it —
 * counting `filled_quote_micro` there would count zero for an open that may
 * have filled in full. The daily cap errs toward under-spending, never over.
 */
export const PERP_UNRESOLVED_ORDER_STATUSES: readonly PerpOrderStatus[] = Object.freeze(["submitted", "executed"]);

// ── money as text ───────────────────────────────────────────────────────────

const INT_RE = /^-?(0|[1-9]\d*)$/;

/**
 * An integer as the canonical decimal string every perp money column holds —
 * TEXT, because a micro-USDG sum can pass 2^53 and a Postgres INTEGER is int4.
 * Canonical (no leading zeros, no "-0") so equal amounts are equal strings.
 * Throws on anything that is not an exact integer: a float here is exactly the
 * rounding rule 11 forbids.
 */
export function intText(v: bigint | number | string, what: string, opts: { min?: bigint } = {}): string {
  let b: bigint;
  if (typeof v === "bigint") b = v;
  else if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new RangeError(`${what}: ${v} is not a safe integer`);
    b = BigInt(v);
  } else {
    if (!INT_RE.test(v)) throw new RangeError(`${what}: ${JSON.stringify(v)} is not a canonical integer`);
    b = BigInt(v);
  }
  if (opts.min !== undefined && b < opts.min) throw new RangeError(`${what}: ${b} is below ${opts.min}`);
  return b.toString();
}

/** A stored integer string back to a bigint; null for NULL, and null — never 0 — for anything unreadable. */
export function textInt(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isSafeInteger(v) ? BigInt(v) : null;
  if (typeof v !== "string" || !INT_RE.test(v)) return null;
  return BigInt(v);
}

/**
 * `CASE <column> WHEN 'a' THEN 0 … ELSE -1 END` — a rank table as SQL, for a
 * guard that must run inside one statement (the mirror's rank-guarded update).
 * The values are this file's own literals, never input, so inlining them is
 * safe; an unknown status ranks below everything and so can never win.
 */
export function rankCaseSql(column: string, ranks: Readonly<Record<string, number>>): string {
  const arms = Object.entries(ranks)
    .map(([k, r]) => `WHEN '${k.replace(/'/g, "''")}' THEN ${r}`)
    .join(" ");
  return `(CASE ${column} ${arms} ELSE -1 END)`;
}
