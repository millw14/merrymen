/**
 * A COIN POSTED IN A TELEGRAM GROUP, SEEN FROM THE TRADING SIDE.
 *
 * The contract is docs/tg-groups.md ("The coin flow", "Nomination caps"). The
 * chat side (telegram/tg-groups/) never imports anything that trades; it holds
 * a `TgCoinsPort`, and this file is what index.ts builds that port from:
 *
 *   - `createCoinLook` — the quick look (step 5): what kind of address was
 *     posted, cheapest reads first, cached, and rate-capped so a busy group
 *     cannot spend the process's RPC governor or the fleet's GeckoTerminal
 *     quota;
 *   - `createTgCoinsPort` — the port object itself, whose every method is safe
 *     to call at any time and never throws;
 *   - three small rules the trencher tick applies at its own seams (the group
 *     entry claim, what a review of a nominated coin reports, and which sale is
 *     an exit worth one line), kept here so a test can run them.
 *
 * NOTHING HERE CAN MAKE A TRADE HAPPEN. The look reads; the port hands a
 * validated address to the nomination book; the entry claim can only REFUSE an
 * entry. The Brain still decides, the trencher entry path still sizes, and
 * checkPolicy and the TrencherVault still bound every buy exactly as before.
 *
 * NAMING: the web room's name never appears in code here (see
 * worker/src/groupchat/boundary.test.ts). This is "Telegram groups".
 */
import type { PublicClient } from "viem";
import { CASH, STOCK_TOKENS, isEnergyReserveToken } from "../../packages/core/src/index";
import type { BrainDecision } from "./brain-client";
import { coinDisplayName } from "./coin-name";
import { PONS_CURVE_DEX } from "./discovery";
import { TRENCHER_FAST, shouldEnter, type Candidate } from "./strategies/trencher";
import { highVolumePools } from "./trencher-brain";
import { isCaAddress, type NominationBook, type ReviewedDecision } from "./trencher-nominate";
import type { GeckoPool } from "./venues/geckoterminal";
import { aggregate3, parseTokenMeta } from "./venues/pons-meta";
import type {
  CoinKind,
  CoinLook,
  CoinOutcome,
  NominateResult,
  Nomination,
  TgCoinsPort,
  TrencherReadiness,
} from "./telegram/tg-groups/types";

const MIN = 60_000;

/** The look's clocks and bounds. */
export const COIN_LOOK = {
  /** A definite answer about an address is reused this long (the contract's 30 min). */
  cacheMs: 30 * MIN,
  /**
   * Looks that must read the network, per process, per rolling window. Beyond
   * it the answer is `unknown` ("can't get a proper look rn"). Six in ten
   * minutes is a busy group's worth of fresh coins, and at most ~6 GeckoTerminal
   * slots and ~6 batched RPC requests against a governor the stop-loss tick
   * shares — a price worth paying for chatter, and no more.
   */
  maxUncached: 6,
  windowMs: 10 * MIN,
  /** Addresses remembered at once; the oldest answer goes first. */
  cacheMax: 500,
} as const;

const DEX_V3 = "uniswap-v3-robinhood";
const ZERO_ADDRESS = "0x" + "0".repeat(40);

/** What one multicall says an address with code is. */
export interface TokenProbe {
  /** Answers the Pons template's metadata getter (venues/pons-meta.ts). */
  pons: boolean;
  /** Answers `decimals()` with a uint8 — an ERC-20, or something shaped like one. */
  erc20: boolean;
}

/**
 * The readers a look is built from, injected so every branch is testable and
 * so the look itself owns no client, no ledger and no clock.
 */
