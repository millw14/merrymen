/**
 * Could THIS agent buy THIS token — and if not, why not?
 *
 * The answer is spread across five modules and two processes: what the signed
 * permission can sell (core grant.ts sellableAssets), what the worker watches
 * (worker strategies/registry.ts watchTokensFor), the owner's asset mode
 * (core tokens.ts assetModeAllows), the price guards (worker pool-price.ts and
 * quarantine.ts scoutAllows), the class route's prerequisites (worker
 * class-entry-gate.ts), and the Trencher route's (worker index.ts
 * trenchCandidates, whose fast arm alone builds a vault-custodied buy, and
 * policy.ts custody "trencher", which skips the asset allowlist and the no-exit
 * rule for that buy only). This asks each of
 * them from the same inputs the worker uses and says plainly which ones cannot
 * be checked from here.
 *
 * It never places, quotes or simulates a trade.
 *
 * AN ANSWER, NOT A PROMISE. Even "yes" leaves the per-trade and daily caps, the
 * operation count, the drawdown breaker, price impact, the live depth and
 * divergence reads and the on-chain wall to the worker at trade time.
 *
 * WHAT IS VISIBLE HERE. The grant is seen through its non-secret projection
 * (features + extra token addresses), which is everything sellableAssets reads.
 * Settings are seen through the allowlist projection (settings-view.ts), which
 * does not carry the owner's price floors, so those are the defaults and say so.
 * It does carry the Trencher's live and fast switches; whether a Brain is
 * connected (its URL and token) it does not, and the Trencher route says so.
 */
import {
  CASH,
  DEFAULT_BASKET_SYMBOLS,
  GRANT_PONS_CLASS,
  GRANT_TRENCHER,
  LEGACY_TRADEABLE_SYMBOLS,
  SETTINGS_DEFAULTS,
  STOCK_TOKENS,
  TRADEABLE_SYMBOLS,
  TRADEABLE_V2,
  assetModeAllows,
  officialCoinsFor,
  sellableAssets,
  shortAddress,
  type AssetMode,
} from "@merrymen/core";
import type { Db } from "../../../../worker/src/db";
import { classRouteLooks } from "../../../../worker/src/class-entry-gate";
import { readAgentRow } from "./agent-status";
import type { SettingsView } from "./settings-view";
import {
  PRICE_FLOORS,
  discoverability,
  guardKey,
  impersonates,
  ownerTokens,
  poolSymbol,
  priceability,
  tokenKind,
  trustedTickers,
  type OwnerToken,
  type TokenFacts,
  type TokenFlag,
  type TokenKind,
  type Verdict,
} from "./market-intel";

/** The slice of an agent this needs: never a key, never the serialized grant. */
export interface EligibilityAgent {
  account: string | null;
  chainId: number | null;
  expiresAt: number | null;
  /** grantFeatures sealed into the signature. */
  features: readonly string[];
  /** Extra token addresses the signature can approve for a sale. */
  grantTokens: readonly string[];
}

export type CheckResult = "pass" | "fail" | "unknown" | "not_applicable";
export type CheckName =
  | "permission_signed"
  | "permission_current"
  | "grant_can_sell"
  | "watched_by_agent"
  | "in_strategy_basket"
  | "asset_mode"
  | "price_guard"
  | "scout_budget"
  | "trading_not_paused"
  | "symbol_collision"
  | "class_route"
  | "trencher_route"
  | "discovery_lists_it";

export interface EligibilityCheck {
  check: CheckName;
  result: CheckResult;
  detail: string;
}

export type Book = "paper" | "live" | "idle" | "unknown";

export interface EligibilityView {
  address: string;
  chain_id: number;
  /** Raw; trusted only when symbol_trusted. */
  symbol: string | null;
  symbol_trusted: boolean;
  kind: TokenKind;
  flags: TokenFlag[];
  book: Book;
  discoverable: Verdict;
  priceable: Verdict;
  executable: Verdict;
  checks: EligibilityCheck[];
  settings_used: {
    asset_mode: AssetMode;
    asset_mode_defaulted: boolean;
    basket: string[];
    basket_defaulted: boolean;
    min_pool_liquidity_usdg: number;
    max_price_divergence_bps: number;
    price_floors_source: "defaults";
    scout_enabled: boolean;
    scout_budget_usdg: number | null;
    launch_buying_enabled: boolean;
    class_min_depth_usdg: number;
    grant_tradable_set: "wide" | "legacy" | "none";
    grant_extra_tokens: number;
  };
  notes: string[];
}

