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
  const data = await json<{ assets: Asset[] }>("/robinhood/assets");
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
        json<{ quotes: Quote[] }>("/robinhood/prices"),
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
/** Session return from the same underlying-equity source as the candles. */
export async function loadSessionChanges(
  tokens: LiveToken[],
): Promise<Map<string, number>> {
  if (changesCache && changesCache.expires > Date.now())
    return changesCache.values;
  const values = new Map<string, number>();
  const queue = tokens.filter((t) => t.kind !== "memecoin");
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let token = queue.shift(); token; token = queue.shift()) {
        try {
          const data = await json<{
            chart?: {
              result?: { meta?: { regularMarketChangePercent?: number } }[];
            };
          }>(
            `/yahoo/v8/finance/chart/${encodeURIComponent(token.symbol)}?interval=1d&range=5d`,
          );
          const change =
            data.chart?.result?.[0]?.meta?.regularMarketChangePercent;
          if (typeof change === "number" && Number.isFinite(change))
            values.set(token.id, change);
        } catch {
          /* An unavailable reference return stays unknown. */
        }
      }
    }),
  );
  if (values.size) changesCache = { expires: Date.now() + 300_000, values };
  return values;
}
