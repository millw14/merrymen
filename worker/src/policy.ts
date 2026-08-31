/**
 * Deterministic policy layer — and its posture DEPENDS ON THE RAIL, which is
 * the single most important thing to understand about this file.
 *
 * ON THE EVM RAIL (swap / vault / transfer) it is a MIRROR of the on-chain
 * Kernel session-key policies: the on-chain caps are the hard wall; this layer
 * exists to reject bad intents cheaply and log WHY, before gas is spent. If
 * this code and the on-chain policy ever disagree, the on-chain policy wins
 * and that divergence is a bug to alert on. A mirror must never be stricter
 * than the chain — a stricter mirror rejects trades the wall would allow.
 *
 * ON THE BROKER RAIL (equity-order) there is NO on-chain policy to mirror.
 * Robinhood's Agentic account is custodial, its OAuth scope cannot be
 * restricted below full trading, and nothing re-checks amounts after this
 * function returns ok — so here this layer IS the wall, and the posture
 * inverts: deliberately conservative, because there is no backstop to defer
 * to. The only enforcement beneath it is Robinhood's own account-level
 * reserved budget. This is why processIntent runs checkPolicy TWICE on that
 * rail — once on the proposed notional and again on the terms review()
 * returns — where the EVM rail relies on the account contract for the
 * re-check. (spikes/robinhood-mcp/DESIGN.md §5.)
 *
 * Nothing in this file may call an LLM, read agent memory, or take a string that
 * originated from a model. Intents come in typed; verdicts go out typed.
 */

import { scoutAllows, type ScoutLimits } from "./quarantine";

export interface AgentLimits {
  /** USDG (6dp) ceiling for a single trade. */
  perTradeUsdg: bigint;
  /** USDG (6dp) ceiling summed over a rolling 24h window. */
  dailyUsdg: bigint;
  /** Allowed target contracts (Rialto router via registry, Morpho vault, tokens for approvals). */
  allowedTargets: readonly `0x${string}`[];
  /** Allowed token addresses the agent may hold or trade. */
  allowedAssets: readonly `0x${string}`[];
  /**
   * Token addresses the SIGNED KEY can actually approve for a sell — i.e. what
   * it can get back OUT of. Distinct from allowedAssets, which is only what the
   * owner pointed the agent at.
   *
   * These diverge for a real and previously costly reason: approving USDG is a
   * single generic permission, so a BUY works for any token with a pool, while
   * a SELL needs a per-token approve baked into the signature at signing time.
   * A token in the first set but not the second is a one-way door.
   *
   * Undefined disables the check — for callers (backtests, fixtures) that have
   * no grant to reason about. Never leave it undefined on a live path.
   */
  sellableAssets?: readonly string[];
  /**
   * Curve addresses this agent has SEEN LAUNCH, from a factory-filtered scan.
   *
   * The curve is the one argument the wall cannot pin -- a new address per
   * token, hundreds an hour -- so wall.ts passes `null` for it and says so
   * outright. That makes this the only place a curve can be constrained at all.
   *
   * What made a curve trustworthy before this was INCIDENTAL: the launch scan
   * happens to filter on PONS_V2_FACTORY (pons.ts) and discovery copies the
   * value through. Any future producer that sourced a curve from somewhere else
   * -- an LLM proposal, a chat message, a poisoned tape -- would silently lose
   * that property, and nothing would have noticed.
   *
   * Optional, like sellableAssets, for fixtures. Absent means the rule cannot
   * run; it must never mean the rule passed.
   */
  knownCurves?: readonly string[];
  /**
   * The QUOTE side of the book: USDG and the tradeable stock tokens.
   *
   * `builtinGrantTargets(grant)` -- deliberately NOT sellableAssets, which also
   * contains the owner's added extras and therefore the launched memecoins. The
   * two lists differ by exactly the tokens a curve trade might be ENTERING, so
   * using the wrong one turns the drawdown breaker's exit exemption into a
   * blanket exemption for the venue.
   *
   * Optional for fixtures. Absent means the exit test falls back to cashToken
   * alone -- narrower, which is the safe direction for an exemption.
   */
  quoteAssets?: readonly string[];
  /**
   * Tickers the agent may trade on the brokerage rail — the broker analog of
   * allowedAssets, since an equity order has no address for that list to
   * check. Optional for fixtures only (the sellableAssets rule); on a live
   * broker path this IS the asset wall, so never leave it undefined there.
   */
  allowedTickers?: readonly string[];
  /**
   * Addresses this grant's wall permits USDG transfers to, mirroring the
   * on-chain ONE_OF pin. An EMPTY array means the wall has no transfer
   * permission at all; UNDEFINED means the grant predates the allowlist and
   * still carries the old free-form permission — the two are different, and
   * conflating them would make this mirror stricter than the chain.
   */
  withdrawalAddresses?: readonly string[];
  /**
   * The cash token (USDG). Passed in rather than imported so this file stays
   * free of the token registry — it is a judge, not a market participant.
   *
   * Used to recognise a de-risking SELL: a swap whose buy side is cash is money
   * coming home, and the drawdown breaker must never block that. Undefined
   * disables that recognition, so a fixture without it keeps the old, stricter
   * behaviour rather than silently widening.
   */
  cashToken?: string;
  /** Drawdown (bps from high-water mark) at which the breaker pauses the agent. */
  maxDrawdownBps: number;
  /** Unix seconds after which the session key is dead regardless of anything. */
  expiresAt: number;
  /** Ops ceiling per rolling 24h — mirrors the on-chain rate-limit policy. */
  maxOpsPerDay: number;
}

