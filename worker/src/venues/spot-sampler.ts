/**
 * A TIME-WEIGHTED PRICE FOR A POOL TOO NEW TO KEEP ONE ITSELF.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * A v3 pool's oracle holds ONE observation until somebody pays to grow it, so
 * `observe()` over the 15-minute window reverts and the pool pricer has no TWAP
 * to trust. That is not an edge case on this chain: measured 2026-10-08, every
 * busy new coin on the tape (CHONK, ZEVIO, SS, SynthID, DUCAT, CHOP) sat on a
 * cardinality-1 pool, and the fast Trencher could only ever price — and so only
 * ever trade — the handful of older coins whose pools had grown one. It traded
 * the same four coins all day.
 *
 * So the worker keeps the series the pool does not: a spot reading every tick,
 * held for a few minutes, averaged by TIME. That is the same idea as the pool's
 * own oracle, measured by us instead of by the pool.
 *
 * ── WHAT IT IS GOOD ENOUGH FOR ───────────────────────────────────────────
 *
 * A READY series — at least SAMPLE_MIN_COUNT readings spanning SAMPLE_MIN_SPAN_SEC
 * with no gap over SAMPLE_MAX_GAP_SEC — stands in for the TWAP in the same two
 * checks: the depth floor, and spot against the average. Pushing it means
 * holding a price across several readings minutes apart, not for one block.
 * Even so it is a thinner claim than the pool's oracle, so the price it makes
 * carries its own source ("sampled"): it may authorise a FAST TRENCHER VAULT entry,
 * which the vault contract caps at $5 a buy and $25 a day, and nothing else —
 * every other buy of it stays inside the owner's scout budget
 * (strategies/trencher.ts unpriceableCause, index.ts scoutContextFor).
 *
 * A series that is NOT yet ready still values a holding — exactly as a v4 mark
 * does, off spot and depth — so a restart cannot turn a held coin unpriceable
 * and force its exit while the series refills. It never authorises a buy.
 *
 * ── WHAT IT DOES NOT KEEP ────────────────────────────────────────────────
 *
 * Memory only, bounded per series and in series count. A restart starts empty,
 * which costs a few minutes of no new entries in these coins and nothing else.
 */

/** The window the average is taken over. */
export const SAMPLE_WINDOW_SEC = 300;
/** Readings a series needs inside the window before it may authorise an entry. */
export const SAMPLE_MIN_COUNT = 4;
/** How much of the window those readings must cover. */
export const SAMPLE_MIN_SPAN_SEC = 180;
/**
 * The longest gap between two readings that still counts as one series. A
 * worker on a 60s tick that skips one tick stays continuous; one that stopped
 * reading for minutes starts again, because an average over a hole is an
 * average of whatever happened to bracket it.
 */
export const SAMPLE_MAX_GAP_SEC = 150;
/** Readings kept per series — a 15s tick fills the window with twenty. */
const SERIES_MAX = 64;
/** Series kept at all. The tape turns over; a worker that runs for weeks must not grow. */
const SERIES_CAP = 512;

export interface SpotSample {
  atSec: number;
  /**
   * USD per whole token, 18dp. Not 8dp: a coin under about $1e-7 moves in
   * 10% steps at 8dp, so its own rounding would read as a divergence and its
   * average would lose a unit to the floor. Scaled to 8dp once, on the way out.
   */
  price18: bigint;
  /** In-range depth of the route's thinner leg, USDG 6dp. */
  liquidityUsdg: bigint;
}

export interface SampledPrice {
  /** Time-weighted mean over the window, 8dp. What valuation and the guards read. */
  price8: bigint;
  /** The newest reading, 8dp. */
  spot8: bigint;
  /** The newest reading's depth, USDG 6dp. */
  liquidityUsdg: bigint;
  /** |spot − mean| / mean, bps. */
  divergenceBps: number;
  readings: number;
  spanSec: number;
  /** Enough readings over enough time to stand in for a TWAP. */
  ready: boolean;
}

