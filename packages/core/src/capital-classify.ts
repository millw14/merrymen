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
   * A movement to or from chain infrastructure — an EntryPoint, Permit2, a
   * deployer. Definitionally not capital and not a trade, and separated from
   * `internal` because "another of our accounts" and "the 4337 EntryPoint" are
   * different facts that a reader of an audit trail should not have to guess
   * between.
   */
  | "protocol"
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
  /**
   * Trading venues: routers, pools, launchpads.
   *
   * A weak signal on purpose. A venue here with NOTHING paired is `ambiguous`,
   * never "trade" — see the fallback below.
   */
  protocolAddresses?: readonly string[];
  /**
   * Chain INFRASTRUCTURE — EntryPoints, Permit2, deployers, multicall.
   *
   * Unlike a venue, these are definitionally not the owner's capital whatever
   * else the transaction did, so a movement to one is `protocol` rather than
   * ambiguous. Kept as a separate list because the two lists carry different
   * amounts of authority and merging them would silently promote a router.
   */
  systemAddresses?: readonly string[];
}

/**
 * Everything needed to explain the verdict without re-fetching the transaction.
 *
 * A classification an auditor cannot re-derive is an assertion, and this whole
 * exercise exists because assertions got believed. Carried on every arm,
 * including the ones that decided nothing.
 */
export interface ClassificationEvidence {
  counterparty: string;
  direction: "in" | "out" | "self" | "none";
  /** How many ERC-20 Transfers the deciding transaction contained. */
  txLegCount: number;
  /** The rule that fired, so two verdicts can be compared without reading prose. */
  rule:
    | "paired-token-movement"
    | "known-account"
    | "system-address"
    | "venue-without-pair"
    | "no-pair-external"
    | "not-this-account";
}

export interface Classification {
  kind: CapitalKind;
  /** The sentence an auditor reads. Always populated, including on the happy path. */
  why: string;
  /** The token that moved the other way, when this was a swap. */
  pairedToken?: string;
  evidence: ClassificationEvidence;
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
      evidence: {
        counterparty: outbound ? usdg.to : "none",
        direction: outbound ? "self" : "none",
        txLegCount: txLegs.length,
        rule: "not-this-account",
      },
    };
  }

  const counterparty = outbound ? usdg.to : usdg.from;
  const base = { counterparty, direction: outbound ? ("out" as const) : ("in" as const), txLegCount: txLegs.length };

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
      evidence: { ...base, rule: "paired-token-movement" },
    };
  }

  // ── Movements between accounts this system controls are not external. ─────
  if (has(input.knownAccounts, counterparty)) {
    return {
      kind: "internal",
      why: `the counterparty ${counterparty} is another account this system controls`,
      evidence: { ...base, rule: "known-account" },
    };
  }

  // ── Chain infrastructure is never the owner's capital. ───────────────────
  //
  // An EntryPoint or a Permit2 is not a person who could have deposited, so this
  // is safe to decide on the address alone — unlike a VENUE, where the same
  // reasoning would silently reclassify a trade the primary test could not see.
  // The two lists are separate so that promoting a router into this one has to
  // be a deliberate act rather than an append.
  if (has(input.systemAddresses, counterparty)) {
    return {
      kind: "protocol",
      why: `the counterparty ${counterparty} is chain infrastructure, which cannot be a source of capital`,
      evidence: { ...base, rule: "system-address" },
    };
  }

  // ── FALLBACK: a known trading venue with no paired leg. ───────────────────
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
      evidence: { ...base, rule: "venue-without-pair" },
    };
  }

  return {
    kind: outbound ? "capital-out" : "capital-in",
    why:
      `${outbound ? "sent to" : "received from"} ${counterparty}, an address outside this system, with no ` +
      `paired token movement — external capital`,
    evidence: { ...base, rule: "no-pair-external" },
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
  /** Movements to chain infrastructure. Never capital, never a trade. */
  protocol: number;
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
  let protocol = 0;
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
      case "protocol":
        protocol += 1;
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
    protocol,
  };
}