export interface CoinLookReaders {
  /** This agent's own money: `bookAddresses` of the active grant (account + vaults). Read on every look. */
  own: () => readonly string[];
  /** The memecoin currently held at this address, with its display name when known; null when not held. */
  held: (address: string) => { name?: string | null } | null;
  /** GeckoTerminal's token-pools page (venues/geckoterminal.ts readTokenPools). null = could not be read. */
  tokenPools: (address: string) => Promise<GeckoPool[] | null>;
  /** eth_getCode. undefined or "0x" = no code. A rejection is a failed read, never "no code". */
  getCode: (address: `0x${string}`) => Promise<string | undefined>;
  /** One multicall: Pons template + ERC-20 shape. null = the batch could not be read. */
  probe: (address: `0x${string}`) => Promise<TokenProbe | null>;
  /** Pons curve provenance from the local ledger (0 RPC). A rejection counts as "not known here". */
  curveFor?: (address: string) => Promise<unknown>;
  now?: () => number;
}

/** The address-derived id discovery gives a coin (trencher-discovery.ts), used only to reject it as a name. */
const addressSymbol = (address: string) => `T${address.slice(-11).toUpperCase()}`;

/**
 * Names a memecoin may not be called in a group: a launchpad coin calling
 * itself TSLA or USDG is exactly the impersonation the address-first identity
 * exists to defeat, and a bot that says "tsla" about it misleads the room.
 * Such a coin is "this one".
 */
const TRUSTED_NAMES = new Set(
  [...STOCK_TOKENS.map((t) => t.symbol), "USDG", "WETH", "ETH", "MERRYMEN"].map((s) => s.toUpperCase()),
);

function displayName(address: string, pools: readonly GeckoPool[]): string | undefined {
  for (const p of pools) {
    const n = coinDisplayName({ symbol: addressSymbol(address), name: p.name, kind: "memecoin" });
    if (n && !TRUSTED_NAMES.has(n.toUpperCase())) return n;
  }
  return undefined;
}

const UNKNOWN: CoinLook = Object.freeze({ kind: "unknown" });

/**
 * THE QUICK LOOK — `(address) => CoinLook`, cheapest first.
 *
 * 1. FREE: its own wallet or vault, cash, the energy reserve, a stock token,
 *    a coin it already holds. Answered every time, never cached, so a coin
 *    bought since the last look is `held` and not a stale `candidate`.
 * 2. CACHED: a definite answer from the last 30 minutes.
 * 3. RATE-CAPPED: past the per-process allowance the answer is `unknown`.
 * 4. GeckoTerminal's page for the token. When pools are known they decide:
 *    a Pons curve pool → `curve`; only 32-byte pool ids → `v4-only`; no
 *    Uniswap v3 pool at all → `no-pool`; a v3 pool that fails
 *    `highVolumePools` → `too-quiet`; fails `shouldEnter(TRENCHER_FAST)` on
 *    depth or size → `too-thin`, on age → `too-new`; else `candidate`.
 * 5. No pool known: local curve provenance, then ONE getCode read (batched
 *    with one multicall probe): no code → `wallet`; a Pons template →
 *    `curve`; an ERC-20 → `no-pool`; anything else → `not-token`.
 *
 * UNREADABLE IS NOT ABSENT. A page, a getCode or a probe that could not be
 * read is `unknown` — never `wallet` (viem's undefined-for-no-code conflation,
 * recover.ts) and never `no-pool` — and `unknown` is not cached, so the next
 * look can succeed.
 *
 * `candidate` IS A PRE-SCREEN, NOT A VERDICT. The depth tested here is the
 * index's pool reserve, which is at least the on-chain route depth the tick
 * enters on (the route's shallowest leg is part of it): a coin this refuses as
 * thin would be refused by the tick too, and one it passes still has to pass
 * discovery's on-chain verification, the tick's pool-grade price and depth,
 * `shouldEnter`, a fresh Brain BUY and the wall.
 */
