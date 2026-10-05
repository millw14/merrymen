/**
 * WHAT AN IN-KIND MOVEMENT WAS WORTH — TWO FIGURES, AND ONLY ONE OF THEM A CANDIDATE.
 *
 * A movement of TSLA or a memecoin has no dollar amount on it. A reviewer
 * deciding whether it was the owner's capital needs one, and there are exactly
 * two honest sources, which are NOT the same quality of claim:
 *
 *   V1  THE CHAINLINK ROUND IN FORCE when the movement's block was sealed.
 *       Read from current state with getRoundData (gas-backfill.ts explains why
 *       no archive node is needed), bounded by the same six-hour staleness rule
 *       and the same successor-round proof the receipt gas preview uses. It is
 *       reported as a CANDIDATE: the figure a later, separately reviewed step
 *       could consider. Only assets with a registered feed get one — ETH, WETH
 *       and the issuer-backed stock tokens. A memecoin has none, by design.
 *
 *   V2  THE EQUITY STEP across the movement: the book's last mark before it
 *       against its first mark after it. It is labelled "estimate, never
 *       bookable" and that label is the point. The interval also holds price
 *       moves, trades and gas, and when the marks were themselves written from
 *       the flows under review the figure is circular — booking it would be
 *       booking the number the review exists to question.
 *
 * READ ONLY. The RPC transport below admits a fixed list of read methods and
 * refuses everything else before a request leaves the process; there is no
 * signer, no eth_sendRawTransaction, and no state-changing call it could make.
 */
import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import { CASH, CASH_FEEDS, CHAINLINK_ABI, NATIVE_ASSET, STOCK_ABI, STOCK_TOKENS } from "../../packages/core/src/index.ts";
import { findRoundAt, MAX_ROUND_LAG_SEC, type FeedRound } from "../../worker/src/gas-backfill.ts";
import { classifyRpcError, type RpcCall } from "../../worker/src/chain-capital.ts";

/** Every method this preview may ask a node. Nothing that writes is on it. */
export const RPC_METHODS = Object.freeze([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getLogs",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
  "eth_call",
]);

/**
 * The only chain transport the preview uses. Method allowlist, eight-second
 * deadline, strict JSON-RPC envelope — and FIXED error text, because a node's
 * own error can echo the URL, and a URL can carry a key.
 *
 * The node's refusal words are kept only as the coarse class the scanner's
 * backoff needs ("429", "exceeds limit"); nothing else of them survives. WHICH
 * words make which class is chain-capital's classifyRpcError, read on the raw
 * message before it is replaced, so the two readers share one definition. A
 * private list here once dropped the Robinhood node's block-span refusal
 * ("query spans N blocks … only 10000000 are allowed for this request"): the
 * scanner then waited out a refusal that waiting cannot fix, never split the
 * range, and the default run from block 0 came back with every sweep UNREAD.
 */
export function createReadOnlyRpc(url: string, fetchImpl: typeof fetch = fetch): RpcCall {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("unsupported-rpc-url");
  let id = 0;
  return async (method, params) => {
    if (!RPC_METHODS.includes(method)) throw new Error("rpc-method-outside-read-allowlist");
    const requestId = ++id;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
    });
    if (response.status === 429) throw new Error("rpc rate limit (429)");
    if (!response.ok) throw new Error("rpc-unavailable");
    const body = (await response.json()) as { jsonrpc?: string; id?: number; result?: unknown; error?: { message?: unknown } };
    if (body.error) {
      const refusal = classifyRpcError(String(body.error.message ?? ""));
      if (refusal === "too-many-results") {
        throw new Error("rpc refused: query returned more than the node allows (exceeds limit)");
      }
      if (refusal === "rate-limited") throw new Error("rpc rate limit (429)");
      throw new Error("rpc-read-failed");
    }
    if (body.jsonrpc !== "2.0" || body.id !== requestId || !Object.hasOwn(body, "result")) throw new Error("rpc-read-failed");
    return body.result;
  };
}

/** A published round with its exact answer kept beside the float the search runs on. */
export interface ExactRound extends FeedRound {
  answer: bigint;
  decimals: number;
}

/** The three reads valuation needs, all `eth_call` at the latest block. */
export interface ValuationReads {
  latestRound(feed: string): Promise<ExactRound | null>;
  round(feed: string, id: bigint): Promise<ExactRound | null>;
  /** ERC-8056 multiplier, read at HEAD — the chain keeps no history of it. */
  uiMultiplier(token: string): Promise<bigint | null>;
}

