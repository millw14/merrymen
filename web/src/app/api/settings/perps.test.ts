/**
 * THE PERPS WALLET'S SETTINGS ARE SAVED ONLY BY THIS ROUTE, AND ONLY AS
 * docs/perps.md SAYS.
 *
 * No perps key is chat-settable, so `PUT /api/settings?wallet=perps` is the
 * one door (rule 1). What it must hold, driven through the real PUT, hosted,
 * against the Perps wallet's own sealed store, the way spec-coverage.test.ts
 * drives Spot's, with MERRYMEN_PERPS=paper (perps-off is dual-purpose.test.ts):
 *   - `perpsMarkets` refuses an unknown key rather than dropping it;
 *   - `perpsDriver` takes perp-trend or manual: the strategist (a Perps worker
 *     builds none) and Brain (no Brain service ships) are refused by name (D9);
 *   - `perpsStyle` is refused: profiles are not in this build (D9);
 *   - the per-trade cap never exceeds the open-notional cap;
 *   - real-money perpetuals are a CONSENT RECORD, and in this build switching
 *     it on is refused "not available on this server yet" (D10), while
 *     WITHDRAWING any of it is never refused;
 *   - `liveTradingEnabled: true` is refused (D5), and false is an off;
 *   - the strategy stored is always perps-only, and every Spot key is reported
 *     in `ignored`, never stored.
 * Bounds for each number are spec-coverage.test.ts's; this file is semantics.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { mintSession } from "@/lib/auth";
import { getSettingsStore, resetSettingsStoreForTest, useSettingsStoreForTest } from "@merrymen/settings-store";
import { PERPS_LIVE_CONSENT_VERSION, SETTINGS_DEFAULTS, type MerrymenSettings } from "@merrymen/core";
import { mergeSettings } from "../../../../../worker/src/settings";

const TENANT = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_PERPS", "MERRYMEN_PERPS_PAPER_TENANTS"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let dir: string;
let PUT: (req: Request) => Promise<Response>;
let GET: (req: Request) => Promise<Response>;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "merrymen-settings-perps-"));
  process.env.MERRYMEN_HOME = dir;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  process.env.MERRYMEN_PERPS = "paper";
  process.env.MERRYMEN_PERPS_PAPER_TENANTS = TENANT;
  delete process.env.DATABASE_URL;
  resetSettingsStoreForTest();
  // After the env: the route resolves its paths when it loads.
  ({ PUT, GET } = await import("./route"));
});
after(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  resetSettingsStoreForTest();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
beforeEach(async () => {
  await getSettingsStore("perps").put(TENANT, { strategy: "perps-only" });
});

const cookie = () => `mm_session=${mintSession(TENANT)}`;
const URL_PERPS = "https://app.example.test/api/settings?wallet=perps";

async function put(body: Record<string, unknown>) {
  // These contract cases intentionally request paper entries. Supply the same
  // current revision the owner's settings screen must read before enabling.
  let expectedVersion: unknown;
  if (body.perpsEnabled === true && !Object.hasOwn(body, "expectedVersion")) {
    const current = await GET(new Request(URL_PERPS, { headers: { cookie: cookie() } }));
    assert.equal(current.status, 200);
    expectedVersion = (await current.json() as { version: string }).version;
    assert.equal(typeof expectedVersion, "string");
  }
  const res = await PUT(new Request(URL_PERPS, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: cookie() },
    body: JSON.stringify({ ...(expectedVersion === undefined ? {} : { expectedVersion }), ...body, owner: TENANT }),
  }));
  return { status: res.status, body: (await res.json()) as { ok?: boolean; errors?: string[]; ignored?: string[]; saved?: string[]; note?: string } };
}
const stored = async () => ((await getSettingsStore("perps").get(TENANT)) ?? {}) as MerrymenSettings & Record<string, unknown>;
const errorsOf = (r: { body: { errors?: string[] } }) => r.body.errors?.join(" ") ?? "";
/** What a Perps wallet's worker resolves from what is stored (worker settings.ts). */
const worker = (s: MerrymenSettings) => mergeSettings(s, { MERRYMEN_WALLET_PURPOSE: "perps", MERRYMEN_PERPS: "paper" });

