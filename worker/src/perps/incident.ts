/**
 * ANYTHING THE VENUE SHOWS THAT WE DID NOT SIGN IS AN INCIDENT (docs/perps.md
 * rule 16; key-amendments `unknown-activity-freeze`).
 *
 * The Lighter API key can trade, park collateral in a sub-account, mint pool
 * shares and register nothing the wall bounds (rule 4). The worker cannot stop
 * a thief who holds it; it can only NOTICE, stop opening, and bring the money
 * home. This module is the noticing and the durable flag — nothing more:
 *
 *   detectIncidents   pure: this pass's reads → the triggers of rule 16 (a)–(e),
 *                     or null. Unread inputs are NEVER a pass: they are gaps
 *                     (incidentReadGaps), which refuse opens under rule 11.
 *   persistIncident   writes perp_accounts.incident_json BEFORE any response
 *                     step runs. The response itself — the rule-13 stand-down
 *                     on every account under our L1, withdrawals repeated as
 *                     margin frees, the owner told how to rotate the key — is
 *                     another module's (standdown.ts). A flag that lived only in
 *                     memory would be forgotten by the next restart while the
 *                     thief still holds the key.
 *   clearIncident     the owner's action, and only once the key at our index is
 *                     no longer the sealed one: until then whoever holds that key
 *                     can open again as fast as we close.
 *
 * THE TRIGGERS, and what each one's evidence is:
 *
 *   (a) nonce-foreign        the venue's nonce for OUR key index says a tx
 *                            executed that we never reserved (above our
 *                            committed high-water), or that sits inside our
 *                            range but matches no row we wrote. Every tx this
 *                            worker signs reserves its nonce BEFORE signing and
 *                            is written BEFORE it is sent (rule 9), so "ours"
 *                            is always on the books first.
 *   (b) pubkey-mismatch      the key at our index is not the sealed key — unless
 *                            the sealed key was RETIRED by a journaled recover
 *                            (the owner rotated it on purpose).
 *       extra-api-key        any other key index registered on our account.
 *   (c) extra-account        any account under our L1 address other than the
 *                            master: the key can create sub-accounts and move
 *                            collateral into them with no L1 signature
 *                            (subaccount-transfer-blind-spot).
 *   (d) unknown-activity     an order, or a fill other than a liquidation,
 *                            deleverage or settlement, matching no row of ours.
 *   (e) venue-money-unexplained  collateral moved by more than fills, fees,
 *                            funding and our own transfers explain, K times in
 *                            a row (reconcile.ts's delta check). One mismatch is
 *                            a book gap (a fill landing between two reads);
 *                            only a PERSISTENT one is evidence.
 *
 * DETECTION IS AFTER THE FACT (Honest limits): what a stolen key does between
 * its first transaction and the next reconcile is not bounded here, and a
 * worker that is itself compromised will not report itself.
 */

import type { PerpIncident } from "../store";
import type { ApiKeyRead, L1Accounts } from "./markets";

// ── the incident ────────────────────────────────────────────────────────────

export const INCIDENT_TRIGGERS = Object.freeze([
  "nonce-foreign",
  "pubkey-mismatch",
  "extra-api-key",
  "extra-account",
  "unknown-activity",
  "venue-money-unexplained",
] as const);
export type IncidentTriggerKind = (typeof INCIDENT_TRIGGERS)[number];

export interface IncidentTrigger {
  kind: IncidentTriggerKind;
  /** Plain words and small numbers — indexes, nonces, counts. Never a key's bytes: the mirror and the log both read this. */
  evidence: string;
}

/**
 * Rule 16's durable flag, in store.ts PerpIncident's shape: `kind` is the
 * FIRST trigger (the table order above, most specific first), `at` unix
 * seconds, and `detail.triggers` every trigger this pass found.
 */
export interface Incident extends PerpIncident {
  kind: IncidentTriggerKind;
  at: number;
  detail: { triggers: IncidentTrigger[] };
}

// ── detection ───────────────────────────────────────────────────────────────

