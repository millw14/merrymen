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
  /**
   * USDG spent buying the ENERGY RESERVE into the account itself.
   *
   * Capital leaving the trading BOOK while staying in the account: not a trade,
   * because what it bought is never a position (never watched, never valued,
   * never sold by a strategy), and not a withdrawal to an outside address,
   * because nothing left the account. It sits beside `capital-out` rather than
   * inside it for one reason that matters: the live deposit scanner books every
   * `capital-in`/`capital-out` it sees, and the worker already books this one
   * itself at landing — a second booker that dedupes the row but moves the
   * high-water mark again is the Shogun double-lowering. So the live scanner
   * logs this kind as "not capital", and only the fleet tools (chain-capital,
   * hwm-repair, reconstruction) count it as capital leaving the book.
   *
   * Only produced when the caller passes `reserveTokens`; see ClassifyInput.
   */
  | "reserve-out"
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
  /**
   * Contracts that hold THIS account's own assets — its class vault.
   *
   * A PER-CALL PARAMETER, never a module constant, and that is the whole design.
   * `protocolAddresses` and `systemAddresses` are lists of addresses that are the
   * same for everyone; a class vault is CREATE2-salted with one smart account, so
   * a global list could never contain it and `protocols.ts`'s single-constant
   * shape does not carry over.
   *
   * It extends the PRIMARY rule, which is checked before custody transfers.
   * A class buy moves USDG account -> vault and the token curve -> vault in the
   * same transaction; a class sell moves the token vault -> curve and the
   * proceeds curve -> account. Both are trades, and both are decided by
   * TRANSACTION CONTEXT — the property this module's header says an allowlist can
   * never have. Without it neither leg pairs, both fall to `no-pair-external`,
   * and a trade is booked as a deposit or a withdrawal, corrupting the
   * denominator of every P&L figure.
   *
   * Without a paired trade, cash moving between the account and its own vault
   * is internal. This includes residual cash returned during a class purchase;
   * that refund is existing capital, not a new owner deposit.
   *
   * Absent means no class route, which is every grant today, and the behaviour
   * is byte-identical to before this field existed.
   */
  custodyAddresses?: readonly string[];
  /**
   * Tokens held as ENERGY rather than traded — energyReserveTokens(chainId).
   *
   * A USDG outflow whose ONLY inbound pair is one of these, landing at the
   * account itself, is `reserve-out` rather than `trade-out`. Every other shape
   * is unchanged: a mixed batch (a reserve token AND anything else arriving)
   * stays a trade, because part of it bought a position; a reserve landing at a
   * custody vault stays a trade, because the energy route delivers to the
   * account and nothing else is that route. There is no `reserve-in` — selling
   * the reserve back is unsupported, so USDG arriving against a reserve token
   * leaving stays `trade-in`.
   *
   * Absent or empty is byte-identical to before this field existed.
   */
  reserveTokens?: readonly string[];
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
    | "reserve-purchase"
    | "custody-transfer"
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
  // "The account" here means the account OR a contract holding for it — see
  // ClassifyInput.custodyAddresses. A class buy's token lands at the vault and
  // never touches the account at all, so an account-only test finds no pair and
  // books a trade as a withdrawal.
  const ours = (address: string) => eq(address, account) || has(input.custodyAddresses, address);
  const paired = txLegs.find(
    (l) =>
      !eq(l.token, usdgToken) &&
      (outbound ? ours(l.to) : ours(l.from)) &&
      BigInt(l.amountRaw || "0") > 0n,
  );
  if (paired) {
    // ── THE ENERGY RESERVE: a paired movement that is not a trade. ──────────
    //
    // Decided on the same transaction context as a trade, then narrowed: EVERY
    // token that arrived must be a reserve token and must have arrived at the
    // account itself. One other token arriving makes it a (mixed) trade, which
    // is the conservative reading — a trade leaves contributions alone, while a
    // wrong reserve-out would lower them.
    if (outbound && (input.reserveTokens?.length ?? 0) > 0) {
      const arrived = txLegs.filter(
        (l) => !eq(l.token, usdgToken) && ours(l.to) && BigInt(l.amountRaw || "0") > 0n,
      );
      if (arrived.every((l) => has(input.reserveTokens, l.token) && eq(l.to, account))) {
        return {
          kind: "reserve-out",
          pairedToken: paired.token,
          why:
            `the same transaction moved ${paired.token} INTO the account, and it is the energy reserve — this USDG ` +
            `was set aside outside the trading book, not spent on a position and not sent anywhere`,
          evidence: { ...base, rule: "reserve-purchase" },
        };
      }
    }
    const custodied = outbound ? !eq(paired.to, account) : !eq(paired.from, account);
    return {
      kind: outbound ? "trade-out" : "trade-in",
      pairedToken: paired.token,
      why: outbound
        ? `the same transaction moved ${paired.token} INTO ${custodied ? `this account's vault at ${paired.to}` : "the account"} — this USDG bought something, it did not leave`
        : `the same transaction moved ${paired.token} OUT of ${custodied ? `this account's vault at ${paired.from}` : "the account"} — this USDG is sale proceeds, not a deposit`,
      evidence: { ...base, rule: "paired-token-movement" },
    };
  }

  // Preserve trade classification above; unpaired own-vault cash stays ours.
  if (has(input.custodyAddresses, counterparty)) {
    return {
      kind: "internal",
      why: `the counterparty ${counterparty} holds this account's own assets — cash moved within its custody`,
      evidence: { ...base, rule: "custody-transfer" },
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
  /** Σ external capital out. Withdrawals to an outside address ONLY — never the energy reserve. */
  grossWithdrawalsRaw: string;
  /**
   * Σ USDG spent buying the energy reserve (`reserve-out`). Capital that left
   * the trading book without leaving the account, kept apart from withdrawals
   * so "the owner took money home" and "the agent bought its energy" stay two
   * different facts.
   */
  grossReservePurchasesRaw: string;
  /** in − out − reserve. May be zero while the figures above are large. */
  netContributionsRaw: string;
  /** Movements the classifier refused to decide. A repair must not touch these. */
  ambiguous: number;
  tradeLegs: number;
  internal: number;
  /** Movements to chain infrastructure. Never capital, never a trade. */
  protocol: number;
  /** How many `reserve-out` movements the total above is made of. */
  reservePurchases: number;
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
  let reserveRaw = 0n;
  let reservePurchases = 0;
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
      case "reserve-out":
        // Capital leaving the book — it lowers net contributions exactly as a
        // withdrawal does, so P&L (equity − contributions) is unmoved by it.
        reserveRaw += amt;
        reservePurchases += 1;
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
    grossReservePurchasesRaw: reserveRaw.toString(),
    netContributionsRaw: (inRaw - outRaw - reserveRaw).toString(),
    ambiguous,
    tradeLegs,
    internal,
    protocol,
    reservePurchases,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MOVEMENTS IN KIND: everything that is not USDG.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * WHICH NON-USDG MOVEMENTS COULD BE THE OWNER'S CAPITAL.
 *
 * Everything above is about the cash token. An owner can also fund or drain a
 * book IN KIND — send TSLA to the account, sweep a memecoin out with the owner
 * key — and equity then steps by the asset's value with no flow row behind it,
 * so the return reads the owner's own money as profit or loss. That is the
 * "balance change with no trade" shape, and nothing so far could name it.
 *
 * WHY THE USDG RULE IS NOT ENOUGH ON ITS OWN. Transaction context still comes
 * first — a different asset moving the other way is a swap, whoever signed it.
 * But for an asset, the dangerous movement is the one where NOTHING pairs
 * because the ledger lost the other half: a session-key swap whose trades row
 * is missing (the Shogun case). "No trades row" read as "not a trade" books an
 * agent's own purchase as an owner deposit, which is the same confident wrong
 * number in a new coat. So whether a trades row exists is never an input here.
 *
 * PROVENANCE COMES FROM THE OPERATION ITSELF. Kernel v3 packs the validator
 * that authorised a UserOperation into its nonce (executor.ts isFirstEnable),
 * and the EntryPoint records that nonce in its own event — a contract cannot
 * forge a log at the EntryPoint's address. That makes the signer a structural
 * fact rather than an inference:
 *
 *   permission (session key)  the agent. Its wall admits trading calls only, so
 *                             what it moved is a trade leg, or — with nothing
 *                             visible on the other side — ambiguous. NEVER
 *                             capital, whatever the database remembers.
 *   root (sudo)               the owner's own key. The only signer that can
 *                             sweep, so the only op that can be a candidate.
 *   no op from this account   somebody else acted. An inbound movement is a
 *                             candidate only when the owner's own wallet sent
 *                             the transaction or the operation that delivered
 *                             it — never because a Transfer log names the
 *                             owner, which any token contract can write.
 *                             Anything else arriving unasked (airdrops, dust,
 *                             poisoning) is ambiguous rather than a deposit.
 *
 * NATIVE ETH IS FUEL, NOT BOOK. Equity is cash + vault + positions +
 * quarantined cost (equity.ts), with no ETH in it, so an ETH movement on its
 * own steps nothing and is `fuel` — never a candidate, never valued. The
 * consequence that matters is the other side: a position bought WITH ETH
 * arrives in the book with nothing leaving the book, and equity steps by its
 * value as if it were profit. A session key cannot do that (every wall
 * permission carries valueLimit 0) — if one ever did, it is still the agent
 * trading. The owner's root key can, and that purchase is `ambiguous` with the
 * rule `paid-with-fuel`, so it reaches a reviewer and is valued, rather than
 * passing as a trade leg nobody reads. And because ETH the account RECEIVES is
 * invisible here (no log, no traces), a sale for ETH looks like a token
 * leaving with nothing back — which, measured against the book, it is.
 *
 * A CANDIDATE IS NOT CAPITAL. Nothing in this section books, totals or moves a
 * peak. It answers "which movements must a reviewer look at as possible owner
 * capital", and every arm that is not a candidate says why in words.
 *
 * `classifyUsdgMovement` above is deliberately untouched: the live deposit
 * scanner and the fleet tools depend on its exact verdicts, and this section
 * shares its helpers and its shape rather than its code path.
 */

/** The pseudo-token for native ETH, which an execution moves without any ERC-20 Transfer. */
export const NATIVE_ASSET = "native";

/** What one non-USDG movement turned out to be. */
export type AssetMovementKind =
  /** Owner capital arriving in kind. A CANDIDATE for review, never a booking. */
  | "asset-in"
  /** Owner capital leaving in kind — a sweep. A CANDIDATE for review, never a booking. */
  | "asset-out"
  /** One half of a swap. Not capital. */
  | "trade-leg"
  /**
   * The energy reserve token, in either direction. Excluded: the reserve sits
   * outside the trading book the way ETH gas does (energy.ts), so moving it
   * changes no equity the return is measured against, and the USDG side of
   * buying it is already `reserve-out` above.
   */
  | "reserve"
  /**
   * Native ETH, in either direction, whoever signed. Excluded: ETH is fuel and
   * sits outside the book (equity.ts composeEquityUsdg is cash + vault +
   * positions + quarantined cost, and no ETH), so sending it home steps no
   * equity the return is measured against. Its consequence for a POSITION is
   * the rule `paid-with-fuel`, below.
   */
  | "fuel"
  /**
   * Between the account and a contract holding its own assets — its class or
   * Trencher vault. Excluded: a sweep back from the vault moves a position, not
   * money (custody.ts).
   */
  | "custody"
  /** To or from another account this system controls. Not external. */
  | "internal"
  /** To or from chain infrastructure. Never capital, never a trade. */
  | "protocol"
  /** The classifier could not decide, and says why. Never quietly a candidate. */
  | "ambiguous";

/**
 * WHO AUTHORISED THE OPERATION THAT MOVED THE ASSET, read off the chain.
 *
 * A union rather than a string so that "I could not tell" cannot be spelled
 * the same way as an answer.
 */
export type OperationProvenance =
  /**
   * This account's own UserOperation, as the EntryPoint recorded it. `validator`
   * is the nonce key's validator type: 0x00 root, 0x01 secondary, 0x02
   * permission (executor.ts isFirstEnable has the layout).
   */
  | { source: "user-op"; validator: "root" | "permission" | "secondary"; userOpHash: string; nonce: string }
  /**
   * No operation from this account touched it: somebody else acted. `actors`
   * are the transaction's sender and the sender of any other account's
   * operation that produced the movement, so a deposit from the owner's own
   * smart wallet is recognised as the owner's.
   */
  | { source: "none"; actors: readonly string[] }
  /**
   * It could not be established — an unreadable receipt, a nonce whose key is
   * not one Kernel defines, a movement outside any operation's segment of a
   * bundle. Classifies `ambiguous` before any other rule can guess.
   */
  | { source: "unknown"; why: string };

export interface AssetClassifyInput {
  /** The account whose book this is. */
  account: string;
  /** The movement being classified. `token` is NATIVE_ASSET for ETH an execution sent. */
  leg: TransferLeg;
  /**
   * Every ERC-20 Transfer the SAME OPERATION produced, USDG included.
   *
   * Narrower than ClassifyInput.txLegs on purpose: a bundle can carry an owner
   * sweep and an agent swap side by side, and pairing across them would turn
   * the sweep into "half of a swap". A movement outside any operation is paired
   * only against the other movements outside any operation.
   */
  opLegs: readonly TransferLeg[];
  /**
   * Native ETH the operation's executions sent, as legs with token NATIVE_ASSET.
   *
   * NULL MEANS UNREAD, not "none": the executions could not be decoded, so a
   * curve buy paid in ETH has no visible pair. A root-key movement with nothing
   * paired is then `executions-unread` rather than a candidate. Pass an empty
   * list when this account did not act — there were no executions of its own.
   *
   * Only ETH the account SENT can appear here. ETH it RECEIVED — sale
   * proceeds, an unwrap, a refund — arrives by internal call with no log, and
   * this read has no traces, so it is never visible to this rule.
   */
  nativeLegs: readonly TransferLeg[] | null;
  provenance: OperationProvenance;
  /** The cash token. USDG movements belong to classifyUsdgMovement, not here. */
  usdgToken: string;
  /**
   * Wallets that are the owner's: the grant's owner key and the signed-in
   * tenant wallet. Only consulted when no operation of this account acted, and
   * matched against the provenance's actors — never against a log's `from`.
   */
  ownerAddresses?: readonly string[];
  /** Addresses this system controls — other hosted smart accounts. */
  knownAccounts?: readonly string[];
  /** Trading venues. A weak signal, exactly as in ClassifyInput. */
  protocolAddresses?: readonly string[];
  /** Chain infrastructure, exactly as in ClassifyInput. */
  systemAddresses?: readonly string[];
  /**
   * Contracts holding THIS account's own assets. Part of "the book" here: a
   * class buy's token lands at the vault, and a sweep from the vault to the
   * account moves nothing across the book's edge.
   */
  custodyAddresses?: readonly string[];
  /** energyReserveTokens(chainId). Any movement of one is `reserve`. */
  reserveTokens?: readonly string[];
}

export interface AssetClassificationEvidence {
  counterparty: string;
  direction: "in" | "out" | "self" | "none";
  /** How many ERC-20 Transfers the deciding operation contained. */
  opLegCount: number;
  /** Who authorised it, flattened so two verdicts compare without reading prose. */
  provenance: "root" | "permission" | "secondary" | "none" | "unknown";
  rule:
    | "cash-leg"
    | "zero-amount"
    | "not-this-account"
    | "reserve-token"
    | "native-fuel"
    | "custody-transfer"
    | "provenance-unread"
    | "paired-movement"
    | "paid-with-fuel"
    | "known-account"
    | "system-address"
    | "session-key-without-pair"
    | "secondary-validator-without-pair"
    | "executions-unread"
    | "venue-without-pair"
    | "owner-operation"
    | "owner-wallet"
    | "owner-named-only-by-log"
    | "unsolicited-inbound"
    | "moved-without-account-operation";
}

export interface AssetClassification {
  kind: AssetMovementKind;
  /** The sentence a reviewer reads. Always populated. */
  why: string;
  /** The asset that moved the other way, when this was half of a swap. */
  pairedAsset?: string;
  /**
   * True for `asset-in` and `asset-out` only. A reviewer's queue, not a ledger:
   * nothing downstream may book a candidate without a separate, reviewed step.
   */
  capitalCandidate: boolean;
  evidence: AssetClassificationEvidence;
}

/**
 * Classify one non-USDG movement. PURE.
 *
 * The rule order is the argument, top to bottom: facts that make the question
 * meaningless first, then exclusions that hold whoever signed, then the one
 * test that does not depend on knowing anybody (a pair), and only then the
 * signer. A candidate is reachable through exactly two doors — an owner root
 * op, or the owner's own wallet sending — and every other path ends somewhere
 * that is not capital.
 */
export function classifyAssetMovement(input: AssetClassifyInput): AssetClassification {
  const { account, leg, provenance } = input;
  const flat: AssetClassificationEvidence["provenance"] =
    provenance.source === "user-op" ? provenance.validator : provenance.source;
  // "The book" is the account and every contract holding for it — custody.ts's
  // bookAddresses, passed in rather than derived so this stays pure.
  const ours = (address: string) => eq(address, account) || has(input.custodyAddresses, address);
  const outbound = ours(leg.from);
  const inbound = ours(leg.to);
  const counterparty = inbound && !outbound ? leg.from : leg.to;
  const direction: AssetClassificationEvidence["direction"] =
    outbound && inbound ? "self" : outbound ? "out" : inbound ? "in" : "none";
  const evidence = (rule: AssetClassificationEvidence["rule"]): AssetClassificationEvidence => ({
    counterparty,
    direction,
    opLegCount: input.opLegs.length,
    provenance: flat,
    rule,
  });
  const notCapital = (
    kind: Exclude<AssetMovementKind, "asset-in" | "asset-out">,
    rule: AssetClassificationEvidence["rule"],
    why: string,
    pairedAsset?: string,
  ): AssetClassification => ({
    kind,
    why,
    ...(pairedAsset ? { pairedAsset } : {}),
    capitalCandidate: false,
    evidence: evidence(rule),
  });

  // ── Questions this function is not the one to answer. ──────────────────
  if (eq(leg.token, input.usdgToken)) {
    return notCapital("ambiguous", "cash-leg", "this is a USDG movement — classifyUsdgMovement decides those, not the in-kind rule");
  }
  if (BigInt(leg.amountRaw || "0") <= 0n) {
    // Zero-value Transfers are how address poisoning works. Nothing moved.
    return notCapital("ambiguous", "zero-amount", "a zero-amount transfer moves nothing and says nothing about capital");
  }
  if (!outbound && !inbound) {
    return notCapital("ambiguous", "not-this-account", "the movement does not touch this account or a vault holding for it");
  }

  // ── Exclusions that hold whoever signed. ──────────────────────────────
  //
  // Before the signer on purpose: the owner sweeping the energy reserve home,
  // or sweeping a position back from the vault, is the owner acting and is
  // still not a change to the book this return is measured against.
  if (has(input.reserveTokens, leg.token)) {
    return notCapital(
      "reserve",
      "reserve-token",
      `${leg.token} is the energy reserve, which sits outside the trading book — moving it changes no equity the return is measured against`,
    );
  }
  if (eq(leg.token, NATIVE_ASSET)) {
    return notCapital(
      "fuel",
      "native-fuel",
      "native ETH is fuel, which sits outside the book — equity is cash, vault, positions and quarantined cost, " +
        "so moving ETH changes no equity the return is measured against",
    );
  }
  if (outbound && inbound) {
    return eq(leg.from, leg.to)
      ? notCapital("ambiguous", "not-this-account", "the account is both sender and recipient — a self-transfer says nothing about capital")
      : notCapital(
          "custody",
          "custody-transfer",
          `moved between ${leg.from} and ${leg.to}, both of which hold this account's own assets — a position changed place, not hands`,
        );
  }

  // ── An unread signer stops everything after this point. ────────────────
  //
  // Even a pair is not trusted without it: a movement that could not be placed
  // in one operation may be "paired" with a different operation's leg in the
  // same bundle, and that is exactly how an owner sweep would come to read as
  // half of somebody's swap.
  if (provenance.source === "unknown") {
    return notCapital("ambiguous", "provenance-unread", `who authorised this could not be read from the chain — ${provenance.why}`);
  }

  // ── PRIMARY: did a different asset cross the book's edge the other way? ──
  //
  // The same test as the USDG rule, run first over the book's own assets.
  const crossesBack = (l: TransferLeg) =>
    !eq(l.token, leg.token) &&
    (outbound ? ours(l.to) && !ours(l.from) : ours(l.from) && !ours(l.to)) &&
    BigInt(l.amountRaw || "0") > 0n;
  const paired = input.opLegs.find(crossesBack);
  if (paired) {
    return notCapital(
      "trade-leg",
      "paired-movement",
      outbound
        ? `the same operation moved ${paired.token} INTO the book — this ${leg.token} was spent on something, it did not leave`
        : `the same operation moved ${paired.token} OUT of the book — this ${leg.token} was bought, it was not deposited`,
      paired.token,
    );
  }
  // Then ETH an execution sent: a curve buy paid in native ETH has no ERC-20
  // leg leaving, and without the execution's value it would look like a token
  // arriving from nowhere. But ETH is fuel, outside the book, so the book paid
  // NOTHING for this position — the signer decides what that is.
  const fuel = (input.nativeLegs ?? []).find(crossesBack);
  if (fuel) {
    if (provenance.source === "user-op" && provenance.validator === "permission") {
      return notCapital(
        "trade-leg",
        "paired-movement",
        `the same operation paid native ETH for this ${leg.token} — a session key's purchase, not a deposit; ETH is fuel ` +
          `outside the book, so equity stepped by this position's value with nothing leaving the book`,
        NATIVE_ASSET,
      );
    }
    return notCapital(
      "ambiguous",
      "paid-with-fuel",
      `${provenance.source === "user-op" && provenance.validator === "root" ? "the owner's root key" : "a secondary validator"} ` +
        `paid native ETH for this ${leg.token} — by its shape a purchase, but ETH is fuel outside the book, so the book ` +
        `paid nothing and equity stepped by this position's value; whether that is the owner's capital arriving in kind ` +
        `is for a reviewer`,
      NATIVE_ASSET,
    );
  }

  if (has(input.knownAccounts, counterparty)) {
    return notCapital("internal", "known-account", `the counterparty ${counterparty} is another account this system controls`);
  }
  if (has(input.systemAddresses, counterparty)) {
    return notCapital(
      "protocol",
      "system-address",
      `the counterparty ${counterparty} is chain infrastructure, which cannot be a source of capital`,
    );
  }

  // ── Nothing paired. Now, and only now, the signer decides. ─────────────
  if (provenance.source === "user-op" && provenance.validator === "permission") {
    // The Shogun case lands here when its other half is invisible. The wall
    // sealed into a session key admits trading calls only, so this is the
    // agent trading even when nothing on the other side can be seen — and a
    // missing trades row must not promote it to the owner's money.
    return notCapital(
      "ambiguous",
      "session-key-without-pair",
      `a session key moved this, and its wall admits trading calls only — it cannot be the owner's capital, but nothing ` +
        `visible moved the other way in the same operation (native ETH the account received is not observable), so it ` +
        `cannot be confirmed as a completed trade either`,
    );
  }
  if (provenance.source === "user-op" && provenance.validator === "secondary") {
    return notCapital(
      "ambiguous",
      "secondary-validator-without-pair",
      "a secondary validator — neither the owner's root key nor a session key — authorised this, and nothing paired with it",
    );
  }

  if (provenance.source === "user-op") {
    // The owner's root key, nothing paired. But "nothing paired" is only a
    // finding when the executions were READ: an owner's own curve buy paid in
    // native ETH has no ERC-20 leg leaving, and with the execution's value
    // unknown it is indistinguishable from a deposit.
    if (input.nativeLegs === null) {
      return notCapital(
        "ambiguous",
        "executions-unread",
        `the owner's key moved this with nothing visible the other way, but the operation's executions could not be ` +
          (inbound ? `decoded — native ETH it sent may have paid for it` : `decoded — what else the operation did is unknown`),
      );
    }
    // A venue still refuses rather than guesses, exactly as the USDG rule
    // does: an approval-style leg to a router may be half of a trade this
    // operation cannot show.
    if (has(input.protocolAddresses, counterparty)) {
      return notCapital(
        "ambiguous",
        "venue-without-pair",
        `the owner's key moved this to or from ${counterparty}, a known venue, with nothing moving the other way — ` +
          `it cannot be read as either capital or a completed trade`,
      );
    }
    return {
      kind: outbound ? "asset-out" : "asset-in",
      why: outbound
        ? `the owner's root key sent ${leg.token} to ${counterparty} and nothing visible came back into the book — a sweep ` +
          `of the book, in kind (native ETH the account received is not observable, but it is fuel outside the book, so ` +
          `a sale for ETH lowers the book the same way)`
        : `the owner's root key brought ${leg.token} in from ${counterparty} with nothing leaving the book — a deposit, in kind`,
      capitalCandidate: true,
      evidence: evidence("owner-operation"),
    };
  }

  // ── No operation of this account acted. ────────────────────────────────
  if (outbound) {
    // A smart account's assets leave only through its own operations, or
    // through an allowance somebody else spent. The second is not a decision
    // the owner can be said to have made.
    return notCapital(
      "ambiguous",
      "moved-without-account-operation",
      `${leg.token} left the book in a transaction that carried no operation of this account — an allowance was spent, ` +
        `and that is not a withdrawal anybody can be said to have chosen`,
    );
  }
  // Checked before the venue list on purpose: an owner who swaps on a DEX with
  // the account as recipient is depositing in kind, and the pool being the
  // Transfer's sender is how that looks.
  //
  // THE ACTORS, NEVER THE LOG. `leg.from` is a field of a Transfer log, and the
  // token contract that emitted the log chose it: a worthless contract can log
  // Transfer(owner → account) in a transaction a stranger sent, and address
  // poisoning does exactly that with wallets that are public on chain. Who
  // sent the transaction, and whose operation produced the log, the chain
  // authenticates — so only those open this door.
  if (provenance.actors.some((a) => has(input.ownerAddresses, a))) {
    return {
      kind: "asset-in",
      why: `the owner's own wallet sent the transaction, or the operation, that delivered ${leg.token} to the account — a deposit, in kind`,
      capitalCandidate: true,
      evidence: evidence("owner-wallet"),
    };
  }
  if (has(input.ownerAddresses, leg.from)) {
    return notCapital(
      "ambiguous",
      "owner-named-only-by-log",
      `the Transfer log names the owner's wallet ${leg.from} as sender, but the owner did not send the transaction or ` +
        `the operation that produced it — a token contract writes its own logs, so this is not evidence the owner sent anything`,
    );
  }
  if (has(input.protocolAddresses, counterparty)) {
    return notCapital(
      "ambiguous",
      "venue-without-pair",
      `${leg.token} arrived from ${counterparty}, a known venue, in a transaction this account did not send — ` +
        `it cannot be read as either capital or a completed trade`,
    );
  }
  return notCapital(
    "ambiguous",
    "unsolicited-inbound",
    `${leg.token} arrived from ${counterparty}, which is not the owner, in a transaction neither this account nor its owner ` +
      `sent — an airdrop or a stranger's transfer is not a deposit, and nothing here can say it was one`,
  );
}
