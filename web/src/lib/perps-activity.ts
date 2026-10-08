/** Client-safe wire contract: amounts stay exact decimal strings. */
import { perpMarketByKey } from "@merrymen/core";
export interface PerpsActivityQuery { market: string; book: "paper" | "live" }
interface ActivityBase extends PerpsActivityQuery { id: string; timeMs: number }
export type PerpsActivityItem = (ActivityBase & {
  /** For reduce/close/reverse, side is the prior position being closed; size is the full execution. */
  kind: "fill"; side: "long" | "short"; effect: "open" | "add" | "reduce" | "close" | "reverse" | "unknown";
  priceExact: string; sizeExact: string; realizedMicro: string | null; feeMicro: string; attribution: string; tradeType: string;
}) | (ActivityBase & { kind: "funding"; paymentMicro: string });
export interface PerpsActivityResponse extends PerpsActivityQuery {
  state: "ok" | "unreadable" | "not-configured"; generatedAtMs: number;
  items: PerpsActivityItem[]; unknownRows: number; truncated: boolean;
}
export function perpsActivityQuery(url: string): PerpsActivityQuery | null {
  const p = new URL(url).searchParams, market = p.get("market"), book = p.get("book");
  return p.size === 2 && market && (market === "all" || perpMarketByKey(market)) && (book === "paper" || book === "live") ? { market, book } : null;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is string => typeof value === "string" && value.length <= 100 && /^-?\d+$/.test(value);
const positive = (value: unknown): value is string => typeof value === "string" && value.length <= 100 && /^\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 0;
export function readPerpsActivity(raw: unknown, q: PerpsActivityQuery): PerpsActivityResponse | null {
  if (!record(raw) || raw.market !== q.market || raw.book !== q.book || !["ok", "unreadable", "not-configured"].includes(String(raw.state)) ||
      typeof raw.generatedAtMs !== "number" || !Number.isSafeInteger(raw.generatedAtMs) || raw.generatedAtMs <= 0 ||
      typeof raw.unknownRows !== "number" || !Number.isSafeInteger(raw.unknownRows) || raw.unknownRows < 0 || typeof raw.truncated !== "boolean" || !Array.isArray(raw.items) || raw.items.length > 100) return null;
  const ids = new Set<string>(); let prior = Infinity;
  for (const item of raw.items) {
    if (!record(item) || (q.market === "all" ? typeof item.market !== "string" || !perpMarketByKey(item.market) : item.market !== q.market) || item.book !== q.book || typeof item.id !== "string" || !item.id || ids.has(item.id) ||
        typeof item.timeMs !== "number" || !Number.isSafeInteger(item.timeMs) || item.timeMs > raw.generatedAtMs || item.timeMs < raw.generatedAtMs - 30 * 86400_000 || item.timeMs > prior) return null;
    if (item.kind === "fill") {
      if (!["long", "short"].includes(String(item.side)) || !["open", "add", "reduce", "close", "reverse", "unknown"].includes(String(item.effect)) ||
          !positive(item.priceExact) || !positive(item.sizeExact) || !integer(item.feeMicro) || (item.realizedMicro !== null && !integer(item.realizedMicro)) || typeof item.attribution !== "string" || typeof item.tradeType !== "string") return null;
    } else if (item.kind !== "funding" || !integer(item.paymentMicro)) return null;
    ids.add(item.id); prior = item.timeMs;
  }
  if (raw.state !== "ok" && raw.items.length) return null;
  return raw as unknown as PerpsActivityResponse;
}
