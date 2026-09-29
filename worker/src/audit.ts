/**
 * The audit format, and the verifier for it.
 *
 * The premise: someone who does not trust the operator, has never installed
 * merrymen, and has only a public RPC should be able to check every performance
 * claim the software makes. Until this existed they could not — the ledger is a
 * plain sqlite file on the operator's own disk, the equity curve is a series of
 * balance readings written by the process being audited, and nothing
 * cross-checked any of it.
 *
 * Three independent things are checked, and they fail differently on purpose:
 *
 *   1. THE CHAIN. Each record carries the hash of the one before it, so an
 *      edited record breaks every hash after it, and `seq` is monotonic, so a
 *      DELETED record shows up as a gap. Silence is as detectable as tampering.
 *
 *   2. THE CHAIN OF CUSTODY. Every fill and every flow names a transaction. A
 *      verifier with an RPC refetches it and compares the token movements the
 *      record claims against the ones the chain actually recorded. This is the
 *      part that makes the record more than internally consistent.
 *
 *   3. THE ARITHMETIC. Equity is recomputed from primitives — fills, flows and
 *      marks — rather than read back, and compared against what was published.
 *
 * Everything here is pure and takes its inputs as data, so the verifier can run
 * against a file it did not produce, with no access to ~/.merrymen.
 *
 * PERPS ADD A FOURTH KIND OF EVIDENCE, AND IT IS NOT THE CHAIN (docs/perps.md,
 * "Verify"; rule 10). A Lighter fill or funding payment happened on the venue's
 * own rollup: it is attested by Lighter's API and cannot be re-derived from a
 * Robinhood Chain receipt. So it is its own class — VENUE-ATTESTED — counted
 * into the arithmetic (it is money), never counted as chain-verified, never
 * counted as failed, and always said out loud as a gap in what was checked.
 * Margin moving between the account and the venue DOES touch the chain, and is
 * checked against its receipts by this file's own decoder.
 */

import { createHash } from "node:crypto";

/** Must match store.JOURNAL_GENESIS — duplicated so a verifier needs no store. */
export const GENESIS = "0".repeat(64);

// ── the export formats ──────────────────────────────────────────────────────
//
// WHY THE FORMAT STRING CHANGES, NOT JUST THE VERSION NUMBER. Every verifier
// already shipped checks `format` and never `version` (audit-cli.ts readExport).
// Bumping only `version` would let an old verifier read a perp book it does not
// understand, skip every perp record, and then FAIL the arithmetic — equity
// would include a venue term its composition check has never heard of — which
// is a false accusation, exit 1, against an honest ledger. A new `format` is
// refused by every shipped verifier instead ("not a merrymen journal export"):
// the one outcome an old tool can give that is not a wrong verdict.
//
// THE DECISION, stated once: an agent that has never touched perps keeps
// exporting v1, byte for byte, so every verifier ever shipped still reads it;
// anything with a perp record, a perp term on a mark, or a venue account is
// exported as v2. This verifier reads both, and refuses anything else with
// exit 2 (INDETERMINATE: nothing was judged), never exit 1.

/** The export every verifier has read since the audit trail shipped. No perps. */
export const JOURNAL_FORMAT_V1 = "merrymen-journal";
/** The export of a book that holds, or has held, perps. */
export const JOURNAL_FORMAT_V2 = "merrymen-journal-v2";

/** The journal kinds a perp book writes (store.ts JournalKind). Unknown to a v1 export by construction. */
export const PERP_JOURNAL_KINDS: readonly string[] = Object.freeze(["perp-fill", "funding", "margin", "perp-carry"]);

/**
 * THE VENUES THIS VERIFIER KNOWS, PINNED HERE — never taken from the header.
 *
 * The header is written by the operator, and anything the auditor must accept
 * from it is something the operator chose: a header naming a different proxy
 * could point every margin check at a contract that emits whatever it is told.
 * So a v2 header must name one of these, and every field it names must equal
 * the pinned one, or the export is refused. Duplicated from core's
 * LIGHTER_ROUTE_V1 on purpose (this file imports nothing); audit.test.ts holds
 * the two equal.
 */
export const VERIFIER_VENUES = Object.freeze({
  "lighter-rh": Object.freeze({
    /** Robinhood Chain, where the settlement contract lives. */
    chainId: 4663,
    /** Lighter's Robinhood instance — the L2 chain id its transactions are signed for. */
    l2ChainId: 466324,
    proxy: "0x94bab9693ba2f6358507effcbd372b0660afff9d",
    usdg: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
    assetIndex: 3,
    routeType: 0,
    usdgTickSize: 1,
    /** keccak256("Deposit(uint48,address,uint16,uint8,uint128)") — nothing indexed. */
    depositTopic: "0x493c3b8240368e8343bcd42cac5f4b8b161c06d061710e542a72f06a40ddd9d1",
    /** keccak256("WithdrawPending(address,uint16,uint128)") — owner indexed. */
    withdrawPendingTopic: "0xef80235b5f4cf1822ad6a8621af41ac64372ff672c402874f507fc63dbe5e06f",
  }),
});
export type VerifierVenueName = keyof typeof VERIFIER_VENUES;
export type PinnedVenue = (typeof VERIFIER_VENUES)[VerifierVenueName];

/** What a v2 header says about the venue — every field but the account checked against the pin. */
export interface ExportVenue {
  venue: VerifierVenueName;
  l2ChainId: number;
  proxy: string;
  /** Lighter's account index for this agent; null before the first deposit landed (or on paper). */
  accountIndex: number | null;
}

/** The venue as the verifier uses it: the pinned constants, plus the one fact only the export can give. */
export type VerifiedVenue = PinnedVenue & { name: VerifierVenueName; accountIndex: number | null };

export type ExportHeaderVerdict =
  | { ok: true; version: 1 | 2; venue: VerifiedVenue | null }
  | { ok: false; why: string };

/**
 * READ THE HEADER, OR REFUSE IT. Pure. A refusal is INDETERMINATE (exit 2):
 * this verifier did not judge the record, which is a different fact from the
 * record being wrong.
 */
export function readExportHeader(header: Record<string, unknown>): ExportHeaderVerdict {
  if (header.format === JOURNAL_FORMAT_V1) {
    // Every v1 export ever written says version 1; an absent one predates
    // nothing and is read the same. Any OTHER number under the v1 name is a
    // writer this verifier has never met.
    if (header.version !== 1 && header.version !== undefined) {
      return { ok: false, why: `a '${JOURNAL_FORMAT_V1}' export of version ${JSON.stringify(header.version)} — this verifier reads version 1` };
    }
    return { ok: true, version: 1, venue: null };
  }
  if (header.format === JOURNAL_FORMAT_V2) {
    if (header.version !== 2) {
      return { ok: false, why: `a '${JOURNAL_FORMAT_V2}' export of version ${JSON.stringify(header.version)} — this verifier reads version 2` };
    }
    const v = header.venue as Record<string, unknown> | null | undefined;
    if (!v || typeof v !== "object") return { ok: false, why: "a v2 export must name its venue, and this one does not" };
    const name = v.venue;
    if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(VERIFIER_VENUES, name)) {
      return { ok: false, why: `this export names a venue this verifier does not know (${JSON.stringify(name)})` };
    }
    const pin = VERIFIER_VENUES[name as VerifierVenueName];
    if (v.l2ChainId !== pin.l2ChainId) {
      return { ok: false, why: `the export says ${name} signs for L2 chain ${JSON.stringify(v.l2ChainId)}; the pinned one is ${pin.l2ChainId}` };
    }
    if (typeof v.proxy !== "string" || v.proxy.toLowerCase() !== pin.proxy) {
      return {
        ok: false,
        why: `the export names ${JSON.stringify(v.proxy)} as ${name}'s settlement contract; the pinned one is ${pin.proxy} — ` +
          `a margin record checked against the export's own contract would prove nothing`,
      };
    }
    const idx = v.accountIndex;
    if (idx !== null && !(typeof idx === "number" && Number.isSafeInteger(idx) && idx >= 0)) {
      return { ok: false, why: `the export's venue account index ${JSON.stringify(idx)} is not an account index` };
    }
    return { ok: true, version: 2, venue: { ...pin, name: name as VerifierVenueName, accountIndex: idx as number | null } };
  }
  return {
    ok: false,
    why: `not a merrymen journal export this verifier knows (format ${JSON.stringify(header.format)}; it reads ` +
      `'${JOURNAL_FORMAT_V1}' and '${JOURNAL_FORMAT_V2}')`,
  };
}