export type TradeIntent = {
  /**
   * Opaque link to the `decisions` row that produced this intent — set upstream
   * (strategist / chat / tick fallback), stamped onto the trade for attribution.
   * checkPolicy MUST ignore it: this stays a numbers-only decision. It is NOT the
   * model's reason (that free text lives only in the decisions table, never here),
   * so the policy-purity rule above is preserved.
   */
  decisionId?: string;
} & ({
  kind: "swap";
  target: `0x${string}`;
  sellToken: `0x${string}`;
  buyToken: `0x${string}`;
  /** Raw units of sellToken (USDG = 6dp, stock tokens = 18dp) — what executes. */
  sellAmountRaw: bigint;
  /** USDG-equivalent size (6dp) — what the caps judge. */
  notionalUsdg: bigint;
} | {
  kind: "vault-deposit" | "vault-withdraw";
  target: `0x${string}`;
  amountUsdg: bigint;
} | {
  /**
   * USDG leaving the wall to an external recipient (chat /transfer, confirmed).
   * target is the USDG token contract; the recipient is free-form but the
   * amount is capped on-chain by the grant's transfer permission and here by
   * the same per-trade/daily caps as any spend.
   */
  kind: "transfer";
  target: `0x${string}`;
  recipient: `0x${string}`;
  amountUsdg: bigint;
} | {
  /**
   * A brokerage equity order (the Robinhood venue). NO ADDRESS FIELDS on
   * purpose: there is no contract to target and no calldata to build, and
   * omitting `target` means the compiler forces every consumer that assumes an
   * EVM shape to decide what an equity order means to it — nothing falls
   * through an else-branch built for chains.
   */
  kind: "equity-order";
  /** Uppercase ticker as the broker knows it (AAPL), never an address. */
  ticker: string;
  side: "buy" | "sell";
  /** USD notional, 6dp — same unit as USDG, judged by the same caps. */
  notionalUsdg: bigint;
} | {
  /**
   * A trade on a Pons bonding curve, through the PonsSelfTrade adapter.
   *
   * ITS OWN KIND rather than a `swap`, for a reason that is about safety and
   * not tidiness. A curve has no fee tier, no path and no PoolKey, so it does
   * not fit the Quote that `swap` dispatches on — and forcing it through would
   * mean either inventing a sentinel for the native side or having
   * `asset-allowlist` reject the venue outright, which is a mirror STRICTER
   * than the chain. A distinct kind also makes the compiler ask every consumer
   * what a curve trade means to it, the same reasoning that leaves
   * `equity-order` without a `target`.
   *
   * `target` IS here, and it is the ADAPTER — never the curve. The curve is a
   * call argument the wall cannot pin (a new address per token, ~475 an hour),
   * so `target-allowlist` covers the one address that IS pinned, unchanged.
   */
  kind: "curve-trade";
  /** The PonsSelfTrade adapter. What the wall pinned and what gets called. */
  target: `0x${string}`;
  /** The bonding curve. An argument, vouched for by nobody — see wall.ts. */
  curve: `0x${string}`;
  assetIn: `0x${string}`;
  assetOut: `0x${string}`;
  /** Raw units of assetIn — what executes. */
  amountInRaw: bigint;
  /**
   * Slippage floor in assetOut units, from the SAME quote that sized this
   * intent. Carried on the intent rather than recomputed at execution time so
   * the number the trade is judged against and the number the chain enforces
   * cannot come from two different readings of a curve that moves 1,546 bps at
   * p99 over four minutes.
   *
   * checkPolicy ignores it, like every other execution detail here.
   */
  minAmountOutRaw: bigint;
  /** USDG-equivalent size (6dp) — what the caps judge. */
  notionalUsdg: bigint;
});