const USDG = (CASH.USDG as string).toLowerCase();

interface WatchToken {
  symbol: string;
  address: string;
  origin: "basket" | "official" | "custom";
}

/**
 * The worker's watch set, rebuilt faithfully from the same inputs.
 *
 * The basket is the owner's symbols that name a registry stock or one of their
 * own tokens, or the default basket when none survive (worker/src/settings.ts).
 * The watch set is then watchTokensFor (worker/src/strategies/registry.ts):
 * basket stock tokens, official coins, then the owner's tokens — and a later
 * entry whose symbol or address is already taken is DROPPED, registry symbols
 * winning. That module drags in the strategy runtime, so its rule is restated
 * here rather than imported.
 */
export function watchSetFor(settings: SettingsView | null, chainId: number): {
  tokens: WatchToken[];
  dropped: Array<WatchToken & { why: string }>;
  basket: string[];
  basketDefaulted: boolean;
} {
  const custom = ownerTokens(settings?.customTokens);
  const selectable = new Set([...STOCK_TOKENS.map((t) => t.symbol), ...custom.map((t) => t.symbol)]);
  const chosen = (settings?.basketSymbols ?? []).filter((s) => selectable.has(s));
  const basketDefaulted = chosen.length === 0;
  const basket = basketDefaulted ? [...DEFAULT_BASKET_SYMBOLS] : chosen;

  const tokens: WatchToken[] = STOCK_TOKENS.filter((t) => basket.includes(t.symbol))
    .map((t) => ({ symbol: t.symbol, address: t.address.toLowerCase(), origin: "basket" as const }));
  const takenSymbols = new Set(STOCK_TOKENS.map((t) => t.symbol.toUpperCase()));
  const takenAddresses = new Set(tokens.map((t) => t.address));
  const dropped: Array<WatchToken & { why: string }> = [];
  for (const c of officialCoinsFor(chainId)) {
    if (takenSymbols.has(c.symbol.toUpperCase()) || takenAddresses.has(c.address.toLowerCase())) continue;
    takenSymbols.add(c.symbol.toUpperCase());
    takenAddresses.add(c.address.toLowerCase());
    tokens.push({ symbol: c.symbol, address: c.address.toLowerCase(), origin: "official" });
  }
  for (const c of custom) {
    const entry = { symbol: c.symbol, address: c.address, origin: "custom" as const };
    if (takenSymbols.has(c.symbol.toUpperCase())) {
      dropped.push({ ...entry, why: "The owner added it under a symbol a registry stock token or another watched token already uses, and the worker drops the later entry so a real ticker cannot be taken over." });
      continue;
    }
    if (takenAddresses.has(c.address)) continue; // already watched through the basket or a listing
    takenSymbols.add(c.symbol.toUpperCase());
    takenAddresses.add(c.address);
    tokens.push(entry);
  }
  return { tokens, dropped, basket, basketDefaulted };
}

export function modeOf(raw: string | null | undefined): Book {
  return raw === "paper" || raw === "live" || raw === "idle" ? raw : "unknown";
}

const iso = (sec: number): string => new Date(sec * 1000).toISOString();

/**
 * Judge from gathered inputs. Pure, so every rule can be tested without a
 * database or a market read.
 */