/** What a Settings page would send to consent: the switch, the version it showed, the attestation. */
const CONSENT = { perpsLiveEnabled: true, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION, perpsRegionAttested: true };
const RECORD_KEYS = ["perpsLiveEnabled", "perpsLiveConsentVersion", "perpsLiveConsentAt", "perpsRegionAttested"] as const;
/** A consent record as a later build (Phase 4) would have stored it: this build never writes one. */
const LATER_RECORD = { ...CONSENT, perpsLiveConsentAt: 1_790_000_000_000 };
/**
 * A real consent version that is not the current one: the previous text once
 * there is one, and until then a newer build's (what a rollback leaves stored).
 */
const OTHER_VERSION = PERPS_LIVE_CONSENT_VERSION > 1 ? PERPS_LIVE_CONSENT_VERSION - 1 : PERPS_LIVE_CONSENT_VERSION + 1;

describe("perpsEnabled — the paper switch", () => {
  it("takes a real boolean, both ways, and refuses a string", async () => {
    for (const v of [true, false]) {
      const r = await put({ perpsEnabled: v });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await stored()).perpsEnabled, v);
    }
    const bad = await put({ perpsEnabled: "true" });
    assert.equal(bad.status, 400);
    assert.match(errorsOf(bad), /^perpsEnabled: must be true or false/);
  });

  it("is the tenant's own, hosted: never stripped as a house key", async () => {
    const r = await put({ perpsEnabled: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.ignored, undefined);
    assert.equal((await stored()).perpsEnabled, true);
  });
});

describe("perpsDriver (D9)", () => {
  it("takes perp-trend and manual, refuses the strategist and Brain by name and anything else, and null clears it", async () => {
    for (const d of ["perp-trend", "manual"]) {
      const r = await put({ perpsDriver: d });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await stored()).perpsDriver, d);
    }
    const strategist = await put({ perpsDriver: "strategist" });
    assert.equal(strategist.status, 400);
    assert.match(errorsOf(strategist), /^perpsDriver: the strategist does not drive a Perps wallet in this version .*choose perp-trend or manual/);
    const brain = await put({ perpsDriver: "brain" });
    assert.equal(brain.status, 400);
    assert.match(errorsOf(brain), /^perpsDriver: Brain is not available in this version; choose perp-trend or manual/);
    for (const bad of ["future-driver", "Manual", 3, ["manual"]]) {
      const r = await put({ perpsDriver: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.match(errorsOf(r), /^perpsDriver: must be perp-trend or manual/);
    }
    assert.equal((await stored()).perpsDriver, "manual", "a refused value left the last good one in place");
    assert.equal((await put({ perpsDriver: null })).status, 200);
    assert.equal("perpsDriver" in (await stored()), false);
    assert.equal(worker(await stored()).perpsDriver, "perp-trend");
  });
});

describe("perpsStyle (D9): profiles are not in this build", () => {
  it("refuses every profile and stores nothing; clearing one is a no-op", async () => {
    for (const value of ["swing-trend", "scalp-breakout", "unknown", 5, ["swing-trend"]]) {
      const r = await put({ perpsStyle: value, perpsDriver: "perp-trend" });
      assert.equal(r.status, 400, JSON.stringify(value));
      assert.match(errorsOf(r), /^perpsStyle: profiles are not available in this version; a Perps wallet trades the fixed 4 h swing trend/);
      assert.equal("perpsStyle" in (await stored()), false);
      assert.equal((await stored()).perpsDriver, undefined, "the rest of a refused save is not written");
    }
    const clear = await put({ perpsStyle: null });
    assert.equal(clear.status, 200, JSON.stringify(clear.body));
    assert.equal(clear.body.ignored, undefined);
  });

  it("an off beside a profile is still written", async () => {
    await getSettingsStore("perps").put(TENANT, { strategy: "perps-only", perpsEnabled: true });
    const r = await put({ perpsEnabled: false, perpsStyle: "made-up" });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.saved, ["perpsEnabled"]);
    assert.equal((await stored()).perpsEnabled, false);
  });
});