/** Does this journal carry anything a v1 verifier would misread? A perp kind, or a mark with a perp term. */
export function journalHasPerps(entries: readonly Pick<ExportedEntry, "kind" | "payload_json">[]): boolean {
  return entries.some((e) => {
    if (PERP_JOURNAL_KINDS.includes(e.kind)) return true;
    if (e.kind !== "mark") return false;
    try {
      const p = JSON.parse(e.payload_json) as Record<string, unknown>;
      return Object.keys(p).some((k) => k.startsWith("perp"));
    } catch {
      return false;
    }
  });
}

/**
 * THE EXPORT HEADER, v1 or v2 by the rule above. Pure, so the choice is
 * testable without a ledger. `perpAccount` is the ledger's venue account row
 * (undefined: the agent has none) — collateral carried into an epoch whose
 * journal has no perp record yet still makes this a perp book.
 *
 * v1's keys, and their order, are exactly what they always were: an agent
 * without perps exports the same bytes it did before perps existed.
 */
export function exportHeader(a: {
  agentId: string;
  epoch: number;
  chainId: number | null;
  usdgToken: string;
  entries: readonly Pick<ExportedEntry, "kind" | "payload_json">[];
  perpAccount?: { accountIndex: number | null };
}): Record<string, unknown> {
  const base = {
    agentId: a.agentId,
    epoch: a.epoch,
    chainId: a.chainId,
    usdgToken: a.usdgToken,
    records: a.entries.length,
  };
  if (a.perpAccount === undefined && !journalHasPerps(a.entries)) {
    return { format: JOURNAL_FORMAT_V1, version: 1, ...base };
  }
  const pin = VERIFIER_VENUES["lighter-rh"];
  return {
    format: JOURNAL_FORMAT_V2,
    version: 2,
    ...base,
    venue: {
      venue: "lighter-rh",
      l2ChainId: pin.l2ChainId,
      proxy: pin.proxy,
      accountIndex: a.perpAccount?.accountIndex ?? null,
    },
  };
}

export interface ExportedEntry {
  seq: number;
  agent_id: string;
  epoch: number;
  kind: string;
  payload_json: string;
  prev_hash: string;
  hash: string;
  at: number;
}

export interface AuditFinding {
  /** 'chain' | 'gap' | 'arithmetic' — which of the three checks failed. */
  check: string;
  seq: number | null;
  detail: string;
}

/** Recompute a link. Deliberately re-implemented here rather than imported. */
export function linkHash(prevHash: string, payloadJson: string): string {
  return createHash("sha256").update(prevHash).update(payloadJson).digest("hex");
}

/**
 * Walk the chain. Returns every break, not just the first — an operator who
 * edited one row wants to know that; one who rewrote a range needs to see it.
 */
