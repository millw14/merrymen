/**
 * THE ENERGY BUY'S ARITHMETIC AND ITS SENTENCES — the pure half.
 *
 * An owner asks their agent to buy the $MERRYMEN it is short ("get my energy").
 * This file decides whether it may, how much ONE confirmation spends, and what
 * the owner is told — from reads the caller made fresh, never from a remembered
 * goal and never from a number a model supplied. index.ts's submitEnergyBuy
 * makes the reads, hands them here, and builds the one intent this returns.
 *
 * ONE CHUNK PER CONFIRMATION, and no durable goal. A goal ("top me up to full
 * across as many buys as it takes") needs a record, a spent-so-far count, expiry
 * and cancel, and it breaks the one-row receipt an order comes back with. So a
 * confirmation buys at most one chunk, sized under every cap at once, and the
 * sentence says how many more asks would finish the job. Asking again is safe
 * because the size is derived from the CHAIN every time: a duplicate order can
 * only top up to full, never past it.
 *
 * EVERY INPUT FAILS CLOSED. A balance nobody could read is never "you hold
 * nothing" — that is the sentence that sends somebody to buy tokens they already
 * have — and a tax nobody could read is never a floor. Each unknown refuses, by
 * name, before anything is sized.
 *
 * THE SIZING IS EXACT V2 ARITHMETIC AT THE EXPECTED RATE, not a hedge. What
 * must ARRIVE is the shortfall plus a 50 bps margin; grossNeededFor inverts the
 * token's buy tax exactly (ceiling at each step); the router's own getAmountsIn
 * prices that gross output across both pools, fees included; the result is
 * rounded UP to the cent. The owner's slippage tolerance is NOT in the size —
 * it is the router's floor on what arrives (the executor's minOut), nothing
 * else. Sizing for the worst case bought 1.5% over the shortfall at the default
 * tolerance and ~11.7% at the maximum on every ask; a buy the market moves
 * against now arrives a little short, and the next ask tops it up from the
 * chain, which is already safe. Only then is it capped:
 * by the owner's own maximum for this ask, the key's per-trade cap (the USDG
 * approve the wall seals), what is left of today's budget, and the cash in the
 * account — each rounded DOWN to the cent. Every cap binds at once, so the
 * amount never exceeds any of them (energy-buy.test.ts proves it over random
 * inputs).
 *
 * STANCE: utility only. Energy is how much the agent may do on its own; every
 * sentence here speaks of energy, USDG spent, and $MERRYMEN held — never of the
 * token's price, where it is going, or what it might return. No tax or fee
 * percentage is printed: the tax is its owner's to change.
 */

import { ENERGY, ENERGY_FULL_RAW, MERRYMEN_TOKEN, isEnergyReserveToken, wholeTokens } from "../../packages/core/src/index";
import { energyPreTradeGate, type EnergyGateRule } from "./energy-accounting";
import { count } from "./energy-copy";
import type { LedgerFacts } from "./order-receipt";
import { rejectRuleLabel, rejectRuleRemedy } from "./thesis-policy";
import { grossNeededFor } from "./venues/uniswap-v2";

/**
 * The margin on what must arrive, bps — the ONLY margin over the shortfall.
 * The tax is inverted exactly; slippage is never sized in (it is the router's
 * floor, see the header), so this is what absorbs rounding and a small move
 * between the quote and the fill: the card's "small margin for price movement".
 */
export const ENERGY_BUFFER_BPS = 50;
/** One cent of USDG, raw 6dp. */
const CENT = 10_000n;

/** Where the balances stand, as the caller read them — pinned to one block. */
export interface EnergyReads {
  /**
   * Raw $MERRYMEN per counted address (circle.ts HolderParts): a bigint was
   * read, `null` is a read that FAILED, `undefined` is no such address (no
   * wallet configured, or the account IS the wallet and was counted once).
   */
  holder: bigint | null | undefined;
  account: bigint | null | undefined;
  /** Raw USDG in the account; null = unread. */
  cashUsdg: bigint | null;
  /** An earlier energy buy is still unresolved on the ledger; null = the ledger would not answer. */
  inFlight: boolean | null;
}