export function valuationReads(rpc: RpcCall): ValuationReads {
  const decimals = new Map<string, Promise<number | null>>();
  const call = async (to: string, data: Hex) => (await rpc("eth_call", [{ to, data }, "latest"])) as Hex;
  const decimalsOf = (feed: string) => {
    const key = feed.toLowerCase();
    if (!decimals.has(key)) {
      const pending = call(feed, encodeFunctionData({ abi: CHAINLINK_ABI, functionName: "decimals" }))
        .then((r) => Number(decodeFunctionResult({ abi: CHAINLINK_ABI, functionName: "decimals", data: r })))
        .catch(() => null);
      decimals.set(key, pending);
      // A failed read is not cached as the answer.
      void pending.then((d) => d === null && decimals.delete(key));
    }
    return decimals.get(key)!;
  };
  const read = async (feed: string, id?: bigint): Promise<ExactRound | null> => {
    try {
      const places = await decimalsOf(feed);
      const raw =
        id === undefined
          ? await call(feed, encodeFunctionData({ abi: CHAINLINK_ABI, functionName: "latestRoundData" }))
          : await call(feed, encodeFunctionData({ abi: CHAINLINK_ABI, functionName: "getRoundData", args: [id] }));
      const [roundId, answer, , updatedAt, answeredInRound] = decodeFunctionResult({
        abi: CHAINLINK_ABI,
        functionName: id === undefined ? "latestRoundData" : "getRoundData",
        data: raw,
      }) as readonly [bigint, bigint, bigint, bigint, bigint];
      // The same refusals as the receipt preview's reader: an unset, negative,
      // carried-over or mismatched round is not a price.
      if (places === null || places < 0 || places > 18 || roundId <= 0n || answer <= 0n || updatedAt <= 0n ||
          answeredInRound < roundId || (id !== undefined && roundId !== id)) return null;
      const at = Number(updatedAt);
      const priceUsd = Number(answer) / 10 ** places;
      if (!Number.isSafeInteger(at) || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;
      return { roundId, priceUsd, updatedAt: at, answer, decimals: places };
    } catch {
      return null;
    }
  };
  return {
    latestRound: (feed) => read(feed),
    round: (feed, id) => read(feed, id),
    uiMultiplier: async (token) => {
      try {
        const raw = await call(token, encodeFunctionData({ abi: STOCK_ABI, functionName: "uiMultiplier" }));
        const m = decodeFunctionResult({ abi: STOCK_ABI, functionName: "uiMultiplier", data: raw }) as bigint;
        return m > 0n ? m : null;
      } catch {
        return null;
      }
    },
  };
}

/** Which registered feed values this asset, and in what unit. Null: no feed, by design. */
export function feedFor(
  asset: string,
): { symbol: string; feed: string; tokenDecimals: number; multiplier: "none" | "erc8056" } | null {
  const a = asset.toLowerCase();
  if (a === NATIVE_ASSET) return { symbol: "ETH", feed: CASH_FEEDS.ETH_USD, tokenDecimals: 18, multiplier: "none" };
  if (a === CASH.WETH.toLowerCase()) return { symbol: "WETH", feed: CASH_FEEDS.ETH_USD, tokenDecimals: 18, multiplier: "none" };
  const stock = STOCK_TOKENS.find((t) => t.address.toLowerCase() === a);
  if (!stock || !stock.chainlinkFeed || stock.kind === "memecoin") return null;
  // Chainlink stock feeds quote per ERC-8056 UI share, so the multiplier
  // applies (positions.ts valuationMultiplierFor, "chainlink").
  return { symbol: stock.symbol, feed: stock.chainlinkFeed, tokenDecimals: stock.decimals ?? 18, multiplier: "erc8056" };
}

export type V1Valuation =
  | {
      basis: "V1";
      status: "candidate";
      label: "candidate";
      symbol: string;
      feed: string;
      roundId: string;
      /** The round's answer exactly as published, with its decimals. */
      answer: string;
      feedDecimals: number;
      publishedAt: number;
      /** Seconds the round was already old when the movement's block was sealed. */
      lagSec: number;
      /** How the round was proved to still be in force at the movement. */
      boundary: "latest-round" | "successor-published-after";
      /** ERC-8056 multiplier, read at head; null for ETH and WETH. */
      multiplier: { raw: string; readAt: "head" } | null;
      /** USDG base units (6dp), floored. Never a float. */
      valueUsdgRaw: string;
      why: string;
    }
  | { basis: "V1"; status: "unavailable"; why: string };

/**
 * V1: the asset's value at the Chainlink round in force when the movement
 * landed. Every way of not knowing is its own sentence, never a zero.
 */
export async function valueAtRoundInForce(args: {
  asset: string;
  amountRaw: string;
  /** The movement's confirmed block time. Undefined when it could not be read. */
  at: number | undefined;
  reads: ValuationReads;
}): Promise<V1Valuation> {
  const unavailable = (why: string): V1Valuation => ({ basis: "V1", status: "unavailable", why });
  const source = feedFor(args.asset);
  if (!source) return unavailable("no registered Chainlink feed values this asset — only V2 applies, and it is never bookable");
  if (args.at === undefined) return unavailable("the movement's block time could not be read");
  let amount: bigint;
  try {
    amount = BigInt(args.amountRaw);
  } catch {
    return unavailable("the movement's amount is not an integer");
  }
  if (amount <= 0n) return unavailable("the movement moved nothing");

  const latest = await args.reads.latestRound(source.feed);
  if (!latest) return unavailable("the feed's latest round could not be read");
  // The search returns one of the rounds `round` produced; keep the exact ones.
  const seen = new Map<string, ExactRound>([[latest.roundId.toString(), latest]]);
  const found = await findRoundAt(args.at, latest, async (id) => {
    const r = await args.reads.round(source.feed, id);
    if (r) seen.set(r.roundId.toString(), r);
    return r;
  });
  const round = found ? seen.get(found.roundId.toString()) : undefined;
  if (!round) return unavailable("no published round at or before the movement");
  const lagSec = args.at - round.updatedAt;
  if (lagSec < 0) return unavailable(`round ${round.roundId} was published after the movement`);
  if (lagSec > MAX_ROUND_LAG_SEC) {
    return unavailable(
      `the newest round at the time was ${Math.round(lagSec / 3600)}h old — the feed was not tracking the market ` +
        `(a weekend, for a stock feed), so there is no candidate rather than a bad one`,
    );
  }
  // A skipped or unread round inside the search cannot prove the chosen one
  // still governed this block. Its immediate successor must have been
  // published after the movement; the receipt gas preview applies the same rule.
  let boundary: "latest-round" | "successor-published-after";
  if (round.roundId === latest.roundId) boundary = "latest-round";
  else {
    const next = await args.reads.round(source.feed, round.roundId + 1n);
    if (!next || next.roundId !== round.roundId + 1n || next.updatedAt <= args.at) {
      return unavailable(`the round after ${round.roundId} could not prove that round was still in force at the movement`);
    }
    boundary = "successor-published-after";
  }

  let multiplier = 10n ** 18n;
  if (source.multiplier === "erc8056") {
    const m = await args.reads.uiMultiplier(args.asset);
    if (m === null) return unavailable("the token's ERC-8056 multiplier could not be read");
    multiplier = m;
  }
  // amount (tokenDecimals) × multiplier (1e18) × answer (feedDecimals) → USDG (6dp)
  const valueUsdgRaw =
    (amount * multiplier * round.answer * 10n ** 6n) /
    (10n ** BigInt(source.tokenDecimals) * 10n ** 18n * 10n ** BigInt(round.decimals));
  return {
    basis: "V1",
    status: "candidate",
    label: "candidate",
    symbol: source.symbol,
    feed: source.feed,
    roundId: round.roundId.toString(),
    answer: round.answer.toString(),
    feedDecimals: round.decimals,
    publishedAt: round.updatedAt,
    lagSec,
    boundary,
    multiplier: source.multiplier === "erc8056" ? { raw: multiplier.toString(), readAt: "head" } : null,
    valueUsdgRaw: valueUsdgRaw.toString(),
    why:
      `${source.symbol} at the ${source.feed} round in force (${Math.round(lagSec / 60)} minutes old)` +
      (source.multiplier === "erc8056"
        ? " — the ERC-8056 multiplier is today's; a corporate action since the movement would change it"
        : ""),
  };
}

/** One equity mark of the funded book, as the snapshot read it. */
export interface EquityMark {
  at: number;
  equityUsdg: number;
  epoch: number;
  mode: string | null;
}

export type V2Estimate =
  | {
      basis: "V2";
      label: "estimate, never bookable";
      bookable: false;
      status: "estimate";
      before: EquityMark;
      after: EquityMark;
      /** after − before, in USDG, rounded to 6dp. Includes everything else in the interval. */
      stepUsdg: number;
      intervalSec: number;
      sameEpoch: boolean;
      why: string;
    }
  | { basis: "V2"; label: "estimate, never bookable"; bookable: false; status: "unavailable"; why: string };

/**
 * V2: the book's equity step across the movement. PURE.
 *
 * Marks at exactly the movement's second are skipped on both sides: whether
 * such a mark saw the movement or not is unknowable from the row.
 */
export function equityStepEstimate(marks: readonly EquityMark[], at: number | undefined): V2Estimate {
  const label = "estimate, never bookable" as const;
  if (at === undefined) return { basis: "V2", label, bookable: false, status: "unavailable", why: "the movement's block time could not be read" };
  const usable = marks.filter((m) => m.mode !== "paper" && Number.isFinite(m.equityUsdg) && Number.isSafeInteger(m.at));
  let before: EquityMark | undefined;
  let after: EquityMark | undefined;
  for (const m of usable) {
    if (m.at < at && (!before || m.at >= before.at)) before = m;
    if (m.at > at && (!after || m.at < after.at)) after = m;
  }
  if (!before || !after) {
    return {
      basis: "V2",
      label,
      bookable: false,
      status: "unavailable",
      why: !before ? "no funded-book mark before the movement" : "no funded-book mark after the movement",
    };
  }
  const sameEpoch = before.epoch === after.epoch;
  return {
    basis: "V2",
    label,
    bookable: false,
    status: "estimate",
    before,
    after,
    stepUsdg: Math.round((after.equityUsdg - before.equityUsdg) * 1e6) / 1e6,
    intervalSec: after.at - before.at,
    sameEpoch,
    why:
      `equity moved ${(after.equityUsdg - before.equityUsdg).toFixed(6)} USDG across ${after.at - before.at}s around this ` +
      `movement — that interval also holds price moves, trades and gas, and marks written from the flows under review ` +
      `make it circular` +
      (sameEpoch ? "" : "; the two marks are from different epochs, so a carry sits inside the step"),
  };
}