export function verifyChain(entries: readonly ExportedEntry[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  let expectedPrev = GENESIS;
  let lastSeq: number | null = null;

  for (const e of entries) {
    if (lastSeq !== null && e.seq !== lastSeq + 1) {
      // AUTOINCREMENT never reuses a value, so a jump means rows were removed
      // between these two. The chain itself would still verify if the deleter
      // was careful, which is exactly why the sequence is checked separately.
      findings.push({
        check: "gap",
        seq: e.seq,
        detail: `sequence jumps ${lastSeq} → ${e.seq}: ${e.seq - lastSeq - 1} record(s) removed`,
      });
      // Re-anchor so one gap doesn't cascade into a break at every later row.
      expectedPrev = e.prev_hash;
    }
    if (e.prev_hash !== expectedPrev) {
      findings.push({
        check: "chain",
        seq: e.seq,
        detail: `prev_hash ${e.prev_hash.slice(0, 12)}… does not follow ${expectedPrev.slice(0, 12)}…`,
      });
    }
    const recomputed = linkHash(e.prev_hash, e.payload_json);
    if (recomputed !== e.hash) {
      findings.push({
        check: "chain",
        seq: e.seq,
        detail: `payload does not hash to its recorded hash — this record was edited`,
      });
    }
    expectedPrev = e.hash;
    lastSeq = e.seq;
  }
  return findings;
}

/**
 * How far two USDG figures may differ before the difference means something.
 *
 * One hundredth of a cent. The ledger stores USDG as SQLite REAL and prices are
 * floats, so exact equality between a total and the sum of its parts is not
 * available; anything below this is the storage format talking. It is small
 * enough that the failures this catches — a whole contribution booked twice —
 * clear it by four orders of magnitude.
 */
export const ARITHMETIC_TOLERANCE_USDG = 0.0001;

export interface ReconstructedBook {
  /** Σ flows in − Σ flows out, 6dp USDG as a float (the ledger is REAL). */
  netContributionsUsdg: number;
  /** Σ realized P&L booked on closing fills. */
  realizedPnlUsdg: number;
  /** Σ gas paid, wei. Not in equity — gas leaves the account in ETH. */
  gasWei: bigint;
  /** Σ gas in USDG, priced from the WETH pool TWAP when each trade landed. */
  gasUsdg: number;
  /** Landed fills whose gas could not be priced — the figure is gross of these. */
  gasUnpricedFills: number;
  /** The last published equity figure, for comparison. */
  publishedEquityUsdg: number | null;
  /**
   * The components published in the SAME breath as that equity figure.
   *
   * Kept because a scalar equity is an assertion and these are what it is
   * asserted to be the sum of. Checking one against the others is the cheapest
   * real arithmetic check there is, and it needs no chain and no prices.
   */
  publishedCashUsdg: number | null;
  publishedPositionsUsdg: number | null;
  publishedVaultUsdg: number | null;
  /**
   * The FOURTH term of the composition — quarantined holdings at cost.
   *
   * `composeEquityUsdg` is cash + vault + positions + quarantinedCost, and the
   * journal used to carry only the first three beside the total. Null here means
   * the mark did not say, which is NOT the same as zero: assuming zero would
   * make every book holding a quarantined asset look like it does not add up,
   * and this codebase has already been bitten once by a re-derivation that
   * dropped this exact term.
   */
  publishedQuarantinedCostUsdg: number | null;
  /** How many flow records were seen. Zero means no capital movement is on record. */
  flowCount: number;
  /** How many marks were seen. Zero means there is nothing to reconcile against. */
  markCount: number;
  /**
   * Every USDG ever spent ACQUIRING something, this epoch, gross of later sales.
   *
   * This is the bound on how much unrealized LOSS the open positions can carry:
   * you cannot be down more on a position than you paid for it. Gross rather
   * than net of disposals on purpose — the looser bound is the conservative one
   * here, because it can only reduce the number of findings, never invent one.
   */
  grossBuyNotionalUsdg: number;
  /** Fills and flows that name a transaction — what an RPC check would refetch. */
  chainRefs: { kind: string; txHash: string; seq: number }[];
  /** Records that move money but name NO transaction. */
  unanchored: { kind: string; seq: number; why: string }[];

  // ── perps (v2 exports; every figure is 0 and every list empty in v1) ─────
  //
  // OPTIONAL, and absent means exactly what a v1 book means: no venue, a known
  // zero, nothing refused. reconstruct always fills them; a caller building a
  // book by hand from before perps (a test, a report) need not.

  /** Which export this was read as — it decides what an absent perp term means. */
  formatVersion?: 1 | 2;
  /** Σ realized P&L on perp fills, USDG. Money the venue says was made or lost. */
  perpRealizedUsdg?: number;
  /** Σ perp trading fees, USDG (signed: a maker rebate is negative). */
  perpFeesUsdg?: number;
  /** Σ funding, USDG, from the holder's side: + received, − paid. */
  perpFundingUsdg?: number;
  /**
   * Perp money terms this verifier could not read — a fill whose realized P&L
   * the writer had not derived (null is unknown, never zero), or an amount that
   * is not a canonical integer. Any at all and the identity is not closed.
   */
  perpUnreadTerms?: number;
  /** Open positions carried into this epoch at mark. Their P&L is measured from the carry, the venue's U from the entry. */
  perpCarries?: number;
  /**
   * The latest mark's venue terms, integer micro-USDG, taken from the SAME
   * entry as its equity. In v1 they are a KNOWN zero (a v1 book has no venue);
   * in v2 a mark that does not state them all is null — unknown, never zero.
   */
  publishedPerp?: {
    collateralMicro: bigint;
    isolatedMarginMicro: bigint;
    unrealizedMicro: bigint;
    unrealizedGainMicro: bigint;
    inTransitMicro: bigint;
  } | null;
  /**
   * VENUE-ATTESTED records: Lighter fills and funding, and the steps of a margin
   * transfer that happen on the venue's rollup. Counted into the arithmetic,
   * never chain-verified and never failed — and always a gap in what was checked.
   */
  venueAttested?: { kind: string; seq: number; why: string }[];
  /**
   * RECORDS THIS VERIFIER DOES NOT UNDERSTAND. Never skipped: a kind nobody
   * taught this file moves money nobody can see, so the arithmetic is not judged
   * at all (neither passed nor failed) and the verdict is INDETERMINATE.
   */
  unknownRecords?: { kind: string; seq: number; why: string }[];
}

/** How reconstruct reads an export: the version (from its header) decides what a perp record means. */
export interface ReconstructOptions {
  /** 1 (the default, and every caller before perps) or 2. */
  version?: 1 | 2;
}

/** A canonical integer string (optionally signed), as micro-USDG — or null. The writer never emits anything else. */
function microOf(v: unknown, signed: boolean): bigint | null {
  if (typeof v !== "string" || !(signed ? /^-?(0|[1-9]\d*)$/ : /^(0|[1-9]\d*)$/).test(v) || v === "-0") return null;
  return BigInt(v);
}

const microToUsdg = (m: bigint) => Number(m) / 1e6;

/** A 0x-prefixed 32-byte transaction hash — the only kind an eth RPC is ever asked about. Lighter's 80-hex L2 hashes never are. */
const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * THE ROBINHOOD CHAIN TRANSACTION A MARGIN RECORD STANDS ON, or null when this
 * step of the transfer happened on the venue alone.
 *
 *   deposit, the step money LEFT the account (from nothing or `submitted`) —
 *            its UserOp's transaction, which must carry the proxy's Deposit;
 *   withdrawal, the step money ARRIVED (`paid`) — the payout, which must carry
 *            the proxy's WithdrawPending naming the account.
 * Every other step (credited, executed, failed, refunded) is the venue's word.
 * Exported so reconstruct and compareRecord cannot pick different hashes.
 */
export function marginChainHash(p: Record<string, unknown>): string | null {
  if (p.direction === "deposit" && (p.from === null || p.from === undefined || p.from === "submitted")) {
    return typeof p.txHash === "string" && EVM_TX_HASH.test(p.txHash) ? p.txHash : null;
  }
  if (p.direction === "withdraw" && p.to === "paid") {
    return typeof p.paidTxHash === "string" && EVM_TX_HASH.test(p.paidTxHash) ? p.paidTxHash : null;
  }
  return null;
}

/** Is this margin step one the chain saw, rather than one the venue reports? */
function marginOnChainStep(p: Record<string, unknown>): boolean {
  return (p.direction === "deposit" && (p.from === null || p.from === undefined || p.from === "submitted")) ||
    (p.direction === "withdraw" && p.to === "paid");
}

/**
 * Rebuild the book from the journal alone.
 *
 * `unanchored` is the honest part: a paper fill and an inferred flow move the
 * numbers but cannot be checked against any chain, so they are counted AND
 * listed. An auditor who wants only chain-verifiable figures drops them and
 * recomputes; one who accepts them at least knows what they accepted.
 */
export function reconstruct(entries: readonly ExportedEntry[], opts: ReconstructOptions = {}): ReconstructedBook {
  const version = opts.version ?? 1;
  // Every optional perp field is filled here — Required, so none can be missed.
  const book: Required<ReconstructedBook> = {
    netContributionsUsdg: 0,
    realizedPnlUsdg: 0,
    gasWei: 0n,
    gasUsdg: 0,
    gasUnpricedFills: 0,
    publishedEquityUsdg: null,
    publishedCashUsdg: null,
    publishedPositionsUsdg: null,
    publishedVaultUsdg: null,
    publishedQuarantinedCostUsdg: null,
    flowCount: 0,
    markCount: 0,
    grossBuyNotionalUsdg: 0,
    chainRefs: [],
    unanchored: [],
    formatVersion: version,
    perpRealizedUsdg: 0,
    perpFeesUsdg: 0,
    perpFundingUsdg: 0,
    perpUnreadTerms: 0,
    perpCarries: 0,
    // A v1 book has no venue: its perp term is a KNOWN zero, so the identity is
    // exactly the one it always was. A v2 book's is read off its latest mark.
    publishedPerp:
      version === 1
        ? { collateralMicro: 0n, isolatedMarginMicro: 0n, unrealizedMicro: 0n, unrealizedGainMicro: 0n, inTransitMicro: 0n }
        : null,
    venueAttested: [],
    unknownRecords: [],
  };

  for (const e of entries) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(e.payload_json) as Record<string, unknown>;
    } catch {
      continue; // verifyChain already reports an unparseable payload as edited
    }

    // ── A KIND THIS VERIFIER WAS NEVER TAUGHT IS REFUSED, NOT SKIPPED ──────
    //
    // This loop used to fall through any kind it did not handle, so a newer
    // writer's records — money, all of it — vanished from the reconstruction
    // and the arithmetic then accused the ledger of not adding up. `fee` is an
    // accrual (the performance fee is not in the equity identity) and is the
    // one known kind with no arm below. The perp kinds are known only to a v2
    // export: a v1 file carrying one was written wrong, and is not guessed at.
    const known =
      e.kind === "flow" || e.kind === "fill" || e.kind === "mark" || e.kind === "fee" ||
      (version === 2 && PERP_JOURNAL_KINDS.includes(e.kind));
    if (!known) {
      book.unknownRecords.push({
        kind: e.kind,
        seq: e.seq,
        why: PERP_JOURNAL_KINDS.includes(e.kind)
          ? `a perp record in a '${JOURNAL_FORMAT_V1}' export — only '${JOURNAL_FORMAT_V2}' carries these; re-export it`
          : `kind '${e.kind}' is not one this verifier knows — a newer merrymen wrote it`,
      });
      continue;
    }

    if (e.kind === "flow") {
      book.flowCount += 1;
      const amount = Number(p.amountUsdg ?? 0);
      book.netContributionsUsdg += p.direction === "in" ? amount : -amount;
      if (typeof p.txHash === "string" && p.txHash) {
        book.chainRefs.push({ kind: "flow", txHash: p.txHash, seq: e.seq });
      } else {
        book.unanchored.push({
          kind: "flow",
          seq: e.seq,
          why: `source '${String(p.source)}' carries no transaction — inferred from a balance change`,
        });
      }
    }

    if (e.kind === "fill") {
      const realized = p.realizedPnlUsdg;
      if (typeof realized === "number") book.realizedPnlUsdg += realized;
      // What was actually paid, preferring the receipt-derived cash leg over
      // the intended notional — the two differ by slippage, and the bound this
      // feeds should be built from what left the account.
      if (p.fillSide === "buy" && p.status !== "rejected") {
        const cash = typeof p.fillCashUsdg === "number" ? p.fillCashUsdg : null;
        const notional = typeof p.amountUsdg === "number" ? p.amountUsdg : 0;
        book.grossBuyNotionalUsdg += cash ?? notional;
      }
      if (typeof p.gasWei === "string" && p.gasWei) {
        try {
          book.gasWei += BigInt(p.gasWei);
        } catch {
          /* a malformed figure is a chain finding, not an arithmetic one */
        }
        // Priced when it was burned. A null here is UNPRICED, not free — and it
        // is counted, so a "net of gas" claim can be checked rather than taken.
        if (typeof p.gasUsdg === "number") book.gasUsdg += p.gasUsdg;
        else if (p.status === "landed") book.gasUnpricedFills += 1;
      }
      if (typeof p.txHash === "string" && p.txHash) {
        book.chainRefs.push({ kind: "fill", txHash: p.txHash, seq: e.seq });
      } else {
        book.unanchored.push({
          kind: "fill",
          seq: e.seq,
          why:
            p.status === "paper"
              ? "simulated fill — nothing was signed, so there is nothing to check"
              : "landed fill with no transaction recorded",
        });
      }
    }

    if (e.kind === "mark") {
      const eq = p.equityUsdg;
      if (typeof eq === "number") {
        book.markCount += 1;
        book.publishedEquityUsdg = eq;
        // Taken from the SAME entry as the equity, never from a different mark:
        // components from one tick against a total from another would produce a
        // difference that is just time passing.
        book.publishedCashUsdg = typeof p.cashUsdg === "number" ? p.cashUsdg : null;
        book.publishedPositionsUsdg = typeof p.positionsUsdg === "number" ? p.positionsUsdg : null;
        book.publishedVaultUsdg = typeof p.vaultUsdg === "number" ? p.vaultUsdg : null;
        book.publishedQuarantinedCostUsdg =
          typeof p.quarantinedCostUsdg === "number" ? p.quarantinedCostUsdg : null;
        // THE VENUE'S TERMS, from the same entry. v2: all five, canonical, or
        // unknown. v1: a known zero — and a v1 mark that nonetheless carries a
        // perp term is not a v1 book, so it is refused rather than summed.
        const perpKeys = Object.keys(p).filter((k) => k.startsWith("perp"));
        if (version === 1) {
          if (perpKeys.length > 0) {
            book.unknownRecords.push({
              kind: "mark",
              seq: e.seq,
              why: `a mark with perp terms in a '${JOURNAL_FORMAT_V1}' export — only '${JOURNAL_FORMAT_V2}' carries these; re-export it`,
            });
          }
        } else {
          const c = microOf(p.perpCollateralMicro, true);
          const m = microOf(p.perpIsolatedMarginMicro, false);
          const u = microOf(p.perpUnrealizedMicro, true);
          const g = microOf(p.perpUnrealizedGainMicro, false);
          const t = microOf(p.perpInTransitMicro, false);
          book.publishedPerp =
            c !== null && m !== null && u !== null && g !== null && t !== null
              ? { collateralMicro: c, isolatedMarginMicro: m, unrealizedMicro: u, unrealizedGainMicro: g, inTransitMicro: t }
              : null;
        }
      }
    }

    // ── perps (v2 only; refused above in a v1 export) ────────────────────
    if (e.kind === "perp-fill") {
      const fee = microOf(p.feeMicro, true);
      const realized = p.realizedMicro === null ? null : microOf(p.realizedMicro, true);
      // Unknown realized is not zero realized: the writer books it null until
      // it is derived, and a sum that treated it as 0 would close an identity
      // it has no right to close.
      if (fee === null || realized === null) book.perpUnreadTerms += 1;
      if (fee !== null) book.perpFeesUsdg += microToUsdg(fee);
      if (realized !== null) book.perpRealizedUsdg += microToUsdg(realized);
      if (p.mode === "paper") {
        book.unanchored.push({ kind: "perp-fill", seq: e.seq, why: "simulated perp fill — nothing was signed, so there is nothing to check" });
      } else {
        book.venueAttested.push({
          kind: "perp-fill",
          seq: e.seq,
          why: `a Lighter trade (${String(p.market ?? p.marketId)}) — attested by the venue's API, not re-derivable from Robinhood Chain`,
        });
      }
    }

    if (e.kind === "funding") {
      const pay = microOf(p.paymentMicro, true);
      if (pay === null) book.perpUnreadTerms += 1;
      else book.perpFundingUsdg += microToUsdg(pay);
      if (p.mode === "paper") {
        book.unanchored.push({ kind: "funding", seq: e.seq, why: "simulated funding — nothing was paid, so there is nothing to check" });
      } else {
        book.venueAttested.push({
          kind: "funding",
          seq: e.seq,
          why: `a Lighter funding payment (${String(p.market ?? p.marketId)}) — attested by the venue's API, not re-derivable from Robinhood Chain`,
        });
      }
    }

    // Margin moves money between two places the book owns, so it is not in the
    // equity identity at all — equity carries both sides. What it IS, is
    // evidence: the chain steps are checked against their receipts.
    if (e.kind === "margin") {
      if (p.mode === "paper") {
        book.unanchored.push({ kind: "margin", seq: e.seq, why: "simulated margin transfer — instantaneous on paper, nothing on chain" });
      } else if (marginOnChainStep(p)) {
        const hash = marginChainHash(p);
        if (hash) book.chainRefs.push({ kind: "margin", txHash: hash, seq: e.seq });
        else book.unanchored.push({ kind: "margin", seq: e.seq, why: "a margin transfer's on-chain step with no Robinhood Chain transaction recorded" });
      } else {
        book.venueAttested.push({
          kind: "margin",
          seq: e.seq,
          why: `a ${String(p.direction)} reaching '${String(p.to)}' on the venue — the venue's word, not a chain receipt`,
        });
      }
    }

    // An epoch boundary's carry at mark moves no money; it resets where the
    // position's P&L is measured from (store.ts perp_carries).
    if (e.kind === "perp-carry") book.perpCarries += 1;
  }
  return book;
}