/** Every ceiling one ask is under, raw 6dp USDG. */
export interface EnergyCaps {
  /** The owner's own maximum for this ask — the order's usdgAmount, already within their chat limit. */
  ownerMaxRaw: bigint;
  /** The key's per-trade cap: the USDG approve the wall seals, LESS_THAN_OR_EQUAL. */
  perTradeRaw: bigint;
  /** The grant's daily budget, and what today has already spent against it (settled + in flight). */
  dailyRaw: bigint;
  spentTodayRaw: bigint;
  /** Trades still allowed in the trailing 24h. */
  opsRemaining: number;
  /** For the sentence only: the day's total allowance of trades. */
  maxOpsPerDay: number;
}

/**
 * How the route prices right now. `amountInFor` is the router's getAmountsIn
 * over the energy path. NO SLIPPAGE: the owner's tolerance is the executor's
 * floor on what arrives (energyMinOut at the re-quote), never part of the size.
 */
export interface EnergyPricing {
  /** $MERRYMEN's buy tax, bps, read now; null = unreadable. */
  taxBps: number | null;
  amountInFor(grossOut: bigint): Promise<bigint | null>;
}

/** The book, as the accounting gate judges a purchase (energy-accounting.ts). All raw 6dp USDG. */
export interface EnergyBook {
  paper: boolean;
  equityKnown: boolean;
  equityUsdg: bigint;
  netContributionsUsdg: bigint | null;
  lifetimePeakUsdg: bigint;
  breakerPeakUsdg: bigint;
  maxDrawdownBps: number;
}

/** Which ceiling set the size. `null` is none: the shortfall itself was the smallest. */
export type EnergyBinding = "owner" | "per-trade" | "daily" | "cash";

export type EnergyPlanRule =
  | "energy-unreadable"
  | "energy-in-flight"
  | "energy-tax-unreadable"
  | "energy-tax"
  | "energy-no-quote"
  | "energy-too-small"
  | "ops-cap"
  | "daily-cap"
  | "no-cash"
  | EnergyGateRule;

export type EnergyPlan =
  | { kind: "full"; heldRaw: bigint; line: string }
  | { kind: "refuse"; rule: EnergyPlanRule; line: string }
  | {
      kind: "buy";
      /** Raw USDG this confirmation spends. Never above any cap. */
      amountInRaw: bigint;
      /** Raw $MERRYMEN still missing for full energy before this buy. */
      shortRaw: bigint;
      /** Raw $MERRYMEN held (both parts) before this buy. */
      heldRaw: bigint;
      /** Raw USDG the whole shortfall would cost now, cent-rounded up. */
      needInRaw: bigint;
      /** This one chunk buys the whole shortfall. */
      coversShortfall: boolean;
      /** The ceiling that set the size, or null when the shortfall did. */
      binding: EnergyBinding | null;
      /** Further asks like this one that would finish the job (0 when this covers it). */
      asksLeft: number;
      /** The tax the plan was sized with — the executor re-reads it and refuses if it rose past the ceiling. */
      taxBps: number;
    };

const ceilCent = (v: bigint) => (v % CENT === 0n ? v : v + (CENT - (v % CENT)));
const floorCent = (v: bigint) => (v <= 0n ? 0n : v - (v % CENT));

/**
 * THE ONE SIZING RULE: how much $MERRYMEN to price for a shortfall. What must
 * arrive is the shortfall plus its margin (ENERGY_BUFFER_BPS); grossNeededFor
 * inverts the token's buy tax on top, at the EXPECTED rate — zero slippage,
 * because the owner's tolerance is the router's floor (energyMinOut), never
 * part of the size. It takes no slippage argument, so no caller can size with
 * one. The planner sizes the buy with it and index.ts's "about $X" estimate
 * prices the same figure, so the number an owner is shown is the number they
 * will be asked for.
 */
export function energyGrossFor(shortRaw: bigint, taxBps: number): bigint {
  const wantNet = (shortRaw * BigInt(10_000 + ENERGY_BUFFER_BPS) + 9_999n) / 10_000n;
  return grossNeededFor(wantNet, taxBps, 0);
}

/** A route quote → the USDG one buy asks: rounded UP to the cent, and never under the smallest buy. */
export function energyAskFor(quotedRaw: bigint): bigint {
  const need = ceilCent(quotedRaw);
  return need < ENERGY.minChunkUsdg6 ? ENERGY.minChunkUsdg6 : need;
}
/** Raw 6dp USDG → "12.34". */
export const usdgText = (v: bigint) => (Number(v) / 1e6).toFixed(2);
const tokens = (raw: bigint) => count(wholeTokens(raw));
const FULL = count(ENERGY.fullTokens);

