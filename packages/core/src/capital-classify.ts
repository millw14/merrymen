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

// perps.ts imports nothing, so this file stays a leaf in everything but name.
import { LIGHTER_ROUTE_V1 } from "./perps";

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
  /**
   * USDG posted as MARGIN to this account's own venue account (Lighter), or
   * paid back from it. Not capital, not a trade.
   *
   * Money that moved between two places this book owns: the smart account and
   * the Lighter account keyed on it. Booked as capital it would launder perp
   * P&L into contributions — a margin deposit read as a withdrawal lowers the
   * denominator, a payout read as a deposit raises the high-water mark by money
   * that was already the owner's — and the performance fee would be charged on
   * (or escape) exactly the wrong figure. Equity carries the venue side
   * separately (`perpAccountUsdg`, docs/perps.md rule 12).
   *
   * TWO KINDS, NOT ONE `venue-margin`, for the reason capital and trades come
   * in pairs: direction is the first thing every consumer needs — money in
   * transit to the venue and money in transit home are different lines in the
   * equity identity (T_out, T_in) — and a single kind would make each of them
   * re-derive it from the addresses. The RULE is one, `venue-margin`, and it
   * is on the evidence.
   *
   * Only produced when the caller passes `venueProxies`; see ClassifyInput.
   */
  | "margin-out"
  | "margin-in"
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
  /**
   * The Transfer log's position in its receipt, when the caller knows it.
   *
   * Read by exactly one rule, `venue-margin`, which pairs a USDG leg with the
   * venue event its own call emitted — by POSITION, because amounts alone
   * cannot tell two payouts of the same size apart. Absent, that rule refuses
   * (`ambiguous`) rather than pairing by guesswork; every other rule ignores it.
   */
  logIndex?: number;
}

/**
 * One receipt log, undecoded — the shape every RPC returns. The venue arm
 * takes the WHOLE receipt, not Transfers only: the evidence that a USDG leg
 * was margin lives in the venue's own events, and every Transfer decoder in
 * the worker throws those away.
 *
 * `logIndex` is as loose as the worker's own ReceiptLog (fills.ts), because
 * sources disagree on its type — viem gives a number, raw JSON-RPC a hex
 * string. It is read through `logIndexOf`; a position that cannot be read is
 * null, and the venue rule treats a receipt holding one as unreadable.
 */
export interface ReceiptLogLike {
  address: string;
  topics: readonly string[];
  data: string;
  logIndex?: number | string | bigint | null;
}