export function createCoinLook(d: CoinLookReaders): (address: string) => Promise<CoinLook> {
  const now = d.now ?? Date.now;
  const cache = new Map<string, { look: CoinLook; at: number }>();
  const pending = new Map<string, Promise<CoinLook>>();
  let started: number[] = [];

  const free = (a: string): CoinLook | null => {
    if (d.own().some((x) => typeof x === "string" && x.toLowerCase() === a)) return { kind: "own" };
    if (a === CASH.USDG.toLowerCase()) return { kind: "cash", name: "USDG" };
    if (a === CASH.WETH.toLowerCase()) return { kind: "cash", name: "WETH" };
    if (isEnergyReserveToken(a)) return { kind: "energy" };
    const stock = STOCK_TOKENS.find((t) => t.address.toLowerCase() === a);
    if (stock) return { kind: "stock", name: stock.symbol };
    const held = d.held(a);
    if (held) {
      const name = typeof held.name === "string" && held.name && !TRUSTED_NAMES.has(held.name.toUpperCase()) ? held.name : null;
      return name ? { kind: "held", name } : { kind: "held" };
    }
    return null;
  };

  const read = async (a: `0x${string}`): Promise<CoinLook> => {
    const pools = await d.tokenPools(a);
    if (pools === null) return UNKNOWN;
    const mine = pools.filter((p) => p.tokenAddress.toLowerCase() === a);
    if (mine.length > 0) return classifyPools(a, mine, Math.floor(now() / 1000));
    if (d.curveFor && (await d.curveFor(a).catch(() => null))) return { kind: "curve" };
    // Issued together so the metered transport batches them into one request.
    const [code, probe] = await Promise.all([
      d.getCode(a).then((c) => ({ ok: true as const, c }), () => ({ ok: false as const })),
      d.probe(a).catch(() => null),
    ]);
    if (!code.ok) return UNKNOWN;
    if (typeof code.c !== "string" || code.c === "0x" || code.c === "") return { kind: "wallet" };
    if (probe === null) return UNKNOWN;
    if (probe.pons) return { kind: "curve" };
    return { kind: probe.erc20 ? "no-pool" : "not-token" };
  };

  return async (address: string): Promise<CoinLook> => {
    try {
      const a = typeof address === "string" ? address.toLowerCase() : "";
      if (!isCaAddress(a) || a === ZERO_ADDRESS) return UNKNOWN;
      const quick = free(a);
      if (quick) return quick;
      const t = now();
      const hit = cache.get(a);
      if (hit && t - hit.at < COIN_LOOK.cacheMs) return hit.look;
      if (hit) cache.delete(a);
      const joining = pending.get(a);
      if (joining) return await joining;
      started = started.filter((s) => t - s < COIN_LOOK.windowMs);
      if (started.length >= COIN_LOOK.maxUncached) return UNKNOWN;
      started.push(t);
      const job = read(a as `0x${string}`)
        .catch(() => UNKNOWN)
        .then((look) => {
          if (look.kind !== "unknown") {
            if (cache.size >= COIN_LOOK.cacheMax) cache.delete(cache.keys().next().value!);
            cache.set(a, { look, at: now() });
          }
          return look;
        })
        .finally(() => pending.delete(a));
      pending.set(a, job);
      return await job;
    } catch {
      return UNKNOWN;
    }
  };
}