const WAY_ROUND = "You can also send $MERRYMEN to my account on Robinhood Chain directly — it counts the moment it lands.";

// ── the fixed sentences — each a refusal before anything is read or sized ──

/**
 * Is this order about $MERRYMEN? Case-insensitive, and a leading "$" is the
 * way owners write it. Compared with the registry's own symbol, never a typed
 * literal.
 */
export function isEnergySymbol(symbol: string | null | undefined): boolean {
  return (symbol ?? "").trim().replace(/^\$/, "").toUpperCase() === MERRYMEN_TOKEN.symbol.toUpperCase();
}

/**
 * WHICH TOKEN AN ORDINARY ORDER MEANS — the watch set first, the reserve only
 * when nothing there answers to the name.
 *
 * submitChatTrade used to refuse any symbol reading MERRYMEN before it looked
 * at the watch set, so a coin the owner holds or watches at ANOTHER address
 * under that name (a lookalike added in Settings, one a snipe resolved, one
 * the Trencher found — none of them the reserve, all kept in the watch set on
 * purpose) could be neither bought nor sold by its owner, and every surface
 * answered with sentences ("I never sell it") that were false for that coin.
 * An order is resolved by ADDRESS:
 *
 *   'token'   — a watched token answers to the symbol and is not the reserve:
 *               traded like any other, buys and sells alike;
 *   'reserve' — the watched token IS a reserve address (the registry keeps it
 *               out, so this is defence in depth), or nothing watched answers
 *               and the symbol names the reserve: ENERGY_NOT_AN_ORDER;
 *   'unknown' — nothing watched answers, and it is not the reserve's name.
 *
 * The one way the reserve itself is bought is get-energy's marked order,
 * which never comes here (order-gate.ts orderRoute).
 */
export function resolveOrderToken(
  symbol: string,
  watch: readonly { symbol: string; address: string }[],
): { kind: "token"; address: `0x${string}`; symbol: string } | { kind: "reserve" } | { kind: "unknown" } {
  // THE NAME AS THE WATCH SET SPELLS IT, whatever case it was asked in. The
  // app's sell card and Telegram upper-case the symbol before it gets here,
  // and Settings keeps an owner-typed symbol as typed — so a watched
  // lookalike called "MerryMen" missed an exact match, fell through to the
  // reserve's name, and its owner was told "I never sell it" about a coin
  // they held. Folding case is safe: watchTokensFor keeps one token per
  // case-folded symbol. `symbol` comes back as the watch set spells it, which
  // is how the book stores the position the sell reads.
  const want = symbol.trim().replace(/^\$/, "").toUpperCase();
  const hit = watch.find((t) => t.symbol.toUpperCase() === want);
  if (hit) {
    return isEnergyReserveToken(hit.address)
      ? { kind: "reserve" }
      : { kind: "token", address: hit.address as `0x${string}`, symbol: hit.symbol };
  }
  return isEnergySymbol(symbol) ? { kind: "reserve" } : { kind: "unknown" };
}

/**
 * submitChatTrade's answer to an order for THE RESERVE — the Brain's, a
 * Telegram message's, a plain app buy or sell, anything that reaches the
 * ordinary order path and resolves to it (resolveOrderToken). It points to the
 * one way in (the app chat's get-energy, which asks first) and the way round
 * it; it never says "add it in /settings", which would not help.
 */
export const ENERGY_NOT_AN_ORDER =
  "$MERRYMEN is my energy, not something I trade — I never sell it, and I buy it only when you ask me to " +
  "\"get my energy\" in the Merrymen app chat, where you see the most it would spend and confirm before anything " +
  `moves. ${WAY_ROUND}`;

/** A get-energy order that arrived as a SELL. The key has no way to sell the reserve; recover moves it. */
export const ENERGY_NO_SELL =
  "My key can't sell $MERRYMEN — it's my energy, not a position, and nothing I do ever sells it. " +
  "`merrymen recover` with your owner key can move it if you need to.";

/** The account is not on Robinhood Chain: tokens sent to it there would not be this agent's. */
export const ENERGY_NOT_MAINNET =
  "My account is on another network, where $MERRYMEN doesn't count toward my energy and the route I'd buy it on " +
  "doesn't exist. Keep $MERRYMEN in your own wallet on Robinhood Chain instead — it counts the moment it lands.";

