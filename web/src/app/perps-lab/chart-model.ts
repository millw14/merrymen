/** Fictional, fixed data for the visual comparison route. Never use as a venue quote. */
export type SampleTick = { at: number; price: number };
export type SampleEntry = {
  id: string;
  agent: string;
  side: "long" | "short";
  at: number;
  price: number;
  note: string;
};

const START = Date.UTC(2026, 9, 7, 9, 0);
const PRICES = [
  68142, 68180, 68155, 68232, 68285, 68250, 68312, 68376, 68344,
  68432, 68405, 68480, 68522, 68491, 68570, 68538, 68610, 68672,
  68642, 68592, 68654, 68720, 68682, 68734, 68792, 68743, 68698,
  68750, 68810, 68785, 68842, 68814, 68888, 68930, 68894, 68962,
  68938,
];

export const SAMPLE_TICKS: readonly SampleTick[] = PRICES.map((price, index) => ({
  at: START + index * 5 * 60_000,
  price,
}));

// Entry price is the sampled chart price at the entry timestamp. A real chart
// must instead use the venue's actual fill time/price, or say it is unknown.
export const SAMPLE_ENTRIES: readonly SampleEntry[] = [
  { id: "north", agent: "Northstar", side: "long", at: SAMPLE_TICKS[7]!.at, price: SAMPLE_TICKS[7]!.price, note: "Sample: trend confirmed after a higher low." },
  { id: "vector", agent: "Vector", side: "short", at: SAMPLE_TICKS[24]!.at, price: SAMPLE_TICKS[24]!.price, note: "Sample: faded a move into the upper band." },
];

export const CHART = { width: 900, height: 328, left: 58, right: 72, top: 20, bottom: 42 } as const;

export function sampleDomain(ticks: readonly SampleTick[]) {
  if (ticks.length === 0) throw new Error("A sample chart needs price ticks");
  const prices = ticks.map((tick) => tick.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const padding = Math.max((max - min) * 0.13, 1);
  return { minTime: ticks[0]!.at, maxTime: ticks[ticks.length - 1]!.at, minPrice: min - padding, maxPrice: max + padding };
}

export function sampleXY(at: number, price: number, domain = sampleDomain(SAMPLE_TICKS)) {
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  return {
    x: CHART.left + ((at - domain.minTime) / (domain.maxTime - domain.minTime || 1)) * plotWidth,
    y: CHART.top + ((domain.maxPrice - price) / (domain.maxPrice - domain.minPrice || 1)) * plotHeight,
  };
}

export function sampleTime(at: number) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(at);
}

export function samplePrice(price: number) {
  return `$${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
