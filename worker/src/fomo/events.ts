/**
 * EVENT IDENTITY — the key that makes at-least-once delivery safe.
 *
 * The same trader event can reach Merrymen three ways: the live stream, the
 * stream's own replay of recent events on reconnect, and REST recovery after a
 * gap. A worker restart adds a fourth. Every one of those must collapse to ONE
 * persisted event, or a reconnect becomes a duplicate research task, a
 * duplicate decision, a duplicate post.
 *
 * IDENTITY, STRONGEST FIRST
 *
 *   provider-event-id  The provider's own event id (a UUID). It is the same
 *                      on the stream and on REST, which is what lets the two
 *                      be deduplicated against each other.
 *   fill-identity      A provider fill (swap) id. One transaction can carry
 *                      several fills, so a TRANSACTION HASH IS NOT AN EVENT:
 *                      two fills in one tx keep two keys.
 *   fingerprint        Neither exists. A conservative hash over who, what,
 *                      which token, which side, the tx hash when present, the
 *                      quantised event time and the amounts. Marked
 *                      `identityAmbiguous` so downstream code knows two
 *                      genuinely different fills could share it (identical
 *                      size in one tx) or one fill could split (a later row
 *                      carrying a different rounding). Ambiguity is
 *                      preserved, not hidden.
 */

import { createHash } from "node:crypto";
import type { ActivityKind, EventIdentityBasis, TraderEvent } from "./types";

const UUIDISH = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;
const OPAQUE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TX_HASH = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/;

export interface EventIdentityInput {
  eventId?: unknown;
  swapId?: unknown;
  /** Log index within the transaction, when a source supplies one. */
  logIndex?: unknown;
  txHash?: unknown;
  userId?: unknown;
  /** A wallet or handle, used only by the fingerprint when there is no user id. */
  actor?: unknown;
  tokenKey?: string | null;
  kind: ActivityKind;
  /** Provider event time in ms. Quantised to 5 s before hashing (the provider's own quantum). */
  sourceEventAt?: number | null;
  amountToken?: unknown;
  usd?: unknown;
}

export interface EventIdentity {
  eventKey: string;
  basis: EventIdentityBasis;
  ambiguous: boolean;
}

function idString(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).trim();
  return OPAQUE_ID.test(s) ? s : null;
}

function txHashOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!TX_HASH.test(s)) return null;
  // EVM hashes are case-insensitive hex; Solana signatures are base58 and are not.
  return s.startsWith("0x") ? s.toLowerCase() : s;
}

/** Round a float to a few significant figures so a re-serialised copy hashes the same. */
function roundFigure(raw: unknown): string {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return "-";
  return n === 0 ? "0" : Number(n.toPrecision(6)).toString();
}

export function eventIdentity(i: EventIdentityInput): EventIdentity {
  const eventId = idString(i.eventId);
  if (eventId && UUIDISH.test(eventId)) {
    return { eventKey: `ev:${eventId.toLowerCase()}`, basis: "provider-event-id", ambiguous: false };
  }
  const swapId = idString(i.swapId);
  if (swapId) {
    return { eventKey: `fill:${swapId}`, basis: "fill-identity", ambiguous: false };
  }
  const tx = txHashOf(i.txHash);
  const logIndex = typeof i.logIndex === "number" && Number.isSafeInteger(i.logIndex) && i.logIndex >= 0 ? i.logIndex : null;
  if (tx && logIndex !== null) {
    return { eventKey: `log:${tx}:${logIndex}`, basis: "fill-identity", ambiguous: false };
  }
  // A non-UUID provider id is still the provider's identity for this event; it
  // is kept, but namespaced so it can never collide with a UUID key.
  if (eventId) return { eventKey: `evx:${eventId}`, basis: "provider-event-id", ambiguous: false };
  const who = idString(i.userId)?.toLowerCase() ?? (typeof i.actor === "string" ? i.actor.trim().toLowerCase().slice(0, 64) : "-");
  const at = typeof i.sourceEventAt === "number" && Number.isFinite(i.sourceEventAt) ? Math.floor(i.sourceEventAt / 5_000) * 5_000 : "-";
  const parts = [who, i.tokenKey ?? "-", i.kind, tx ?? "-", String(at), roundFigure(i.amountToken), roundFigure(i.usd)];
  const digest = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
  return { eventKey: `fp:${digest}`, basis: "fingerprint", ambiguous: true };
}

/**
 * Collapse duplicates by key, keeping the FIRST copy seen except that a live
 * (non-replay) copy replaces a replayed one, and a richer copy (one that
 * carries a matched fill) fills in fields the first lacked. Order of the
 * survivors follows first appearance.
 */
export function dedupeEvents(events: readonly TraderEvent[]): { events: TraderEvent[]; duplicates: number } {
  const byKey = new Map<string, TraderEvent>();
  let duplicates = 0;
  for (const e of events) {
    const prior = byKey.get(e.eventKey);
    if (!prior) {
      byKey.set(e.eventKey, e);
      continue;
    }
    duplicates++;
    byKey.set(e.eventKey, mergeCopies(prior, e));
  }
  return { events: [...byKey.values()], duplicates };
}