/** A mainnet grant signed without the energy route (GRANT_ENERGY). */
export const ENERGY_RESIGN =
  "My signed key has no route to buy my own energy yet — re-sign at /grant (revoking the old permissions requires network fees). " +
  `${WAY_ROUND}`;

/** Not trading live: the energy buy spends real USDG only on the live rail. `blocker` is liveBlockerText's clause. */
export function energyNeedsLiveLine(blocker: string | null): string {
  return (
    `I buy my own energy only while trading live, and I'm not${blocker ? `: ${blocker}` : ""}. ` +
    `Turn on Live trading, or send $MERRYMEN to my account on Robinhood Chain directly — it counts the moment it lands.`
  );
}

/** What each ceiling is, in the owner's words, for the sentence that names it. */
function bindingWhy(b: EnergyBinding, caps: EnergyCaps): string {
  switch (b) {
    case "owner":
      return "the most you set for this ask";
    case "per-trade":
      return `my key's per-trade cap of ${usdgText(caps.perTradeRaw)} USDG`;
    case "daily":
      return `what is left of today's ${usdgText(caps.dailyRaw)} USDG budget`;
    case "cash":
      return "the USDG in my account";
  }
}

/**
 * THE PLAN FOR ONE CONFIRMATION, or the sentence that says why there is none.
 *
 * Checked in this order, each a refusal before anything is sized:
 *   1. every balance read (either half, and the cash) — unread refuses;
 *   2. the ledger: an earlier energy buy still settling refuses (and a ledger
 *      that would not answer refuses too — a double buy is the cost of guessing);
 *   3. already full — nothing to buy, said as good news;
 *   4. the token's buy tax: unreadable, or above ENERGY.maxTaxBps, refuses;
 *   5. the day's trade count;
 *   6. the price of the shortfall (no quote refuses), every cap at once, and
 *      the smallest buy worth an operation;
 *   7. the accounting gate: whether spending this much would leave a book the
 *      ledger cannot tell apart from P&L, or trip the drawdown limit.
 */
