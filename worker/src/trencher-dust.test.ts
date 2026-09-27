/**
 * A PRICED SLIVER WORTH NOTHING MUST NOT HOLD THE DESK HOSTAGE.
 *
 * Measured on The Ludes Donnie, 2026-09-25 04:29 → 2026-09-26 09:37: after a
 * DELTA exit left 40000000000000 raw behind (0.00004 of an 18dp token, valued at
 * 0 USDG), the Trencher proposed selling it every ~15s — "held 1h — past the
 * window" — and the wall refused every one as `non-positive` ("swap sized
 * 40000000000000 raw / 0 USDG is not a trade"). Nearly a thousand refusals, and
 * because the sliver still counted as held, DELTA (the desk's only candidate)
 * could not be entered again for the whole 29 hours.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTrencher, TRENCHER_DEFAULTS, type Candidate, type OpenPosition } from "./strategies/trencher";
import { takeTick, type Snapshot } from "./strategies/types";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const DELTA = "0x6666666666666666666666666666666666666666" as const;
const NOW = Math.floor(Date.now() / 1000);

const cfg = { ...TRENCHER_DEFAULTS, maxFdvUsd: 100_000_000, maxAgeSec: 1e9, maxHoldSec: 30 * 60 };

const sliver: OpenPosition = {
  symbol: "DELTA",
  token: DELTA,
  entryPrice8: 100_000_000n,
  entryLiquidityUsd: 2_000_000,
  entrySec: NOW - 2 * 3600,
  costUsdg: 0n,
  qtyRaw: 40_000_000_000_000n,
};

const candidate: Candidate = {
  symbol: "DELTA",
  token: DELTA,
  decimals: 18,
  priceable: true,
  liquidityUsd: 2_247_103,
  fdvUsd: 22_199_016,
  ageSec: 81_278 * 60,
  price8: 100_000_000n,
} as Candidate;

const snap = (valueUsdg: bigint, over: Partial<Snapshot> = {}): Snapshot => ({
  cashUsdg: 10_546_505n,
  vaultUsdg: 0n,
  holdings: new Map([["DELTA", { token: DELTA, rawBalance: 40_000_000_000_000n, valueUsdg, priceStale: false }]]),
  prices: new Map([["DELTA", { price8: 100_000_000n, stale: false } as never]]),
  pausedTokens: new Set(),
  staleFeeds: new Set(),
  sequencerUp: true,
  spendHeadroomUsdg: 1_000_000_000n,
  perTradeCapUsdg: 10_000_000n,
  ...over,
});

const desk = (open: OpenPosition[], unpriceable = new Set<string>()) =>
  makeTrencher({
    cfg,
    candidates: async () => [candidate],
    open: async () => open,
    liquidityOf: () => 2_000_000,
    unpriceable: () => unpriceable,
    swapRouter: ROUTER,
    usdgToken: USDG,
  });

describe("a zero-value sliver", () => {
  it("is not offered to the wall as a 0-USDG sell", async () => {
    const t = takeTick(await desk([sliver]).tick(snap(0n)));
    const sells = t.intents.filter((i) => i.kind === "swap" && i.sellToken === DELTA);
    assert.deepEqual(sells, [], "the wall refuses a 0-USDG sell as non-positive, every tick, forever");
  });

  it("does not stop the desk from entering the token again", async () => {
    const t = takeTick(await desk([sliver]).tick(snap(0n)));
    const buys = t.intents.filter((i) => i.kind === "swap" && i.buyToken === DELTA);
    assert.equal(buys.length, 1, "DELTA was the only candidate, and the sliver locked it out for 29 hours");
  });
});

describe("what is not a sliver", () => {
  it("a position with value is still sold when its window ends", async () => {
    const t = takeTick(await desk([sliver]).tick(snap(3_000_000n)));
    const sells = t.intents.filter((i) => i.kind === "swap" && i.sellToken === DELTA);
    assert.equal(sells.length, 1);
    const sell = sells[0];
    assert.ok(sell?.kind === "swap" && sell.notionalUsdg > 0n);
    const buys = t.intents.filter((i) => i.kind === "swap" && i.buyToken === DELTA);
    assert.equal(buys.length, 0, "a real holding still blocks a second entry");
  });

  it("an unpriceable position is still exited — no price is not worth zero", async () => {
    const t = takeTick(
      await desk([{ ...sliver, costUsdg: 5_000_000n }], new Set(["DELTA"])).tick(snap(0n, { holdings: new Map() })),
    );
    const sells = t.intents.filter((i) => i.kind === "swap" && i.sellToken === DELTA);
    assert.equal(sells.length, 1);
  });
});

describe("re-entering on top of a sliver starts a fresh clock", () => {
  it("a buy onto dust is recognised as a fresh entry, a top-up is not", async () => {
    const { buysOntoDust } = await import("./strategies/trencher");
    // The DELTA case: 4e13 raw left behind (valued at 0 USDG), then 5 USDG
    // buys 5e21 raw. At that price the sliver is 0.04 micro-USDG: dust.
    assert.equal(buysOntoDust(40_000_000_000_000n, 5_000_000_000_000_000_000_000n, 5_000_000n), true);
    // A real holding of 1e21 raw at the same price is 1 USDG: a top-up keeps its baseline.
    assert.equal(buysOntoDust(1_000_000_000_000_000_000_000n, 5_000_000_000_000_000_000_000n, 5_000_000n), false);
    // Nothing held is not dust — there is simply no old entry to forget.
    assert.equal(buysOntoDust(0n, 5_000_000_000_000_000_000_000n, 5_000_000n), false);
  });

  it("clearing then stamping replaces a stale entry time", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "merrymen-dust-"));
    process.env.MERRYMEN_HOME = home;
    const store = await import("./store");
    store.initStore();
    const { DatabaseSync } = await import("node:sqlite");
    const { homePaths } = await import("./home");
    try {
      await store.setTrenchEntry("0xa", "paper", "DELTA", 2_000_000);
      const db = new DatabaseSync(homePaths.db());
      db.prepare("UPDATE trench_positions SET entry_sec = unixepoch() - 7200").run();
      db.close();
      const stale = await store.getTrenchEntry("0xa", "paper", "DELTA");
      // setTrenchEntry alone keeps the old clock (a top-up must not reset a stop).
      await store.setTrenchEntry("0xa", "paper", "DELTA", 2_000_000);
      assert.equal((await store.getTrenchEntry("0xa", "paper", "DELTA"))?.entrySec, stale?.entrySec);
      // The re-entry path forgets it first, so the new position starts now.
      await store.clearTrenchEntry("0xa", "paper", "DELTA");
      await store.setTrenchEntry("0xa", "paper", "DELTA", 2_000_000);
      const fresh = await store.getTrenchEntry("0xa", "paper", "DELTA");
      assert.ok(fresh && stale && fresh.entrySec >= stale.entrySec + 7000);
    } finally {
      store.closeStoreForTest();
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