/** Two copies of the same event: keep what is known, never invent what is not. */
export function mergeCopies(a: TraderEvent, b: TraderEvent): TraderEvent {
  // Pick the kept and the filling copy BEFORE spreading. Comparing a spread copy
  // to `a` is never true, which once made `other` always `a`: the normal case
  // (first copy kept) then filled every field from itself and silently dropped a
  // later REST copy's matched fill, tx hash and verification upgrade.
  const keepB = a.replay && !b.replay;
  const base = keepB ? b : a;
  const other = keepB ? a : b;
  // Optional fields are filled only when one copy knows them, so a merge never adds an empty key.
  const optional: Partial<TraderEvent> = {};
  for (const k of ["providerAlertId", "providerAlertSeq", "fillUsdSource", "perp"] as const) {
    const v = base[k] ?? other[k];
    if (v !== undefined && v !== null) (optional as Record<string, unknown>)[k] = v;
  }
  return {
    ...base,
    ...optional,
    replay: a.replay && b.replay,
    fillUsd: base.fillUsd ?? other.fillUsd,
    fillUsdBasis: base.fillUsdBasis ?? other.fillUsdBasis,
    execAt: base.execAt ?? other.execAt,
    txHash: base.txHash ?? other.txHash,
    swapId: base.swapId ?? other.swapId,
    verification: mergedVerification(base, other),
    observedAt: Math.min(a.observedAt, b.observedAt),
  };
}

/**
 * Order for two events at the same time: the provider's alert sequence when
 * both carry one (its own "then id desc" tiebreak inside a 5 s bucket), so a
 * position's later sell is never sorted before its earlier one by a random
 * event id. An event without one sorts after those with one (a total order,
 * so a sort stays consistent on mixed input); callers then fall back to the key.
 */
export function providerSequenceOrder(a: TraderEvent, b: TraderEvent): number {
  const x = typeof a.providerAlertSeq === "number" && Number.isFinite(a.providerAlertSeq) ? a.providerAlertSeq : Infinity;
  const y = typeof b.providerAlertSeq === "number" && Number.isFinite(b.providerAlertSeq) ? b.providerAlertSeq : Infinity;
  return x === y ? 0 : x < y ? -1 : 1;
}

/** The provider's event-time quantum (its alert times are 5 s buckets; the fingerprint above uses the same). */
const PROVIDER_QUANTUM_MS = 5_000;

const finiteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * THE TIME AN EVENT IS ORDERED BY, which is not always the time it is shown at.
 *
 * An app-feed alert the provider sequenced (`alrt_<ts>_<seq>`) is ordered on
 * the PROVIDER's clock: its event time, quantised to the provider's 5 s
 * bucket, with the sequence deciding inside the bucket. Its block time
 * (`execAt`, set when the fill matched exactly) is another clock, seconds
 * away from the provider's (live, 2026-10-04: from 8 s before to 2 s after),
 * and a sort that took the block time for one sell and the provider time for
 * the next put a trader's later sell first, so "the latest sell" and "the
 * latest cumulative P&L" came from the earlier one. Everything else (an
 * on-chain trade frame, a row with no sequence) is ordered by when it
 * happened: the block, else the provider time, else our receipt.
 */
export function eventOrderTime(e: TraderEvent): number {
  if (finiteNum(e.providerAlertSeq) && finiteNum(e.sourceEventAt)) return Math.floor(e.sourceEventAt / PROVIDER_QUANTUM_MS) * PROVIDER_QUANTUM_MS;
  return e.execAt ?? e.sourceEventAt ?? e.observedAt;
}

/**
 * Oldest first: the order time, then the provider's sequence, then the event
 * key. Each event sorts by its own (time, sequence, key), so this is a total
 * order on any mix of sequenced and unsequenced events. Newest first is
 * `(a, b) => chronologicalOrder(b, a)`.
 */
export function chronologicalOrder(a: TraderEvent, b: TraderEvent): number {
  return eventOrderTime(a) - eventOrderTime(b) || providerSequenceOrder(a, b) || (a.eventKey < b.eventKey ? -1 : a.eventKey > b.eventKey ? 1 : 0);
}

/** The stronger basis of two copies, except that only a buy or sell can be provider-verified (a matched fill). */
function mergedVerification(base: TraderEvent, other: TraderEvent): TraderEvent["verification"] {
  const v = rankBasis(base.verification) >= rankBasis(other.verification) ? base.verification : other.verification;
  return v === "provider-verified" && base.kind !== "buy" && base.kind !== "sell" ? "provider-reported" : v;
}

function rankBasis(b: TraderEvent["verification"]): number {
  return b === "independently-verified" ? 2 : b === "provider-verified" ? 1 : 0;
}

export const EVENT_GUARDS = { UUIDISH, OPAQUE_ID, TX_HASH } as const;
