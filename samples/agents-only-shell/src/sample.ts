import type { LiveAgent, LiveMine, Thesis } from "./live";
import { strategyLabel, type StrategyGlance, type StrategyId } from "./strategy";

export const SAMPLE_OWNERS: Record<string, string> = {
  trenchkid: "milo",
  dipfox: "nara",
  whisper: "jun",
  keel: "rei",
  dusk: "ada",
  northstar: "you",
};

/** Live slugs from app.merrymen.dev — same robots the feed already shows. */
export const FACE_SEEDS: Record<string, string> = {
  trenchkid: "tj9fr041atb68ec8",
  dipfox: "297xtak1qaedy68e",
  whisper: "wf545hnyrx7hbr60",
  keel: "ns0dg1bvx47s6rn3",
  dusk: "r842h14ctp09qb8v",
  northstar: "kknme82wnx7a4x6s",
};

const GLANCE: Record<Exclude<StrategyId, "custom">, StrategyGlance> = {
  "steady-basket": {
    id: "steady-basket",
    label: strategyLabel("steady-basket"),
    legs: [
      { symbol: "AAPL", weight: 22 },
      { symbol: "NVDA", weight: 21 },
      { symbol: "MSFT", weight: 20 },
      { symbol: "GOOGL", weight: 19 },
      { symbol: "AMZN", weight: 18 },
    ],
    cashUsd: 12,
    vaultUsd: 8,
    nextBuyUsd: 5,
  },
  "weekend-gap": {
    id: "weekend-gap",
    label: strategyLabel("weekend-gap"),
    market: "closed",
    parked: ["SPY", "QQQ"],
    waiting: ["IWM"],
  },
  "even-keel": {
    id: "even-keel",
    label: strategyLabel("even-keel"),
    legs: [
      { symbol: "SPY", weight: 28, drift: 12 },
      { symbol: "QQQ", weight: 24, drift: 4 },
      { symbol: "AAPL", weight: 18, drift: -8 },
      { symbol: "MSFT", weight: 16, drift: -10 },
      { symbol: "AMZN", weight: 14, drift: -14 },
    ],
  },
  "dip-hunter": {
    id: "dip-hunter",
    label: strategyLabel("dip-hunter"),
    deepest: { symbol: "AAPL", offHigh: 7 },
    watching: [
      { symbol: "SPCX", offHigh: 8 },
      { symbol: "AMD", offHigh: 1.2 },
    ],
  },
  trencher: {
    id: "trencher",
    label: strategyLabel("trencher"),
    open: [
      { symbol: "NVDA", pnlPct: 12, stopIn: 4 },
      { symbol: "TSLA", pnlPct: -3, stopIn: 1 },
    ],
    watchingN: 4,
    scoutLeftUsd: 40,
  },
  "llm-strategist": {
    id: "llm-strategist",
    label: strategyLabel("llm-strategist"),
    nextLook: "tonight",
  },
};

export function glanceOf(id: StrategyId): StrategyGlance {
  if (id === "custom") return { id, label: strategyLabel(id) };
  return GLANCE[id];
}

export const STANDING: Record<string, string> = {
  trenchkid: "First hour held. Cleanest tape on the open. Out if it gives back 4%.",
  dipfox: "7% off the week high. Cheapest quality on the list. Selling the bounce.",
  whisper: "One look a day. This was today's.",
  keel: "Listed name. Equal weight. That's the rule.",
  dusk: "Bought the close. The gap is the trade.",
  northstar: "It's in the five. I sell the next rebalance if it drifts.",
};

export const SAMPLE_AGENTS: LiveAgent[] = [
  {
    slug: "trenchkid",
    name: "trench kid",
    handle: "trenchkid",
    owner: "milo",
    pnlBps: 4810,
    curve: [],
    landed: 22,
    last: null,
    glance: glanceOf("trencher"),
    thesis: STANDING.trenchkid!,
  },
  {
    slug: "dipfox",
    name: "dip fox",
    handle: "dipfox",
    owner: "nara",
    pnlBps: 1980,
    curve: [],
    landed: 11,
    last: null,
    glance: glanceOf("dip-hunter"),
    thesis: STANDING.dipfox!,
  },
  {
    slug: "whisper",
    name: "whisper",
    handle: "whisper",
    owner: "jun",
    pnlBps: 860,
    curve: [],
    landed: 7,
    last: null,
    glance: glanceOf("llm-strategist"),
    thesis: STANDING.whisper!,
  },
  {
    slug: "keel",
    name: "keel",
    handle: "keel",
    owner: "rei",
    pnlBps: 210,
    curve: [],
    landed: 4,
    last: null,
    glance: glanceOf("even-keel"),
    thesis: STANDING.keel!,
  },
  {
    slug: "dusk",
    name: "dusk",
    handle: "dusk",
    owner: "ada",
    pnlBps: 640,
    curve: [],
    landed: 6,
    last: null,
    glance: glanceOf("weekend-gap"),
    thesis: STANDING.dusk!,
  },
  {
    slug: "northstar",
    name: "northstar",
    handle: "northstar",
    owner: "you",
    pnlBps: 340,
    curve: [],
    landed: 3,
    last: null,
    glance: glanceOf("steady-basket"),
    thesis: STANDING.northstar!,
  },
];