describe("perpsMarkets — an unknown market is an error, never dropped", () => {
  it("stores a valid list exactly as sent, in the owner's order", async () => {
    const r = await put({ perpsMarkets: ["SOL-PERP", "BTC-PERP", "TSLA-PERP"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await stored()).perpsMarkets, ["SOL-PERP", "BTC-PERP", "TSLA-PERP"]);
    assert.deepEqual(worker(await stored()).perpsMarkets, ["SOL-PERP", "BTC-PERP", "TSLA-PERP"]);
  });

  it("refuses the whole save for one unknown key, names it, and stores nothing", async () => {
    await put({ perpsMarkets: ["ETH-PERP"] });
    for (const [why, list, named] of [
      ["an unlisted market", ["BTC-PERP", "DOGE-PERP"], "DOGE-PERP"],
      ["a bare spot symbol", ["BTC"], "BTC"],
      ["the wrong case", ["btc-perp"], "btc-perp"],
      ["a market id", [1], "1"],
    ] as const) {
      const r = await put({ perpsMarkets: list, perpsEnabled: true });
      assert.equal(r.status, 400, why);
      assert.match(errorsOf(r), new RegExp(`^perpsMarkets: unknown markets ${named}`), why);
      assert.equal(r.body.ignored, undefined, `${why}: reported as an error, not as ignored`);
      const s = await stored();
      assert.deepEqual(s.perpsMarkets, ["ETH-PERP"], `${why}: the stored list moved`);
      assert.equal(s.perpsEnabled, undefined, `${why}: the rest of the save went through`);
    }
  });

  it("refuses a repeat, an empty list, more than eight, and a non-list; null clears to the default", async () => {
    const twice = await put({ perpsMarkets: ["BTC-PERP", "ETH-PERP", "BTC-PERP"] });
    assert.equal(twice.status, 400);
    assert.match(errorsOf(twice), /^perpsMarkets: listed more than once: BTC-PERP/);
    const none = await put({ perpsMarkets: [] });
    assert.equal(none.status, 400);
    assert.match(errorsOf(none), /^perpsMarkets: pick at least one market/);
    const eight = ["BTC-PERP", "ETH-PERP", "SOL-PERP", "HYPE-PERP", "XRP-PERP", "SUI-PERP", "TSLA-PERP", "NVDA-PERP"];
    assert.equal((await put({ perpsMarkets: eight })).status, 200);
    const nine = await put({ perpsMarkets: [...eight, "SPY-PERP"] });
    assert.equal(nine.status, 400);
    assert.match(errorsOf(nine), /^perpsMarkets: at most 8 markets/);
    const text = await put({ perpsMarkets: "BTC-PERP" });
    assert.equal(text.status, 400);
    assert.match(errorsOf(text), /^perpsMarkets: must be a list/);
    assert.equal((await put({ perpsMarkets: null })).status, 200);
    assert.equal("perpsMarkets" in (await stored()), false);
    assert.deepEqual(worker(await stored()).perpsMarkets, SETTINGS_DEFAULTS.perpsMarkets);
  });
});

describe("one open is never larger than all opens together", () => {
  it("refuses an open-notional cap below the per-trade cap, however the save arrives at it", async () => {
    const both = await put({ perpsPerTradeUsdg: 40, perpsMaxOpenNotionalUsdg: 30 });
    assert.equal(both.status, 400);
    assert.match(errorsOf(both), /^perpsMaxOpenNotionalUsdg: must be at least the per-trade limit \(40 USDG\)/);
    // Against the stored per-trade cap…
    assert.equal((await put({ perpsPerTradeUsdg: 40, perpsMaxOpenNotionalUsdg: 80 })).status, 200);
    const lower = await put({ perpsMaxOpenNotionalUsdg: 39.99 });
    assert.equal(lower.status, 400);
    // …against the stored open-notional cap…
    const raise = await put({ perpsPerTradeUsdg: 80.01 });
    assert.equal(raise.status, 400);
    // …and against the defaults when neither is stored (25 and 50).
    await getSettingsStore("perps").put(TENANT, {});
    assert.equal((await put({ perpsMaxOpenNotionalUsdg: 24.99 })).status, 400);
    assert.equal((await put({ perpsPerTradeUsdg: 50 })).status, 200, "equal is allowed");
    assert.equal((await stored()).perpsPerTradeUsdg, 50);
  });

  it("does not fail an unrelated save over a pair an older build stored", async () => {
    await getSettingsStore("perps").put(TENANT, { perpsPerTradeUsdg: 80, perpsMaxOpenNotionalUsdg: 40 });
    const r = await put({ perpsEnabled: true, perpsMaxLeverage: 3 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // And the worker reads that pair in the restrictive direction.
    assert.equal(worker(await stored()).perpsPerTradeUsdg, 40);
  });
});

describe("the live rail (D5) and the strategy: a Perps wallet trades perps-only, on paper", () => {
  it("liveTradingEnabled: true is refused and stores nothing; false and null are offs", async () => {
    const on = await put({ liveTradingEnabled: true, perpsEnabled: true });
    assert.equal(on.status, 400);
    assert.match(errorsOf(on), /^liveTradingEnabled: a Perps wallet trades only on paper in this version/);
    assert.equal((await stored()).liveTradingEnabled, undefined);
    assert.equal((await stored()).perpsEnabled, undefined, "nothing else in the refused save was written");
    assert.match(errorsOf(await put({ liveTradingEnabled: "false" })), /^liveTradingEnabled: must be true or false/);
    assert.equal((await put({ liveTradingEnabled: false })).status, 200);
    assert.equal((await stored()).liveTradingEnabled, false);
    // A rail a hand edit (or another build) left on is switched off beside an error, not kept.
    await getSettingsStore("perps").put(TENANT, { liveTradingEnabled: true });
    const off = await put({ liveTradingEnabled: false, perpsMaxLeverage: 11 });
    assert.equal(off.status, 400);
    assert.deepEqual(off.body.saved, ["liveTradingEnabled"]);
    assert.equal((await stored()).liveTradingEnabled, false);
    assert.equal((await stored()).perpsMaxLeverage, undefined);
  });

  it("the stored strategy is always perps-only: an echo is accepted, a Spot strategy refused", async () => {
    await getSettingsStore("perps").put(TENANT, {});
    assert.equal((await put({ perpsEnabled: true })).status, 200);
    assert.equal((await stored()).strategy, "perps-only", "written on every save, asked or not");
    for (const echo of ["perps-only", null, ""]) assert.equal((await put({ strategy: echo })).status, 200, String(echo));
    assert.equal((await stored()).strategy, "perps-only");
    const spot = await put({ strategy: "trencher" });
    assert.equal(spot.status, 400);
    assert.match(errorsOf(spot), /^strategy: a Perps wallet runs perps-only/);
    assert.equal((await stored()).strategy, "perps-only");
    assert.equal(worker(await stored()).strategy, "perps-only");
  });
});

describe("an allowlist: a Spot key is reported, never stored on the Perps wallet", () => {
  it("secrets, URLs, Telegram, holder and Spot strategy fields come back in `ignored` and are not written", async () => {
    const spotKeys = {
      telegramBotToken: "111:AAA-first-secret",
      telegramEnabled: true,
      telegramAllowlist: [777],
      groqApiKey: "gsk_0123456789abcdef",
      slippageBps: 150,
      basketSymbols: ["TSLA"],
      agentName: "Perpy",
      tickSeconds: 60,
      telegramMaxActionUsdg: 9,
      paperTradingEnabled: false,
      scoutEnabled: false,
      classSnipeEnabled: false,
      holderAddress: "0x1111111111111111111111111111111111111111",
    };
    const r = await put({ ...spotKeys, perpsEnabled: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([...(r.body.ignored ?? [])].sort(), Object.keys(spotKeys).sort());
    assert.deepEqual(await stored(), { strategy: "perps-only", perpsEnabled: true });
  });
});

describe("real-money perpetuals are a consent record, and not available on this server yet (D10)", () => {
  it("REFUSES switching it on in every form — the full current consent included — and stores nothing", async () => {
    for (const [why, body] of [
      ["the switch alone", { perpsLiveEnabled: true }],
      ["the full current consent", { ...CONSENT }],
      ["no attestation", { perpsLiveEnabled: true, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION }],
      ["an attestation withheld", { ...CONSENT, perpsRegionAttested: false }],
      ["another consent text", { ...CONSENT, perpsLiveConsentVersion: OTHER_VERSION }],
      ["a consent from the future", { ...CONSENT, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION + 1 }],
    ] as const) {
      const r = await put(body);
      assert.equal(r.status, 400, `${why}: ${JSON.stringify(r.body)}`);
      assert.match(errorsOf(r), /^perpsLiveEnabled: real-money perpetuals are not available on this server yet, so no consent to them was recorded/, why);
      assert.equal(r.body.saved, undefined, `${why}: nothing was on to switch off`);
      const s = await stored();
      for (const k of RECORD_KEYS) assert.equal(s[k], undefined, `${why}: ${k} was stored`);
      assert.equal(worker(s).perpsLiveEnabled, false, why);
    }
    for (const [key, v] of [["perpsLiveEnabled", "true"], ["perpsLiveEnabled", 1], ["perpsRegionAttested", "yes"], ["perpsLiveConsentVersion", "1"], ["perpsLiveConsentVersion", 1.5], ["perpsLiveConsentVersion", 0]] as const) {
      const r = await put({ ...CONSENT, [key]: v });
      assert.equal(r.status, 400, `${key}=${JSON.stringify(v)}`);
      assert.match(errorsOf(r), new RegExp(`^${key}: must be`));
    }
  });

  it("NEVER TAKES THE STAMP FROM A REQUEST — on its own, or beside a refused consent", async () => {
    const alone = await put({ perpsLiveConsentAt: 2 });
    assert.equal(alone.status, 200);
    assert.equal(alone.body.ignored, undefined, "a server-owned field echoed back is not an unknown key");
    assert.equal((await stored()).perpsLiveConsentAt, undefined);
    assert.equal((await put({ ...CONSENT, perpsLiveConsentAt: Date.now() })).status, 400);
    assert.equal((await stored()).perpsLiveConsentAt, undefined);
    // Nor does an echo move one a later build stored.
    await getSettingsStore("perps").put(TENANT, { ...LATER_RECORD });
    assert.equal((await put({ perpsLiveConsentAt: 1 })).status, 200);
    assert.equal((await stored()).perpsLiveConsentAt, LATER_RECORD.perpsLiveConsentAt);
  });

  it("a body that repeats a stored record (a later build's) changes nothing and is not refused — the stamp does not move", async () => {
    await getSettingsStore("perps").put(TENANT, { ...LATER_RECORD });
    for (const echo of [{ ...CONSENT }, { ...CONSENT, perpsLiveConsentAt: 1_790_000_000_000, perpsMaxLeverage: 3 }, { perpsLiveEnabled: true }, { perpsRegionAttested: true }]) {
      const r = await put(echo);
      assert.equal(r.status, 200, `${JSON.stringify(echo)}: ${JSON.stringify(r.body)}`);
      assert.equal((await stored()).perpsLiveConsentAt, 1_790_000_000_000, JSON.stringify(echo));
    }
  });

  it("a stored consent to ANOTHER text is left alone by an echo — the worker is what stops it counting — and a new consent is refused, not stamped", async () => {
    const stale = { perpsLiveEnabled: true, perpsLiveConsentVersion: OTHER_VERSION, perpsRegionAttested: true, perpsLiveConsentAt: 1_700_000_000_000 };
    await getSettingsStore("perps").put(TENANT, stale);
    const echo = await put({ perpsLiveEnabled: true, perpsLiveConsentVersion: stale.perpsLiveConsentVersion, perpsRegionAttested: true, perpsMaxLeverage: 3 });
    assert.equal(echo.status, 200, JSON.stringify(echo.body));
    let s = await stored();
    assert.equal(s.perpsLiveConsentVersion, stale.perpsLiveConsentVersion);
    assert.equal(s.perpsLiveConsentAt, stale.perpsLiveConsentAt);
    assert.equal(worker(s).perpsLiveEnabled, false);
    assert.equal(worker(s).perpsLiveConsentStale, true);
    const again = await put({ ...CONSENT });
    assert.equal(again.status, 400);
    assert.match(errorsOf(again), /not available on this server yet/);
    s = await stored();
    assert.equal(s.perpsLiveConsentVersion, stale.perpsLiveConsentVersion, "nothing re-stamped");
    assert.equal(s.perpsLiveConsentAt, stale.perpsLiveConsentAt);
  });

  it("TURNING IT OFF IS NEVER REFUSED, and takes the whole record with it", async () => {
    for (const off of [
      { perpsLiveEnabled: false },
      { perpsLiveEnabled: null },
      // A malformed version or attestation beside an off must not keep the owner in.
      { perpsLiveEnabled: false, perpsLiveConsentVersion: "junk", perpsRegionAttested: "x" },
      { perpsLiveEnabled: false, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION, perpsRegionAttested: true },
      // Any part of the consent withdrawn on its own withdraws all of it.
      { perpsRegionAttested: false },
      { perpsRegionAttested: null },
      { perpsLiveConsentVersion: null },
      { perpsRegionAttested: false, perpsLiveConsentVersion: "junk" },
      // …and so does a withdrawal beside a switch a client echoes back as on.
      { perpsLiveEnabled: true, perpsRegionAttested: false },
      { perpsLiveEnabled: true, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION, perpsRegionAttested: false },
      { perpsLiveEnabled: true, perpsLiveConsentVersion: null },
      { perpsLiveEnabled: true, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION, perpsRegionAttested: null },
    ]) {
      await getSettingsStore("perps").put(TENANT, { ...LATER_RECORD });
      const r = await put(off);
      assert.equal(r.status, 200, `${JSON.stringify(off)}: ${JSON.stringify(r.body)}`);
      const s = await stored();
      assert.ok(s.perpsLiveEnabled !== true, `${JSON.stringify(off)} left it on`);
      for (const k of ["perpsLiveConsentVersion", "perpsLiveConsentAt", "perpsRegionAttested"] as const) {
        assert.equal(s[k], undefined, `${JSON.stringify(off)} left ${k}`);
      }
      assert.equal(worker(s).perpsLiveEnabled, false);
      assert.equal(worker(s).perpsLiveConsentStale, false);
    }
  });

  it("an off is never refused by an unrelated error beside it in the same save — the off is written, the rest is not", async () => {
    const onEverything = { ...LATER_RECORD, perpsEnabled: true, liveTradingEnabled: true, perpsMarkets: ["BTC-PERP"], perpsMaxLeverage: 3 };
    const cases: Array<[string, Record<string, unknown>, string[]]> = [
      ["the switch off beside a leverage past its bound", { perpsLiveEnabled: false, perpsMaxLeverage: 11 }, ["perpsLiveEnabled"]],
      ["the switch off beside the strategist", { perpsLiveEnabled: false, perpsDriver: "strategist" }, ["perpsLiveEnabled"]],
      ["the attestation withdrawn beside a bad number", { perpsRegionAttested: false, perpsMaxLeverage: 0 }, ["perpsLiveEnabled"]],
      ["the attestation withdrawn beside an echoed switch and a bad number", { perpsLiveEnabled: true, perpsRegionAttested: false, perpsMaxLeverage: 0 }, ["perpsLiveEnabled"]],
      ["paper off beside an unknown market", { perpsEnabled: false, perpsMarkets: ["DOGE-PERP"] }, ["perpsEnabled"]],
      ["the live rail off beside a bad value", { liveTradingEnabled: false, perpsMaxLeverage: 11 }, ["liveTradingEnabled"]],
      ["everything off beside a bad value", { perpsLiveEnabled: false, perpsEnabled: false, liveTradingEnabled: false, perpsDriver: "future-driver" }, ["perpsEnabled", "liveTradingEnabled", "perpsLiveEnabled"]],
    ];
    for (const [why, body, off] of cases) {
      await getSettingsStore("perps").put(TENANT, { ...onEverything });
      const r = await put(body);
      assert.equal(r.status, 400, `${why}: the other error is still reported`);
      assert.deepEqual([...(r.body.saved ?? [])].sort(), [...off].sort(), why);
      assert.match(r.body.note ?? "", /that was saved/, why);
      const s = await stored();
      if (off.includes("perpsLiveEnabled")) {
        assert.equal(worker(s).perpsLiveEnabled, false, `${why}: real perps still on`);
        for (const k of ["perpsLiveConsentVersion", "perpsLiveConsentAt", "perpsRegionAttested"] as const) assert.equal(s[k], undefined, `${why}: ${k}`);
      } else {
        assert.equal(s.perpsLiveEnabled, true, `${why}: an off nobody asked for`);
      }
      if (off.includes("perpsEnabled")) assert.equal(s.perpsEnabled, false, `${why}: paper perps still on`);
      if (off.includes("liveTradingEnabled")) assert.equal(s.liveTradingEnabled, false, `${why}: the live rail still on`);
      // Nothing ELSE in the refused body was written.
      assert.equal(s.perpsMaxLeverage, 3, `${why}: the rest of the save went through`);
      assert.deepEqual(s.perpsMarkets, ["BTC-PERP"], why);
      assert.equal(s.perpsDriver, undefined, why);
    }
  });

  it("unticking every market while switching perps off is the off, not an error", async () => {
    await getSettingsStore("perps").put(TENANT, { ...LATER_RECORD, perpsEnabled: true, perpsMarkets: ["SOL-PERP"] });
    const r = await put({ perpsLiveEnabled: false, perpsEnabled: false, perpsMarkets: [] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ignored, undefined);
    const s = await stored();
    assert.equal(worker(s).perpsLiveEnabled, false);
    assert.equal(s.perpsEnabled, false);
    assert.deepEqual(s.perpsMarkets, ["SOL-PERP"], "the list is kept for when perps come back on");
    // Without the off, an empty list is still refused.
    const none = await put({ perpsMarkets: [] });
    assert.equal(none.status, 400);
    assert.match(errorsOf(none), /^perpsMarkets: pick at least one market/);
  });

  it("an error beside an off that has nothing to turn off saves nothing and claims nothing", async () => {
    // Stored: nothing on (beforeEach). "Switched off — saved" would be a lie.
    const r = await put({ perpsLiveEnabled: false, perpsEnabled: false, perpsMaxLeverage: 11 });
    assert.equal(r.status, 400);
    assert.equal(r.body.saved, undefined);
    assert.deepEqual(await stored(), { strategy: "perps-only" });
  });

  it("the paper switch off is never refused either, whatever is stored beside it", async () => {
    await getSettingsStore("perps").put(TENANT, { perpsEnabled: true, perpsPerTradeUsdg: 80, perpsMaxOpenNotionalUsdg: 40, perpsLiveEnabled: true, perpsLiveConsentVersion: 0 });
    const r = await put({ perpsEnabled: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await stored()).perpsEnabled, false);
  });

  it("the attestation or version on its own is not a way to consent", async () => {
    for (const body of [{ perpsRegionAttested: true }, { perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION }, { perpsRegionAttested: true, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION }]) {
      const r = await put(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(errorsOf(r), /recorded only as part of a real-money consent .*not available on this server yet/);
      const s = await stored();
      for (const k of RECORD_KEYS) assert.equal(s[k], undefined, `${JSON.stringify(body)}: ${k}`);
    }
  });
});

describe("GET ?wallet=perps shows the Perps wallet's values and defaults, never stored", () => {
  const view = async () => {
    const res = await GET(new Request(URL_PERPS, { headers: { cookie: cookie() } }));
    return { res, view: (await res.json()) as { values: Record<string, unknown>; defaults: Record<string, unknown>; strategies: unknown; owner: unknown; telegramBotToken?: unknown } };
  };

  it("returns what was stored, perps-only, the contract's defaults, and private no-store, Vary: Cookie", async () => {
    await put({ perpsEnabled: true, perpsMaxLeverage: 3, perpsMarkets: ["SOL-PERP"] });
    const { res, view: v } = await view();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.equal(res.headers.get("vary"), "Cookie");
    assert.equal(v.owner, TENANT);
    assert.equal(v.values.perpsEnabled, true);
    assert.equal(v.values.perpsMaxLeverage, 3);
    assert.deepEqual(v.values.perpsMarkets, ["SOL-PERP"]);
    assert.equal(v.values.strategy, "perps-only");
    assert.deepEqual(v.strategies, { builtin: ["perps-only"], custom: [] });
    assert.equal(v.defaults.perpsEnabled, false);
    assert.equal(v.defaults.perpsLiveEnabled, false);
    assert.equal(v.defaults.perpsDriver, "perp-trend");
    assert.deepEqual(v.defaults.perpsMarkets, ["BTC-PERP", "ETH-PERP"]);
  });

  it("a secret a Perps blob somehow holds is masked, as Spot's are", async () => {
    await getSettingsStore("perps").put(TENANT, { strategy: "perps-only", telegramBotToken: "111:AAA-first-secret" });
    const { view: v } = await view();
    assert.deepEqual(v.telegramBotToken, { set: true, hint: "cret" });
    assert.equal("telegramBotToken" in v.values, false);
  });

  it("A STORE THAT CANNOT BE READ IS A 503, never the defaults: an unread allocation is not a saved one", async () => {
    useSettingsStoreForTest({
      get: async () => {
        throw new Error("sealed store unavailable");
      },
      put: async () => {
        throw new Error("must not be written");
      },
    } as never, "perps");
    try {
      const { res, view: v } = await view();
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("cache-control"), "private, no-store");
      assert.equal((v as unknown as { code?: string }).code, "settings-unreadable");
      const saved = await put({ perpsEnabled: false });
      assert.equal(saved.status, 503, "and a save built on an unread blob is refused");
    } finally {
      resetSettingsStoreForTest();
    }
  });
});

describe("a Perps save whose write fails says so in a fixed sentence, never the store's own words", () => {
  /**
   * What a driver's message can carry: an internal host and port, a table, a
   * connection's state, or a credential a misconfigured URL put there. The
   * owner can only retry, so the text is logged on the server and the answer
   * is a fixed sentence, as the grants route's storeRefused and this route's
   * own Perps read already give (grants/dual-purpose.test.ts holds theirs).
   */
  const LEAK = 'connect ECONNREFUSED 10.1.2.3:5432 (postgres://admin:hunter2@db.internal:5432/merrymen); relation "perps_tenant_settings" does not exist';
  const NOT_SAVED = "Your Perps wallet's settings could not be saved. Nothing was changed; try again.";

  /** The real Perps store's reads, and a write that throws LEAK. */
  const failingWrites = () => {
    const real = getSettingsStore("perps");
    const puts: unknown[] = [];
    useSettingsStoreForTest({
      get: (tenant: `0x${string}`) => real.get(tenant),
      put: async (_tenant: `0x${string}`, s: unknown) => {
        puts.push(s);
        throw new Error(LEAK);
      },
    } as never, "perps");
    return puts;
  };

  for (const [what, body, lever] of [
    ["a whole save", { perpsMaxLeverage: 3 }, "paper"],
    ["the offs beside an error", { perpsEnabled: false, perpsDriver: "strategist" }, "paper"],
    ["an off where Perps are not offered (D1)", { perpsEnabled: false }, undefined],
  ] as const) {
    it(`${what}: 503, the fixed sentence, and none of the error's text`, async (t) => {
      await getSettingsStore("perps").put(TENANT, { strategy: "perps-only", perpsEnabled: true });
      const logged: string[] = [];
      t.mock.method(console, "error", (...a: unknown[]) => void logged.push(a.map(String).join(" ")));
      const puts = failingWrites();
      if (lever === undefined) delete process.env.MERRYMEN_PERPS;
      try {
        const r = await put(body);
        assert.equal(r.status, 503, JSON.stringify(r.body));
        assert.ok(puts.length > 0, "the write was attempted");
        assert.deepEqual(r.body.errors, [NOT_SAVED]);
        const said = JSON.stringify(r.body);
        for (const leaked of ["ECONNREFUSED", "10.1.2.3", "5432", "hunter2", "db.internal", "postgres://", "perps_tenant_settings", "relation"]) {
          assert.equal(said.includes(leaked), false, `${leaked} reached the owner: ${said}`);
        }
        assert.ok(logged.some((l) => l.includes("ECONNREFUSED 10.1.2.3:5432")), "the operator still has it, in the server's log");
        assert.equal(logged.some((l) => l.includes("hunter2")), false, "…less the database password (redact-urls.ts)");
      } finally {
        process.env.MERRYMEN_PERPS = "paper";
        resetSettingsStoreForTest();
      }
    });
  }
});