/** A log's position as a non-negative safe integer, or null when it cannot be read. */
export function logIndexOf(log: Pick<ReceiptLogLike, "logIndex">): number | null {
  const v = log.logIndex;
  let n: number | null = null;
  if (typeof v === "number") n = v;
  else if (typeof v === "bigint") n = v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
  else if (typeof v === "string" && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(v)) n = Number(v);
  return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
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
  /**
   * The perp venue's settlement contracts on THIS chain — `lighterVenueProxies
   * (chainId)`, i.e. LIGHTER_ROUTE_V1.proxy on 4663 and nothing anywhere else.
   *
   * THE SWITCH FOR THE `venue-margin` RULE. Once a proxy is named, that rule
   * OWNS every USDG leg whose counterparty it is: the leg is margin when the
   * same receipt proves it (below), capital-out in the one shape that proves
   * the money went to somebody else's venue account, and `ambiguous` in every
   * other case. It never falls through to `no-pair-external` — that is where a
   * payout home would be booked as a fresh owner deposit (the high-water mark
   * raised by money that was already the owner's, which then reads as a
   * drawdown), and where a margin deposit would be booked as the owner taking
   * money out. Ambiguous stops the live scanner for the account, which is this
   * module's fail-closed answer to a movement it cannot prove.
   *
   * Absent or empty is byte-identical to before this field existed, whatever
   * `venueLogs` holds.
   */
  venueProxies?: readonly string[];
  /**
   * EVERY log in the same receipt, unfiltered — the evidence `venueProxies`
   * needs. Decoded here with `decodeLighterLog`, the same decoder
   * `lighterEventsFromReceiptLogs` uses, so a scanner and an auditor cannot
   * read one receipt two ways.
   *
   * Absent while `venueProxies` is set means NO evidence, not "don't check":
   * every proxy leg is then `ambiguous`. A caller that can name the venue but
   * cannot hand over the receipt has not shown the movement was margin.
   */
  venueLogs?: readonly ReceiptLogLike[];
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
    | "venue-margin"
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

  // ── THE PERP VENUE: margin, proved by the venue's own events. ────────────
  //
  // AFTER the paired rule, which stays first because it needs no list: a leg
  // that really was half of a swap is a trade whoever the counterparty is.
  // BEFORE custody, known accounts, infrastructure and the venue fallback, and
  // above all before `no-pair-external`: once the caller names the proxy, this
  // rule decides every leg that touches it, so none can drop through to be
  // booked as capital on the strength of having no pair.
  if ((input.venueProxies?.length ?? 0) > 0 && has(input.venueProxies, counterparty)) {
    return classifyVenueMargin(input, outbound, counterparty, base);
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

// ── the perp venue's receipts ──────────────────────────────────────────────

/** keccak256("Transfer(address,address,uint256)") — the ERC-20 event. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * The venue proxies on a chain: Lighter's on 4663, none anywhere else.
 *
 * ONE SOURCE for `ClassifyInput.venueProxies`, keyed by chain, so no caller
 * types an address and none can name the mainnet proxy on testnet — where it
 * is codeless and nothing it "emits" could be evidence of anything.
 */
export function lighterVenueProxies(chainId: number): readonly string[] {
  return chainId === LIGHTER_ROUTE_V1.chainId ? [LIGHTER_ROUTE_V1.proxy] : [];
}

/** A Lighter proxy event, decoded. Amounts are the venue's base units (× usdgTickSize = USDG base units). */
export type LighterEvent =
  | {
      event: "Deposit";
      proxy: string;
      /** Null when the source carried no readable position — the event is still evidence of WHAT, not of WHERE. */
      logIndex: number | null;
      toAccountIndex: bigint;
      toAddress: `0x${string}`;
      assetIndex: number;
      routeType: number;
      baseAmount: bigint;
    }
  | {
      event: "WithdrawPending";
      proxy: string;
      logIndex: number | null;
      owner: `0x${string}`;
      assetIndex: number;
      baseAmount: bigint;
    };

const HEX_WORDS = /^0x(?:[0-9a-fA-F]{64})*$/;

/** The 32-byte words of `data`, or null unless there are exactly `n` of them. */
function words(data: string, n: number): bigint[] | null {
  if (typeof data !== "string" || !HEX_WORDS.test(data) || data.length !== 2 + n * 64) return null;
  const out: bigint[] = [];
  for (let i = 0; i < n; i++) out.push(BigInt(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`));
  return out;
}

/** A word that holds an address and nothing else (high 12 bytes zero), as a lowercase address. */
function addressWord(w: bigint | undefined): `0x${string}` | null {
  if (w === undefined || w >> 160n !== 0n) return null;
  return `0x${w.toString(16).padStart(40, "0")}`;
}

/**
 * One proxy log, decoded against LIGHTER_EVENTS_ABI's layout — or null.
 *
 *   Deposit(uint48 toAccountIndex, address toAddress, uint16 assetIndex,
 *           uint8 routeType, uint128 baseAmount)     nothing indexed: 1 topic, 5 words
 *   WithdrawPending(address indexed owner, uint16 assetIndex,
 *           uint128 baseAmount)                      owner in topic1, 2 words
 *
 * STRICT, BY HAND, ON PURPOSE. Only the canonical encoding is read: the exact
 * topic count, the exact data length, and every word within its declared type
 * — a uint16 with high bits set or an address word with a dirty high byte is
 * not an event this contract emits, and a lenient decoder that masked it would
 * be pairing money with something the venue never said. Anything else is
 * null, and the venue rule treats a null where it needed an event as no
 * evidence (`ambiguous`). capital-classify.test.ts proves the layout against
 * viem's encoder over LIGHTER_EVENTS_ABI.
 *
 * The address is NOT checked here — callers decide whose logs count
 * (`lighterEventsFromReceiptLogs` by chain, the venue rule by counterparty).
 */
export function decodeLighterLog(log: ReceiptLogLike): LighterEvent | null {
  const t0 = (log.topics?.[0] ?? "").toLowerCase();
  if (t0 === LIGHTER_ROUTE_V1.topics.deposit) {
    if (log.topics.length !== 1) return null;
    const w = words(log.data, 5);
    if (!w) return null;
    const [acct, to, asset, route, amount] = w as [bigint, bigint, bigint, bigint, bigint];
    const toAddress = addressWord(to);
    if (toAddress === null || acct >> 48n !== 0n || asset >> 16n !== 0n || route >> 8n !== 0n || amount >> 128n !== 0n) {
      return null;
    }
    return {
      event: "Deposit",
      proxy: log.address.toLowerCase(),
      logIndex: logIndexOf(log),
      toAccountIndex: acct,
      toAddress,
      assetIndex: Number(asset),
      routeType: Number(route),
      baseAmount: amount,
    };
  }
  if (t0 === LIGHTER_ROUTE_V1.topics.withdrawPending) {
    if (log.topics.length !== 2) return null;
    const topic1 = words(log.topics[1] ?? "", 1);
    const w = words(log.data, 2);
    if (!topic1 || !w) return null;
    const owner = addressWord(topic1[0]);
    const [asset, amount] = w as [bigint, bigint];
    if (owner === null || asset >> 16n !== 0n || amount >> 128n !== 0n) return null;
    return {
      event: "WithdrawPending",
      proxy: log.address.toLowerCase(),
      logIndex: logIndexOf(log),
      owner,
      assetIndex: Number(asset),
      baseAmount: amount,
    };
  }
  return null;
}

/**
 * Every Lighter margin event a receipt carries on this chain, in receipt order.
 * PURE. Logs from any other address — including a contract that copies the
 * proxy's event signatures — are not events of the venue and are skipped, as
 * is anything `decodeLighterLog` will not read. Off 4663 there is no venue and
 * the answer is always empty.
 *
 * The one decoder for scanners, payout recognition and audits alike: two
 * decoders would be two answers about what a receipt said.
 */
export function lighterEventsFromReceiptLogs(logs: readonly ReceiptLogLike[], chainId: number): LighterEvent[] {
  const proxies = lighterVenueProxies(chainId);
  if (proxies.length === 0) return [];
  const out: LighterEvent[] = [];
  for (const l of logs) {
    if (!has(proxies, l.address)) continue;
    const e = decodeLighterLog(l);
    if (e) out.push(e);
  }
  return out;
}

/** A USDG Transfer log's (from, to, amount), or null — for checking the leg against its own receipt. */
function transferOf(log: ReceiptLogLike): { token: string; from: string; to: string; amount: bigint } | null {
  if ((log.topics?.[0] ?? "").toLowerCase() !== TRANSFER_TOPIC || log.topics.length !== 3) return null;
  const from = addressWord(words(log.topics[1] ?? "", 1)?.[0]);
  const to = addressWord(words(log.topics[2] ?? "", 1)?.[0]);
  const amount = words(log.data, 1)?.[0];
  if (from === null || to === null || amount === undefined) return null;
  return { token: log.address.toLowerCase(), from, to, amount };
}

/**
 * THE `venue-margin` RULE. Decides every USDG leg whose counterparty is a
 * named venue proxy, and proves each verdict from the same receipt.
 *
 * OUT (account → proxy) is `margin-out` only when ALL hold:
 *   - the leg's own Transfer sits at `usdg.logIndex` in `venueLogs` — the
 *     position is checked, not trusted;
 *   - the FIRST Deposit the proxy emits after it names this account, asset 3
 *     and route 0, for baseAmount × tickSize == the leg's amount;
 *   - no other USDG enters the proxy in between.
 * That is how one `deposit` call reads on chain — safeTransferFrom, then
 * NewPriorityRequest, then Deposit, all inside the call (receipt 0x28144cb2…:
 * Transfer at 2, Deposit at 4, `{22149, self, 3, 0, 82973191}`) — and USDG has
 * no transfer hook, so nothing can interleave. Pairing by position is also
 * what makes SOMEBODY ELSE'S DEPOSIT IN THE SAME TRANSACTION irrelevant: it
 * sits after its own Transfer, never between this leg and this leg's event,
 * and a router crediting another account (a third of live Deposits are routed
 * that way) never pairs with our money.
 *
 * When that one paired Deposit names ANOTHER address — same asset, route and
 * amount — the verdict is `capital-out`, today's verdict for any leg to the
 * proxy, now with its reason: this account's USDG was credited to a venue
 * account this book does not own and will never see again, which is a
 * withdrawal to an outside party. Only the owner key can make that call; the
 * wall pins `_to` to the account.
 *
 * Anything else — no Deposit, an amount that differs, another asset or route,
 * an undecodable event, a leg whose position is unknown or wrong — is
 * `ambiguous`. Not capital-out (the old fall-through), because the money
 * demonstrably went to the venue and a withdrawal would be a guess; not
 * margin, because nothing proved it. Ambiguous blocks the live scanner until
 * someone looks, which is the point.
 *
 * IN (proxy → account) is `margin-in` only when the log at `usdg.logIndex + 1`
 * is the proxy's WithdrawPending(owner = this account, asset 3) for the same
 * amount — the claim's own event, emitted right after its Transfer. POSITIONAL
 * because Lighter's relayer batches claims (receipt 0x0f82c519…: Transfer i,
 * WithdrawPending i+1, per owner) and one owner can be paid twice in one
 * transaction with equal amounts; matching by amount alone could pair both
 * transfers with one event. Anything else from the proxy is `ambiguous`.
 */
function classifyVenueMargin(
  input: ClassifyInput,
  outbound: boolean,
  proxy: string,
  base: Omit<ClassificationEvidence, "rule">,
): Classification {
  const { account, usdg } = input;
  const evidence: ClassificationEvidence = { ...base, rule: "venue-margin" };
  const refuse = (why: string): Classification => ({
    kind: "ambiguous",
    why: `the counterparty ${proxy} is the perp venue, but ${why} — it cannot be read as margin, capital or a trade`,
    evidence,
  });

  // The venue's collateral is asset 3, which is this USDG and nothing else.
  if (!eq(usdg.token, LIGHTER_ROUTE_V1.usdg)) return refuse(`${usdg.token} is not the venue's collateral token`);
  const amount = BigInt(usdg.amountRaw || "0");
  const tick = BigInt(LIGHTER_ROUTE_V1.usdgTickSize);
  const at = usdg.logIndex;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) {
    return refuse("this transfer's position in its receipt is unknown, so it cannot be paired with its own venue event");
  }
  // POSITIONS OR NOTHING. Pairing is by position, so a receipt with any log
  // whose position cannot be read cannot say what sits between two others.
  // Two logs claiming one position is not a receipt any chain produced.
  const positioned = (input.venueLogs ?? []).map((l) => ({ l, i: logIndexOf(l) }));
  if (positioned.some((p) => p.i === null) || new Set(positioned.map((p) => p.i)).size !== positioned.length) {
    return refuse("its receipt carries a log whose position could not be read, so nothing in it can be paired by position");
  }
  const logs = positioned
    .map(({ l, i }) => ({ ...l, logIndex: i as number }))
    .sort((a, b) => a.logIndex - b.logIndex);
  const own = logs.find((l) => l.logIndex === at);
  const leg = own ? transferOf(own) : null;
  if (
    !leg ||
    !eq(leg.token, usdg.token) ||
    !eq(leg.from, outbound ? account : proxy) ||
    !eq(leg.to, outbound ? proxy : account) ||
    leg.amount !== amount
  ) {
    return refuse(`the receipt's log ${at} is not this transfer, so nothing in it can be paired with the leg`);
  }
  const fromProxy = (l: ReceiptLogLike) => eq(l.address, proxy);

  if (outbound) {
    const next = logs.find(
      (l) => l.logIndex > at && fromProxy(l) && (l.topics?.[0] ?? "").toLowerCase() === LIGHTER_ROUTE_V1.topics.deposit,
    );
    if (!next) return refuse("no Deposit from it follows this transfer in the same receipt");
    const between = logs.some((l) => {
      if (l.logIndex <= at || l.logIndex >= next.logIndex) return false;
      const t = transferOf(l);
      return t !== null && eq(t.token, usdg.token) && eq(t.to, proxy);
    });
    if (between) return refuse("other USDG entered the venue between this transfer and the Deposit that follows it");
    const d = decodeLighterLog(next);
    if (!d || d.event !== "Deposit") return refuse(`the Deposit at log ${next.logIndex} is not canonically encoded`);
    if (d.assetIndex !== LIGHTER_ROUTE_V1.assetIndex || d.routeType !== LIGHTER_ROUTE_V1.routePerps) {
      return refuse(`the Deposit that follows it is for asset ${d.assetIndex} on route ${d.routeType}, not USDG margin for perps`);
    }
    if (d.baseAmount * tick !== amount) {
      return refuse(`the Deposit that follows it credits ${d.baseAmount * tick} base units, not the ${amount} this transfer moved`);
    }
    if (eq(d.toAddress, account)) {
      return {
        kind: "margin-out",
        why:
          `posted as margin: the venue's Deposit at log ${d.logIndex} credits this account's own venue account ` +
          `(index ${d.toAccountIndex}) with exactly this USDG — it moved within the book, it did not leave it`,
        evidence,
      };
    }
    return {
      kind: "capital-out",
      why:
        `the venue's Deposit at log ${d.logIndex} credits ${d.toAddress}'s venue account, not this one — this USDG ` +
        `left the book for an account it does not own`,
      evidence,
    };
  }

  const next = logs.find((l) => l.logIndex === at + 1);
  const w = next && fromProxy(next) ? decodeLighterLog(next) : null;
  if (!w || w.event !== "WithdrawPending") {
    return refuse("the log right after this transfer is not the venue's WithdrawPending for it");
  }
  if (!eq(w.owner, account) || w.assetIndex !== LIGHTER_ROUTE_V1.assetIndex || w.baseAmount * tick !== amount) {
    return refuse(
      `the WithdrawPending right after it pays ${w.owner} ${w.baseAmount * tick} of asset ${w.assetIndex}, ` +
        `not this account ${amount} of USDG`,
    );
  }
  return {
    kind: "margin-in",
    why:
      `a payout from this account's own venue account: the venue's WithdrawPending at log ${w.logIndex} names this ` +
      `account for exactly this USDG — money coming home, not a deposit`,
    evidence,
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
  /**
   * Σ USDG posted as margin to this account's own venue account (`margin-out`)
   * and Σ paid back from it (`margin-in`). NEITHER IS CAPITAL AND NEITHER
   * MOVES `netContributionsRaw`: the money stayed in the book, on the other
   * side of the venue. Kept as figures anyway so a reader can reconcile them
   * against the venue's own deposit and withdrawal history.
   */
  grossMarginOutRaw: string;
  grossMarginInRaw: string;
  /** How many `margin-out`/`margin-in` movements the two figures above are made of. */
  marginLegs: number;
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
  let marginOutRaw = 0n;
  let marginInRaw = 0n;
  let marginLegs = 0;
  for (const l of legs) {
    const amt = BigInt(l.amountRaw || "0");
    const kind = l.classification.kind;
    switch (kind) {
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
      // Margin is neither capital nor a trade: its own figures, and nothing
      // else moves. Not `tradeLegs` — a margin deposit bought nothing — and
      // not `internal`, which means "another account this system controls".
      case "margin-out":
        marginOutRaw += amt;
        marginLegs += 1;
        break;
      case "margin-in":
        marginInRaw += amt;
        marginLegs += 1;
        break;
      default: {
        // EXHAUSTIVE, so the next kind is a compile error here rather than a
        // movement that silently counts as nothing.
        const unhandled: never = kind;
        throw new Error(`totalCapital: unhandled classification kind ${String(unhandled)}`);
      }
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
    grossMarginOutRaw: marginOutRaw.toString(),
    grossMarginInRaw: marginInRaw.toString(),
    marginLegs,
  };
}