export interface IncidentInputs {
  /** The public key sealed in the grant (0x + 80 hex, either case). */
  sealedPubKey: string;
  /** Our key index (LIGHTER_ROUTE_V1.apiKeyIndex, 16 at ship time). */
  apiKeyIndex: number;
  /** Our venue account index — the master under our L1 address. */
  masterIndex: number;
  /** apikeys(master, 255): every key registered on our account. null = unread (a gap, never a pass). */
  apikeysRead: readonly ApiKeyRead[] | null;
  /** accountsByL1Address(self). null = unread. */
  accountsByL1Read: L1Accounts | null;
  /** perp_accounts.nonce_high_water, read AFTER the venue's nonce (so any nonce we sent is already under it). */
  highWater: bigint | null;
  /**
   * The venue's NEXT nonce for our key (apikeys' `nonce`, equal to nextNonce),
   * so the last one used is this − 1. null = unread.
   */
  venueNonceForOurKey: number | null;
  /**
   * Judge (a) this pass. False until the reconciler has established a
   * continuity baseline (a wiped ledger's lost nonces were ours, and are
   * adopted — redeploy-restart-lifecycle — not an incident).
   */
  nonceJudged?: boolean;
  /**
   * Is the venue's last-used nonce (or the next, whichever the venue's field
   * turns out to mean) a nonce some perp_orders row holds? null = not
   * checked. Only consulted when that nonce is inside our high-water: above
   * it, (a) fires regardless.
   */
  nonceRecorded?: boolean | null;
  /** The sealed key was retired by a journaled recover: a different key at our index is then the owner's rotation. */
  sealedRetired?: boolean;
  /** This pass: fills attributed `venue-unknown` (forced fills never count here). */
  unknownFills: number;
  /** This pass: venue orders on our account that match no row and are not ours by the client-index scheme. */
  unknownOrders?: number;
  /** The venue-delta identity has failed K passes in a row (reconcile.ts): contributions are doubtful. */
  deltaMismatch: boolean;
  /** Unix seconds, for `at`. */
  nowSec: number;
}

function canonKey(k: string): string | null {
  const bare = typeof k === "string" ? k.trim().toLowerCase().replace(/^0x/, "") : "";
  return /^[0-9a-f]{80}$/.test(bare) ? `0x${bare}` : null;
}

/** A key shown in evidence: its first bytes only. The whole key is not a secret, but nothing here needs it. */
function keyTag(k: string): string {
  return `${k.slice(0, 10)}…`;
}

/**
 * The reads this pass could not make, as book gaps (rule 11). "If the apikeys
 * or account read fails, that is a gap in the book, never a pass."
 */
export function incidentReadGaps(i: Pick<IncidentInputs, "apikeysRead" | "accountsByL1Read" | "venueNonceForOurKey" | "nonceJudged" | "masterIndex">): string[] {
  const gaps: string[] = [];
  if (i.apikeysRead === null) gaps.push("incident: the venue's api keys were not read");
  if (i.accountsByL1Read === null) gaps.push("incident: the accounts under our L1 address were not read");
  else if (!i.accountsByL1Read.accounts.some((a) => a.accountIndex === i.masterIndex)) {
    // An answer that does not show our own account is not an answer about us.
    gaps.push("incident: the L1 account list does not show our account");
  }
  if (i.nonceJudged !== false && i.venueNonceForOurKey === null) gaps.push("incident: the venue's nonce for our key was not read");
  return gaps;
}

/**
 * Rule 16 (a)–(e) over one pass's reads → the incident, or null. Pure. An
 * unread input contributes no trigger (see incidentReadGaps for what it
 * contributes instead); a read that shows something we never do always does.
 */
