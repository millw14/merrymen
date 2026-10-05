import type { LiveToken } from "./live";

type Deployment = { chainId: number; contractAddress: string };
type Asset = { deployments: Deployment[]; currentMultiplier: string };
type Quote = {
  deployments: Deployment[];
  currency: string;
  bid: string;
  ask: string;
  generatedAt: string;
};
export type TokenQuote = {
  priceUsd: number;
  priceUpdatedAt: number;
  uiMultiplier: number;
};
let assetsCache: { expires: number; assets: Asset[] } | undefined;
let inFlight: Promise<Map<string, TokenQuote>> | undefined;

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok)
    throw new Error(`Quote request failed (${response.status})`);
  return response.json() as Promise<T>;
}
async function assets(): Promise<Asset[]> {
  if (assetsCache && assetsCache.expires > Date.now())
    return assetsCache.assets;
  const data = await json<{ assets: Asset[] }>("/api/venue?desk=quotes&doc=assets");
  if (!Array.isArray(data.assets)) throw new Error("Missing asset metadata");
  assetsCache = { assets: data.assets, expires: Date.now() + 300_000 };
  return data.assets;
}

/** Official issuer bid/ask midpoint, converted to token units using asset metadata.
 * https://docs.robinhood.com/chain/stock-token-apis/
 * A missing multiplier is unknown, not an implicit 1:1 conversion.
 */
export function loadTokenQuotes(): Promise<Map<string, TokenQuote>> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const result = new Map<string, TokenQuote>();
    try {
      const [metadata, data] = await Promise.all([
        assets(),
        json<{ quotes: Quote[] }>("/api/venue?desk=quotes&doc=prices"),
      ]);
      const multipliers = new Map<string, number>();
      for (const asset of metadata) {
        const multiplier = Number(asset.currentMultiplier);
        if (!Number.isFinite(multiplier) || multiplier <= 0) continue;
        for (const deployment of asset.deployments ?? []) {
          if (deployment.chainId === 4663)
            multipliers.set(
              deployment.contractAddress.toLowerCase(),
              multiplier,
            );
        }
      }
      for (const quote of data.quotes ?? []) {
        const bid = Number(quote.bid),
          ask = Number(quote.ask);
        const time = Date.parse(quote.generatedAt) / 1000;
        if (
          quote.currency !== "USD" ||
          !Number.isFinite(bid) ||
          !Number.isFinite(ask) ||
          bid <= 0 ||
          ask < bid ||
          !Number.isFinite(time)
        )
          continue;
        for (const deployment of quote.deployments ?? []) {
          if (deployment.chainId !== 4663) continue;
          const id = deployment.contractAddress.toLowerCase();
          const multiplier = multipliers.get(id);
          if (multiplier == null) continue;
          const priceUsd = ((bid + ask) / 2) * multiplier;
          if (Number.isFinite(priceUsd) && priceUsd > 0)
            result.set(id, {
              priceUsd,
              priceUpdatedAt: time,
              uiMultiplier: multiplier,
            });
        }
      }
    } catch (error) {
      console.warn("Could not refresh token quotes", error);
    }
    return result;
  })().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

export function applyTokenQuotes(
  tokens: LiveToken[],
  quotes: Map<string, TokenQuote>,
): LiveToken[] {
  return tokens.map((token) => {
    const quote = quotes.get(token.id.toLowerCase());
    return quote ? { ...token, ...quote, priceSource: "robinhood" } : token;
  });
}

let changesCache: { expires: number; values: Map<string, number> } | undefined;
/**
 * HOW LONG A PASS IS KEPT. One that read something, five minutes, as before. One
 * that read nothing, a minute: it was not kept at all, so while the chart venue
 * was down every caller — the market's clock, and the fresh clocks each sign-in
 * or sign-out starts (live-clocks.ts) — sent one request per stock straight back
 * at the endpoint failing.
 */
const CHANGES_READ_MS = 300_000;
const CHANGES_UNREAD_MS = 60_000;
/**
 * WHEN A PASS STOPS ASKING: nothing has answered yet and the last two failed.
 * That is the venue down, not a symbol it refused, and every stock left would
 * fail the same way. Once anything has answered, a failure is that symbol's own
 * and the pass carries on past it.
 */
const CHANGES_DOWN_AFTER = 2;

/**
 * Session return from the same underlying-equity source as the candles.
 *
 * A VENUE THAT IS DOWN COSTS FOUR REQUESTS, NOT ONE PER STOCK. The stocks are
 * asked for four at a time. Until one answers, a failure holds every worker
 * until the requests still out have said whether the venue is up, so nothing
 * more is sent past a failure into a venue that may be down. One answer among
 * them and all four carry on — a refused symbol is only that symbol. None, and
 * the pass ends there.
 */
export async function loadSessionChanges(
  tokens: LiveToken[],
): Promise<Map<string, number>> {
  if (changesCache && changesCache.expires > Date.now())
    return changesCache.values;
  const values = new Map<string, number>();
  const queue = tokens.filter((t) => t.kind !== "memecoin");
  const asked = queue.length > 0;
  let answered = 0;
  let failedInARow = 0;
  let out = 0;
  let settled: (() => void)[] = [];
  const down = () => answered === 0 && failedInARow >= CHANGES_DOWN_AFTER;
  /** The next stock to ask for, counted as out the moment it is handed over. */
  const next = async (): Promise<LiveToken | undefined> => {
    while (answered === 0 && failedInARow > 0 && out > 0)
      await new Promise<void>((resolve) => settled.push(resolve));
    const token = down() ? undefined : queue.shift();
    if (token) out++;
    return token;
  };
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let token = await next(); token; token = await next()) {
        try {
          const data = await json<{
            chart?: {
              result?: { meta?: { regularMarketChangePercent?: number } }[];
            };
          }>(
            `/api/venue?desk=chart&symbol=${encodeURIComponent(token.symbol)}&window=5D`,
          );
          answered++;
          failedInARow = 0;
          const change =
            data.chart?.result?.[0]?.meta?.regularMarketChangePercent;
          if (typeof change === "number" && Number.isFinite(change))
            values.set(token.id, change);
        } catch {
          /* An unavailable reference return stays unknown. */
          failedInARow++;
        } finally {
          out--;
          const waiting = settled;
          settled = [];
          for (const wake of waiting) wake();
        }
      }
    }),
  );
  if (values.size)
    changesCache = { expires: Date.now() + CHANGES_READ_MS, values };
  else if (asked)
    changesCache = { expires: Date.now() + CHANGES_UNREAD_MS, values };
  return values;
}