export type Verdict =
  | { ok: true }
  | { ok: false; rule: string; detail: string };

export interface AgentState {
  spentTodayUsdg: bigint;
  /** Executed operations in the trailing 24h — mirrors the on-chain rate limit. */
  opsToday: number;
  highWaterMarkUsdg: bigint;
  equityUsdg: bigint;
  /**
   * Is `equityUsdg` the WHOLE book? False when a held asset couldn't be valued
   * this tick, in which case the figure is a partial sum — lower than reality,
   * not equal to it.
   *
   * The drawdown rule must not run on a partial total. Doing so reads the
   * missing asset as a loss and rejects every intent, INCLUDING the sell that
   * would clear the position — the agent locks itself in precisely when the
   * owner most needs it to act. Absent = true, so existing callers keep today's
   * behaviour; only a caller that KNOWS the book is short passes false.
   */
  equityKnown?: boolean;
  nowSec: number;
}

/**
 * Everything the scout ceiling needs, supplied BY THE CALLER, never by the intent.
 *
 * That separation is the point. Intents come from strategies, including
 * user-written ones in ~/.merrymen/strategies, so a flag carried on the intent
 * saying "this token is priceable" would be a flag a strategy could simply set —
 * and the budget on unpriceable positions would be bypassable by the very code
 * it exists to bound. Only the tick knows what it managed to price, so only the
 * tick gets to say.
 *
 * Absent = no scout gating, matching the behaviour before scout mode existed.
 * That is right for backtests and fixtures, which have no live price map. NEVER
 * leave it absent on a live path: an unpriceable buy would then be limited only
 * by the per-trade cap, which is exactly the hole this closes.
 */
export interface ScoutContext {
  limits: ScoutLimits;
  /** Did the tick fail to price the token being BOUGHT this cycle? */
  buyUnpriceable: boolean;
  /** USDG (6dp) already sunk into that same token. */
  existingCostUsdg: bigint;
  /** USDG (6dp) total across every unpriceable position held. */
  quarantinedUsdg: bigint;
}