export async function planEnergyBuy(
  reads: EnergyReads,
  caps: EnergyCaps,
  pricing: EnergyPricing,
  book: EnergyBook,
): Promise<EnergyPlan> {
  const refuse = (rule: EnergyPlanRule, line: string): EnergyPlan => ({ kind: "refuse", rule, line });

  // 1. READS. A half that failed is not a half that holds nothing.
  const unread: string[] = [];
  if (reads.holder === null) unread.push("your wallet's $MERRYMEN");
  if (reads.account === null) unread.push("my account's $MERRYMEN");
  if (reads.cashUsdg === null) unread.push("my USDG");
  if (unread.length > 0) {
    return refuse(
      "energy-unreadable",
      `I could not read ${unread.join(" or ")} just now, so I did not buy anything — that is a fact about my reads, ` +
        `not about your balance. Ask again in a minute.`,
    );
  }
  const cash = reads.cashUsdg as bigint;

  // 2. THE LEDGER. One buy at a time, on a reading that already includes the last.
  if (reads.inFlight === null) {
    return refuse(
      "energy-in-flight",
      "I could not read my own ledger to check for an energy buy still settling, so I did not start another. Ask again in a minute.",
    );
  }
  if (reads.inFlight) {
    return refuse(
      "energy-in-flight",
      "An earlier energy buy is still settling on the chain, so I did not start another — I won't buy twice on one reading. " +
        "Ask again once it shows in your trades.",
    );
  }

  // 3. ALREADY FULL.
  const held = (reads.holder ?? 0n) + (reads.account ?? 0n);
  if (held >= ENERGY_FULL_RAW) {
    return {
      kind: "full",
      heldRaw: held,
      line: `I already have full energy — ${tokens(held)} $MERRYMEN between your wallet and my account, and ${FULL} is full. Nothing bought.`,
    };
  }
  const shortRaw = ENERGY_FULL_RAW - held;

  // 4. THE TAX, read now. A floor built on a tax nobody read is not a floor.
  if (pricing.taxBps === null) {
    return refuse(
      "energy-tax-unreadable",
      `I could not read $MERRYMEN's own buy tax, so I could not set a safe floor and bought nothing. Ask again in a minute. ${WAY_ROUND}`,
    );
  }
  if (!Number.isInteger(pricing.taxBps) || pricing.taxBps < 0 || pricing.taxBps > ENERGY.maxTaxBps) {
    return refuse(
      "energy-tax",
      `$MERRYMEN's own buy tax is higher than my energy buy is built to accept, so I bought nothing. ${WAY_ROUND}`,
    );
  }
  const taxBps = pricing.taxBps;

  // 5. THE DAY'S TRADE COUNT.
  if (caps.opsRemaining <= 0) {
    return refuse(
      "ops-cap",
      `I've used all ${caps.maxOpsPerDay} of today's trades, so I did not buy — the count rolls 24 hours from the first. ${WAY_ROUND}`,
    );
  }

  // 6. THE PRICE OF THE SHORTFALL, then every cap at once.
  const gross = energyGrossFor(shortRaw, taxBps);
  const quoted = await pricing.amountInFor(gross);
  if (quoted === null || quoted <= 0n) {
    return refuse(
      "energy-no-quote",
      `The USDG → VIRTUAL → $MERRYMEN route would not quote that size just now, so I bought nothing. Ask again shortly. ${WAY_ROUND}`,
    );
  }
  const needInRaw = ceilCent(quoted);
  const dailyLeft = caps.dailyRaw > caps.spentTodayRaw ? caps.dailyRaw - caps.spentTodayRaw : 0n;
  // Ties go to the first named: the owner's own number is the one they can change.
  const ceilings: [EnergyBinding, bigint][] = [
    ["owner", floorCent(caps.ownerMaxRaw)],
    ["per-trade", floorCent(caps.perTradeRaw)],
    ["daily", floorCent(dailyLeft)],
    ["cash", floorCent(cash)],
  ];
  let [binding, cap] = ceilings[0]!;
  for (const [b, v] of ceilings) {
    if (v < cap) {
      binding = b;
      cap = v;
    }
  }

  // THE SMALLEST BUY WORTH AN OPERATION. A shortfall that costs less than it is
  // bought AT it — overshooting by under a dollar beats an agent that can never
  // be topped up the last few tokens. A ceiling below it refuses, by name.
  const minChunk = ENERGY.minChunkUsdg6;
  if (cap < minChunk) {
    const rule: EnergyPlanRule = binding === "cash" ? "no-cash" : binding === "daily" ? "daily-cap" : "energy-too-small";
    return refuse(
      rule,
      `The most I could spend right now is ${usdgText(cap)} USDG — ${bindingWhy(binding, caps)} — and the smallest ` +
        `energy buy I make is ${usdgText(minChunk)} USDG, so I bought nothing. ${WAY_ROUND}`,
    );
  }
  const wanted = energyAskFor(quoted);
  const amountInRaw = wanted <= cap ? wanted : cap;
  const coversShortfall = amountInRaw >= needInRaw;

  // HOW MANY MORE ASKS, at the per-ask ceiling (the owner's max and the key's
  // per-trade cap — the day's budget and the cash are not a property of an ask).
  const perAsk = [floorCent(caps.ownerMaxRaw), floorCent(caps.perTradeRaw)].reduce((a, b) => (b < a ? b : a));
  const rest = coversShortfall ? 0n : needInRaw - amountInRaw;
  const asksLeft = rest === 0n || perAsk <= 0n ? 0 : Number((rest + perAsk - 1n) / perAsk);

  // 7. THE ACCOUNTING GATE, on the size actually to be spent.
  const gate = energyPreTradeGate({
    paper: book.paper,
    equityKnown: book.equityKnown,
    equityUsdg: book.equityUsdg,
    spendUsdg: amountInRaw,
    netContributionsUsdg: book.netContributionsUsdg,
    lifetimePeakUsdg: book.lifetimePeakUsdg,
    breakerPeakUsdg: book.breakerPeakUsdg,
    maxDrawdownBps: book.maxDrawdownBps,
  });
  if (gate.action === "refuse") return refuse(gate.rule, `I did not buy: ${gate.why}.`);
  if (gate.action === "skip") {
    // Only a PAPER book with no live record skips — and the energy buy never
    // runs on paper. Reaching here means the two disagree; refuse, never book
    // a real purchase the ledger was told to skip.
    return refuse("no-contribution-record", `I did not buy: ${gate.why}.`);
  }

  return {
    kind: "buy",
    amountInRaw,
    shortRaw,
    heldRaw: held,
    needInRaw,
    coversShortfall,
    binding: coversShortfall ? null : binding,
    asksLeft,
    taxBps,
  };
}