export class SpotSampler {
  private readonly series = new Map<string, { source: string; samples: SpotSample[] }>();

  /**
   * Add a reading. Out-of-order or same-second readings replace nothing and are dropped.
   *
   * `source` NAMES WHAT WAS READ — the pool and the route through it. A series
   * is one pool's history: when the route moves to another pool (a deeper fee
   * tier opened, say), that pool's first reading must not join the old pool's
   * readings and inherit their readiness. A reading from a different source
   * starts the series over.
   */
  record(key: string, sample: SpotSample, source = ""): void {
    if (sample.price18 <= 0n || !Number.isFinite(sample.atSec)) return;
    let entry = this.series.get(key);
    if (entry && entry.source !== source) {
      this.series.delete(key);
      entry = undefined;
    }
    if (!entry) {
      entry = { source, samples: [] };
      this.series.set(key, entry);
      while (this.series.size > SERIES_CAP) this.series.delete(this.series.keys().next().value as string);
    }
    const s = entry.samples;
    const last = s[s.length - 1];
    if (last && sample.atSec <= last.atSec) return;
    // A gap long enough to break the series ends it: the new reading starts over.
    if (last && sample.atSec - last.atSec > SAMPLE_MAX_GAP_SEC) s.length = 0;
    s.push(sample);
    // Keep one reading older than the window: it is what the window's first
    // seconds were priced at.
    while (s.length > SERIES_MAX || (s.length > 1 && s[1]!.atSec <= sample.atSec - SAMPLE_WINDOW_SEC)) s.shift();
  }

  /** Forget a series — a route that now has an oracle, or a token no longer watched. */
  drop(key: string): void {
    this.series.delete(key);
  }

  /**
   * The series as a price at `nowSec`, or null when there is no reading newer
   * than one gap. Each reading holds until the next one; the oldest kept one is
   * clipped to the window's start.
   */
  read(key: string, nowSec: number, source = ""): SampledPrice | null {
    const entry = this.series.get(key);
    // Another pool's history is not this one's.
    if (entry && entry.source !== source) return null;
    const s = entry?.samples;
    const last = s?.[s.length - 1];
    if (!s || !last || nowSec - last.atSec > SAMPLE_MAX_GAP_SEC) return null;
    const start = nowSec - SAMPLE_WINDOW_SEC;
    let weighted = 0n;
    let total = 0n;
    for (let i = 0; i < s.length; i++) {
      const from = Math.max(s[i]!.atSec, start);
      const to = i + 1 < s.length ? s[i + 1]!.atSec : nowSec;
      if (to <= from) continue;
      const w = BigInt(Math.round(to - from));
      weighted += s[i]!.price18 * w;
      total += w;
    }
    // Counted apart from the weights: a reading taken this very second has no
    // duration yet and still happened.
    const readings = s.filter((x) => x.atSec >= start).length;
    // A single reading taken this second has no duration yet: it is its own mean.
    const mean18 = total > 0n ? weighted / total : last.price18;
    if (mean18 <= 0n) return null;
    const first = s.find((x) => x.atSec >= start) ?? last;
    const spanSec = Math.max(0, last.atSec - first.atSec);
    const diff = last.price18 > mean18 ? last.price18 - mean18 : mean18 - last.price18;
    return {
      // May be 0 for a coin cheaper than 8dp carries: the caller refuses it.
      price8: mean18 / 10_000_000_000n,
      spot8: last.price18 / 10_000_000_000n,
      liquidityUsdg: last.liquidityUsdg,
      divergenceBps: Number((diff * 10_000n) / mean18),
      readings,
      spanSec,
      ready: readings >= SAMPLE_MIN_COUNT && spanSec >= SAMPLE_MIN_SPAN_SEC,
    };
  }

  /** Series count, for tests. */
  size(): number {
    return this.series.size;
  }
}
