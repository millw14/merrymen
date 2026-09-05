import type { Thesis } from "./live";
import type { StrategyId } from "./strategy";

export type WhyView =
  | { kind: "buy"; symbol: string; size: number; weight: number; legs: number }
  | { kind: "sell"; symbol: string; size: number }
  | { kind: "hold"; symbol: string }
  | { kind: "park"; size: number }
  | { kind: "unpark"; size: number }
  | { kind: "other"; line: string };

export function parseWhy(t: Thesis): WhyView {
  const r = t.reason ?? "";
  const head = t.head ?? "";
  const dca = r.match(/into ([A-Z0-9]+), its (\d+)% of a (\d+)-leg/i);
  if (t.action === "buy" && t.symbol) {
    return {
      kind: "buy",
      symbol: t.symbol,
      size: t.sizeUsdg ?? 0,
      weight: dca ? Number(dca[2]) : 0,
      legs: dca ? Number(dca[3]) : 0,
    };
  }
  if (t.action === "sell" && t.symbol) {
    return { kind: "sell", symbol: t.symbol, size: t.sizeUsdg ?? 0 };
  }
  if (t.action === "hold" && t.symbol) {
    return { kind: "hold", symbol: t.symbol };
  }
  if (/parking/i.test(r) || /vault-deposit/i.test(head)) {
    return { kind: "park", size: t.sizeUsdg ?? 0 };
  }
  if (/pulling/i.test(r) || /vault-withdraw/i.test(head)) {
    return { kind: "unpark", size: t.sizeUsdg ?? 0 };
  }
  return { kind: "other", line: r || head };
}

/** Why they bought. Schedule size and book weight are not a thesis. */
export function isWhy(text: string | null | undefined): boolean {
  const r = (text ?? "").trim();
  if (!r) return false;
  if (/schedule says buy/i.test(r)) return false;
  if (/its \d+% of a \d+-leg/i.test(r)) return false;
  if (/^\d+% of a \d+-name book$/i.test(r)) return false;
  if (/idle above/i.test(r)) return false;
  if (/today's budget still allows/i.test(r)) return false;
  if (/parking it in the vault/i.test(r)) return false;
  if (/pulling .* from the vault/i.test(r)) return false;
  if (/under one tick/i.test(r)) return false;
  if (/parking idle cash/i.test(r)) return false;
  return true;
}

export function thesisLine(t: Thesis, standing?: string | null): string {
  if (isWhy(t.reason)) return shortWhy(t.reason!);
  if (isWhy(standing)) return shortWhy(standing!);
  return "";
}

/** A take on the name. Not the schedule, not the slice. */
export function takeFor(
  slug: string,
  symbol: string,
  posted?: string | null,
  standing?: string | null,
  strategy?: StrategyId,
): string {
  if (isWhy(posted)) return shortWhy(posted!);
  if (isWhy(standing)) return shortWhy(standing!);
  return posted || standing || "";
}

function shortWhy(text: string): string {
  const r = text.trim();
  if (r.length <= 90) return r;
  return `${r.slice(0, 87).trimEnd()}…`;
}

/** One line for the feed. Book weight is not a thesis — use thesisLine for that. */
export function whyLine(t: Thesis): string {
  const w = parseWhy(t);
  switch (w.kind) {
    case "buy":
      if (w.legs) return `${w.weight}% of a ${w.legs}-name book`;
      return t.reason && t.reason.length < 80 ? t.reason : `Bought ${w.symbol}`;
    case "sell":
      return t.reason && t.reason.length < 80 ? t.reason : `Sold ${w.symbol}`;
    case "hold":
      return t.reason && t.reason.length < 80 ? t.reason : `Holding ${w.symbol}`;
    case "park":
      return "Parking idle cash";
    case "unpark":
      return "Pulling cash to trade";
    case "other":
      return w.line;
    default: {
      const _x: never = w;
      return _x;
    }
  }
}

export function stampOf(t: Thesis): string | null {
  if (t.outcome === "refused" || t.outcome === "reverted") {
    const x = (t.outcomeText ?? "").toLowerCase();
    if (x.includes("drawdown")) return "breaker";
    if (x.includes("per-trade")) return "cap";
    if (x.includes("spending")) return "cap";
    if (x.includes("wall")) return "wall";
    return "blocked";
  }
  if (t.outcome === "landed" && t.paper) return "paper";
  if (t.paper) return "paper";
  return null;
}
