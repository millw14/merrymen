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
 */

import { createHash } from "node:crypto";

/** Must match store.JOURNAL_GENESIS — duplicated so a verifier needs no store. */
export const GENESIS = "0".repeat(64);

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
}

/**
 * Rebuild the book from the journal alone.
 *
 * `unanchored` is the honest part: a paper fill and an inferred flow move the
 * numbers but cannot be checked against any chain, so they are counted AND
 * listed. An auditor who wants only chain-verifiable figures drops them and
 * recomputes; one who accepts them at least knows what they accepted.
 */
export function reconstruct(entries: readonly ExportedEntry[]): ReconstructedBook {
  const book: ReconstructedBook = {
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
  };

  for (const e of entries) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(e.payload_json) as Record<string, unknown>;
    } catch {
      continue; // verifyChain already reports an unparseable payload as edited
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
      }
    }
  }
  return book;
}

// ── 2. the chain of custody ───────────────────────────────────────────────

/** A receipt as `eth_getTransactionReceipt` returns it, reduced to what we check. */
export interface FetchedReceipt {
  /** '0x1' success, '0x0' reverted. */
  status: string;
  logs: readonly { address: string; topics: readonly string[]; data: string }[];
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
}): AuditFinding[] {
  const { seq, kind, payload, receipt, account, usdgToken } = args;
  const findings: AuditFinding[] = [];
  const txHash = String(payload.txHash ?? "");

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
  const explained = book.netContributionsUsdg + book.realizedPnlUsdg;
  const residual = book.publishedEquityUsdg - explained;
  const findings: AuditFinding[] = [];

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
  if (cash !== null && pos !== null && vault !== null && quarantineKnown) {
    const parts = cash + pos + vault + quarantine;
    if (Math.abs(book.publishedEquityUsdg - parts) > ARITHMETIC_TOLERANCE_USDG) {
      findings.push({
        seq: 0,
        check: "arithmetic",
        detail:
          `published equity ${book.publishedEquityUsdg.toFixed(6)} does not equal the components published with it ` +
          `(cash ${cash.toFixed(6)} + positions ${pos.toFixed(6)} + vault ${vault.toFixed(6)} + quarantined ` +
          `${quarantine.toFixed(6)} = ${parts.toFixed(6)}, off by ${(book.publishedEquityUsdg - parts).toFixed(6)}). ` +
          `One of the five figures is wrong.`,
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
  if (pos !== null && quarantineKnown && contributionsRecorded && basisVisible) {
    const ceiling = pos + quarantine + ARITHMETIC_TOLERANCE_USDG;
    const floor = -book.grossBuyNotionalUsdg - ARITHMETIC_TOLERANCE_USDG;
    if (residual > ceiling) {
      findings.push({
        seq: 0,
        check: "arithmetic",
        detail:
          `equity exceeds what the record can explain by ${(residual - pos - quarantine).toFixed(6)} USDG: ` +
          `contributions ${book.netContributionsUsdg.toFixed(6)} + realized ${book.realizedPnlUsdg.toFixed(6)} leaves ` +
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
          `contributions ${book.netContributionsUsdg.toFixed(6)} + realized ${book.realizedPnlUsdg.toFixed(6)} against ` +
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
      quarantineKnown && cash !== null && pos !== null && vault !== null && contributionsRecorded && basisVisible,
    note:
      "residual = published equity − (contributions + realized). It is the unrealized " +
      "mark-to-market on open positions, and is expected to be non-zero while any position is open. " +
      "Gas is excluded here because it never entered equity; it is charged against P&L instead.",
  };
}