function classifyPools(a: string, mine: readonly GeckoPool[], nowSec: number): CoinLook {
  const name = displayName(a, mine);
  const as = (kind: CoinKind): CoinLook => (name ? { kind, name } : { kind });
  // Trencher v1 buys through a Uniswap v3 pool CONTRACT and nothing else
  // (venues/trencher-vault.ts refuses v4 routes), so that is what is looked for.
  const v3 = mine.filter((p) => p.dex === DEX_V3 && p.poolAddress !== null);
  if (v3.length === 0) {
    if (mine.some((p) => p.dex === PONS_CURVE_DEX)) return as("curve");
    if (mine.every((p) => p.poolAddress === null)) return as("v4-only");
    return as("no-pool");
  }
  const busy = highVolumePools(v3);
  if (busy.length === 0) return as("too-quiet");
  const best = busy[0]!;
  // A figure the index left out is a look that could not be made, not a pass.
  if (best.reserveUsd === null || best.fdvUsd === null || best.createdAt === null || best.createdAt > nowSec) return UNKNOWN;
  const c: Candidate = {
    symbol: addressSymbol(a),
    token: a as `0x${string}`,
    decimals: 18,
    // Priceability is the tick's question (pool-grade, on chain), not this one's.
    priceable: true,
    liquidityUsd: best.reserveUsd,
    fdvUsd: best.fdvUsd,
    ageSec: nowSec - best.createdAt,
    price8: 1n,
  };
  if (shouldEnter(c, TRENCHER_FAST, nowSec).enter) return as("candidate");
  // Named by WHICH bound refused, in shouldEnter's own order; the prose it
  // returns carries dollar figures and is never repeated.
  if (c.liquidityUsd < TRENCHER_FAST.minLiquidityUsd || c.fdvUsd < TRENCHER_FAST.minFdvUsd) return as("too-thin");
  if (c.ageSec < TRENCHER_FAST.minAgeSec) return as("too-new");
  return UNKNOWN;
}

/** Pons template metadata getter — the selector venues/pons-meta.ts reads. */
const PONS_METADATA_SELECTOR = "0xabb1dc44" as const;
/** ERC-20 `decimals()`. */
const DECIMALS_SELECTOR = "0x313ce567" as const;

/**
 * The probe `createCoinLook` wants, over the chain: ONE Multicall3 aggregate3
 * with two sub-calls, so "is it a Pons coin" and "is it a token at all" cost one
 * eth_call. aggregate3 returns [] when the batch itself failed, which is the
 * one answer that means "could not read" — a sub-call that reverts is an
 * ordinary "no".
 */
export function chainTokenProbe(client: PublicClient): (address: `0x${string}`) => Promise<TokenProbe | null> {
  return async (address) => {
    const r = await aggregate3(client, [
      { target: address, callData: PONS_METADATA_SELECTOR },
      { target: address, callData: DECIMALS_SELECTOR },
    ]);
    if (r.length !== 2) return null;
    const pons = !!r[0]?.success && parseTokenMeta(address, r[0].returnData) !== null;
    const dec = r[1];
    let erc20 = false;
    if (dec?.success && /^0x[0-9a-f]{64}$/i.test(dec.returnData)) {
      try {
        erc20 = BigInt(dec.returnData) <= 255n;
      } catch {
        erc20 = false;
      }
    }
    return { pons, erc20 };
  };
}

// ─── The port ───────────────────────────────────────────────────────────────

export interface TgCoinsPortDeps {
  readiness: () => TrencherReadiness;
  look: (address: string) => Promise<CoinLook>;
  book: Pick<NominationBook, "nominate">;
  /** Told the lowercased address after an accepted nomination (its tape page). Its errors are swallowed. */
  onNominated?: (address: string) => void;
  heldNames: () => readonly string[];
  paper: () => boolean;
  log?: (line: string) => void;
}

/** The port, plus the one thing only the trading side may do with it: deliver outcomes. */
export interface TgCoinsHub extends TgCoinsPort {
  emit(outcomes: CoinOutcome | readonly CoinOutcome[] | null | undefined): void;
}

const READINESS_UNREADABLE: TrencherReadiness = {
  kind: "off",
  ownerReason: "I couldn't check my Trencher settings just now, so I left that coin alone. I'll check again with the next one.",
};

/**
 * THE PORT index.ts HANDS TO startTelegram — every method safe at any time.
 *
 * A method that fails answers the way that does nothing: readiness `off`, a
 * look `unknown`, a nomination refused `invalid`, no held names, and `paper`
 * for the mode — a group told a practice trade was real is the mistake that
 * must not happen, so an unreadable mode never claims real money.
 *
 * `emit` never throws either: a subscriber that throws is skipped and the
 * others still hear the outcome, because one broken chat handler must not
 * cost another chat its answer, and the trading tick that emits must never
 * see a chat's error.
 */
