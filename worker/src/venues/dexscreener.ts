/**
 * DexScreener — a second index for ONE question: which Robinhood Chain pools
 * trade this token?
 *
 * WHY IT EXISTS. A coin posted in a Telegram group is looked at through the
 * chain and GeckoTerminal (tg-coin-look.ts). On a bad day both fail at once —
 * the fleet's RPC rate-limited, GeckoTerminal's shared quota in cooldown — and
 * a real Robinhood coin with six figures of liquidity read as `unknown`, which
 * the chat side answers with silence. DexScreener is a separate index with its
 * own quota, so it is asked only then: when GeckoTerminal's page could not be
 * read, had not answered after two seconds (then beside it, so the look keeps
 * its bound), or, with the chain down too, showed nothing.
 *
 * SHAPE OF THE TRUST — the same as GeckoTerminal's. Everything here is a third
 * party's claim about a market. It may decide what a chat line SAYS about a
 * coin; it never decides what is bought. A nominated coin is still read from
 * GeckoTerminal's tape on the trading side, verified on chain by discovery, and
 * bounded by shouldEnter, a fresh Brain BUY, checkPolicy and the vault.
 *
 * ONLY ROBINHOOD CHAIN, ONLY THIS TOKEN. The request names the chain, and every
 * pair is checked again: another chain's pair, or a pair where this token is
 * only the quote side, is dropped. What is left is mapped onto GeckoPool so the
 * look classifies it with the same rules — with `buyers24h` null, because
 * DexScreener does not publish distinct buyers (null is unknown, never zero).
 *
 * Free and keyless (300 requests a minute on this endpoint); the look's own
 * allowance bounds how often it is asked.
 */

import { DATA } from "../../../packages/core/src/index";
import { readBoundedJson } from "../bounded-read";
import { emptyGeckoBuckets, GECKO_WINDOWS, type GeckoBucket, type GeckoPool } from "./geckoterminal";

const DEX_BASE = "https://api.dexscreener.com";

/** DexScreener's id for Robinhood Chain (packages/core DATA.dexScreenerChainId). */
export const DEX_CHAIN = DATA.dexScreenerChainId;

/** The dex id GeckoTerminal gives Uniswap v3 on Robinhood Chain — what the look reads as "a v3 pool trencher can buy through". */
const V3_DEX = "uniswap-v3-robinhood";

const ADDRESS = /^0x[0-9a-f]{40}$/;
const POOL_ID = /^0x[0-9a-f]{64}$/;

/** A number that arrived as a number or a string, or null — never NaN, never a silent 0. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const lower = (v: unknown): string => (typeof v === "string" ? v.toLowerCase() : "");

/**
 * One DexScreener pair as a GeckoPool, or null when it is not a Robinhood
 * Chain pair of `token` with `token` as the coin (the base side).
 *
 * The venue is named the way GeckoTerminal names it only when the pair says
 * so: Uniswap, labelled v3, with a 20-byte pair contract. A v4 pair (a 32-byte
 * pool id, or labelled v4) keeps its id and has no contract, like
 * GeckoTerminal's v4 rows. Anything else keeps DexScreener's own dex id, and
 * the look reads a pair it cannot place as saying nothing (`unknown`), never
 * as "no pool".
 */
export function parseDexPair(raw: unknown, token: string): GeckoPool | null {
  const p = obj(raw);
  if (lower(p.chainId) !== DEX_CHAIN) return null;
  const want = lower(token);
  if (!ADDRESS.test(want)) return null;
  const base = obj(p.baseToken);
  if (lower(base.address) !== want) return null;
  const id = lower(p.pairAddress);
  const isContract = ADDRESS.test(id);
  if (!isContract && !POOL_ID.test(id)) return null;

  const labels = Array.isArray(p.labels) ? p.labels.map(lower) : [];
  const dexId = lower(p.dexId);
  const uniswap = dexId.startsWith("uniswap");
  const v4 = !isContract || labels.includes("v4");
  const dex = uniswap && !v4 && labels.includes("v3") ? V3_DEX : uniswap && v4 ? "uniswap-v4-robinhood" : `${dexId || "unknown"}-robinhood`;

  const txns = obj(p.txns);
  const volume = obj(p.volume);
  const change = obj(p.priceChange);
  // DexScreener names its windows the way GeckoTerminal does: m5, h1, h6, h24.
  const buckets = emptyGeckoBuckets();
  for (const w of GECKO_WINDOWS) {
    const t = obj(txns[w]);
    const b: GeckoBucket = {
      changePct: num(change[w]),
      volumeUsd: num(volume[w]),
      buys: int(t.buys),
      sells: int(t.sells),
      // Not published by DexScreener: unknown, never zero.
      buyers: null,
      sellers: null,
    };
    buckets[w] = b;
  }
  const quote = obj(p.quoteToken);
  const symbol = typeof base.symbol === "string" ? base.symbol : "";
  const quoteSymbol = typeof quote.symbol === "string" ? quote.symbol : "";
  const createdMs = num(p.pairCreatedAt);

  return {
    poolId: id,
    poolAddress: isContract ? (id as `0x${string}`) : null,
    tokenAddress: want as `0x${string}`,
    // GeckoTerminal's label shape ("CHUMP / WETH"), so the name is read the same way.
    name: symbol ? `${symbol} / ${quoteSymbol}` : "",
    dex,
    priceUsd: num(p.priceUsd),
    reserveUsd: num(obj(p.liquidity).usd),
    fdvUsd: num(p.fdv),
    volume24hUsd: buckets.h24.volumeUsd,
    change24hPct: buckets.h24.changePct,
    change1hPct: buckets.h1.changePct,
    buys24h: buckets.h24.buys,
    sells24h: buckets.h24.sells,
    buyers24h: null,
    buckets,
    createdAt: createdMs !== null && createdMs > 0 ? Math.floor(createdMs / 1000) : null,
  };
}

/**
 * The Robinhood Chain pools of `token` DexScreener lists, or null when it could
 * not be asked (a refusal, an outage, a timeout, a changed shape). An empty
 * list is an answer: DexScreener lists no Robinhood pair of it — which a coin
 * still on a bonding curve may well look like there — so an empty list is
 * never read as "no pool".
 */
export async function readDexTokenPairs(
  token: string,
  opts: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<GeckoPool[] | null> {
  const want = typeof token === "string" ? token.toLowerCase() : "";
  // Validated before it becomes part of a URL: nothing but an address is spliced in.
  if (!ADDRESS.test(want)) return null;
  const f = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5_000);
  try {
    const res = await f(`${DEX_BASE}/tokens/v1/${DEX_CHAIN}/${want}`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const read = await readBoundedJson<unknown>(res);
    if (!read.ok) return null;
    // The v1 endpoint answers a bare array; the older shape wraps it in `pairs` (null for none).
    const body = read.value;
    const rows = Array.isArray(body) ? body : body && typeof body === "object" && "pairs" in body ? (body as { pairs: unknown }).pairs : undefined;
    if (rows === null) return [];
    if (!Array.isArray(rows)) return null;
    return rows.map((r) => parseDexPair(r, want)).filter((p): p is GeckoPool => p !== null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
