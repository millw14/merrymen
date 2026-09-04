/**
 * WHICH TOKEN MOVEMENTS ARE THE OWNER'S CAPITAL, AND WHICH ARE THE AGENT TRADING.
 *
 * A contribution total is a claim about money the OWNER put in. Every USDG
 * transfer touching the account looks the same at the ERC-20 level, so treating
 * inbound as a deposit and outbound as a withdrawal produces a number that is
 * mostly trading volume. On the canary that rule would report 10 in and 6.666
 * out — a 6.666 USDG "withdrawal" that is actually four TSLA purchases.
 *
 * WHY NOT AN ADDRESS ALLOWLIST. It was the obvious first answer and it is wrong
 * in the direction that matters: the canary's four outflows go to
 * 0xf4acdaee…, which appears in NO protocol table in this repo. Venues are
 * added, pools are created per pair, and a list that is merely stale silently
 * reclassifies trading as withdrawals — which is the same class of confident
 * wrong number this whole effort is about. An allowlist can only ever add
 * certainty on the addresses it already knows.
 *
 * SO THE PRIMARY TEST IS TRANSACTION CONTEXT. A swap moves two tokens in
 * opposite directions within ONE transaction. If the same transaction that took
 * USDG out of the account also put a different token IN to it, that is a
 * purchase, whoever the counterparty was. Nothing about a deposit looks like
 * that: an owner funding an account sends one token and receives none.
 *
 * The address list is kept as a secondary signal for the case the primary test
 * cannot see — an approval-style leg with no paired movement — and never as the
 * thing that makes a movement capital.
 */

/** What a single USDG movement turned out to be. */
export type CapitalKind =
  /** External capital arriving. Counts toward gross contributions. */
  | "capital-in"
  /** Capital leaving to an outside address. Counts toward gross withdrawals. */
  | "capital-out"
  /** USDG spent buying something — the sell leg of a swap. Not capital. */
  | "trade-out"
  /** USDG received selling something — the buy leg of a swap. Not capital. */
  | "trade-in"
  /** A movement between accounts this system controls. Not external capital. */
  | "internal"
  /**
   * The classifier could not decide.
   *
   * A distinct arm rather than a default, because the whole point is that an
   * unclassifiable movement must not be quietly counted as a contribution. A
   * repair tool is expected to refuse these rather than guess.
   */
  | "ambiguous";

/** One ERC-20 Transfer, reduced to what classification needs. */
export interface TransferLeg {
  token: string;
  from: string;
  to: string;
  /** Base units as a decimal string — never a float across this boundary. */
  amountRaw: string;
}

export interface ClassifyInput {
  /** The account whose book this is. */
  account: string;
  /** The USDG movement being classified. */
  usdg: TransferLeg;
  /** EVERY ERC-20 Transfer in the same transaction, including the one above. */
  txLegs: readonly TransferLeg[];
  /** The cash token's address, so a paired leg can be told from another USDG leg. */
  usdgToken: string;
  /** Addresses this system controls — other hosted smart accounts. */
  knownAccounts?: readonly string[];
  /** Protocol addresses, used only as a fallback signal. */
  protocolAddresses?: readonly string[];
}

export interface Classification {
  kind: CapitalKind;
  /** The sentence an auditor reads. Always populated, including on the happy path. */
  why: string;
  /** The token that moved the other way, when this was a swap. */
  pairedToken?: string;
}

const eq = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

const has = (list: readonly string[] | undefined, a: string) =>
  (list ?? []).some((x) => eq(x, a));

/**
 * Classify one USDG movement. PURE.
 *
 * Takes the whole transaction's legs rather than fetching them, so the rule can
 * be tested against hand-built transactions and an auditor can re-run it against
 * a receipt they fetched themselves.
 */
