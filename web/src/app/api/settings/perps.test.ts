/**
 * PERPETUALS ARE SAVED ONLY BY THIS ROUTE, AND ONLY AS docs/perps.md SAYS.
 *
 * No perps key is chat-settable, so this PUT is the one door (rule 1). What it
 * must hold, driven through the real PUT, hosted, against the sealed tenant
 * store, the way spec-coverage.test.ts does it:
 *   - `perpsMarkets` refuses an unknown key rather than dropping it;
 *   - `perpsDriver` takes core's list and nothing else;
 *   - the per-trade cap never exceeds the open-notional cap;
 *   - real-money perps are a CONSENT RECORD — the switch, the current consent
 *     version, the regional attestation, and a stamp only this route writes —
 *     and turning any of it off is never refused.
 * Bounds for each number are spec-coverage.test.ts's; this file is semantics.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { mintSession } from "@/lib/auth";
import { getSettingsStore, resetSettingsStoreForTest } from "@merrymen/settings-store";
import { PERPS_LIVE_CONSENT_VERSION, SETTINGS_DEFAULTS, type MerrymenSettings } from "@merrymen/core";
import { mergeSettings } from "../../../../../worker/src/settings";

const TENANT = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let dir: string;
let PUT: (req: Request) => Promise<Response>;
let GET: (req: Request) => Promise<Response>;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "merrymen-settings-perps-"));
  process.env.MERRYMEN_HOME = dir;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
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
  await getSettingsStore().put(TENANT, { strategy: "trencher" });
});

const cookie = () => `mm_session=${mintSession(TENANT)}`;

async function put(body: Record<string, unknown>) {
  const res = await PUT(new Request("https://app.example.test/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: cookie() },
    body: JSON.stringify({ ...body, owner: TENANT }),
  }));
  return { status: res.status, body: (await res.json()) as { ok?: boolean; errors?: string[]; ignored?: string[]; saved?: string[]; note?: string } };
}
const stored = async () => ((await getSettingsStore().get(TENANT)) ?? {}) as MerrymenSettings & Record<string, unknown>;
const errorsOf = (r: { body: { errors?: string[] } }) => r.body.errors?.join(" ") ?? "";

/** What the Settings page sends when the owner consents: the switch, the version it showed, the attestation. */
const CONSENT = { perpsLiveEnabled: true, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION, perpsRegionAttested: true };
const RECORD_KEYS = ["perpsLiveEnabled", "perpsLiveConsentVersion", "perpsLiveConsentAt", "perpsRegionAttested"] as const;
/**
 * A real consent version that is not the current one: the previous text once
 * there is one, and until then a newer build's (what a rollback leaves stored).
 * Versions start at 1, so "current − 1" does not exist yet.
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

describe("perpsDriver", () => {
  it("takes each of core's drivers, refuses anything else by name, and null clears it", async () => {
    for (const d of ["perp-trend", "strategist", "manual"]) {
      const r = await put({ perpsDriver: d });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await stored()).perpsDriver, d);
    }
    for (const bad of ["brain", "Strategist", 3, ["manual"]]) {
      const r = await put({ perpsDriver: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.match(errorsOf(r), /^perpsDriver: must be perp-trend, strategist, manual/);
    }
    assert.equal((await stored()).perpsDriver, "manual", "a refused value left the last good one in place");
    assert.equal((await put({ perpsDriver: null })).status, 200);
    assert.equal("perpsDriver" in (await stored()), false);
  });
});

describe("perpsMarkets — an unknown market is an error, never dropped", () => {
  it("stores a valid list exactly as sent, in the owner's order", async () => {
    const r = await put({ perpsMarkets: ["SOL-PERP", "BTC-PERP", "TSLA-PERP"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await stored()).perpsMarkets, ["SOL-PERP", "BTC-PERP", "TSLA-PERP"]);
    assert.deepEqual(mergeSettings(await stored(), {}).perpsMarkets, ["SOL-PERP", "BTC-PERP", "TSLA-PERP"]);
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
    assert.deepEqual(mergeSettings(await stored(), {}).perpsMarkets, SETTINGS_DEFAULTS.perpsMarkets);
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
    await getSettingsStore().put(TENANT, {});
    assert.equal((await put({ perpsMaxOpenNotionalUsdg: 24.99 })).status, 400);
    assert.equal((await put({ perpsPerTradeUsdg: 50 })).status, 200, "equal is allowed");
    assert.equal((await stored()).perpsPerTradeUsdg, 50);
  });

  it("does not fail an unrelated save over a pair an older build stored", async () => {
    await getSettingsStore().put(TENANT, { perpsPerTradeUsdg: 80, perpsMaxOpenNotionalUsdg: 40 });
    const r = await put({ perpsEnabled: true, slippageBps: 150 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // And the worker reads that pair in the restrictive direction.
    assert.equal(mergeSettings(await stored(), {}).perpsPerTradeUsdg, 40);
  });
});

describe("real-money perpetuals are a consent record, not a switch", () => {
  it("REFUSES the switch alone, without the current consent, or without the attestation — and stores nothing", async () => {
    for (const [why, body, said] of [
      ["the switch alone", { perpsLiveEnabled: true }, /current consent \(version \d+\)/],
      ["no attestation", { perpsLiveEnabled: true, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION }, /not in a region Lighter excludes/],
      ["an attestation withheld", { ...CONSENT, perpsRegionAttested: false }, /not in a region Lighter excludes/],
      ["another consent text", { ...CONSENT, perpsLiveConsentVersion: OTHER_VERSION }, /current consent/],
      ["a consent from the future", { ...CONSENT, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION + 1 }, /current consent/],
    ] as const) {
      const r = await put(body);
      assert.equal(r.status, 400, `${why}: ${JSON.stringify(r.body)}`);
      assert.match(errorsOf(r), /^perpsLiveEnabled: real-money perpetuals are switched on only/, why);
      assert.match(errorsOf(r), said, why);
      const s = await stored();
      for (const k of RECORD_KEYS) assert.equal(s[k], undefined, `${why}: ${k} was stored`);
      assert.equal(mergeSettings(s, {}).perpsLiveEnabled, false, why);
    }
    for (const [key, v] of [["perpsLiveEnabled", "true"], ["perpsLiveEnabled", 1], ["perpsRegionAttested", "yes"], ["perpsLiveConsentVersion", "1"], ["perpsLiveConsentVersion", 1.5], ["perpsLiveConsentVersion", 0]] as const) {
      const r = await put({ ...CONSENT, [key]: v });
      assert.equal(r.status, 400, `${key}=${JSON.stringify(v)}`);
      assert.match(errorsOf(r), new RegExp(`^${key}: must be`));
    }
  });

  it("accepts the whole consent, stamps it from the server clock, and the worker then honours it", async () => {
    const before = Date.now();
    const r = await put({ ...CONSENT });
    const after = Date.now();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ignored, undefined);
    const s = await stored();
    assert.equal(s.perpsLiveEnabled, true);
    assert.equal(s.perpsLiveConsentVersion, PERPS_LIVE_CONSENT_VERSION);
    assert.equal(s.perpsRegionAttested, true);
    assert.ok(typeof s.perpsLiveConsentAt === "number" && s.perpsLiveConsentAt >= before && s.perpsLiveConsentAt <= after, `stamp ${s.perpsLiveConsentAt}`);
    const c = mergeSettings(s, {});
    assert.equal(c.perpsLiveEnabled, true);
    assert.equal(c.perpsLiveConsentAt, s.perpsLiveConsentAt);
    // Consent to real perps switches on nothing else.
    assert.equal(s.perpsEnabled, undefined);
    assert.equal(s.liveTradingEnabled, undefined);
  });

  it("NEVER takes the stamp from a request — not with a consent, not on its own", async () => {
    const r = await put({ ...CONSENT, perpsLiveConsentAt: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const at = (await stored()).perpsLiveConsentAt!;
    assert.ok(at > 1_000_000_000_000, "the client's backdated stamp was stored");
    const alone = await put({ perpsLiveConsentAt: 2 });
    assert.equal(alone.status, 200);
    assert.equal(alone.body.ignored, undefined, "a server-owned field echoed back is not an unknown key");
    assert.equal((await stored()).perpsLiveConsentAt, at);
    // Nor can one mint a record where none is.
    await getSettingsStore().put(TENANT, {});
    assert.equal((await put({ perpsLiveConsentAt: Date.now() })).status, 200);
    assert.equal((await stored()).perpsLiveConsentAt, undefined);
  });

  it("a body that repeats the stored record changes nothing and is not refused — the stamp does not move", async () => {
    await getSettingsStore().put(TENANT, { ...CONSENT, perpsLiveConsentAt: 1_790_000_000_000 });
    for (const echo of [{ ...CONSENT }, { ...CONSENT, perpsLiveConsentAt: 1_790_000_000_000, slippageBps: 150 }, { perpsLiveEnabled: true }, { perpsRegionAttested: true }]) {
      const r = await put(echo);
      assert.equal(r.status, 200, `${JSON.stringify(echo)}: ${JSON.stringify(r.body)}`);
      assert.equal((await stored()).perpsLiveConsentAt, 1_790_000_000_000, JSON.stringify(echo));
    }
  });

  it("a stored consent to ANOTHER text is left alone by an echo — the worker is what stops it counting — and a new consent re-stamps it", async () => {
    const stale = { perpsLiveEnabled: true, perpsLiveConsentVersion: OTHER_VERSION, perpsRegionAttested: true, perpsLiveConsentAt: 1_700_000_000_000 };
    await getSettingsStore().put(TENANT, stale);
    const echo = await put({ perpsLiveEnabled: true, perpsLiveConsentVersion: stale.perpsLiveConsentVersion, perpsRegionAttested: true, slippageBps: 150 });
    assert.equal(echo.status, 200, JSON.stringify(echo.body));
    let s = await stored();
    assert.equal(s.perpsLiveConsentVersion, stale.perpsLiveConsentVersion);
    assert.equal(s.perpsLiveConsentAt, stale.perpsLiveConsentAt);
    assert.equal(mergeSettings(s, {}).perpsLiveEnabled, false);
    assert.equal(mergeSettings(s, {}).perpsLiveConsentStale, true);
    const again = await put({ ...CONSENT });
    assert.equal(again.status, 200);
    s = await stored();
    assert.equal(s.perpsLiveConsentVersion, PERPS_LIVE_CONSENT_VERSION);
    assert.ok(s.perpsLiveConsentAt! > stale.perpsLiveConsentAt);
    assert.equal(mergeSettings(s, {}).perpsLiveEnabled, true);
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
      // …and so does a withdrawal beside a switch a client echoes back as on:
      // the owner who moved somewhere Lighter excludes and unticked the
      // attestation is withdrawing, whatever else the blob repeats.
      { perpsLiveEnabled: true, perpsRegionAttested: false },
      { perpsLiveEnabled: true, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION, perpsRegionAttested: false },
      { perpsLiveEnabled: true, perpsLiveConsentVersion: null },
      { perpsLiveEnabled: true, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION, perpsRegionAttested: null },
    ]) {
      await getSettingsStore().put(TENANT, { ...CONSENT, perpsLiveConsentAt: 1_790_000_000_000 });
      const r = await put(off);
      assert.equal(r.status, 200, `${JSON.stringify(off)}: ${JSON.stringify(r.body)}`);
      const s = await stored();
      assert.ok(s.perpsLiveEnabled !== true, `${JSON.stringify(off)} left it on`);
      for (const k of ["perpsLiveConsentVersion", "perpsLiveConsentAt", "perpsRegionAttested"] as const) {
        assert.equal(s[k], undefined, `${JSON.stringify(off)} left ${k}`);
      }
      assert.equal(mergeSettings(s, {}).perpsLiveEnabled, false);
      assert.equal(mergeSettings(s, {}).perpsLiveConsentStale, false);
    }
  });

  it("an off is never refused by an unrelated error beside it in the same save — the off is written, the rest is not", async () => {
    const onEverything = { ...CONSENT, perpsLiveConsentAt: 1_790_000_000_000, perpsEnabled: true, liveTradingEnabled: true, perpsMarkets: ["BTC-PERP"], slippageBps: 100 };
    const cases: Array<[string, Record<string, unknown>, string[]]> = [
      ["the switch off beside a leverage past its bound", { perpsLiveEnabled: false, perpsMaxLeverage: 11 }, ["perpsLiveEnabled"]],
      ["the switch off beside a slippage past its bound", { perpsLiveEnabled: false, slippageBps: 999_999 }, ["perpsLiveEnabled"]],
      ["the attestation withdrawn beside a bad number", { perpsRegionAttested: false, perpsMaxLeverage: 0 }, ["perpsLiveEnabled"]],
      ["the attestation withdrawn beside an echoed switch and a bad number", { perpsLiveEnabled: true, perpsRegionAttested: false, perpsMaxLeverage: 0 }, ["perpsLiveEnabled"]],
      ["paper off beside an unknown market", { perpsEnabled: false, perpsMarkets: ["DOGE-PERP"] }, ["perpsEnabled"]],
      ["the live rail off beside a bad value", { liveTradingEnabled: false, perpsMaxLeverage: 11 }, ["liveTradingEnabled"]],
      ["everything off beside a bad value", { perpsLiveEnabled: false, perpsEnabled: false, liveTradingEnabled: false, perpsDriver: "brain" }, ["perpsEnabled", "liveTradingEnabled", "perpsLiveEnabled"]],
    ];
    for (const [why, body, off] of cases) {
      await getSettingsStore().put(TENANT, { ...onEverything });
      const r = await put(body);
      assert.equal(r.status, 400, `${why}: the other error is still reported`);
      assert.deepEqual([...(r.body.saved ?? [])].sort(), [...off].sort(), why);
      assert.match(r.body.note ?? "", /that was saved/, why);
      const s = await stored();
      const c = mergeSettings(s, {});
      if (off.includes("perpsLiveEnabled")) {
        assert.equal(c.perpsLiveEnabled, false, `${why}: real perps still on`);
        for (const k of ["perpsLiveConsentVersion", "perpsLiveConsentAt", "perpsRegionAttested"] as const) assert.equal(s[k], undefined, `${why}: ${k}`);
      } else {
        assert.equal(s.perpsLiveEnabled, true, `${why}: an off nobody asked for`);
      }
      if (off.includes("perpsEnabled")) assert.equal(c.perpsEnabled, false, `${why}: paper perps still on`);
      if (off.includes("liveTradingEnabled")) assert.equal(s.liveTradingEnabled, false, `${why}: the live rail still on`);
      // Nothing ELSE in the refused body was written.
      assert.equal(s.slippageBps, 100, `${why}: the rest of the save went through`);
      assert.deepEqual(s.perpsMarkets, ["BTC-PERP"], why);
      assert.equal(s.perpsMaxLeverage, undefined, why);
    }
  });

  it("unticking every market while switching perps off is the off, not an error", async () => {
    await getSettingsStore().put(TENANT, { ...CONSENT, perpsLiveConsentAt: 1_790_000_000_000, perpsEnabled: true, perpsMarkets: ["SOL-PERP"] });
    const r = await put({ perpsLiveEnabled: false, perpsEnabled: false, perpsMarkets: [] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ignored, undefined);
    const s = await stored();
    assert.equal(mergeSettings(s, {}).perpsLiveEnabled, false);
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
    assert.deepEqual(await stored(), { strategy: "trencher" });
  });

  it("the paper switch off is never refused either, whatever is stored beside it", async () => {
    await getSettingsStore().put(TENANT, { perpsEnabled: true, perpsPerTradeUsdg: 80, perpsMaxOpenNotionalUsdg: 40, perpsLiveEnabled: true, perpsLiveConsentVersion: 0 });
    const r = await put({ perpsEnabled: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await stored()).perpsEnabled, false);
  });

  it("the attestation or version on its own is not a way to consent", async () => {
    for (const body of [{ perpsRegionAttested: true }, { perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION }, { perpsRegionAttested: true, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION }]) {
      const r = await put(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(errorsOf(r), /recorded only when real-money perpetuals are switched on/);
      const s = await stored();
      for (const k of RECORD_KEYS) assert.equal(s[k], undefined, `${JSON.stringify(body)}: ${k}`);
    }
  });
});

describe("GET shows the perps values and defaults", () => {
  it("returns what was stored, and the contract's defaults", async () => {
    await put({ perpsEnabled: true, perpsMaxLeverage: 3, perpsMarkets: ["SOL-PERP"], ...CONSENT });
    const res = await GET(new Request("https://app.example.test/api/settings", { headers: { cookie: cookie() } }));
    const view = (await res.json()) as { values: Record<string, unknown>; defaults: Record<string, unknown> };
    assert.equal(view.values.perpsEnabled, true);
    assert.equal(view.values.perpsMaxLeverage, 3);
    assert.deepEqual(view.values.perpsMarkets, ["SOL-PERP"]);
    assert.equal(view.values.perpsLiveEnabled, true);
    assert.equal(typeof view.values.perpsLiveConsentAt, "number");
    assert.equal(view.defaults.perpsEnabled, false);
    assert.equal(view.defaults.perpsLiveEnabled, false);
    assert.equal(view.defaults.perpsDriver, "perp-trend");
    assert.deepEqual(view.defaults.perpsMarkets, ["BTC-PERP", "ETH-PERP"]);
  });
});