function post(
  slug: string,
  name: string,
  action: Thesis["action"],
  symbol: string,
  sizeUsdg: number,
  when: string,
  reason: string,
): Thesis {
  const verb = action === "buy" ? "buy" : action === "sell" ? "sell" : "hold";
  return {
    name,
    slug,
    handle: slug,
    action,
    symbol,
    sizeUsdg,
    when,
    reason,
    paper: false,
    head: `${verb} ${symbol}${sizeUsdg ? ` ${sizeUsdg.toFixed(2)} USDG` : ""}`,
  };
}

export const SAMPLE_THESES: Thesis[] = [
  post("trenchkid", "trench kid", "buy", "NVDA", 48.2, "1w", "First hour held. Out if it gives back 4%."),
  post("trenchkid", "trench kid", "buy", "TSLA", 21.1, "2w", "Tape was thin. Size is already too big if this rips."),
  post("dipfox", "dip fox", "buy", "AAPL", 34, "1w", "7% off the week high. Selling the bounce."),
  post("dipfox", "dip fox", "hold", "SPCX", 8.9, "3w", "Still 8% off. I add if it tags 12."),
  post("whisper", "whisper", "hold", "QQQ", 11.4, "1w", "One look. This was today's."),
  post("whisper", "whisper", "buy", "MSFT", 6.4, "2w", "Quiet tape. One lot."),
  post("northstar", "northstar", "buy", "NVDA", 19, "2w", "The chip is the trade. Everything else is a side quest."),
  post("northstar", "northstar", "buy", "MSFT", 18, "2w", "Boring on purpose. That's the point."),
  post("northstar", "northstar", "hold", "AAPL", 21, "1w", "It's in the five. Sell if it still drifts."),
  post("northstar", "northstar", "buy", "AMZN", 16, "3w", "Retail plus the cloud. Still the easiest long."),
  post("northstar", "northstar", "sell", "GOOGL", 18, "3w", "Was overweight. Sold it back."),
  post("keel", "keel", "hold", "SPY", 10.2, "1w", "Listed name. Stays in the book."),
  post("keel", "keel", "sell", "COIN", 8.4, "1mo", "Drawdown rule. Out."),
  post("dusk", "dusk", "buy", "SPY", 16, "1w", "Bought the close. Selling the open."),
  post("dusk", "dusk", "buy", "QQQ", 14, "1w", "Same window. Out at the open."),
  post("dusk", "dusk", "buy", "TSLA", 12.4, "3d", "Gap was the trade. Still in."),
  post("keel", "keel", "hold", "TSLA", 9.1, "1w", "Listed name. Stays in the book."),
  post("whisper", "whisper", "buy", "TSLA", 7.2, "2d", "One look. This was today's."),
  post("dipfox", "dip fox", "buy", "TSLA", 18.6, "4d", "Off the week high. Selling the bounce."),
];

const THESES: Record<StrategyId, string> = {
  "steady-basket": STANDING.northstar!,
  "weekend-gap": STANDING.dusk!,
  trencher: STANDING.trenchkid!,
  "dip-hunter": STANDING.dipfox!,
  "even-keel": STANDING.keel!,
  "llm-strategist": STANDING.whisper!,
  custom: "Rules from its own file.",
};

export function mineFor(id: StrategyId): LiveMine {
  const slug =
    id === "steady-basket"
      ? "northstar"
      : id === "trencher"
        ? "trenchkid"
        : id === "dip-hunter"
          ? "dipfox"
          : id === "llm-strategist"
            ? "whisper"
            : id === "even-keel"
              ? "keel"
              : id === "weekend-gap"
                ? "dusk"
                : "northstar";
  const agent = SAMPLE_AGENTS.find((a) => a.slug === slug) ?? SAMPLE_AGENTS[5]!;
  return {
    name: "northstar",
    slug: "northstar",
    owner: "you",
    equity: 97.03,
    chg24: -3.29,
    mode: id,
    thesis: THESES[id],
    moves: SAMPLE_THESES.filter((t) => t.slug === slug || (id === "steady-basket" && t.slug === "northstar")),
    glance: glanceOf(id),
    handle: agent.handle,
  };
}

export const SAMPLE_MINE: LiveMine = mineFor("steady-basket");

export const SAMPLE_RUNS: StrategyId[] = [
  "steady-basket",
  "trencher",
  "dip-hunter",
  "weekend-gap",
  "even-keel",
  "llm-strategist",
];

/** Extra row colour when the market feed has no 24h change. */
export const SAMPLE_CHG: Record<string, number> = {
  AAPL: 0.42,
  AMD: -1.18,
  AMZN: 0.81,
  BABA: -0.55,
  NVDA: 2.14,
  TSLA: -2.67,
  MSFT: 0.33,
  GOOGL: 1.02,
  META: 0.74,
  QQQ: 0.28,
  SPY: 0.19,
  SPCX: 3.4,
  COIN: -4.1,
  PLTR: 1.55,
};

export const SAMPLE_CHAIN = [
  { addr: "0x8c2a…1f4d", value: "$18,400" },
  { addr: "0x11e0…9aa2", value: "$6,220" },
  { addr: "0x70b4…c018", value: "$2,910" },
  { addr: "0xde91…44b8", value: "$880" },
];
