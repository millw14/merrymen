/**
 * Strategy registry — one armed agent runs one named strategy. All knobs come
 * in as resolved settings (web UI > env > default); nothing in here reads the
 * environment, so the worker can rebuild a strategy mid-run when the user
 * changes settings.
 */

import { CASH, MORPHO, STOCK_TOKENS, isHostedMode, type StockToken } from "../../../packages/core/src/index";
import type { LlmCreds } from "../llm";
import { createDriver, nullDriver } from "../strategist/driver";
import { makeLlmStrategist, type StrategistDecision } from "../strategist/strategy";
import { makeCustomStrategy } from "./custom";
import { steadyBasketTick, type SteadyBasketConfig } from "./steady-basket";
import { weekendGapTick, type WeekendGapConfig } from "./weekend-gap";
import { evenKeelTick, type EvenKeelConfig } from "./even-keel";
import { makeDipHunter, type DipHunterConfig } from "./dip-hunter";
import { makeTrencher, TRENCHER_DEFAULTS, type Candidate, type OpenPosition } from "./trencher";
import type { Strategy } from "./types";

/** Free, open strategies — available to everyone. */
const FREE_STRATEGIES = ["steady-basket", "weekend-gap", "llm-strategist", "trencher"] as const;
/** Merry Circle strategies — buildable and selectable, but only RUN for holders
 * (Merry Man tier and up). The worker gates them at tick time by holder tier. */
export const CIRCLE_STRATEGIES = ["even-keel", "dip-hunter"] as const;
export const BUILTIN_STRATEGIES = [...FREE_STRATEGIES, ...CIRCLE_STRATEGIES] as const;
export type BuiltinStrategyName = (typeof BUILTIN_STRATEGIES)[number];

/** Is this a holder-only (Merry Circle) strategy? */
export function isCircleStrategy(name: string): boolean {
  return (CIRCLE_STRATEGIES as readonly string[]).includes(name);
}

export interface StrategyBuildOpts {
  /**
   * The bonding-curve legs available right now, re-read per decision.
   *
   * Supplied by the host (the worker tick), because a curve leg carries THIS
   * TICK’S reserves — the input a slippage floor is derived from. Optional, so
   * a host that does not trade curves is unchanged.
   */
  curveLegsNow?: () => {
    legs: ReadonlyMap<string, import("../strategist/proposals").CurveLeg>;
    tokens: ReadonlyMap<string, `0x${string}`>;
    slippageBps: number;
  } | null;
  swapRouter: `0x${string}`;
  usdg6: (v: number) => bigint;
  basketSymbols: string[];
  /**
   * Every token the worker watches — registry basket plus owner-added ones.
   * Legs are resolved against this, so a memecoin the owner selected is a
   * tradable leg rather than something the agent can only stare at. Omitted
   * (tests, fixtures) falls back to the shipped registry, i.e. old behaviour.
   */
  universe?: readonly StockToken[];
  buyPerTickUsdg: number;
  idleFloorUsdg: number;
  gapEnterBudgetUsdg: number;
  llm: {
    creds: LlmCreds | null;
    intervalMin: number;
    maxActionUsdg: number;
    /** Persist each strategist decision (survivor + drop) — see makeLlmStrategist. */
    onDecision?: (d: StrategistDecision) => void | Promise<void>;
  };
  onNote?: (level: "ok" | "warn", message: string) => void;
  /**
   * Everything the trencher needs, supplied by the tick. Absent = the strategy
   * still builds but sees no candidates and no open positions, so it proposes
   * nothing — an honest no-op rather than a crash, which is what a backtest or
   * a fixture should get.
   */
  trench?: {
    usdgToken: `0x${string}`;
    candidates: () => readonly Candidate[] | Promise<readonly Candidate[]>;
    open: () => readonly OpenPosition[] | Promise<readonly OpenPosition[]>;
    liquidityOf: (token: `0x${string}`) => number | null;
    unpriceable?: () => ReadonlySet<string>;
  };
}