export function detectIncidents(i: IncidentInputs): Incident | null {
  const triggers: IncidentTrigger[] = [];
  const sealed = canonKey(i.sealedPubKey);

  // (a) a nonce on our key we did not sign.
  if (i.nonceJudged !== false && i.venueNonceForOurKey !== null && Number.isSafeInteger(i.venueNonceForOurKey)) {
    const lastUsed = BigInt(i.venueNonceForOurKey) - 1n;
    if (lastUsed > 0n && (i.highWater === null || lastUsed > i.highWater)) {
      triggers.push({
        kind: "nonce-foreign",
        evidence: `key ${i.apiKeyIndex} has used nonce ${lastUsed}, above the ${i.highWater === null ? "(never reserved)" : i.highWater.toString()} this worker ever reserved`,
      });
    } else if (lastUsed > 0n && i.nonceRecorded === false) {
      triggers.push({ kind: "nonce-foreign", evidence: `key ${i.apiKeyIndex} last used nonce ${lastUsed}, which no order row of ours holds` });
    }
  }

  // (b) the keys on our account.
  if (i.apikeysRead !== null) {
    const ours = i.apikeysRead.filter((k) => k.accountIndex === i.masterIndex && k.apiKeyIndex === i.apiKeyIndex);
    for (const k of ours) {
      const at = canonKey(k.publicKey);
      if (sealed === null || at === null || at !== sealed) {
        if (i.sealedRetired !== true) {
          triggers.push({
            kind: "pubkey-mismatch",
            evidence: `index ${i.apiKeyIndex} holds ${at === null ? "an unreadable key" : keyTag(at)}, not the sealed ${sealed === null ? "(unreadable)" : keyTag(sealed)}`,
          });
        }
      }
    }
    const others = i.apikeysRead.filter((k) => k.apiKeyIndex !== i.apiKeyIndex || k.accountIndex !== i.masterIndex);
    for (const k of others) {
      triggers.push({ kind: "extra-api-key", evidence: `account ${k.accountIndex} has a key registered at index ${k.apiKeyIndex}` });
    }
  }

  // (c) accounts under our L1 address.
  if (i.accountsByL1Read !== null) {
    for (const a of i.accountsByL1Read.accounts) {
      if (a.accountIndex !== i.masterIndex) {
        triggers.push({ kind: "extra-account", evidence: `account ${a.accountIndex} (type ${a.accountType}) exists under our L1 address` });
      }
    }
    // More than a page of accounts is more than the one we own.
    if (i.accountsByL1Read.nextCursor !== null) triggers.push({ kind: "extra-account", evidence: "the L1 account list runs past one page" });
  }

  // (d) orders and fills that are nobody's we know.
  const fills = Number.isSafeInteger(i.unknownFills) && i.unknownFills > 0 ? i.unknownFills : 0;
  const orders = i.unknownOrders !== undefined && Number.isSafeInteger(i.unknownOrders) && i.unknownOrders > 0 ? i.unknownOrders : 0;
  if (fills > 0 || orders > 0) {
    triggers.push({ kind: "unknown-activity", evidence: `${fills} fill(s) and ${orders} order(s) on our account match no order of ours` });
  }

  // (e) money the ledger cannot explain, persistently.
  if (i.deltaMismatch) {
    triggers.push({ kind: "venue-money-unexplained", evidence: "the venue's collateral moved by more than our fills, fees, funding and transfers explain, pass after pass" });
  }

  if (triggers.length === 0) return null;
  triggers.sort((x, y) => INCIDENT_TRIGGERS.indexOf(x.kind) - INCIDENT_TRIGGERS.indexOf(y.kind));
  const first = triggers[0] as IncidentTrigger;
  return { kind: first.kind, at: Math.floor(i.nowSec), detail: { triggers } };
}

// ── the durable flag ────────────────────────────────────────────────────────

/** The two store.ts functions the flag is kept with; the store module fits as is. */
export interface IncidentStore {
  getPerpAccount(agentId: string, mode: "live"): Promise<{ incident: PerpIncident | null } | null>;
  patchPerpAccount(agentId: string, mode: "live", patch: { incident: PerpIncident | null }): Promise<void>;
}

/**
 * SET THE FLAG, DURABLY, BEFORE ANYTHING RESPONDS TO IT. `already-set` when a
 * flag is standing: the FIRST incident's evidence is the one the owner needs,
 * and a later pass never replaces it. Throws when the write fails — the caller
 * must then keep refusing opens from memory and say the flag is not stored,
 * never carry on as if it were.
 */
export async function persistIncident(store: IncidentStore, args: { agentId: string; incident: Incident }): Promise<"set" | "already-set"> {
  const held = await store.getPerpAccount(args.agentId, "live");
  if (held?.incident) return "already-set";
  await store.patchPerpAccount(args.agentId, "live", { incident: args.incident });
  // Read back: "durably" means the row says so, not that a write returned.
  const after = await store.getPerpAccount(args.agentId, "live");
  if (!after?.incident) throw new Error("perp incident: the flag did not persist");
  return "set";
}

/**
 * THE OWNER CLEARS THE FLAG — from the dashboard, and only after the key at
 * our index is no longer the sealed one (rule 16). The literal `true` is the
 * caller's assertion; `keyAtOurIndex` is the read it rests on, re-checked
 * here, so a caller cannot clear a flag while the compromised key still
 * stands. An unreadable key (null) is not a rotated one.
 */
export async function clearIncident(
  store: IncidentStore,
  args: { agentId: string; venueKeyNoLongerSealed: true; sealedPubKey: string; keyAtOurIndex: string | null },
): Promise<"cleared" | "none"> {
  if (args.venueKeyNoLongerSealed !== true) throw new Error("perp incident: only the owner's rotation clears the flag");
  const sealed = canonKey(args.sealedPubKey);
  const at = args.keyAtOurIndex === null ? null : canonKey(args.keyAtOurIndex);
  if (sealed === null) throw new Error("perp incident: the sealed key is unreadable");
  if (at === null) throw new Error("perp incident: the key at our index was not read; the flag stays");
  if (at === sealed) throw new Error("perp incident: the key at our index is still the sealed one; rotate it with the owner key first");
  const held = await store.getPerpAccount(args.agentId, "live");
  if (!held?.incident) return "none";
  await store.patchPerpAccount(args.agentId, "live", { incident: null });
  return "cleared";
}