/** The plan in one line, for the log and the decision row. Never shown as a result. */
export function sayEnergyPlan(plan: EnergyPlan): string {
  if (plan.kind !== "buy") return plan.line;
  return (
    `energy buy: spend ${usdgText(plan.amountInRaw)} USDG of ${usdgText(plan.needInRaw)} needed for ` +
    `${tokens(plan.shortRaw)} $MERRYMEN short` +
    (plan.coversShortfall ? "" : ` (${plan.binding ?? "cap"} binds; ≈${plan.asksLeft} more ask${plan.asksLeft === 1 ? "" : "s"})`)
  );
}

/** "≈2 more asks like this one" — or nothing when there is nothing left to ask for. */
function asksText(n: number): string {
  if (n <= 0) return "";
  return ` That's about ${n} more ask${n === 1 ? "" : "s"} like this one.`;
}

/**
 * WHAT THE OWNER IS TOLD, read off the LEDGER ROW the buy wrote — never off the
 * plan's hopes. "Bought" is said only for a row the chain landed; anything
 * short of that is "placed", "refused" or "turned back", in those words.
 *
 * `heldAfter` is the combined balance re-read at the landing block (null when
 * that read failed — then the sentence says it could not re-read, and never
 * guesses from the plan).
 */
export function sayEnergyOutcome(
  outcome: LedgerFacts | null,
  plan: Extract<EnergyPlan, { kind: "buy" }>,
  heldAfter: bigint | null,
): { ok: boolean; line: string } {
  const planned = `${usdgText(plan.amountInRaw)} USDG`;
  if (!outcome) {
    return { ok: false, line: "🤔 the energy buy never reached my ledger. Nothing was sent; ask again." };
  }
  switch (outcome.status) {
    case "landed": {
      const spent =
        typeof outcome.amountUsdg === "number" && Number.isFinite(outcome.amountUsdg) && outcome.amountUsdg > 0
          ? `${outcome.amountUsdg.toFixed(2)} USDG`
          : planned;
      const head = `✅ bought energy — ${spent} of my USDG went into $${MERRYMEN_TOKEN.symbol} in my account.`;
      if (heldAfter === null) {
        return { ok: true, line: `${head} I couldn't re-read the balance just now; it will show on my next check.` };
      }
      if (heldAfter >= ENERGY_FULL_RAW) {
        return { ok: true, line: `${head} That's full energy — ${tokens(heldAfter)} between your wallet and my account.` };
      }
      return {
        ok: true,
        line:
          `${head} Still ${tokens(ENERGY_FULL_RAW - heldAfter)} short of ${FULL} between your wallet and my account.` +
          asksText(Math.max(plan.asksLeft, 1)),
      };
    }
    case "submitted":
      return {
        ok: true,
        line:
          `🏹 placed the energy buy (${planned}) — it is in flight, and I'll know once the chain answers. ` +
          "I won't start another until it settles.",
      };
    case "reverted":
      return {
        ok: false,
        line:
          `↩️ the energy buy reached the chain and turned back${outcome.rejectRule ? ` — ${outcome.rejectRule}` : ""}. ` +
          "No USDG moved, but the gas is spent.",
      };
    case "paper":
      return { ok: false, line: "📝 not bought — that was simulated, and your money did not move." };
    case "dropped":
      // Written only by the stranded-op resolver, never by the buy itself —
      // said truthfully in case that ever changes: it was sent, not refused.
      return { ok: false, line: "↩️ the energy buy was dropped before it reached the chain. No USDG moved and no gas was spent." };
    default: {
      const label = rejectRuleLabel(outcome.rejectRule);
      const remedy = rejectRuleRemedy(outcome.rejectRule);
      const slug = outcome.rejectRule ?? outcome.status;
      return {
        ok: false,
        line: label
          ? `🧱 refused: ${label}.${remedy ? ` ${remedy}` : ""} Nothing was sent and nothing was spent. (${slug})`
          : `🧱 refused. Nothing was sent and nothing was spent. (${slug})`,
      };
    }
  }
}