/** Registry tokens for the chosen symbols — unknown symbols are ignored. */
export function tokensForSymbols(symbols: readonly string[]): StockToken[] {
  return STOCK_TOKENS.filter((t) => symbols.includes(t.symbol));
}

/**
 * The full set the worker watches: the curated basket, plus whatever the owner
 * added themselves.
 *
 * Owner-added entries become `kind: "memecoin"` with `chainlinkFeed: null`, which
 * is what routes them to pool pricing and keeps them out of every code path that
 * assumes an issuer-backed Stock Token (ERC-8056 multipliers, pause reads, feed
 * staleness). They carry their real `decimals`, because the asset model divides
 * by 10^decimals and 18 is a guess that silently misvalues a 9dp coin.
 *
 * Registry entries WIN on collision. A curated token has a verified address and a
 * feed; letting a settings entry shadow it would let a typo'd or hostile address
 * take over a real symbol — and the basket would keep naming it as if nothing
 * had changed.
 */
export function watchTokensFor(
  basketSymbols: readonly string[],
  customTokens: readonly { symbol: string; address: `0x${string}`; decimals: number }[],
): StockToken[] {
  const basket = tokensForSymbols(basketSymbols);
  const takenSymbols = new Set(STOCK_TOKENS.map((t) => t.symbol.toUpperCase()));
  const takenAddresses = new Set(basket.map((t) => t.address.toLowerCase()));
  const extras: StockToken[] = [];
  for (const c of customTokens) {
    if (takenSymbols.has(c.symbol.toUpperCase())) continue;
    if (takenAddresses.has(c.address.toLowerCase())) continue;
    takenSymbols.add(c.symbol.toUpperCase());
    takenAddresses.add(c.address.toLowerCase());
    extras.push({
      symbol: c.symbol,
      name: c.symbol,
      address: c.address,
      chainlinkFeed: null,
      kind: "memecoin",
      decimals: c.decimals,
    });
  }
  return [...basket, ...extras];
}

/**
 * The legs a strategy trades: the owner's selected symbols, resolved against the
 * FULL watch set rather than the shipped registry.
 *
 * Resolving from STOCK_TOKENS alone is why an owner-added memecoin could be
 * watched, priced and valued and then never traded by anything — it was in the
 * watch set but could not become a leg, so no strategy ever saw it.
 *
 * Selection stays explicit and stays the owner's: adding a token in settings
 * means "know about this", putting its symbol in the basket means "trade it".
 * Exactly how stock tokens already work, and deliberately NOT automatic — a
 * token added to be tracked must not start being bought on its own.
 */
export function legsForUniverse(symbols: readonly string[], universe?: readonly StockToken[]) {
  const pool = universe ?? STOCK_TOKENS;
  const chosen = pool.filter((t) => symbols.includes(t.symbol));
  return chosen.map((t) => ({
    symbol: t.symbol,
    token: t.address,
    weightBps: Math.floor(10_000 / chosen.length),
  }));
}