// ── 2. the chain of custody ───────────────────────────────────────────────

/** A receipt as `eth_getTransactionReceipt` returns it, reduced to what we check. */
export interface FetchedReceipt {
  /** '0x1' success, '0x0' reverted. */
  status: string;
  /** `logIndex` as the RPC returns it (hex); read only by the margin check, which pairs by position when it can. */
  logs: readonly { address: string; topics: readonly string[]; data: string; logIndex?: string | number }[];
}

/** ERC-20 Transfer. Re-declared here so the verifier depends on nothing. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Net movement of each token in or out of `account`, from a receipt's logs.
 *
 * Intentionally a second implementation of the same idea as fills.ts. The
 * verifier must not share code with the thing it verifies any more than it has
 * to — if the writer's log-parsing is wrong, a verifier importing that same
 * parser would agree with it and call the record confirmed.
 */
export function receiptDeltas(
  receipt: FetchedReceipt,
  account: string,
): Map<string, bigint> {
  const me = account.toLowerCase();
  const out = new Map<string, bigint>();
  for (const log of receipt.logs) {
    if (log.topics.length < 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const from = `0x${log.topics[1]!.slice(-40)}`.toLowerCase();
    const to = `0x${log.topics[2]!.slice(-40)}`.toLowerCase();
    if (from !== me && to !== me) continue;
    let v: bigint;
    try {
      v = BigInt(log.data);
    } catch {
      continue;
    }
    const token = log.address.toLowerCase();
    let d = out.get(token) ?? 0n;
    if (to === me) d += v;
    if (from === me) d -= v;
    out.set(token, d);
  }
  return out;
}

/** 6dp USDG float → integer units, for comparing against an on-chain amount. */
function toUsdgUnits(v: number): bigint {
  return BigInt(Math.round(v * 1e6));
}

/**
 * Check ONE record against the transaction it names.
 *
 * A tolerance of one unit is allowed on the cash leg because the ledger stores
 * USDG as a float (REAL columns) while the chain is exact — a difference in the
 * last 6dp digit is a rounding artifact of our own storage, not a discrepancy.
 * Anything larger is reported.
 */
export function compareRecord(args: {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  receipt: FetchedReceipt | null;
  account: string;
  usdgToken: string;
  /** The venue a v2 export names, already checked against the pin (readExportHeader). Needed for `margin`. */
  venue?: VerifiedVenue | null;
}): AuditFinding[] {
  const { seq, kind, payload, receipt, account, usdgToken } = args;
  const findings: AuditFinding[] = [];
  // A margin record's chain transaction is not always `txHash` (a payout is
  // `paidTxHash`); marginChainHash is the one answer reconstruct also used.
  const txHash = kind === "margin" ? String(marginChainHash(payload) ?? "") : String(payload.txHash ?? "");

  if (!receipt) {
    findings.push({ check: "onchain", seq, detail: `${txHash}: no such transaction on this chain` });
    return findings;
  }
  if (receipt.status !== "0x1") {
    findings.push({
      check: "onchain",
      seq,
      detail: `${txHash}: the chain says this transaction FAILED, but the ledger records it as settled`,
    });
    return findings;
  }

  if (kind === "margin") return compareMargin({ seq, txHash, payload, receipt, account, venue: args.venue ?? null });

  const deltas = receiptDeltas(receipt, account);
  const usdgDelta = deltas.get(usdgToken.toLowerCase()) ?? 0n;

  if (kind === "flow") {
    const claimed = toUsdgUnits(Number(payload.amountUsdg ?? 0));
    const expected = payload.direction === "in" ? claimed : -claimed;
    if (absDiff(usdgDelta, expected) > 1n) {
      findings.push({
        check: "onchain",
        seq,
        detail:
          `${txHash}: ledger claims a ${String(payload.direction)}flow of ${fmtUsdg(claimed)} USDG, ` +
          `chain shows ${fmtUsdg(usdgDelta)}`,
      });
    }
    return findings;
  }

  if (kind === "fill") {
    // Cash leg.
    const cash = payload.fillCashUsdg;
    if (typeof cash === "number") {
      const claimed = toUsdgUnits(cash);
      const expected = payload.fillSide === "buy" ? -claimed : claimed;
      if (absDiff(usdgDelta, expected) > 1n) {
        findings.push({
          check: "onchain",
          seq,
          detail:
            `${txHash}: ledger claims ${String(payload.fillSide)} for ${fmtUsdg(claimed)} USDG, ` +
            `chain shows a USDG movement of ${fmtUsdg(usdgDelta)}`,
        });
      }
    }
    // Stock leg — the token is whichever side of the swap is not USDG.
    const stockToken = String(
      (payload.fillSide === "buy" ? payload.buyToken : payload.sellToken) ?? "",
    ).toLowerCase();
    const qty = payload.fillQtyRaw;
    if (stockToken && typeof qty === "string") {
      let claimedQty: bigint;
      try {
        claimedQty = BigInt(qty);
      } catch {
        return findings;
      }
      const stockDelta = deltas.get(stockToken) ?? 0n;
      const expected = payload.fillSide === "buy" ? claimedQty : -claimedQty;
      // Exact: token quantities are integers on both sides, so any difference
      // is real. This is the check that would have caught a fill booked from
      // the quote instead of the receipt.
      if (stockDelta !== expected) {
        findings.push({
          check: "onchain",
          seq,
          detail:
            `${txHash}: ledger claims ${expected} raw units of ${stockToken.slice(0, 10)}…, ` +
            `chain shows ${stockDelta}`,
        });
      }
    }
  }
  return findings;
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

// ── margin against its receipt ──────────────────────────────────────────────
//
// A SECOND DECODER, ON PURPOSE. core's capital-classify.ts decodes the same two
// proxy events for the scanner that WROTE these records; importing it here
// would let one decoding mistake confirm itself. So this is the tiny decode
// again, by hand, strictly: exact topic count, exact data length, every word
// inside its declared type.

const WORD = /^[0-9a-fA-F]{64}$/;

/** The 32-byte words of `data`, or null unless there are exactly `n`. */
function dataWords(data: string, n: number): bigint[] | null {
  if (typeof data !== "string" || !data.startsWith("0x") || data.length !== 2 + 64 * n) return null;
  const out: bigint[] = [];
  for (let i = 0; i < n; i++) {
    const w = data.slice(2 + 64 * i, 2 + 64 * (i + 1));
    if (!WORD.test(w)) return null;
    out.push(BigInt(`0x${w}`));
  }
  return out;
}

/** A word holding an address and nothing else, lowercased — or null. */
function wordAddress(w: bigint | undefined): string | null {
  if (w === undefined || w >> 160n !== 0n) return null;
  return `0x${w.toString(16).padStart(40, "0")}`;
}

function logPosition(v: string | number | undefined): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

type ReceiptLogOf = FetchedReceipt["logs"][number];

/** Deposit(uint48 toAccountIndex, address toAddress, uint16 assetIndex, uint8 routeType, uint128 baseAmount), nothing indexed. */
function readDeposit(l: ReceiptLogOf, venue: VerifiedVenue) {
  if (l.address.toLowerCase() !== venue.proxy || l.topics.length !== 1 || l.topics[0]?.toLowerCase() !== venue.depositTopic) return null;
  const w = dataWords(l.data, 5);
  if (!w) return null;
  const [acct, to, asset, route, amount] = w as [bigint, bigint, bigint, bigint, bigint];
  const toAddress = wordAddress(to);
  if (toAddress === null || acct >> 48n !== 0n || asset >> 16n !== 0n || route >> 8n !== 0n || amount >> 128n !== 0n) return null;
  return { toAccountIndex: acct, toAddress, assetIndex: Number(asset), routeType: Number(route), amount: amount * BigInt(venue.usdgTickSize), at: logPosition(l.logIndex) };
}

/** WithdrawPending(address indexed owner, uint16 assetIndex, uint128 baseAmount). */
function readWithdrawPending(l: ReceiptLogOf, venue: VerifiedVenue) {
  if (l.address.toLowerCase() !== venue.proxy || l.topics.length !== 2 || l.topics[0]?.toLowerCase() !== venue.withdrawPendingTopic) return null;
  const t1 = l.topics[1] ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(t1)) return null;
  const owner = wordAddress(BigInt(t1));
  const w = dataWords(l.data, 2);
  if (!owner || !w) return null;
  const [asset, amount] = w as [bigint, bigint];
  if (asset >> 16n !== 0n || amount >> 128n !== 0n) return null;
  return { owner, assetIndex: Number(asset), amount: amount * BigInt(venue.usdgTickSize) };
}

/** Σ of the venue's USDG moving `from` → `to` in this receipt — Transfer logs of the pinned token only. */
function usdgMoved(receipt: FetchedReceipt, venue: VerifiedVenue, from: string, to: string): bigint {
  let sum = 0n;
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== venue.usdg || l.topics.length !== 3 || l.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const f = `0x${(l.topics[1] ?? "").slice(-40)}`.toLowerCase();
    const t = `0x${(l.topics[2] ?? "").slice(-40)}`.toLowerCase();
    const w = dataWords(l.data, 1);
    if (f === from && t === to && w) sum += w[0]!;
  }
  return sum;
}