export function checkPolicy(
  intent: TradeIntent,
  limits: AgentLimits,
  state: AgentState,
  scout?: ScoutContext,
): Verdict {
  if (state.nowSec >= limits.expiresAt) {
    return { ok: false, rule: "expiry", detail: "session key expired" };
  }

  const lc = (a: string) => a.toLowerCase();
  // Equity orders have no contract target — their allowlist is tickers, below.
  if (intent.kind !== "equity-order" && !limits.allowedTargets.map(lc).includes(lc(intent.target))) {
    return { ok: false, rule: "target-allowlist", detail: `target ${intent.target} not allowed` };
  }

  if (intent.kind === "equity-order") {
    if (intent.notionalUsdg <= 0n) {
      return { ok: false, rule: "order-amount", detail: "order notional must be positive" };
    }
    // Ticker allowlist — the broker rail's analog of allowedAssets. Optional
    // for the same reason sellableAssets is (backtests and fixtures have no
    // grant to reason about); NEVER leave it undefined on a live broker path.
    // Step 4 of the adapter plan makes it a first-class part of the retyped
    // limits — until then this is the whole asset wall on this rail.
    if (limits.allowedTickers) {
      const up = intent.ticker.toUpperCase();
      if (!limits.allowedTickers.some((t) => t.toUpperCase() === up)) {
        return { ok: false, rule: "ticker-allowlist", detail: `ticker ${intent.ticker} not allowed` };
      }
    }
  }

  // ── curve trades ────────────────────────────────────────────────────────
  //
  // THIS BLOCK EXISTS BECAUSE THE MIRROR WAS LOOSER THAN THE CHAIN.
  //
  // Every asset rule below used to sit inside `if (intent.kind === "swap")`,
  // so a curve trade reached the bundler having passed no asset check at all.
  // The chain would still refuse it -- wall.ts pins both legs ONE_OF the
  // sealed list -- but limits.ts:27-41 records that the mirror going LOOSER
  // than the chain is the one direction that is never safe, and the cost of
  // discovering it on chain is a wasted UserOp and a `gas-unreadable` refusal
  // that names nothing.
  //
  // GATED ON sellableAssets, NOT allowedAssets, and the distinction is the
  // whole point. allowedAssets is [USDG, ...watchTokens] and watchTokens comes
  // from SETTINGS (limits.ts:78), which hot-reload with no signature.
  // sellableAssets comes from the GRANT (grant.ts:344), which is what the wall
  // actually sealed. Checking the settings-derived list here would reproduce
  // exactly the bug this block is closing: an owner adds a token in /settings,
  // does not re-sign, and gets a curve buy that passes every off-chain check
  // and reverts at the wall.
  if (intent.kind === "curve-trade") {
    // Positivity. equity-order has one of these; curve-trade did not, so a zero
    // or negative size would sail through every cap below (they are all upper
    // bounds) and be signed.
    if (intent.amountInRaw <= 0n || intent.notionalUsdg <= 0n) {
      return {
        ok: false,
        rule: "non-positive",
        detail: `curve trade sized ${intent.amountInRaw} raw / ${intent.notionalUsdg} USDG is not a trade`,
      };
    }

    if (limits.sellableAssets) {
      const sellable = limits.sellableAssets.map(lc);
      for (const token of [intent.assetIn, intent.assetOut]) {
        if (!sellable.includes(lc(token))) {
          return {
            ok: false,
            rule: "asset-allowlist",
            detail:
              `asset ${token} is not in the signed grant, so the wall will refuse this trade. ` +
              `Add it at /settings and re-sign the grant at /grant to cover it.`,
          };
        }
      }
    }

    // CURVE PROVENANCE. `intent.target` is the adapter and is covered by the
    // target allowlist above; `intent.curve` is covered by nothing, on chain or
    // off. This turns the incidental factory-filter property into an enforced
    // one, before any producer exists that could source a curve elsewhere.
    if (limits.knownCurves) {
      if (!limits.knownCurves.map(lc).includes(lc(intent.curve))) {
        return {
          ok: false,
          rule: "curve-provenance",
          detail:
            `curve ${intent.curve} was not seen in a factory-filtered launch, so nothing vouches ` +
            `for it being a Pons curve at all. The wall cannot pin this argument, which is exactly ` +
            `why it is checked here.`,
        };
      }
    }
  }

  if (intent.kind === "swap") {
    for (const token of [intent.sellToken, intent.buyToken]) {
      if (!limits.allowedAssets.map(lc).includes(lc(token))) {
        return { ok: false, rule: "asset-allowlist", detail: `asset ${token} not allowed` };
      }
    }

    // NEVER ENTER A POSITION THE KEY CANNOT EXIT.
    //
    // Buying spends USDG, which every grant can approve generically; selling
    // needs a per-token approve sealed into the signature. So a token with a
    // live pool but no approve permission buys fine and can never be sold —
    // the exit reverts at the wall, and no cap or breaker helps, because the
    // owner's money is in an asset the agent has no way to give back.
    //
    // This is checked here rather than left to the on-chain policy on purpose:
    // on-chain, the failure lands on the SELL, long after the buy succeeded and
    // the position exists. Refusing the buy is the only moment it's still free.
    //
    // Sells are never blocked by this rule — an exit must always be attemptable.
    if (limits.sellableAssets) {
      const sellable = limits.sellableAssets.map(lc);
      if (!sellable.includes(lc(intent.buyToken))) {
        return {
          ok: false,
          rule: "no-exit",
          detail:
            `refusing to buy ${intent.buyToken}: this key can't approve it for a sell, ` +
            `so the position could be opened and never closed. Re-sign the grant at /grant to cover it.`,
        };
      }
    }

    // BUYING SOMETHING NOBODY CAN PRICE.
    //
    // A token the tick couldn't value is one whose worth is genuinely unknown:
    // its pool is too new or too thin for a TWAP anyone should trust. The
    // drawdown breaker cannot protect that money, because protecting it would
    // mean believing the price it just refused. So the scout BUDGET is the only
    // control there is, and it has to bite here — before the position exists.
    //
    // Sells are untouched: this whole branch only ever inspects buyToken, so
    // getting OUT of an unpriceable position is never blocked by it.
    if (scout?.buyUnpriceable) {
      const verdict = scoutAllows(
        {
          spendUsdg: intent.notionalUsdg,
          existingCostUsdg: scout.existingCostUsdg,
          quarantinedUsdg: scout.quarantinedUsdg,
        },
        scout.limits,
      );
      if (!verdict.ok) return { ok: false, rule: "scout-budget", detail: verdict.reason };
    }
  }

  if (intent.kind === "transfer") {
    // Must at least be a plausible address — garbage never reaches calldata.
    if (!/^0x[0-9a-fA-F]{40}$/.test(intent.recipient)) {
      return { ok: false, rule: "transfer-recipient", detail: `recipient ${intent.recipient} is not an address` };
    }
    // MIRROR of the on-chain withdrawal allowlist. The wall now pins the USDG
    // transfer recipient to the addresses the owner registered at signing, and
    // carries no transfer permission at all when none were. Checking it here
    // too costs nothing and turns an opaque on-chain revert into a sentence
    // that says what to do — the same reason the rest of this file exists.
    //
    // Undefined means "this grant predates the allowlist", NOT "allow
    // anything": such a grant genuinely has the old free-form permission, and
    // a mirror stricter than the chain would reject trades the wall permits.
    if (limits.withdrawalAddresses) {
      if (limits.withdrawalAddresses.length === 0) {
        return {
          ok: false,
          rule: "transfer-not-permitted",
          detail:
            "this wall carries no transfer permission — no withdrawal addresses were registered when it was signed. " +
            "Re-sign the grant with a destination, or move funds with your owner key (`merrymen recover`).",
        };
      }
      const to = intent.recipient.toLowerCase();
      if (!limits.withdrawalAddresses.some((a) => a.toLowerCase() === to)) {
        return {
          ok: false,
          rule: "transfer-recipient-allowlist",
          detail: `${intent.recipient} is not one of the registered withdrawal addresses on this wall`,
        };
      }
    }
    if (intent.amountUsdg <= 0n) {
      return { ok: false, rule: "transfer-amount", detail: "transfer amount must be positive" };
    }
  }

  if (state.opsToday >= limits.maxOpsPerDay) {
    return { ok: false, rule: "ops-cap", detail: `${state.opsToday} ops in 24h >= ${limits.maxOpsPerDay}` };
  }

  // Per-op size ceiling — mirrors the on-chain call policy EXACTLY, because a
  // stricter mirror rejects trades the chain would happily allow (a real bug per
  // this file's contract). On-chain (web/src/lib/session.ts):
  //   • swaps & transfers  → approve/transfer USDG capped at the PER-TRADE limit
  //   • vault deposits      → capped at the DAILY limit (parking idle cash in the
  //                           Morpho vault isn't a market spend; it's reversible)
  //   • vault withdrawals   → unsized (funds return to the account)
  // The old mirror capped deposits at the per-trade limit, so a large idle-cash
  // sweep (e.g. 80 USDG with a 30-USDG per-trade cap) was rejected every tick
  // while the chain would have accepted it.
  if (intent.kind !== "vault-withdraw") {
    // Equity orders count on BOTH sides, like swaps: a sell is still an op and
    // still market exposure, and on this rail these caps are the only wall.
    const notional =
      intent.kind === "swap" || intent.kind === "equity-order" || intent.kind === "curve-trade"
        ? intent.notionalUsdg
        : intent.amountUsdg;
    const isDeposit = intent.kind === "vault-deposit";
    const perOpCap = isDeposit ? limits.dailyUsdg : limits.perTradeUsdg;
    if (notional > perOpCap) {
      return {
        ok: false,
        rule: isDeposit ? "deposit-cap" : "per-trade-cap",
        detail: `${notional} > ${perOpCap}`,
      };
    }
    if (state.spentTodayUsdg + notional > limits.dailyUsdg) {
      return { ok: false, rule: "daily-cap", detail: `would exceed daily cap ${limits.dailyUsdg}` };
    }
  }

  // AN EXIT MUST ALWAYS BE ATTEMPTABLE.
  //
  // The breaker is a brake on taking RISK, not a lock on the doors. Applied to
  // every kind, it rejected the sell that would clear the position, the vault
  // withdrawal that would pull cash back, and the transfer that would send
  // money home — while the high-water mark only ever ratchets up, so nothing
  // the agent could do would clear it. The account was locked in a losing
  // position until a human re-signed a looser grant or swept it with the owner
  // key, and the perverse escape the code actually offered was to DEPOSIT MORE
  // (which lifts the mark and shrinks the ratio).
  //
  // So the same shape `no-exit` already uses: judge the direction of travel by
  // what is being BOUGHT. Money coming home is never blocked.
  //   • vault-withdraw → cash returning from Morpho to the account
  //   • transfer       → to a recipient the wall already pinned at signing
  //   • swap into USDG → the de-risking sell itself
  // Buys stay blocked, which is the entire point of the breaker.
  const isExit =
    intent.kind === "vault-withdraw" ||
    intent.kind === "transfer" ||
    (intent.kind === "swap" &&
      limits.cashToken !== undefined &&
      lc(intent.buyToken) === lc(limits.cashToken)) ||
    (intent.kind === "equity-order" && intent.side === "sell") ||
    // A curve trade INTO cash is a de-risking exit, judged exactly as a swap
    // into cash is. Leaving it out would have the breaker block the one
    // direction it should never block — getting out of a memecoin — while a
    // drawdown is in progress, which is precisely when it matters most.
    // ANY curve trade out of the token and back into something the grant can
    // sell is an exit, not just one into cash. 42.8% of curves are quoted in a
    // stock token, so the cashToken-only test blocked the exit for nearly half
    // the venue during a drawdown -- the exact lock-in the comment above says
    // it prevents, for the positions most likely to be causing the drawdown.
    // ANY curve trade back into the QUOTE side is an exit, not just one into
    // cash. 42.8% of curves are quoted in a stock token, so a cashToken-only
    // test blocked the exit for nearly half the venue during a drawdown --
    // the exact lock-in the comment above says it prevents, for the positions
    // most likely to be causing the drawdown.
    //
    // QUOTE SIDE, NOT sellableAssets. The wall pins BOTH legs ONE_OF the same
    // sealed list, so `assetOut is sellable` is true of every curve trade ever
    // built, including buys -- testing it would mark the whole venue exempt and
    // switch the breaker off exactly where the risk is highest. The real
    // discriminator is that sellableAssets = builtinGrantTargets u grantTokens
    // (grant.ts:344): the launched memecoin arrives as an owner-added EXTRA,
    // while USDG and the tradeable stock tokens are BUILT IN. So trading out
    // into a builtin is an exit and trading out into an extra is an entry.
    (intent.kind === "curve-trade" &&
      ((limits.cashToken !== undefined && lc(intent.assetOut) === lc(limits.cashToken)) ||
        (limits.quoteAssets !== undefined && limits.quoteAssets.map(lc).includes(lc(intent.assetOut)))));

  if (!isExit && state.highWaterMarkUsdg > 0n && state.equityKnown !== false) {
    const drawdownBps = Number(
      ((state.highWaterMarkUsdg - state.equityUsdg) * 10_000n) / state.highWaterMarkUsdg,
    );
    if (drawdownBps >= limits.maxDrawdownBps) {
      return { ok: false, rule: "drawdown-breaker", detail: `${drawdownBps}bps >= ${limits.maxDrawdownBps}bps` };
    }
  }

  return { ok: true };
}