export function classifyUsdgMovement(input: ClassifyInput): Classification {
  const { account, usdg, txLegs, usdgToken } = input;
  const outbound = eq(usdg.from, account);
  const inbound = eq(usdg.to, account);

  if (outbound === inbound) {
    return {
      kind: "ambiguous",
      why: outbound
        ? "the account is both sender and recipient — a self-transfer says nothing about capital"
        : "the movement does not touch this account at all",
    };
  }

  const counterparty = outbound ? usdg.to : usdg.from;

  // ── PRIMARY: did a DIFFERENT token move the other way in the same tx? ──────
  //
  // That is a swap, and it is the only signal here that does not depend on
  // knowing the venue. Checked before everything else for exactly that reason.
  const paired = txLegs.find(
    (l) =>
      !eq(l.token, usdgToken) &&
      (outbound ? eq(l.to, account) : eq(l.from, account)) &&
      BigInt(l.amountRaw || "0") > 0n,
  );
  if (paired) {
    return {
      kind: outbound ? "trade-out" : "trade-in",
      pairedToken: paired.token,
      why: outbound
        ? `the same transaction moved ${paired.token} INTO the account — this USDG bought something, it did not leave`
        : `the same transaction moved ${paired.token} OUT of the account — this USDG is sale proceeds, not a deposit`,
    };
  }

  // ── Movements between accounts this system controls are not external. ─────
  if (has(input.knownAccounts, counterparty)) {
    return {
      kind: "internal",
      why: `the counterparty ${counterparty} is another account this system controls`,
    };
  }

  // ── FALLBACK: a known protocol address with no paired leg. ────────────────
  //
  // Deliberately AMBIGUOUS rather than "trade". A USDG movement to a venue with
  // nothing coming back is not a purchase that this function can see — it may be
  // a failed route, a multi-transaction fill, or a venue this list has wrong.
  // Calling it a trade would remove it from capital on the strength of a list;
  // calling it capital would book a deposit that never happened.
  if (has(input.protocolAddresses, counterparty)) {
    return {
      kind: "ambiguous",
      why:
        `the counterparty ${counterparty} is a known protocol address, but nothing moved the other way in ` +
        `this transaction — it cannot be read as either capital or a completed trade`,
    };
  }

  return {
    kind: outbound ? "capital-out" : "capital-in",
    why:
      `${outbound ? "sent to" : "received from"} ${counterparty}, an address outside this system, with no ` +
      `paired token movement — external capital`,
  };
}

/** The three figures a contribution claim is made of, kept separately. */
export interface CapitalTotals {
  /** Σ external capital in. Non-zero even for an account that later withdrew it all. */
  grossContributionsRaw: string;
  /** Σ external capital out. */
  grossWithdrawalsRaw: string;
  /** in − out. May be zero while both figures above are large. */
  netContributionsRaw: string;
  /** Movements the classifier refused to decide. A repair must not touch these. */
  ambiguous: number;
  tradeLegs: number;
  internal: number;
}

/**
 * Total a classified set. PURE, and in BASE UNITS as decimal strings.
 *
 * Gross and net are kept apart because they answer different questions and
 * collapsing them loses history: an account funded 1010 and withdrawn 1010 nets
 * to zero, and "no contribution ever happened" is a different and false claim.
 */
export function totalCapital(
  legs: readonly { amountRaw: string; classification: Classification }[],
): CapitalTotals {
  let inRaw = 0n;
  let outRaw = 0n;
  let ambiguous = 0;
  let tradeLegs = 0;
  let internal = 0;
  for (const l of legs) {
    const amt = BigInt(l.amountRaw || "0");
    switch (l.classification.kind) {
      case "capital-in":
        inRaw += amt;
        break;
      case "capital-out":
        outRaw += amt;
        break;
      case "trade-in":
      case "trade-out":
        tradeLegs += 1;
        break;
      case "internal":
        internal += 1;
        break;
      case "ambiguous":
        ambiguous += 1;
        break;
    }
  }
  return {
    grossContributionsRaw: inRaw.toString(),
    grossWithdrawalsRaw: outRaw.toString(),
    netContributionsRaw: (inRaw - outRaw).toString(),
    ambiguous,
    tradeLegs,
    internal,
  };
}