/**
 * CHECK ONE MARGIN STEP AGAINST THE RECEIPT IT NAMES (docs/perps.md, "Verify").
 *
 *   deposit — the account's USDG went to the PINNED proxy for the amount
 *             claimed, and the proxy's own Deposit in the same receipt credits
 *             THIS account (and, when the export names one, this venue account
 *             index) with exactly that, asset 3, route 0 — at the log the
 *             record names, when it names one. A Deposit crediting anybody else
 *             is a finding: that money left the book.
 *   payout  — the proxy paid this account in this receipt, and says so with a
 *             WithdrawPending naming it; the USDG it received from the proxy
 *             equals what those events say. The AMOUNT is not held to the one
 *             record: payouts carry no withdrawal id, the relayer batches them,
 *             and a row is marked paid when payouts in aggregate cover it — so
 *             one payout may complete a row it only part-paid. That limit is
 *             stated, not papered over.
 */
function compareMargin(a: {
  seq: number;
  txHash: string;
  payload: Record<string, unknown>;
  receipt: FetchedReceipt;
  account: string;
  venue: VerifiedVenue | null;
}): AuditFinding[] {
  const { seq, txHash, payload, receipt } = a;
  const me = a.account.toLowerCase();
  const finding = (detail: string): AuditFinding[] => [{ check: "onchain", seq, detail: `${txHash}: ${detail}` }];
  if (!a.venue) return finding("a margin record, but the export names no venue to check it against");
  const venue = a.venue;
  const amount = microOf(payload.amountMicro, false);
  if (amount === null || amount === 0n) return finding(`the record's amount ${JSON.stringify(payload.amountMicro)} is not a positive integer`);

  if (payload.direction === "deposit") {
    const sent = usdgMoved(receipt, venue, me, venue.proxy);
    if (sent < amount) {
      return finding(`ledger claims ${fmtUsdg(amount)} USDG posted to the venue, chain shows ${fmtUsdg(sent)} sent to ${venue.proxy}`);
    }
    const deposits = receipt.logs.map((l) => readDeposit(l, venue)).filter((d): d is NonNullable<typeof d> => d !== null);
    const wantAt = typeof payload.logIndex === "number" ? payload.logIndex : null;
    const candidates = wantAt === null ? deposits : deposits.filter((d) => d.at === wantAt);
    const ours = candidates.find(
      (d) =>
        d.toAddress === me &&
        d.assetIndex === venue.assetIndex &&
        d.routeType === venue.routeType &&
        d.amount === amount &&
        (venue.accountIndex === null || d.toAccountIndex === BigInt(venue.accountIndex)),
    );
    if (ours) return [];
    const elsewhere = candidates.find((d) => d.toAddress !== me && d.amount === amount);
    if (elsewhere) {
      return finding(
        `the venue's Deposit credits ${elsewhere.toAddress}, not this account — ${fmtUsdg(amount)} USDG left the book, it was not posted as margin`,
      );
    }
    return finding(
      `no Deposit from ${venue.proxy} ${wantAt === null ? "" : `at log ${wantAt} `}credits this account` +
        (venue.accountIndex === null ? "" : ` (venue account ${venue.accountIndex})`) +
        ` with ${fmtUsdg(amount)} USDG of asset ${venue.assetIndex} on route ${venue.routeType}`,
    );
  }

  if (payload.direction === "withdraw") {
    let named = 0n;
    for (const l of receipt.logs) {
      const w = readWithdrawPending(l, venue);
      if (w && w.owner === me && w.assetIndex === venue.assetIndex) named += w.amount;
    }
    if (named === 0n) return finding(`no WithdrawPending from ${venue.proxy} names this account — this is not a payout to it`);
    const received = usdgMoved(receipt, venue, venue.proxy, me);
    if (received !== named) {
      return finding(
        `the venue's WithdrawPending events name ${fmtUsdg(named)} USDG for this account, but it received ${fmtUsdg(received)} from ${venue.proxy}`,
      );
    }
    return [];
  }
  return finding(`a margin record with direction ${JSON.stringify(payload.direction)}`);
}