export function buildStrategy(name: string, opts: StrategyBuildOpts): Strategy {
  const legsFor = (symbols: readonly string[]) =>
    legsForUniverse(symbols, opts.universe);
  // Not a builtin → a user-written strategy file in strategies/ (lazy-loaded,
  // hot-reloading, crash-isolated; every intent is shape-validated and then
  // policy-checked like any other).
  if (!(BUILTIN_STRATEGIES as readonly string[]).includes(name)) {
    if (isHostedMode()) {
      // FAIL CLOSED on hosted. A non-builtin name makes makeCustomStrategy
      // dynamic-import() and EXECUTE a file from the tenant's home, in the
      // process that holds every tenant's session key — arbitrary code
      // execution. The intent validator constrains the return VALUE, never the
      // module body, which runs at import. So we refuse to load it and fall
      // through to the safe builtin (steady-basket) below rather than run tenant
      // code — never throw, which would crash the child at boot. The settings
      // route rejects the name at write time too; this is the loader half of the
      // gate, the boundary that actually executes.
      opts.onNote?.("warn", `custom strategy "${name}" is disabled on hosted merrymen — running steady-basket instead`);
    } else {
      return makeCustomStrategy(name, { onNote: opts.onNote });
    }
  }
  if (name === "llm-strategist") {
    // LLM proposes; deterministic code disposes. Without a key, the null
    // driver proposes nothing — the worker still runs, honestly idle.
    const driver = opts.llm.creds ? createDriver(opts.llm.creds) : nullDriver;
    if (driver === nullDriver) {
      console.log("[strategist] no AI provider key set — llm-strategist runs with the null driver (no trades). Pick a provider in Settings.");
    }
    return makeLlmStrategist({
      driver,
      universe: {
        legs: new Map(legsFor(opts.basketSymbols).map((l) => [l.symbol, l.token])),
        swapRouter: opts.swapRouter,
        usdg: CASH.USDG as `0x${string}`,
        maxPerActionUsdg: opts.usdg6(opts.llm.maxActionUsdg),
        maxActionsPerTick: 4,
      },
      // The curve venue, re-read per decision. Undefined when the host does
      // not supply one, which keeps every existing strategy identical.
      curveLegsNow: opts.curveLegsNow,
      decisionIntervalMs: opts.llm.intervalMin * 60_000,
      onNote: opts.onNote,
      onDecision: opts.llm.onDecision,
      provider: opts.llm.creds?.provider,
      model: opts.llm.creds?.model,
    });
  }
  if (name === "trencher") {
    // No trench context = no candidates and no positions, so it proposes
    // nothing. A backtest or fixture gets an honest no-op rather than a crash.
    const t = opts.trench;
    return makeTrencher({
      cfg: TRENCHER_DEFAULTS,
      swapRouter: opts.swapRouter,
      usdgToken: t?.usdgToken ?? (CASH.USDG as `0x${string}`),
      candidates: t?.candidates ?? (() => []),
      open: t?.open ?? (() => []),
      liquidityOf: t?.liquidityOf ?? (() => null),
      unpriceable: t?.unpriceable ?? (() => new Set<string>()),
      onNote: opts.onNote,
    });
  }
  if (name === "weekend-gap") {
    const cfg: WeekendGapConfig = {
      legs: legsFor(opts.basketSymbols),
      enterBudgetUsdg: opts.usdg6(opts.gapEnterBudgetUsdg),
      swapRouter: opts.swapRouter,
      usdg: CASH.USDG as `0x${string}`,
    };
    return { name, tick: (snap) => weekendGapTick(cfg, snap) };
  }
  if (name === "even-keel") {
    const cfg: EvenKeelConfig = {
      legs: legsFor(opts.basketSymbols).map((l) => ({ symbol: l.symbol, token: l.token })),
      swapRouter: opts.swapRouter,
      usdg: CASH.USDG as `0x${string}`,
      maxTradeUsdg: opts.usdg6(opts.buyPerTickUsdg),
      bandBps: 500, // rebalance a leg once it's ~5% off equal weight
      seedBudgetUsdg: opts.usdg6(opts.buyPerTickUsdg),
    };
    return { name, tick: (snap) => evenKeelTick(cfg, snap) };
  }
  if (name === "dip-hunter") {
    const cfg: DipHunterConfig = {
      legs: legsFor(opts.basketSymbols).map((l) => ({ symbol: l.symbol, token: l.token })),
      swapRouter: opts.swapRouter,
      usdg: CASH.USDG as `0x${string}`,
      buyPerTickUsdg: opts.usdg6(opts.buyPerTickUsdg),
      minDipBps: 150, // buy once a token is ~1.5% below its rolling high
    };
    return makeDipHunter(cfg);
  }
  const cfg: SteadyBasketConfig = {
    legs: legsFor(opts.basketSymbols),
    buyPerTickUsdg: opts.usdg6(opts.buyPerTickUsdg),
    idleFloorUsdg: opts.usdg6(opts.idleFloorUsdg),
    swapRouter: opts.swapRouter,
    vault: MORPHO.steakhouseUsdgVault as `0x${string}`,
    usdg: CASH.USDG as `0x${string}`,
  };
  return { name: "steady-basket", tick: (snap) => steadyBasketTick(cfg, snap) };
}
