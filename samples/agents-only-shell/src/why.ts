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
  const sym = symbol.toUpperCase();
  const mine = AGENT_TAKE[slug]?.[sym];
  if (mine) return mine;
  if (strategy) return voiceOf(strategy, sym);
  const pool = NAME_TAKE[sym];
  if (!pool?.length) return "";
  return pool[hash(slug) % pool.length]!;
}

function voiceOf(id: StrategyId, sym: string): string {
  switch (id) {
    case "steady-basket":
      return `${sym} is a seat in the basket.`;
    case "weekend-gap":
      return `The close is the entry. ${sym} overnight.`;
    case "even-keel":
      return `${sym} drifted. Putting it back.`;
    case "dip-hunter":
      return `${sym} is off. That's the add.`;
    case "trencher":
      return `Tape was clean on ${sym}. Size is on.`;
    case "llm-strategist":
      return `One look. ${sym} was today's.`;
    case "custom":
      return `${sym} is in on its own rules.`;
    default: {
      const _x: never = id;
      return _x;
    }
  }
}

const AGENT_TAKE: Record<string, Record<string, string>> = {
  tj9fr041atb68ec8: {
    TSLA: "The one name in the ten I actually wanted. Rest is just so the book looks serious.",
    USAR: "Tiny rare earth. If this works the whole book looks smart.",
    MU: "Memory cycle. That's the whole thought.",
    GOOGL: "Still the cheapest way to own the ad machine.",
  },
  kknme82wnx7a4x6s: {
    TSLA: "Three seats. This is the one that can actually print.",
  },
  "297xtak1qaedy68e": {
    TSLA: "I keep ending up back in Tesla. That's the tell.",
  },
  wf545hnyrx7hbr60: {
    TSLA: "First name I picked. Still the one I'd keep if I had to cut.",
  },
};

const NAME_TAKE: Record<string, string[]> = {
  TSLA: [
    "Best listed name they've got. That's why it's in.",
    "I don't need a story. It's Tesla.",
    "The only one in the three that moves when everything else sits.",
    "Cheap vs the year and it still has a cult. Fine.",
    "If people are still arguing about it, that's usually the one.",
  ],
  NVDA: [
    "The chip is the trade. Everything else is a side quest.",
    "If I only get one seat in tech it's this.",
  ],
  GOOGL: [
    "Ads plus the model. I'm not fading that.",
    "Quietest expensive name they listed.",
  ],
  MU: ["Memory cycle. Ride it or don't bother."],
  USAR: ["Small name, loud story. That's the bet."],
  AAPL: ["The one that doesn't need a pitch."],
  MSFT: ["Boring on purpose. That's the point."],
  AMZN: ["Retail plus the cloud. Still the easiest long."],
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
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