function fmtUsdg(units: bigint): string {
  return (Number(units) / 1e6).toFixed(6);
}

/**
 * Does the published equity agree with what the primitives imply?
 *
 * Only meaningful once a full epoch has been recorded from its opening balance:
 * equity should be contributions plus realized P&L plus whatever the open
 * positions are marked at. The marks are in the journal, so the residual is the
 * unrealized component — reported rather than asserted, because calling a
 * mark-to-market difference an ERROR would be wrong.
 */
export function reconcile(book: ReconstructedBook): {
  residualUsdg: number | null;
  note: string;
  /**
   * Whether the checks actually RAN.
   *
   * False when a term the equity identity needs was not published, so the
   * arithmetic was not established — a different state from established and
   * sound, and the caller must not render it as the latter. An empty `findings`
   * with `checked: false` means "nothing was wrong because nothing was asked",
   * the same shape of honesty the on-chain guarantee needs.
   */
  checked: boolean;
  /**
   * WHAT THE RESIDUAL ACTUALLY PROVES, as findings a gate can fail on.
   *
   * For a long time this function returned a number and a paragraph, and the
   * paragraph said — correctly — that a non-zero residual is expected while a
   * position is open. That was true and it was also a hole: `AuditFinding.check`
   * declared an `'arithmetic'` arm that NO SITE EMITTED, so the arithmetic could
   * not fail an audit no matter what it said. An audit that cannot fail on its
   * own headline number is a report, not a check.
   *
   * The two tests below are the ones that survive the "expected non-zero"
   * objection, because each is bounded by a figure the journal already carries:
   *
   *   COMPOSITION  the published equity must equal the components published
   *                beside it. No prices, no chain, no interpretation.
   *
   *   ENVELOPE     the residual is unrealized mark-to-market, so it cannot be
   *                more positive than the entire marked value of the open
   *                positions (that would be money from nowhere) and cannot be
   *                more negative than everything ever paid to acquire them
   *                (you cannot lose more on a position than it cost).
   *
   * The envelope is what catches an over-booked contribution: booking the same
   * opening balance on three deploys triples the denominator, and the residual
   * goes far below anything the purchases can account for.
   */
  findings: AuditFinding[];
} {
  // RECORDS NOBODY TAUGHT THIS FILE ARE NOT JUDGED AT ALL. Their money is in
  // equity and in no figure here, so any residual would be the verifier's
  // ignorance dressed as the ledger's fault. Not a pass (checked: false), not a
  // failure (no finding) — the caller's verdict is INDETERMINATE.
  const unknown = book.unknownRecords ?? [];
  if (unknown.length > 0) {
    return {
      residualUsdg: null,
      checked: false,
      note:
        `${unknown.length} record(s) of a kind this verifier does not understand ` +
        `(${[...new Set(unknown.map((u) => u.kind))].join(", ")}) — the arithmetic is not judged`,
      findings: [],
    };
  }
  if (book.publishedEquityUsdg === null) {
    return {
      residualUsdg: null,
      checked: false,
      note: "no mark recorded — nothing to reconcile against",
      // NOT a finding. Nothing was published, so nothing is being claimed, and
      // an empty book is not a wrong one. The CALLER decides whether "no marks"
      // is acceptable for its purposes; see PortfolioQuality.arithmetic, which is
      // "unknown" here because nothing was verified.
      findings: [],
    };
  }
  // Gas left the account in ETH, so it never touched published equity — it is
  // not part of what equity has to explain, and subtracting it here would
  // manufacture a residual that isn't there. It is charged against P&L
  // separately (see pnlUsdg), which is a different question from this one.
  //
  // PERPS (docs/perps.md, "Verify"): the venue's realized P&L and funding are
  // money made or lost, and its fees money spent, so each is part of what
  // equity must be explained by. Margin is not — it moved between two places
  // the book owns, and equity carries both. What remains after them is
  // unrealized: the spot positions' AND the venue's (U), which the envelope
  // below takes back out before bounding the spot half. With no perps every
  // one of these is 0 and the arithmetic is exactly what it always was.
  const perpRealized = book.perpRealizedUsdg ?? 0;
  const perpFees = book.perpFeesUsdg ?? 0;
  const perpFunding = book.perpFundingUsdg ?? 0;
  const hasPerpMoney = perpRealized !== 0 || perpFees !== 0 || perpFunding !== 0;
  const explained = hasPerpMoney
    ? book.netContributionsUsdg + book.realizedPnlUsdg + perpRealized - perpFees + perpFunding
    : book.netContributionsUsdg + book.realizedPnlUsdg;
  const residual = book.publishedEquityUsdg - explained;
  const findings: AuditFinding[] = [];
  // The latest mark's venue terms. Absent from a hand-built book is a v1 book:
  // a known zero. Null (a v2 mark that did not state them all) is UNKNOWN.
  const perpTerms =
    book.publishedPerp === undefined
      ? { collateralMicro: 0n, isolatedMarginMicro: 0n, unrealizedMicro: 0n, unrealizedGainMicro: 0n, inTransitMicro: 0n }
      : book.publishedPerp;
  const perpKnown = perpTerms !== null;
  const perpAccount =
    perpTerms === null
      ? 0
      : microToUsdg(perpTerms.collateralMicro + perpTerms.isolatedMarginMicro + perpTerms.unrealizedMicro + perpTerms.inTransitMicro);
  const perpUnrealized = perpTerms === null ? 0 : microToUsdg(perpTerms.unrealizedMicro);
  const hasPerpTerm = perpTerms !== null && perpAccount !== 0;

  // COMPOSITION. Only checked when EVERY term of the composition was published.
  //
  // `composeEquityUsdg` is cash + vault + positions + quarantinedCost. Marks
  // written before the fourth term was journalled carry only three, and summing
  // those three against the total finds a discrepancy exactly equal to the
  // quarantined cost — indistinguishable, from inside this function, from a book
  // that genuinely does not add up. So a missing term SKIPS the check rather
  // than failing it, and `quarantineKnown` is what the caller reads to see that
  // the arithmetic was not established rather than established and sound.
  //
  // Treating the absent term as zero is precisely the mistake that produced the
  // bug this file is auditing: index.ts once judged fees against a total
  // including quarantined cost while addEquity re-derived a lower one without it,
  // and the curve everybody read sat below the number the fee ratcheted on.
  const { publishedCashUsdg: cash, publishedPositionsUsdg: pos, publishedVaultUsdg: vault } = book;
  const quarantine = book.publishedQuarantinedCostUsdg;
  const quarantineKnown = quarantine !== null;

  // A JOURNAL THAT RECORDS NO CAPITAL ENTERING CANNOT BOUND WHAT IS IN THE BOOK.
  //
  // Three ordinary, correct books look like this, and the envelope check would
  // have called all three fraudulent:
  //
  //   A HOSTED CHILD THAT RESUMED. It books nothing on restart by design — that
  //   is the entire point of the accounting anchor — so its fresh journal has
  //   equity and zero flow records. The canary itself, after the fix.
  //   A PAPER AGENT. Its starting capital is granted, never booked as a flow.
  //   A NEW EPOCH before its opening balance is carried across.
  //
  // In each case `netContributionsUsdg` is 0 while equity is real, so the
  // residual is the whole book and trivially exceeds what the positions are
  // marked at — reported as "money is unaccounted for" when the truth is that
  // the contributions are recorded somewhere this file cannot see.
  //
  // The distinction is between a book that says something wrong and a book that
  // does not say. This is the second, so the checks do not run and the caller
  // gets `checked: false`.
  const contributionsRecorded = book.flowCount > 0;

  // AND THE LOSS BOUND NEEDS TO SEE WHAT WAS PAID.
  //
  // `grossBuyNotionalUsdg` is this epoch's purchases. A position carried across
  // an epoch boundary was bought in the PREVIOUS one, so its cost is not in this
  // journal: the floor would be −0 while the position legitimately sits below
  // what someone paid for it, and an ordinary drawdown would read as a
  // double-booked contribution.
  //
  // Requiring at least one purchase on record is the narrow, honest guard — it
  // covers the whole-book carry-over that actually happens at an epoch bump. A
  // book that mixes carried and freshly-bought positions still has a partially
  // understated floor; that limit is real and is not papered over here, it is
  // simply smaller than the bug it replaces.
  const basisVisible = book.grossBuyNotionalUsdg > 0 || (pos ?? 0) <= ARITHMETIC_TOLERANCE_USDG;
  if (cash !== null && pos !== null && vault !== null && quarantineKnown && perpKnown) {
    // + the venue's C + ΣM + ΣU + T (docs/perps.md rule 12) — 0 for a book
    // without perps, and then this is the four-term sum it always was.
    const parts = hasPerpTerm ? cash + pos + vault + quarantine + perpAccount : cash + pos + vault + quarantine;
    if (Math.abs(book.publishedEquityUsdg - parts) > ARITHMETIC_TOLERANCE_USDG) {
      findings.push({
        seq: 0,
        check: "arithmetic",
        detail: hasPerpTerm
          ? `published equity ${book.publishedEquityUsdg.toFixed(6)} does not equal the components published with it ` +
            `(cash ${cash.toFixed(6)} + positions ${pos.toFixed(6)} + vault ${vault.toFixed(6)} + quarantined ` +
            `${quarantine.toFixed(6)} + at Lighter ${perpAccount.toFixed(6)} = ${parts.toFixed(6)}, off by ` +
            `${(book.publishedEquityUsdg - parts).toFixed(6)}). One of the six figures is wrong.`
          : `published equity ${book.publishedEquityUsdg.toFixed(6)} does not equal the components published with it ` +
            `(cash ${cash.toFixed(6)} + positions ${pos.toFixed(6)} + vault ${vault.toFixed(6)} + quarantined ` +
            `${quarantine.toFixed(6)} = ${parts.toFixed(6)}, off by ${(book.publishedEquityUsdg - parts).toFixed(6)}). ` +
            `One of the five figures is wrong.`,
      });
    }
  }
  // THE PEAK TERM MUST BE WHAT IT CLAIMS. Σ max(0, Uᵢ) can never be below 0 nor
  // below max(0, ΣUᵢ) — per position it is at least the net. A figure under
  // that would have let the high-water mark and the fee ratchet on an open
  // gain the writer said it had left out. Our own arithmetic, so it may fail.
  if (perpTerms !== null) {
    const floor = perpTerms.unrealizedMicro > 0n ? perpTerms.unrealizedMicro : 0n;
    if (perpTerms.unrealizedGainMicro < floor) {
      findings.push({
        seq: 0,
        check: "arithmetic",
        detail:
          `the mark's open perp gain ${microToUsdg(perpTerms.unrealizedGainMicro).toFixed(6)} is less than its net ` +
          `unrealized P&L ${microToUsdg(perpTerms.unrealizedMicro).toFixed(6)} — a per-position sum of gains cannot be, ` +
          `so the figure every peak subtracts is wrong`,
      });
    }
  }

  // ENVELOPE. The marked value of what is HELD bounds the gain side; what was
  // paid for it bounds the loss side.
  //
  // Quarantined cost sits inside equity too, so it belongs in the ceiling — an
  // agent holding a scout position at cost has that much more equity to explain,
  // and leaving it out would report the quarantine itself as money from nowhere.
  // Absent means unknown, and an unknown term makes the bound unusable rather
  // than smaller, so the check is skipped exactly as the composition one is.
  //
  // PERPS NARROW WHEN IT CAN RUN, never widen it. The residual holds the
  // venue's unrealized U too, and U is the venue's word — so it comes out
  // before the spot half is bounded, and no perp-loss floor is added (an
  // account can be bankrupt at mark before it is liquidated). Skipped when the
  // venue terms are unknown, when a perp money term could not be read (a null
  // realized is unknown, not zero), or when a position was carried into this
  // epoch: its P&L here is measured from the carry's mark while the venue's U
  // is measured from the original entry, and nothing in this journal says
  // what that entry was.
  const perpClosable = perpKnown && (book.perpUnreadTerms ?? 0) === 0 && (book.perpCarries ?? 0) === 0;
  const spotResidual = hasPerpTerm ? residual - perpUnrealized : residual;
  if (pos !== null && quarantineKnown && contributionsRecorded && basisVisible && perpClosable) {
    const ceiling = pos + quarantine + ARITHMETIC_TOLERANCE_USDG;
    const floor = -book.grossBuyNotionalUsdg - ARITHMETIC_TOLERANCE_USDG;
    // The SPOT half, shadowing the whole residual on purpose: every message
    // below is about what the spot positions can explain.
    const residual = spotResidual;
    // Said only when there is perp money, so a spot book's findings read word
    // for word as they always have.
    const perpClause =
      hasPerpMoney || hasPerpTerm
        ? ` + perp (realized ${perpRealized.toFixed(6)} − fees ${perpFees.toFixed(6)} + funding ${perpFunding.toFixed(6)}, ` +
          `and the venue's unrealized ${perpUnrealized.toFixed(6)})`
        : "";
    if (residual > ceiling) {
      findings.push({
        seq: 0,
        check: "arithmetic",
        detail:
          `equity exceeds what the record can explain by ${(residual - pos - quarantine).toFixed(6)} USDG: ` +
          `contributions ${book.netContributionsUsdg.toFixed(6)} + realized ${book.realizedPnlUsdg.toFixed(6)}${perpClause} leaves ` +
          `a residual of ${residual.toFixed(6)}, but what is held is marked at only ${pos.toFixed(6)}` +
          (quarantine > 0 ? ` (+ ${quarantine.toFixed(6)} quarantined at cost)` : "") +
          `. Unrealized gain cannot exceed the whole value of what is held, so money is unaccounted for — most ` +
          `likely a contribution that was never booked, or a mark that is too high.`,
      });
    } else if (residual < floor) {
      findings.push({
        seq: 0,
        check: "arithmetic",
        detail:
          `contributions exceed what the record can support by ${Math.abs(residual - floor).toFixed(6)} USDG: ` +
          `contributions ${book.netContributionsUsdg.toFixed(6)} + realized ${book.realizedPnlUsdg.toFixed(6)}${perpClause} against ` +
          `equity ${book.publishedEquityUsdg.toFixed(6)} implies an unrealized LOSS of ${Math.abs(residual).toFixed(6)}, ` +
          `but only ${book.grossBuyNotionalUsdg.toFixed(6)} was ever spent acquiring positions — you cannot lose more ` +
          `on a position than it cost. The usual cause is the same capital being booked as a contribution more than ` +
          `once (see bootstrap-state.ts).`,
      });
    }
  }

  return {
    residualUsdg: residual,
    findings,
    // Both checks need every term of the composition; neither ran without them.
    checked:
      quarantineKnown && cash !== null && pos !== null && vault !== null && contributionsRecorded && basisVisible &&
      perpClosable,
    note:
      (hasPerpMoney || hasPerpTerm
        ? "residual = published equity − (contributions + realized + perp realized − perp fees + funding). It is the " +
          "unrealized mark-to-market on open positions, spot and perp (the venue's own U), and is expected to be " +
          "non-zero while any position is open. "
        : "residual = published equity − (contributions + realized). It is the unrealized " +
          "mark-to-market on open positions, and is expected to be non-zero while any position is open. ") +
      "Gas is excluded here because it never entered equity; it is charged against P&L instead.",
  };
}