export function createTgCoinsPort(d: TgCoinsPortDeps): TgCoinsHub {
  const listeners = new Set<(o: CoinOutcome) => void>();
  const readiness = (): TrencherReadiness => {
    try {
      const r = d.readiness();
      return r && typeof r.kind === "string" ? r : READINESS_UNREADABLE;
    } catch {
      return READINESS_UNREADABLE;
    }
  };
  return {
    readiness,
    look(address: string): Promise<CoinLook> {
      try {
        return d.look(address).catch(() => UNKNOWN);
      } catch {
        return Promise.resolve(UNKNOWN);
      }
    },
    nominate(n: Nomination): NominateResult {
      let r: NominateResult;
      try {
        r = d.book.nominate(n, readiness().kind);
      } catch {
        return { ok: false, reason: "invalid" };
      }
      if (r.ok) {
        try {
          d.onNominated?.(n.address.toLowerCase());
        } catch {
          // The nomination stands; its tape page arrives with the next refresh.
        }
      }
      return r;
    },
    onOutcome(cb: (o: CoinOutcome) => void): () => void {
      if (typeof cb !== "function") return () => {};
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    heldNames(): string[] {
      try {
        return [...d.heldNames()].filter((n) => typeof n === "string" && n.length > 0);
      } catch {
        return [];
      }
    },
    mode(): "paper" | "live" {
      try {
        return d.paper() === false ? "live" : "paper";
      } catch {
        return "paper";
      }
    },
    emit(outcomes) {
      const list = outcomes == null ? [] : Array.isArray(outcomes) ? outcomes : [outcomes as CoinOutcome];
      for (const o of list) {
        if (!o) continue;
        // The kind only: no address, no name, no chat — this line is the log.
        try {
          d.log?.(`[tg-groups] coin outcome: ${o.kind}`);
        } catch {
          // A log that throws is not a reason to lose the outcome.
        }
        for (const cb of [...listeners]) {
          try {
            cb(o);
          } catch {
            // One subscriber's failure is its own.
          }
        }
      }
    },
  };
}

// ─── The tick's seams ─────────────────────────────────────────────────────

/**
 * WHAT A BRAIN REVIEW TELLS THE NOMINATION BOOK.
 *
 * The decision's own action, with one correction: a BUY the portfolio gate
 * refused or downgraded can never become an order (brain-live.ts
 * orderFromDecision refuses it), so it is reported as the gate-forced hold it
 * is — `skipped`, never a take voiced as the agent's view, and never a buy
 * left waiting for a fill that cannot come.
 */
export function reviewedDecisionOf(d: Pick<BrainDecision, "action" | "decision_id" | "thesis" | "bull_case" | "bear_case" | "risks" | "hold_kind" | "gate_verdict">): ReviewedDecision {
  const gated = d.action === "buy" && (d.gate_verdict === "refuse" || d.gate_verdict === "downgrade-to-hold");
  return {
    action: gated ? "hold" : d.action,
    decisionId: d.decision_id,
    holdKind: gated ? "GATE_FORCED_HOLD" : d.hold_kind ?? null,
    thesis: d.thesis ?? null,
    bullCase: d.bull_case ?? null,
    bearCase: d.bear_case ?? null,
    risks: Array.isArray(d.risks) ? d.risks : null,
  };
}

export type GroupEntryClaim =
  | { group: false }
  | { group: true; address: string; ok: true }
  | { group: true; address: string; ok: false; why: "cap" | "resolved" };

/**
 * THE GROUP-ENTRY CAP, ASKED ONCE PER ENTRY — before the energy claim, before
 * ensureDecision, before anything is built.
 *
 * An entry is GROUP-SOURCED when the coin it buys is an unresolved nomination,
 * or when the Brain decision it carries came from a review of a coin that was
 * nominated at the time. Anything else is not this cap's business and gets
 * `{ group: false }`: every other gate applies to it exactly as before.
 *
 * A group-sourced entry must win a claim (3 per UTC day, NominationBook
 * claimEntry, written durably before it returns). Refused → that entry is
 * skipped and nothing else is. And an entry whose decision came from a
 * nominated review but whose nomination has since RESOLVED (its TTL ran out, a
 * reset) is refused too: there is no nomination left to claim against, and
 * letting it through uncounted is the one way this cap could be walked past.
 * Fail closed; the coin can still be bought later on its own tape merits.
 */
export function claimGroupEntry(
  book: Pick<NominationBook, "nominated" | "claimEntry">,
  intent: { kind: string; buyToken?: string; decisionId?: string },
  reviewedFor: (decisionId: string) => string | undefined,
): GroupEntryClaim {
  if (intent.kind !== "swap" || typeof intent.buyToken !== "string") return { group: false };
  const address = intent.buyToken.toLowerCase();
  let pendingNow = false;
  try {
    pendingNow = book.nominated(address) !== null;
  } catch {
    pendingNow = false;
  }
  const fromReview = typeof intent.decisionId === "string" && reviewedFor(intent.decisionId) === address;
  if (!pendingNow && !fromReview) return { group: false };
  if (!pendingNow) return { group: true, address, ok: false, why: "resolved" };
  let ok = false;
  try {
    ok = book.claimEntry(address) === true;
  } catch {
    ok = false;
  }
  return ok ? { group: true, address, ok: true } : { group: true, address, ok: false, why: "cap" };
}

/**
 * Worker-written, figure-free notes on why a position was left, by the exit
 * rule's CODE (strategies/reasons.ts `trench-exit`). The rule's own sentence
 * carries percentages and is never used. Deliberately no direction words that
 * would read as a result ("up", "profit", "loss").
 */
const EXIT_NOTES: Record<string, string> = {
  unpriceable: "couldn't get a clean price on it anymore",
  drain: "the liquidity was leaving",
  stop: "it kept sliding",
  take: "it had its run",
  aged: "it ran out of steam",
};
const BRAIN_EXIT_NOTE = "the setup stopped looking good";

/**
 * IS THIS SALE AN EXIT — the whole position, not a trim?
 *
 * "Out of that one" after a partial sale would be a lie, so only two shapes
 * count: a mechanical trencher exit (`trench-exit`, which always sells the
 * whole position — strategies/trencher.ts exitSize with `forced`), or a sale
 * of at least everything the tick's book showed held for that token. Anything
 * else is silence. Returns the token and the notes for the one line.
 */
export function groupExitOf(
  intent: { kind: string; sellToken?: string; buyToken?: string; sellAmountRaw?: bigint },
  why: { code: string; cause?: unknown } | null | undefined,
  heldRaw: bigint | null | undefined,
): { address: string; notes: string[] } | null {
  if (intent.kind !== "swap" || typeof intent.sellToken !== "string" || typeof intent.buyToken !== "string") return null;
  const address = intent.sellToken.toLowerCase();
  if (address === CASH.USDG.toLowerCase() || address === CASH.WETH.toLowerCase()) return null;
  if (intent.buyToken.toLowerCase() !== CASH.USDG.toLowerCase()) return null;
  if (why?.code === "trench-exit") {
    const note = typeof why.cause === "string" && Object.hasOwn(EXIT_NOTES, why.cause) ? EXIT_NOTES[why.cause]! : BRAIN_EXIT_NOTE;
    return { address, notes: [note] };
  }
  if (typeof intent.sellAmountRaw === "bigint" && typeof heldRaw === "bigint" && heldRaw > 0n && intent.sellAmountRaw >= heldRaw) {
    return { address, notes: [BRAIN_EXIT_NOTE] };
  }
  return null;
}