export function judgeEligibility(o: {
  address: string;
  agent: EligibilityAgent;
  settings: SettingsView | null;
  facts: TokenFacts;
  mode: Book;
  now: number;
}): EligibilityView {
  const a = o.address.toLowerCase();
  const chainId = o.agent.chainId ?? 4663;
  const mainnet = chainId === 4663;
  const custom: OwnerToken[] = ownerTokens(o.settings?.customTokens);
  const facts = o.facts;
  const stock = facts.stock;
  const kind = tokenKind(a, !!(facts.identity || facts.row || stock));
  const symbol = facts.identity?.symbol ?? (facts.row ? poolSymbol(facts.row) : null);
  const symbolTrusted = !!facts.identity;
  const flags: TokenFlag[] = [];
  if (!symbolTrusted && impersonates(a, symbol, trustedTickers(custom))) flags.push("impersonates_trusted_ticker");

  const assetMode: AssetMode = o.settings?.assetMode ?? SETTINGS_DEFAULTS.assetMode;
  const scoutOn = o.settings?.scoutEnabled === true && (o.settings?.scoutBudgetUsdg ?? 0) > 0;
  const launchOn = o.settings?.launchBuying.enabled === true;
  const classMinDepth = o.settings?.launchBuying.minDepthUsdg ?? SETTINGS_DEFAULTS.classMinDepthUsdg;
  const watch = watchSetFor(o.settings, chainId);
  const grant = o.agent.account ? { grantFeatures: [...o.agent.features], grantTokens: [...o.agent.grantTokens] } : null;
  const wide = o.agent.features.includes(TRADEABLE_V2);

  const checks: EligibilityCheck[] = [];
  const add = (check: CheckName, result: CheckResult, detail: string) => checks.push({ check, result, detail });
  const checkNamed = (name: CheckName) => checks.find((c) => c.check === name)!;

  // ── the permission ──
  if (!o.agent.account) add("permission_signed", "fail", "No trading permission has been signed for this agent, so it cannot trade anything.");
  else add("permission_signed", "pass", "A trading permission is signed for the agent's smart account.");
  if (o.agent.account) {
    if (o.agent.expiresAt === null) add("permission_current", "unknown", "The permission's expiry is not recorded.");
    else if (o.now >= o.agent.expiresAt) add("permission_current", "fail", `The permission expired at ${iso(o.agent.expiresAt)}; the owner must re-sign it before the agent can trade.`);
    else add("permission_current", "pass", `The permission is valid until ${iso(o.agent.expiresAt)}.`);
  } else {
    add("permission_current", "not_applicable", "There is no permission to expire.");
  }

  // ── NEVER ENTER A POSITION THE KEY CANNOT EXIT (worker policy.ts `no-exit`) ──
  const sellable = sellableAssets(grant);
  if (!grant) {
    add("grant_can_sell", "fail", "Without a signed permission no token can be approved for a sale.");
  } else if (sellable.has(a)) {
    const builtin = a === USDG || (stock && (wide ? (TRADEABLE_SYMBOLS as readonly string[]) : (LEGACY_TRADEABLE_SYMBOLS as readonly string[])).includes(stock.symbol));
    add("grant_can_sell", "pass", builtin
      ? `The signed permission can approve it for a sale (it is in the ${wide ? "wide" : "legacy"} tradable set the signature carries).`
      : "The signed permission can approve it for a sale: it was sealed in as an extra token when the owner signed.");
  } else {
    const why = stock
      ? (TRADEABLE_SYMBOLS as readonly string[]).includes(stock.symbol)
        ? "This signature carries only the legacy QQQ/NVDA/TSLA set; re-signing the permission adds the wider tradable set."
        : "This stock token has no pool the agent can sell into, so no signature covers it."
      : "Adding it as one of the owner's tokens in Settings and re-signing the permission would cover it.";
    add("grant_can_sell", "fail", `The signed permission cannot approve this token for a sale, so the worker refuses to buy it: a position it could open and never close ("no-exit"). ${why}`);
  }

  // ── what the worker watches (worker policy.ts `asset-allowlist`) ──
  const watched = watch.tokens.find((t) => t.address === a) ?? null;
  const droppedSelf = watch.dropped.find((t) => t.address === a) ?? null;
  if (a === USDG) add("watched_by_agent", "not_applicable", "USDG is the agents' cash: it is what they buy with.");
  else if (watched) add("watched_by_agent", "pass", watched.origin === "basket" ? "It is a stock token in the agent's basket, so the worker watches it." : watched.origin === "official" ? "It is an official coin the worker watches." : "It is one of the owner's own tokens, so the worker watches it.");
  else if (droppedSelf) add("watched_by_agent", "fail", `The owner added it, but the worker does not watch it. ${droppedSelf.why}`);
  else if (stock) add("watched_by_agent", "fail", "It is a registry stock token, but not in the agent's basket, so the worker does not watch it and cannot trade it. The owner can add it to the basket in Settings.");
  else add("watched_by_agent", "fail", "The worker only trades USDG and the tokens it watches: basket stock tokens, official coins and the owner's own tokens. This is none of them; the owner can add it in Settings (and must then re-sign).");

  // ── the basket: "know about this" is not "trade this" (registry.ts legsForUniverse) ──
  if (!watched) add("in_strategy_basket", "not_applicable", "Not watched, so not a strategy leg.");
  else if (watched.origin === "official" || watch.basket.includes(watched.symbol)) add("in_strategy_basket", "pass", "It is one of the strategy's legs, so the strategy may buy it on its own.");
  else add("in_strategy_basket", "fail", "It is watched but not in the basket, so the strategy will not buy it on its own; an owner order can still name it.");

  // ── asset mode (core tokens.ts assetModeAllows; address-keyed) ──
  if (a === USDG) add("asset_mode", "not_applicable", "Cash is not filtered by asset mode.");
  else if (assetModeAllows(assetMode, a)) add("asset_mode", "pass", `The owner's asset mode (${assetMode}) allows buying this kind of token.`);
  else add("asset_mode", "fail", `The owner's asset mode (${assetMode}) does not allow buying this kind of token. It filters buys only: a held position stays watched and sellable.`);

  // ── the price guards ──
  const priceable: Verdict = mainnet ? priceability(facts) : { state: "unknown", reasons: ["Market data covers Robinhood Chain mainnet only; this agent runs on testnet."] };
  const priceResult: CheckResult = priceable.state === "yes" ? "pass" : priceable.state === "no" ? "fail" : "unknown";
  add("price_guard", priceResult, priceable.reasons.join(" "));
  if (priceResult === "pass") add("scout_budget", "not_applicable", "Not needed: the token can be priced.");
  else if (scoutOn) add("scout_budget", "pass", `Scout mode is on with a ${o.settings!.scoutBudgetUsdg} USDG budget, so the worker may buy what it cannot price, within that budget and carried at cost.`);
  else add("scout_budget", "fail", "Scout mode is off or its budget is 0, and buying what cannot be priced is opt-in (quarantine.ts scoutAllows), so the worker refuses the buy whenever it cannot price the token.");

  // ── a halted stock token ──
  if (!stock) add("trading_not_paused", "not_applicable", "Only issuer-backed stock tokens can be halted by their issuer.");
  else if (facts.stockMarket.row?.paused === true) add("trading_not_paused", "fail", "Trading is halted on the token contract.");
  else if (facts.stockMarket.row?.paused === false) add("trading_not_paused", "pass", "The token contract reports trading is not halted.");
  else add("trading_not_paused", "unknown", "Whether the token contract has halted trading could not be read.");

  // ── symbol collision among the agent's configured tokens ──
  const key = symbol ? guardKey(symbol) : "";
  const clashes = key ? watch.tokens.filter((t) => t.address !== a && guardKey(t.symbol) === key) : [];
  if (!key) add("symbol_collision", "not_applicable", "No symbol is known for this token.");
  else if (droppedSelf) add("symbol_collision", "fail", "Its symbol collides with a token the worker already watches, which is why the worker drops it.");
  else if (clashes.length) add("symbol_collision", "fail", `Another token the agent watches shares this token's symbol (${clashes.slice(0, 3).map((t) => shortAddress(t.address)).join(", ")}). Owner orders name a token by symbol and the worker takes the first match, so an order by symbol could fill the other token.`);
  else add("symbol_collision", "pass", "No other token the agent watches shares this symbol.");

  // ── the class route (worker class-entry-gate.ts classRouteLooks + launch buying) ──
  if (stock || a === USDG || kind === "established") {
    add("class_route", "not_applicable", "The class route buys launchpad coins only.");
  } else {
    const vaultSealed = o.agent.features.includes(GRANT_PONS_CLASS);
    const looks = o.mode === "unknown" ? null : classRouteLooks({ paper: o.mode === "paper", assetMode, vault: vaultSealed ? "sealed" : null });
    const fails: string[] = [];
    if (o.mode === "paper") fails.push("the agent is on paper, which cannot simulate a class fill");
    if (assetMode === "stocks") fails.push("the asset mode is stocks only");
    if (!vaultSealed) fails.push("the signed permission carries no class vault (pons-class)");
    if (!launchOn) fails.push("launch buying is off or sized at zero");
    // A class buy is unpriceable BY CONSTRUCTION (worker class-side.ts
    // scoutFlagsFor: isClassBuy ⇒ buyUnpriceable), so policy.ts runs
    // scoutAllows on every one: with scout mode off or a zero budget the wall
    // refuses the class buy just as it refuses any other unpriceable buy.
    if (!scoutOn) fails.push("scout mode is off or its budget is 0, and every class buy is charged to the scout budget");
    if (facts.row && !facts.row.onCurve) fails.push("the index lists it off a bonding curve, and the class route trades curves only");
    if (fails.length || looks === false) {
      add("class_route", "fail", `The class route cannot buy it: ${fails.join("; ")}.`);
    } else if (looks === null) {
      add("class_route", "unknown", "Whether the agent is on paper could not be read, and paper cannot use the class route.");
    } else {
      add("class_route", "unknown", `Its prerequisites are met. Whether this coin qualifies depends on reads only the worker makes: a USDG-quoted curve that has not graduated, with at least ${classMinDepth} USDG of real depth, found in its factory-filtered launch feed; the buy must also fit the scout budget and its per-token cap. The permission's class marker is visible here; its sealed vault address is not.`);
    }
  }

  // ── the Trencher route (worker index.ts trenchCandidates; policy.ts custody "trencher") ──
  // A buy the Trencher makes into its sealed vault is not judged against the
  // asset allowlist or the no-exit rule: the wall instead requires the vault
  // and a coin the worker verified on chain for it (knownTrencherAssets). Which
  // coins those are comes from the worker's own discovery tape and pool checks.
  //
  // ONLY THE FAST TRENCHER BUILDS ONE. trenchCandidates sets the vault custody
  // inside `if (cfg.trencherFastEnabled)` alone; its other arm hands the
  // strategy discovery candidates that carry no custody, and policy.ts holds
  // those to the allowlist and the no-exit rule like any other buy. So with the
  // fast Trencher off (its default) there is no vault route to answer for them.
  //
  // `trencherPrereqsMet` is the one state in which this route stands in for
  // the ordinary route's allowlist and no-exit refusals (see the verdict). An
  // unread book is not it: if the agent trades live with live trenching off,
  // the feed is empty and those refusals are exactly why it cannot buy.
  let trencherPrereqsMet = false;
  {
    const vaultSealed = o.agent.features.includes(GRANT_TRENCHER);
    const priceOk = checkNamed("price_guard").result !== "fail" || checkNamed("scout_budget").result === "pass";
    const fastSetting = o.settings?.trencherFastEnabled ?? null;
    const liveTrenching = o.settings?.trencherLiveEnabled === true;
    if (stock || a === USDG) {
      add("trencher_route", "not_applicable", "The Trencher route buys discovered coins only.");
    } else if (!vaultSealed) {
      add("trencher_route", "not_applicable", "The signed permission carries no Trencher vault (trencher-vault-v1), so there is no Trencher route.");
    } else if (o.settings?.strategy !== "trencher") {
      add("trencher_route", "not_applicable", "The permission carries a Trencher vault, but the agent's strategy is not Trencher, so nothing uses it.");
    } else if (fastSetting !== true) {
      add("trencher_route", "not_applicable", `The fast Trencher ${fastSetting === false ? "is off" : "is not turned on (it is off by default)"} in the owner's settings, and only the fast Trencher buys into the sealed vault. Without it the Trencher's buys carry no vault custody, so they are ordinary buys: the checks above, including the asset allowlist and the no-exit rule, decide them.`);
    } else {
      const fails: string[] = [];
      if (assetMode === "stocks") fails.push("the asset mode is stocks only, which empties the Trencher's candidate feed");
      // The worker gates live trenching whenever it is not on paper (live, or
      // idle: not trading); on paper the feed runs. An unread book decides
      // nothing either way, so it is not a failure (below).
      if ((o.mode === "live" || o.mode === "idle") && !liveTrenching) {
        fails.push("live trenching (“let trencher trade for real”) is off and the agent is not on paper, so the worker gives the Trencher no candidates");
      }
      if (!priceOk) fails.push("the Trencher opens a position only on a pool price the worker trusts (or inside the scout budget), and this token's price fails the guards");
      if (fails.length) {
        add("trencher_route", "fail", `The Trencher route cannot buy it: ${fails.join("; ")}.`);
      } else if (o.mode === "unknown" && !liveTrenching) {
        add("trencher_route", "unknown", "Whether the agent is on paper could not be read, and that decides this route: live trenching (“let trencher trade for real”) is off, so while the agent is not on paper the worker gives the Trencher no candidates; on paper its feed runs.");
      } else {
        trencherPrereqsMet = true;
        add("trencher_route", "unknown", `Its prerequisites are met: the permission seals a Trencher vault, the strategy is Trencher, the fast Trencher is on in the owner's settings, ${o.mode === "paper" ? "and the asset mode allows it (on paper live trenching is not needed)" : "and live trenching and the asset mode allow it"}. Whether this coin qualifies depends on the worker's own discovery and vault-verified assets: a high-volume pool on its discovery tape, verified on chain for the sealed vault, and a connected Brain approving the entry (whether a Brain is connected is not visible here). The worker caps each entry at 5 USDG and the vault at 25 USDG of buys a day. The asset allowlist and the no-exit rule do not apply to this route.`);
      }
    }
  }

  // ── discovery ──
  const discoverable: Verdict = mainnet ? discoverability(facts) : { state: "unknown", reasons: ["Market data covers Robinhood Chain mainnet only; this agent runs on testnet."] };
  add("discovery_lists_it", discoverable.state === "yes" ? "pass" : discoverable.state === "no" ? "fail" : "unknown", discoverable.reasons.join(" "));

  // ── verdict ──
  const by = checkNamed;
  const hard = (["permission_signed", "permission_current", "asset_mode", "trading_not_paused"] as const).map(by).filter((c) => c.result === "fail");
  const hardUnknown = (["permission_current", "trading_not_paused"] as const).map(by).filter((c) => c.result === "unknown");
  const routeFails = (["watched_by_agent", "grant_can_sell"] as const).map(by).filter((c) => c.result === "fail");
  const price = by("price_guard");
  const scout = by("scout_budget");
  // The ordinary route: watched, sellable, and priced — or unpriceable inside
  // the scout budget.
  const priced = price.result === "pass" || scout.result === "pass";
  const routeA: "yes" | "no" | "unknown" = routeFails.length ? "no" : priced ? "yes" : price.result === "fail" ? "no" : "unknown";
  const classCheck = by("class_route");
  const routeB: "no" | "unknown" = classCheck.result === "unknown" ? "unknown" : "no";
  // The Trencher route: null when the agent has none.
  const trencherCheck = by("trencher_route");
  const routeC: "no" | "unknown" | null = trencherCheck.result === "unknown" ? "unknown" : trencherCheck.result === "fail" ? "no" : null;

  let executable: Verdict;
  const caveat = "Caps (per trade, per day, operation count), the drawdown breaker, price impact and the on-chain wall are still judged by the worker at trade time.";
  if (a === USDG) {
    executable = { state: "no", reasons: ["USDG is the agents' cash: it is what they buy with, not something they buy."] };
  } else if (hard.length) {
    executable = { state: "no", reasons: hard.map((c) => c.detail) };
  } else if (routeA === "no" && routeB === "no" && routeC !== "unknown") {
    // No route could reach it, so an unread halt flag or expiry changes nothing.
    const blockers = [...routeFails, ...(priced ? [] : [price, scout]), ...(classCheck.result === "fail" ? [classCheck] : []), ...(routeC === "no" ? [trencherCheck] : [])];
    executable = { state: "no", reasons: blockers.map((c) => c.detail) };
  } else if (routeA === "yes" && !hardUnknown.length) {
    executable = {
      state: "yes",
      reasons: [
        scout.result === "pass" && price.result !== "pass" ? "The permission and settings allow buying it, as an unpriced scout position inside the scout budget." : "The permission and settings allow buying it.",
        caveat,
      ],
    };
  } else {
    // A Trencher route whose prerequisites are met answers for the ordinary
    // route's allowlist and no-exit refusals: they are not why this agent could
    // not buy it. One that hangs on an unread book does not: if the agent is
    // live, those refusals are exactly why.
    const open = [
      ...hardUnknown, ...(routeC === "unknown" ? [trencherCheck] : []), ...(routeA === "no" && !trencherPrereqsMet ? routeFails : []),
      ...(routeA === "unknown" ? [price, scout] : []), ...(routeB === "unknown" ? [classCheck] : []),
    ];
    executable = { state: "unknown", reasons: [...open.map((c) => c.detail), caveat] };
  }

  // Shown after the verdict, which was judged on the ordinary route's own
  // results: on an open Trencher route the allowlist and the no-exit rule do
  // not apply (policy.ts skips both for a vault-custodied buy), so failing
  // them there would tell the owner to re-sign or add a token for nothing.
  // Only then: with the fast Trencher off, or the route hanging on an unread
  // book, the worker may well refuse the buy on exactly those rules.
  if (trencherPrereqsMet) {
    const onTrencher: Partial<Record<CheckName, string>> = {
      grant_can_sell: "Not required on the Trencher route: a vault-custodied buy is not held to the no-exit rule, since the sealed Trencher vault, not a per-token approval, sells it.",
      watched_by_agent: "Not required on the Trencher route: a vault-custodied buy skips the asset allowlist; the wall checks it against the coins the worker verified on chain for the vault instead.",
    };
    for (const c of checks) {
      const why = onTrencher[c.check];
      if (why && c.result === "fail") {
        c.result = "not_applicable";
        c.detail = `${why} On the ordinary route: ${c.detail}`;
      }
    }
  }

  const notes: string[] = [];
  if (o.mode === "paper") notes.push("The agent is on paper: a buy would be a simulated fill at the oracle price, not real funds.");
  else if (o.mode === "idle") notes.push("The agent is running but not trading right now (see get_agent_status for why).");
  else if (o.mode === "unknown") notes.push("The agent's current book (paper or live) could not be read.");
  if (o.settings && !o.settings.liveTradingEnabled) notes.push("Live trading is off in the owner's settings, so no real order is placed until the owner turns it on.");
  notes.push("Price floors are Merrymen's defaults: the owner may have changed them, and that setting is not visible to this server.");
  if (flags.includes("impersonates_trusted_ticker")) notes.push("This token's label copies a trusted ticker at a different address. It is not that asset.");

  return {
    address: a,
    chain_id: chainId,
    symbol,
    symbol_trusted: symbolTrusted,
    kind,
    flags,
    book: o.mode,
    discoverable,
    priceable,
    executable,
    checks,
    settings_used: {
      asset_mode: assetMode,
      asset_mode_defaulted: !o.settings?.assetMode,
      basket: watch.basket,
      basket_defaulted: watch.basketDefaulted,
      min_pool_liquidity_usdg: PRICE_FLOORS.minPoolLiquidityUsdg,
      max_price_divergence_bps: PRICE_FLOORS.maxPriceDivergenceBps,
      price_floors_source: "defaults",
      scout_enabled: o.settings?.scoutEnabled === true,
      scout_budget_usdg: o.settings?.scoutBudgetUsdg ?? null,
      launch_buying_enabled: launchOn,
      class_min_depth_usdg: classMinDepth,
      grant_tradable_set: !grant ? "none" : wide ? "wide" : "legacy",
      grant_extra_tokens: grant ? o.agent.grantTokens.length : 0,
    },
    notes,
  };
}

/**
 * Read the agent's current book from the shared ledger, then judge. `db` may
 * be null for an agent with no signed account (there is nothing to read).
 */
export async function checkEligibility(db: Db | null, o: {
  address: string;
  agent: EligibilityAgent;
  settings: SettingsView | null;
  facts: TokenFacts;
  now: number;
}): Promise<EligibilityView> {
  const row = db && o.agent.account ? await readAgentRow(db, o.agent.account) : null;
  return judgeEligibility({ ...o, mode: modeOf(row?.mode) });
}
