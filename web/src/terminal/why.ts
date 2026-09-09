import type { Thesis } from "./live";

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

/**
 * THE LINE THAT GOES UNDER AN AGENT'S NAME — and it is only ever theirs.
 *
 * A real view wins; a standing view is the fallback; and if all this agent ever
 * published about the trade was the strategy narrating its own arithmetic
 * ("schedule says buy"), that is what shows. Mechanical is a true thing to say
 * about a mechanical trade, and hiding it would leave the row silent about a
 * decision that was in fact made by a rule.
 *
 * WHAT IT WILL NOT DO IS INVENT ONE. The prototype this came from took the
 * remaining case — an agent that published nothing — and filled it from a table
 * of hand-written quotes keyed by real production slugs, falling back to a
 * sentence generated from the strategy id. There is no such branch here and
 * there must never be: an agent that said nothing is reported as having said
 * nothing. `why.test.ts` pins that by name.
 *
 * It used to take `slug`, `symbol` and `strategy` and use none of them; those
 * were the arguments the fabrication branch needed, left behind when it went.
 */
export function takeFor(posted?: string | null, standing?: string | null): string {
  if (isWhy(posted)) return shortWhy(posted!);
  if (isWhy(standing)) return shortWhy(standing!);
  // Trimmed, because a row of spaces is not a sentence and the feed would
  // otherwise reserve space for one.
  return (posted ?? "").trim() || (standing ?? "").trim() || "";
}

function shortWhy(text: string): string {
  const r = text.trim();
  if (r.length <= 90) return r;
  return `${r.slice(0, 87).trimEnd()}…`;
}

/** One line for the feed. Book weight is not a thesis — use thesisLine for that. */
export function whyLine(t: Thesis): string {
  const w = parseWhy(t);
  // Only reached when the row published no usable reason, so this is the
  // fallback sentence — and a fallback still may not claim a trade happened.
  const shadow = t.shadow === true || t.outcome === "shadow";
  switch (w.kind) {
    case "buy":
      if (w.legs) return `${w.weight}% of a ${w.legs}-name book`;
      return t.reason && t.reason.length < 80
        ? t.reason
        : `${shadow ? "Would buy" : "Bought"} ${w.symbol}`;
    case "sell":
      return t.reason && t.reason.length < 80
        ? t.reason
        : `${shadow ? "Would sell" : "Sold"} ${w.symbol}`;
    case "hold":
      return t.reason && t.reason.length < 80
        ? t.reason
        : `${shadow ? "Would hold" : "Holding"} ${w.symbol}`;
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
  // FIRST, BEFORE EVERY OTHER ARM. A shadow row carries a real action and a
  // real size, so any check below it would classify it as something that
  // happened. `thesis-badge.ts` orders its own check the same way and says why:
  // otherwise a shadow buy renders as "BUYING".
  if (t.shadow === true || t.outcome === "shadow") return "shadow";
  // `dropped` BELONGS WITH THE OTHER TWO. It is the third way a decision
  // comes to nothing, and leaving it out sent a dropped row to the paper/null
  // arms below — so a decision the agent thought better of got the same stamp
  // as one that filled, or no stamp at all. Same union, same treatment; only
  // the words downstream differ.
  if (t.outcome === "refused" || t.outcome === "reverted" || t.outcome === "dropped") {
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
