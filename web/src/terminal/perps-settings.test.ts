/**
 * SETTINGS → PERPETUALS: the real section, in a DOM, against a scripted
 * settings API and GET /api/grants — plus the rules it applies, held without
 * one (docs/perps.md rule 1, rule 4, "Surfaces", "Settings").
 *
 * The properties are the ones an owner cannot see go wrong:
 *
 *   - pressing "Trade perpetuals with real money" ON sends NOTHING; the
 *     consent's own button writes, only once the regional attestation is
 *     ticked, and what it sends is the whole record — the switch, core's
 *     consent version, the attestation — never a time stamp;
 *   - every switch shows only what the server confirmed, and an off is one
 *     click that lands even beside a refusal;
 *   - the status line never reads an unread or unreported Lighter as "no
 *     positions", and paper is always called paper;
 *   - the fields send only what was touched, on core's own bounds and grids,
 *     and refuse beside the field before anything is sent;
 *   - reachability never invents a venue minimum.
 *
 * Source scans at the end pin the consent's words (the honesty.test.ts idiom),
 * because a render test passes on a branch that never fired.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import {
  GRANT_PERP_LIGHTER,
  LIGHTER_MARKETS_V1,
  LIGHTER_ROUTE_V1,
  PERPS_LIVE_CONSENT_VERSION,
  PERPS_NUM_BOUNDS,
  SETTINGS_DEFAULTS,
  perpsBlockerText,
  validatePerpPubKey,
  type PerpsNumKey,
} from "@merrymen/core";
import { EN } from "@/lib/messages/en";
import {
  EMPTY_PERPS_DRAFT,
  PERPS_NUM_KEYS,
  liveConsentCounts,
  liveConsentStale,
  perpMarketGroups,
  perpMarketsInForce,
  perpsAutonomyReadiness,
  perpsDraftBody,
  perpsDraftProblems,
  perpsLiveOffBody,
  perpsLiveOnBody,
  perpsStatusView,
  readPerpsGrant,
  readPerpsNum,
  sessionGapMarkets,
  stopAtLeverage,
  withOwner,
  type PerpsStored,
} from "./perps-settings";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACCOUNT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/** A canonical Lighter public key: limb 0 = 1, the rest 0 (five LE Goldilocks limbs, not all zero). */
const PUBKEY = `0x01${"00".repeat(39)}`;
const DEFAULTS = SETTINGS_DEFAULTS;

// ── fixtures: the worker's report, as `agents.perps` carries it ──────────

const POSITION = {
  market: "BTC-PERP",
  side: "long",
  baseAmount: "0.00020",
  entryPrice: "65000.0",
  markPrice: "65100.0",
  leverage: 2,
  marginMicro: "6500000",
  liqPrice: "33000.0",
  unrealizedMicro: "20000",
  stopTrigger: "61750.0",
  fundingMicro: "0",
};
const PAPER_REPORT = {
  v: 1,
  mode: "paper",
  blocker: null,
  venueReadAt: 1_700_000_000_000,
  protectAt: 1_700_000_000_000,
  accountIndex: null,
  positions: [POSITION],
  openNotionalMicro: "13000000",
  collateralMicro: "30000000",
  inTransitMicro: "0",
  minLiqDistanceBps: 4900,
  stopsMissing: 0,
  incident: false,
};
const LIVE_REPORT = { ...PAPER_REPORT, mode: "live", accountIndex: 42, positions: [POSITION, { ...POSITION, market: "ETH-PERP", side: "short" }] };
const REFUSE_REPORT = {
  ...PAPER_REPORT,
  mode: "refuse",
  blocker: "perps-not-granted",
  positions: [],
  openNotionalMicro: "0",
  collateralMicro: "0",
};
/** Live, and the venue was not read: the worker's own marker is null venue figures (perps/view.ts). */
const LIVE_UNREAD_REPORT = {
  ...LIVE_REPORT,
  positions: [POSITION],
  openNotionalMicro: null,
  collateralMicro: null,
  inTransitMicro: null,
  minLiqDistanceBps: null,
  stopsMissing: 1,
};

function grantsBody(over: Partial<{ perps: unknown; perpsOptIn: boolean; granted: boolean; perTradeUsdg: number; expiresAt: number; exists: boolean; mode: string }> = {}) {
  if (over.exists === false) return { exists: false, ...(over.perps !== undefined ? { perps: over.perps } : {}) };
  const granted = over.granted ?? true;
  return {
    exists: true,
    ...(over.mode !== undefined ? { mode: over.mode } : {}),
    grant: {
      smartAccount: ACCOUNT,
      ...(over.expiresAt !== undefined ? { expiresAt: over.expiresAt } : {}),
      chainId: LIGHTER_ROUTE_V1.chainId,
      caps: { perTradeUsdg: over.perTradeUsdg ?? 20, dailyUsdg: 100, expiryDays: 30, maxDrawdownPct: 20, maxOpsPerDay: 50 },
      grantFeatures: granted ? [GRANT_PERP_LIGHTER] : [],
      ...(granted ? { perp: { route: GRANT_PERP_LIGHTER, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PUBKEY } } : {}),
    },
    ...(over.perpsOptIn !== undefined ? { perpsOptIn: over.perpsOptIn } : {}),
    ...(over.perps !== undefined ? { perps: over.perps } : {}),
  };
}

/** A consent record that counts, as the PUT writes it. */
const CONSENTED: PerpsStored = {
  perpsEnabled: true,
  perpsLiveEnabled: true,
  perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION,
  perpsRegionAttested: true,
  perpsLiveConsentAt: 1_700_000_000_000,
};

// ── the harness ──────────────────────────────────────────────────────────

/**
 * REACT-DOM DECIDES AT LOAD TIME WHETHER IT IS IN A BROWSER, and this file
 * types (groupchat-screen.test.ts has the whole story): with no window when it
 * first loads, react-dom falls back to an IE polyfill that never sees an
 * `input` event. So a throwaway window stands while everything that pulls
 * react-dom in is imported, and is taken away after.
 */
let testDom: typeof import("./test-dom").testDom;
let json: typeof import("./test-dom").json;
let PerpsSettings: typeof import("./PerpsSettings").PerpsSettings;
let LIGHTER_TERMS_URL: string;
before(async () => {
  const boot = new JSDOM("<!doctype html><p></p>", { pretendToBeVisual: true });
  const g = globalThis as Record<string, unknown>;
  g.window = boot.window;
  g.document = boot.window.document;
  ({ testDom, json } = await import("./test-dom"));
  ({ PerpsSettings, LIGHTER_TERMS_URL } = await import("./PerpsSettings"));
  Reflect.deleteProperty(g, "window");
  Reflect.deleteProperty(g, "document");
  boot.window.close();
});

let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Handler>;
let calls: { method: string; url: string; body: Record<string, unknown> | null }[];
/** What the scripted server has stored. The PUT below is a small model of the real route's perps branches. */
let stored: PerpsStored;
let savedCount: number;
const globalsBefore = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  ui = testDom();
  calls = [];
  stored = {};
  savedCount = 0;
  // next/link, outside a browser: with no IntersectionObserver it prefetches
  // on requestIdleCallback from `self`, which node does not define (the
  // market-flip note in nav.test.ts). Given here, and taken back after.
  for (const [name, value] of Object.entries({
    self: globalThis,
    requestIdleCallback: (cb: () => void) => setTimeout(cb, 0),
    cancelIdleCallback: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  })) {
    globalsBefore.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  routes = {
    "GET /api/grants": () => json(grantsBody()),
    "GET /api/settings": () => json({ values: stored }),
    "PUT /api/settings": (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const next: Record<string, unknown> = { ...stored };
      for (const [k, v] of Object.entries(body)) {
        if (k === "owner") continue;
        if (k === "perpsLiveEnabled" && v === false) {
          next.perpsLiveEnabled = false;
          delete next.perpsLiveConsentVersion;
          delete next.perpsLiveConsentAt;
          delete next.perpsRegionAttested;
        } else if (k === "perpsLiveEnabled" && v === true) {
          next.perpsLiveEnabled = true;
          next.perpsLiveConsentAt = Date.now();
        } else if (v === null) delete next[k];
        else next[k] = v;
      }
      stored = next as PerpsStored;
      return json({ ok: true, appliesWithin: "one worker tick" });
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    const handler = routes[`${method} ${url.split("?")[0]}`];
    return handler ? handler(url, init) : json({ error: "not scripted" }, 404);
  }) as typeof fetch;
});

afterEach(async () => {
  await ui.close();
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of globalsBefore) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  globalsBefore.clear();
});

const text = () => ui.container.textContent ?? "";
const writes = () => calls.filter((c) => c.method !== "GET");
const button = (label: string) =>
  Array.from(ui.container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) ?? null;
/** The checkbox inside the field whose label reads `label`. */
const checkbox = (label: string) => {
  const field = Array.from(ui.container.querySelectorAll("label")).find((l) => l.querySelector(".mm-label")?.textContent === label);
  return field?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
};
const PAPER = EN["settings.perps.label.paper"];
const LIVE = EN["settings.perps.label.live"];
const CONFIRM = EN["settings.perps.consent.confirm"];
const SAVE = EN["settings.perps.save"];

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2));
    });
  }
}

async function until(cond: () => boolean, what: string, rounds = 100) {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return;
    await settle(1);
  }
  assert.fail(`never happened: ${what}\n--- screen ---\n${text()}`);
}

async function press(el: Element | null | undefined, what: string) {
  assert.ok(el, `missing: ${what}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

/** Type into a text field the way a person does: React sees an input event with the new value. */
async function typeInto(name: PerpsNumKey, value: string) {
  const input = ui.container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  assert.ok(input, `missing field ${name}`);
  const setter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  });
  await settle(1);
}

async function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new ui.dom.window.Event("change", { bubbles: true }));
  });
  await settle(1);
}

/**
 * The section as Settings.tsx mounts it: values from the last read, and an
 * onSaved that re-reads them — so a switch moves only when the server's
 * answer says it moved.
 */
function Harness(props: { owner: string | null; hosted: boolean | null }) {
  const [values, setValues] = useState<PerpsStored>(stored);
  return createElement(PerpsSettings, {
    values,
    defaults: DEFAULTS,
    owner: props.owner,
    hosted: props.hosted,
    onSaved: async () => {
      savedCount += 1;
      const r = await fetch("/api/settings");
      if (r.ok) setValues(((await r.json()) as { values: PerpsStored }).values);
    },
  });
}

async function shown(opts: { owner?: string | null; hosted?: boolean | null } = {}) {
  await ui.render(createElement(Harness, { owner: opts.owner === undefined ? OWNER : opts.owner, hosted: opts.hosted ?? false }));
  await until(() => !text().includes(EN["settings.perps.status.loading"]), "the first read of /api/grants");
}

// ── the rules, without a screen ──────────────────────────────────────────

describe("the rules the section applies", () => {
  it("renders the contract's ten numbers, in its table's order, from core's one table", () => {
    assert.deepEqual(PERPS_NUM_KEYS, [
      "perpsMaxLeverage",
      "perpsPerTradeUsdg",
      "perpsMaxOpenNotionalUsdg",
      "perpsMaxCollateralUsdg",
      "perpsMaxOpensPerDay",
      "perpsStopLossPct",
      "perpsStopSlipBps",
      "perpsTakeProfitPct",
      "perpsLiqBufferPct",
      "perpsMaxSlippageBps",
    ]);
    assert.deepEqual(PERPS_NUM_KEYS, Object.keys(PERPS_NUM_BOUNDS));
  });

  it("reads a typed number on the field's OWN grid and bounds, not the suffix guess", () => {
    assert.deepEqual(readPerpsNum("perpsMaxLeverage", "3"), { ok: true, value: 3 });
    assert.deepEqual(readPerpsNum("perpsMaxLeverage", "2.5"), { ok: false, reason: "rule" }, "leverage is whole");
    assert.deepEqual(readPerpsNum("perpsMaxLeverage", "11"), { ok: false, reason: "rule" }, "never above 10");
    // Two places on a percentage — the suffix rule (settingDecimals) would read it as whole.
    assert.deepEqual(readPerpsNum("perpsStopLossPct", "2,5"), { ok: true, value: 2.5 });
    assert.deepEqual(readPerpsNum("perpsStopSlipBps", "451"), { ok: false, reason: "rule" }, "inside the venue's 5% band");
    assert.deepEqual(readPerpsNum("perpsPerTradeUsdg", "9.99"), { ok: false, reason: "rule" });
    assert.deepEqual(readPerpsNum("perpsTakeProfitPct", "0"), { ok: true, value: 0 }, "0 = no take-profit");
    assert.deepEqual(readPerpsNum("perpsPerTradeUsdg", ""), { ok: true, value: null }, "empty clears to the default");
    assert.deepEqual(readPerpsNum("perpsPerTradeUsdg", "abc"), { ok: false, reason: "rule" });
    for (const k of PERPS_NUM_KEYS) {
      const b = PERPS_NUM_BOUNDS[k];
      assert.deepEqual(readPerpsNum(k, String(b.min)), { ok: true, value: b.min }, `${k} min`);
      assert.deepEqual(readPerpsNum(k, String(b.max)), { ok: true, value: b.max }, `${k} max`);
      assert.equal(readPerpsNum(k, String(b.max + 1)).ok, false, `${k} above max`);
    }
  });

  it("the save body carries only what was touched — never a switch, never a consent key", () => {
    const body = perpsDraftBody({
      driver: "manual",
      markets: ["BTC-PERP", "SOL-PERP"],
      nums: { perpsMaxLeverage: "3", perpsStopLossPct: "2,5", perpsTakeProfitPct: "" },
    });
    assert.deepEqual(body, {
      perpsDriver: "manual",
      perpsMarkets: ["BTC-PERP", "SOL-PERP"],
      perpsMaxLeverage: 3,
      perpsStopLossPct: 2.5,
      perpsTakeProfitPct: null,
    });
    assert.deepEqual(perpsDraftBody(EMPTY_PERPS_DRAFT), {});
  });

  it("judges a draft the way the PUT does: no markets, and a total below one position", () => {
    const empty = perpsDraftProblems({ ...EMPTY_PERPS_DRAFT, markets: [] }, {}, DEFAULTS);
    assert.equal(empty.markets, "empty");
    const inverted = perpsDraftProblems({ ...EMPTY_PERPS_DRAFT, nums: { perpsPerTradeUsdg: "40" } }, { perpsMaxOpenNotionalUsdg: 30 }, DEFAULTS);
    assert.equal(inverted.openBelowTrade, 40);
    // A stored inversion from an older build does not fail an unrelated save.
    const untouched = perpsDraftProblems({ ...EMPTY_PERPS_DRAFT, driver: "manual" }, { perpsPerTradeUsdg: 40, perpsMaxOpenNotionalUsdg: 30 }, DEFAULTS);
    assert.equal(untouched.openBelowTrade, null);
  });

  it("a consent counts exactly as the worker reads it: switch, CURRENT version, attestation and the PUT's stamp", () => {
    assert.equal(liveConsentCounts(CONSENTED), true);
    for (const [what, s] of [
      ["an older text", { ...CONSENTED, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION + 1 }],
      ["no attestation", { ...CONSENTED, perpsRegionAttested: undefined }],
      ["no stamp", { ...CONSENTED, perpsLiveConsentAt: undefined }],
      ["the switch alone", { perpsLiveEnabled: true }],
    ] as const) {
      assert.equal(liveConsentCounts(s), false, what);
      assert.equal(liveConsentStale(s), true, what);
    }
    assert.equal(liveConsentStale({}), false);
  });

  it("THE PUT BODY SHAPE: the consent is the whole record and never a time; off is the switch alone", () => {
    assert.deepEqual(perpsLiveOnBody(), {
      perpsLiveEnabled: true,
      perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION,
      perpsRegionAttested: true,
    });
    assert.ok(!("perpsLiveConsentAt" in perpsLiveOnBody()), "the route stamps the time; a client never sends one");
    assert.deepEqual(perpsLiveOffBody(), { perpsLiveEnabled: false });
    assert.deepEqual(withOwner(perpsLiveOffBody(), OWNER), { perpsLiveEnabled: false, owner: OWNER });
    assert.deepEqual(withOwner(perpsLiveOffBody(), null), { perpsLiveEnabled: false });
  });

  it("reads GET /api/grants with every 'not said' kept apart from 'no'", () => {
    assert.deepEqual(readPerpsGrant(null), { state: "unread" });
    assert.deepEqual(readPerpsGrant({ connected: false }), { state: "unread" }, "the wrong shape is unread");
    const r = readPerpsGrant(grantsBody({ perps: LIVE_REPORT, perpsOptIn: true }));
    assert.equal(r.state, "read");
    if (r.state !== "read") return;
    assert.equal(r.granted, true);
    assert.equal(r.optIn, true);
    assert.equal(r.signedPerTradeUsdg, 20);
    assert.equal(r.report?.mode, "live");
    const bare = readPerpsGrant(grantsBody({ granted: false }));
    assert.ok(bare.state === "read" && bare.granted === false && bare.optIn === null && bare.report === null);
    // One malformed field rejects the whole report (core's whitelist) — never a book with a position missing.
    const bad = readPerpsGrant(grantsBody({ perps: { ...LIVE_REPORT, positions: [{ ...POSITION, marginMicro: 12.5 }] } }));
    assert.ok(bad.state === "read" && bad.report === null);
    assert.ok(validatePerpPubKey(PUBKEY), "the fixture's key is canonical, so `granted` is the grant's answer");
  });

  it("the status never reads unread or unreported as nothing", () => {
    assert.deepEqual(perpsStatusView({ state: "unread" }), { kind: "unread" });
    assert.deepEqual(perpsStatusView(readPerpsGrant(grantsBody())), { kind: "not-reported" });
    const unread = perpsStatusView(readPerpsGrant(grantsBody({ perps: LIVE_UNREAD_REPORT })));
    assert.ok(unread.kind === "report" && unread.lighterUnread && unread.positions === 1 && unread.stopsMissing === 1);
    const off = perpsStatusView(readPerpsGrant(grantsBody({ perps: { ...REFUSE_REPORT, mode: "off", blocker: "perps-off" } })));
    assert.ok(off.kind === "report" && off.blocker === null, "the off line is not said twice");
  });

  it("groups every market, crypto first, and warns on the ones whose market closes", () => {
    const groups = perpMarketGroups();
    assert.equal(groups[0]?.cls, "crypto");
    assert.equal(groups.flatMap((g) => g.markets).length, LIGHTER_MARKETS_V1.length);
    assert.deepEqual(sessionGapMarkets(["BTC-PERP", "TSLA-PERP", "SPY-PERP", "XAU-PERP", "PONS-PERP"]), ["TSLA-PERP", "SPY-PERP", "XAU-PERP"]);
    assert.deepEqual(sessionGapMarkets(["BTC-PERP", "ETH-PERP"]), []);
  });

  it("markets in force follow the worker: absent is the default; unknown keys never reach a draft", () => {
    assert.deepEqual(perpMarketsInForce({}, DEFAULTS), ["BTC-PERP", "ETH-PERP"]);
    assert.deepEqual(perpMarketsInForce({ perpsMarkets: ["SOL-PERP", "TSLA", "SOL-PERP", "FOO-PERP"] }, DEFAULTS), ["SOL-PERP"]);
  });

  it("says the stop as a share of margin at the chosen leverage, and names the one combination no market can pass", () => {
    const d = stopAtLeverage({ stopPct: 5, slipBps: 200, leverage: 2, liqBufferPct: 2 });
    assert.equal(d.marginPct, 10);
    assert.equal(d.worstMarginPct, 14.2, "a short's stop filling at the edge: (5% + 2% + 0.1%) × 2");
    assert.equal(d.liqBoundPct, 50);
    assert.equal(d.everyOpenRefused, false);
    // 8% + 2% − 0.16% + 2% ≥ 10%: liquidation (nearer than 1/L) always beats the stop plus its room.
    assert.equal(stopAtLeverage({ stopPct: 8, slipBps: 200, leverage: 10, liqBufferPct: 2 }).everyOpenRefused, true);
  });
});

// ── the status line ──────────────────────────────────────────────────────

describe("the status line, from agents.perps", () => {
  it("NO REPORT IS NOT NO POSITIONS", async () => {
    await shown();
    assert.match(text(), /has not reported on perpetuals yet/);
    assert.doesNotMatch(text(), /Open positions/);
  });

  it("a status that could not be read says so, and never shows a count", async () => {
    routes["GET /api/grants"] = () => json({ error: "boom" }, 500);
    await shown();
    assert.match(text(), /Couldn't read your agent's status just now/);
    assert.match(text(), /That is not the same as nothing/);
    assert.doesNotMatch(text(), /Open positions/);
  });

  it("paper is called paper", async () => {
    routes["GET /api/grants"] = () => json(grantsBody({ perps: PAPER_REPORT }));
    await shown();
    assert.match(text(), /Practising on paper — simulated money at Lighter's live prices\./);
    assert.match(text(), /Open paper positions: 1\./);
  });

  it("PRACTICE HELD WHILE PERPS ARE OFF is still counted as paper — the account's book decides, not the rail", async () => {
    routes["GET /api/grants"] = () => json(grantsBody({ perps: { ...PAPER_REPORT, mode: "off", blocker: "perps-off" }, mode: "paper" }));
    await shown();
    assert.match(text(), /Perpetuals are off\./);
    assert.match(text(), /Open paper positions: 1\./);
    assert.doesNotMatch(text(), /Open positions: 1/);
  });

  it("a held book the report does not place is counted without calling it real", async () => {
    routes["GET /api/grants"] = () => json(grantsBody({ perps: { ...PAPER_REPORT, mode: "off", blocker: "perps-off" } }));
    await shown();
    assert.match(text(), /Open positions: 1\. Your agent's report doesn't say whether they are paper or real money\./);
  });

  it("AN UNREAD VENUE IS NEVER 'Open positions: 0': it gives the last-held count, said as that", async () => {
    routes["GET /api/grants"] = () => json(grantsBody({ perps: { ...LIVE_UNREAD_REPORT, positions: [], stopsMissing: 2 } }));
    await shown();
    assert.match(text(), /Positions held at the last record: 2\. What is open now is unknown\./);
    assert.doesNotMatch(text(), /Open positions: 0/);
    assert.match(text(), /Lighter could not be read/);
    const v = perpsStatusView(readPerpsGrant(grantsBody({ perps: { ...PAPER_REPORT, collateralMicro: null, inTransitMicro: null, positions: [], stopsMissing: 3 } })));
    assert.ok(v.kind === "report" && v.positions === 3 && v.book === "paper" && v.lighterUnread);
  });

  it("live says real money, and counts what the venue holds", async () => {
    routes["GET /api/grants"] = () => json(grantsBody({ perps: LIVE_REPORT }));
    await shown();
    assert.ok(text().includes(EN["settings.perps.status.live"]));
    assert.match(text(), /Open positions: 2\./);
    assert.doesNotMatch(text(), /could not be read/);
  });

  it("refuse names its blocker in the owner's words, with the remedy", async () => {
    routes["GET /api/grants"] = () => json(grantsBody({ perps: REFUSE_REPORT, granted: false }));
    await shown();
    const words = perpsBlockerText("perps-not-granted");
    assert.match(text(), /Not trading perpetuals right now\./);
    assert.ok(text().includes(words.what));
    assert.ok(words.remedy && text().includes(words.remedy));
  });

  it("a live report whose venue was unread says Lighter could not be read, and counts stops nobody saw", async () => {
    routes["GET /api/grants"] = () => json(grantsBody({ perps: LIVE_UNREAD_REPORT }));
    await shown();
    assert.match(text(), /Lighter could not be read at your agent's last check/);
    assert.match(text(), /Positions without a stop seen resting at Lighter at the last check: 1\./);
  });

  it("a malformed report reads as not reported, never as an empty book", async () => {
    routes["GET /api/grants"] = () => json(grantsBody({ perps: { ...LIVE_REPORT, mode: "moon" } }));
    await shown();
    assert.match(text(), /has not reported on perpetuals yet/);
  });
});

// ── the switches and the consent ─────────────────────────────────────────

describe("the practice switch", () => {
  it("writes at once, and shows on only once the server's answer says so", async () => {
    await shown();
    assert.equal(checkbox(PAPER)?.checked, false);
    await press(checkbox(PAPER), "the practice switch");
    assert.deepEqual(writes(), [{ method: "PUT", url: "/api/settings", body: { perpsEnabled: true, owner: OWNER } }]);
    await until(() => checkbox(PAPER)?.checked === true, "the confirmed state");
    assert.equal(savedCount, 1, "the page re-read its values");
    assert.match(text(), /on — practising with simulated money at Lighter's live prices/);
  });

  it("on a live account, it does not pretend perpetuals are practice", async () => {
    stored = { perpsEnabled: true, liveTradingEnabled: true };
    await shown();
    assert.match(text(), /your account trades for real, so perpetuals trade only once the real-money switch below is on too/);
    assert.doesNotMatch(text(), /practising with simulated money at Lighter/);
  });
});

describe("real money is a consent, not a checkbox", () => {
  it("a new owner inherits no consent, draft limits or venue report", async () => {
    stored = { perpsEnabled: true };
    await shown({ hosted: true });
    await typeInto("perpsMaxLeverage", "9");
    await press(checkbox(LIVE), "A's switch");
    const panel = ui.container.querySelector('[aria-labelledby="perps-consent-title"]')!;
    await press(Array.from(panel.querySelectorAll("label")).find((l) => l.textContent?.includes("excluded region"))?.querySelector("input"), "A's attestation");
    assert.equal(button(CONFIRM)?.disabled, false);
    routes["GET /api/grants"] = () => json(grantsBody({ granted: false }));
    await shown({ owner: ACCOUNT, hosted: true });
    assert.equal(ui.container.querySelector('[aria-labelledby="perps-consent-title"]'), null);
    assert.equal(ui.container.querySelector<HTMLInputElement>('input[name="perpsMaxLeverage"]')?.value, "");
    assert.equal(button(SAVE)?.disabled, true);
    assert.equal(calls.filter((c) => c.url.split("?")[0] === "/api/grants").length, 2);
    await press(checkbox(LIVE), "B's switch");
    assert.equal(button(CONFIRM)?.disabled, true, "B must attest independently");
    assert.match(text(), /The Perpetuals permission in the permission you signed: not included/);
    assert.deepEqual(writes(), []);
  });

  it("A's delayed save result cannot refresh or reset B's new draft", async () => {
    stored = { perpsEnabled: true };
    await shown({ hosted: true });
    let finish!: (r: Response) => void;
    routes["PUT /api/settings"] = () => new Promise((resolve) => { finish = resolve; });
    await typeInto("perpsMaxLeverage", "9");
    await press(button(SAVE), "A's save");
    assert.equal(writes()[0]?.body?.owner, OWNER);
    await shown({ owner: ACCOUNT, hosted: true });
    await typeInto("perpsMaxLeverage", "3");
    await act(async () => { finish(json({ ok: true })); });
    await settle();
    assert.equal(savedCount, 0, "the old result must not reload the new owner's settings");
    assert.equal(ui.container.querySelector<HTMLInputElement>('input[name="perpsMaxLeverage"]')?.value, "3");
    assert.equal(button(SAVE)?.disabled, false);
    assert.doesNotMatch(text(), new RegExp(EN["settings.perps.saved"]));
    routes["PUT /api/settings"] = () => json({ ok: true });
    await press(button(SAVE), "B's save");
    assert.equal(writes()[1]?.body?.owner, ACCOUNT);
    assert.equal(writes()[1]?.body?.perpsMaxLeverage, 3);
  });

  it("the real-money switch cannot be turned on before practice is saved on", async () => {
    await shown();
    assert.equal(checkbox(LIVE)?.disabled, true);
    assert.match(text(), /Turn on practice perpetuals first — real ones need both switches\./);
  });

  it("PRESSING THE SWITCH ON SENDS NOTHING; the consent needs the attestation; the PUT is the whole record", async () => {
    stored = { perpsEnabled: true };
    await shown();
    await press(checkbox(LIVE), "the real-money switch");
    assert.deepEqual(writes(), [], "the switch itself sent something");
    assert.equal(checkbox(LIVE)?.checked, false, "still off while the owner reads");

    const panel = ui.container.querySelector('[aria-labelledby="perps-consent-title"]');
    assert.ok(panel, "the consent opened");
    const said = panel.textContent ?? "";
    assert.match(said, /anyone who gets your agent's Lighter key can lose everything it has on Lighter/);
    assert.match(said, /your per-trade limit caps each deposit, not each day/);
    assert.match(said, /software an attacker does not run/);
    assert.match(said, /Order size, leverage, markets and how often it trades are limited only by your agent's software/);
    assert.match(said, /Lighter liquidates it/);
    assert.match(said, /funding every hour/);
    assert.match(said, /anyone can look up your agent's/);
    assert.match(said, /Lighter's Robinhood Chain instance/);
    assert.match(said, /the US, the UK, Canada or a sanctioned country/);
    assert.match(said, /Switzerland, the UAE and Singapore/);
    const terms = panel.querySelector<HTMLAnchorElement>(`a[href="${LIGHTER_TERMS_URL}"]`);
    assert.ok(terms, "the venue's terms are linked");
    assert.equal(LIGHTER_TERMS_URL, "https://lighter.xyz/terms");
    // Focus lands on the words, not on the button.
    assert.equal(ui.dom.window.document.activeElement?.id, "perps-consent-title");

    const confirm = button(CONFIRM);
    assert.ok(confirm);
    assert.equal(confirm.disabled, true, "confirmable without the attestation");
    await press(confirm, "the disabled confirm");
    assert.deepEqual(writes(), [], "a consent went out without the attestation");

    const attest = Array.from(panel.querySelectorAll("label")).find((l) => l.textContent?.includes("I am not a resident of, or located in, an excluded region"));
    await press(attest?.querySelector("input"), "the attestation");
    assert.equal(button(CONFIRM)?.disabled, false);
    await press(button(CONFIRM), "the consent");
    assert.deepEqual(writes(), [
      {
        method: "PUT",
        url: "/api/settings",
        body: { perpsLiveEnabled: true, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION, perpsRegionAttested: true, owner: OWNER },
      },
    ]);
    await until(() => checkbox(LIVE)?.checked === true, "the confirmed state");
    assert.equal(ui.container.querySelector('[aria-labelledby="perps-consent-title"]'), null, "the consent closed");
  });

  it("'Not now' sends nothing and asks again next time", async () => {
    stored = { perpsEnabled: true };
    await shown();
    await press(checkbox(LIVE), "the switch");
    const panel = ui.container.querySelector('[aria-labelledby="perps-consent-title"]')!;
    await press(Array.from(panel.querySelectorAll("label")).find((l) => l.textContent?.includes("excluded region"))?.querySelector("input"), "attest");
    await press(button(EN["settings.perps.consent.cancel"]), "Not now");
    assert.equal(ui.container.querySelector('[aria-labelledby="perps-consent-title"]'), null);
    assert.deepEqual(writes(), []);
    await press(checkbox(LIVE), "the switch again");
    assert.equal(button(CONFIRM)?.disabled, true, "the attestation is asked for again, not remembered");
  });

  it("switching practice off while the consent is open closes it, so no consent is given to perpetuals that are off", async () => {
    stored = { perpsEnabled: true };
    await shown();
    await press(checkbox(LIVE), "the switch");
    assert.ok(ui.container.querySelector('[aria-labelledby="perps-consent-title"]'));
    await press(checkbox(PAPER), "practice off");
    await until(() => checkbox(PAPER)?.checked === false, "practice off, re-read");
    assert.equal(ui.container.querySelector('[aria-labelledby="perps-consent-title"]'), null);
    assert.deepEqual(writes(), [{ method: "PUT", url: "/api/settings", body: { perpsEnabled: false, owner: OWNER } }]);
  });

  it("OFF IS ONE CLICK: no consent, the switch alone, for the wallet the values were read for", async () => {
    stored = { ...CONSENTED };
    await shown();
    assert.equal(checkbox(LIVE)?.checked, true);
    await press(checkbox(LIVE), "the switch");
    assert.equal(ui.container.querySelector('[aria-labelledby="perps-consent-title"]'), null);
    assert.deepEqual(writes(), [{ method: "PUT", url: "/api/settings", body: { perpsLiveEnabled: false, owner: OWNER } }]);
    await until(() => checkbox(LIVE)?.checked === false, "off");
  });

  it("an off the server wrote beside a refusal shows as off, and says what happened", async () => {
    stored = { ...CONSENTED };
    routes["PUT /api/settings"] = () => {
      stored = { perpsEnabled: true, perpsLiveEnabled: false };
      return json(
        {
          errors: ["perpsMaxLeverage: must be a whole number between 1 and 10"],
          saved: ["perpsLiveEnabled"],
          note: "Switched off (perpsLiveEnabled) — that was saved. Nothing else in this save was, because of the errors above.",
        },
        400,
      );
    };
    await shown();
    await press(checkbox(LIVE), "the switch");
    await until(() => checkbox(LIVE)?.checked === false, "the off the server kept");
    assert.match(text(), /Switched off \(perpsLiveEnabled\) — that was saved\./);
  });

  it("a refused consent leaves the switch off and keeps the consent open with the reason", async () => {
    stored = { perpsEnabled: true };
    routes["PUT /api/settings"] = () => json({ errors: ["perpsLiveEnabled: real-money perpetuals are switched on only with the current consent"] }, 400);
    await shown();
    await press(checkbox(LIVE), "the switch");
    const panel = ui.container.querySelector('[aria-labelledby="perps-consent-title"]')!;
    await press(Array.from(panel.querySelectorAll("label")).find((l) => l.textContent?.includes("excluded region"))?.querySelector("input"), "attest");
    await press(button(CONFIRM), "the consent");
    assert.equal(checkbox(LIVE)?.checked, false);
    assert.ok(ui.container.querySelector('[aria-labelledby="perps-consent-title"]'), "the consent stays open");
    assert.match(text(), /switched on only with the current consent/);
    assert.equal(savedCount, 0, "nothing was written, so nothing was re-read");
  });

  it("a consent to an older text shows off, and says it no longer counts", async () => {
    stored = { ...CONSENTED, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION + 1 };
    await shown();
    assert.equal(checkbox(LIVE)?.checked, false);
    assert.match(text(), /given for an earlier version of this text, so it no longer counts/);
  });

  it("the consent names what real money ALSO needs, from the account and its grant", async () => {
    stored = { perpsEnabled: true, liveTradingEnabled: false };
    routes["GET /api/grants"] = () => json(grantsBody({ granted: false, perpsOptIn: false }));
    await shown({ hosted: true });
    await press(checkbox(LIVE), "the switch");
    const said = ui.container.querySelector('[aria-labelledby="perps-consent-title"]')?.textContent ?? "";
    assert.match(said, /Live trading, at the top of this page: off\. Turn it on and save\./);
    assert.match(said, /The Perpetuals permission in the permission you signed: not included\./);
    assert.ok(ui.container.querySelector('[aria-labelledby="perps-consent-title"] a[href="/grant#resign"]'), "a way to re-sign");
    assert.match(said, /does not offer real-money perpetuals for your agent yet/);
  });

  it("hosted, with no offer said, the consent says it may not be offered yet", async () => {
    stored = { perpsEnabled: true, liveTradingEnabled: true };
    routes["GET /api/grants"] = () => json(grantsBody({}));
    await shown({ hosted: true });
    await press(checkbox(LIVE), "the switch");
    const said = ui.container.querySelector('[aria-labelledby="perps-consent-title"]')?.textContent ?? "";
    assert.match(said, /Live trading, at the top of this page: on\./);
    assert.match(said, /The Perpetuals permission in the permission you signed: included\./);
    assert.match(said, /The hosted service may not offer real-money perpetuals for your agent yet/);
  });

  it("a form read for nobody sends no owner", async () => {
    stored = { perpsEnabled: true };
    await shown({ owner: null });
    await press(checkbox(PAPER), "the practice switch off");
    assert.deepEqual(writes()[0]?.body, { perpsEnabled: false });
  });
});

// ── markets and limits ───────────────────────────────────────────────────

describe("markets and limits", () => {
  it("saves only what was touched, numbers as numbers, with its own button", async () => {
    await shown();
    await choose(ui.container.querySelector("select")!, "manual");
    await press(button("SOL-PERP"), "SOL-PERP");
    await typeInto("perpsMaxLeverage", "3");
    await typeInto("perpsStopLossPct", "2,5");
    await press(button(SAVE), "save");
    assert.deepEqual(writes(), [
      {
        method: "PUT",
        url: "/api/settings",
        body: {
          perpsDriver: "manual",
          perpsMarkets: ["BTC-PERP", "ETH-PERP", "SOL-PERP"],
          perpsMaxLeverage: 3,
          perpsStopLossPct: 2.5,
          owner: OWNER,
        },
      },
    ]);
    await until(() => (button(SAVE)?.disabled ?? false) === true, "a clean draft after the save");
    assert.equal(ui.container.querySelector<HTMLInputElement>('input[name="perpsMaxLeverage"]')?.value, "3", "the saved value, re-read");
  });

  it("a number off core's grid is refused beside its field, and nothing is sent", async () => {
    await shown();
    await typeInto("perpsMaxLeverage", "2.5");
    const input = ui.container.querySelector<HTMLInputElement>('input[name="perpsMaxLeverage"]')!;
    assert.equal(input.getAttribute("aria-invalid"), "true");
    const alerts = Array.from(ui.container.querySelectorAll('[role="alert"]')).map((a) => a.textContent);
    assert.ok(alerts.includes("A whole number from 1 to 10."), `the refusal names the rule: ${alerts.join(" | ")}`);
    assert.equal(button(SAVE)?.disabled, true);
    await press(button(SAVE), "the disabled save");
    assert.deepEqual(writes(), []);
  });

  it("the total can't be below one position — said on screen, as the PUT would", async () => {
    stored = { perpsMaxOpenNotionalUsdg: 30 };
    await shown();
    await typeInto("perpsPerTradeUsdg", "40");
    assert.match(text(), /Must be at least the largest position \(40 USDG\)/);
    assert.equal(button(SAVE)?.disabled, true);
  });

  it("unticking every market is refused on screen; stopping is the switch's job", async () => {
    await shown();
    await press(button("BTC-PERP"), "BTC-PERP");
    await press(button("ETH-PERP"), "ETH-PERP");
    assert.match(text(), /Pick at least one market\. To stop perpetuals, switch them off instead\./);
    assert.equal(button(SAVE)?.disabled, true);
  });

  it("at most eight: what is not picked cannot be pressed", async () => {
    await shown();
    for (const k of ["SOL-PERP", "HYPE-PERP", "ZEC-PERP", "LIT-PERP", "XRP-PERP", "NEAR-PERP"]) await press(button(k), k);
    assert.equal(button("SUI-PERP")?.disabled, true);
    assert.equal(button("BTC-PERP")?.disabled, false, "a picked one can still be unticked");
    assert.match(text(), /Markets \(8 of up to 8\)/);
  });

  it("stocks, funds and metals carry the weekend-gap warning; crypto does not", async () => {
    await shown();
    assert.doesNotMatch(text(), /close at night and at weekends/);
    await press(button("TSLA-PERP"), "TSLA-PERP");
    const warning = Array.from(ui.container.querySelectorAll(".mm-danger")).find((d) => /at weekends/.test(d.textContent ?? ""));
    assert.ok(warning, "no weekend-gap warning");
    assert.match(warning.textContent ?? "", /^TSLA-PERP: /);
    assert.match(warning.textContent ?? "", /A stop cannot protect against a jump past it/);
  });

  it("REACHABILITY IS NEVER INVENTED: the signed cap is quoted, each market's minimum is left to the venue read", async () => {
    await shown();
    assert.match(text(), /Each open is at most 20 USDG — the smaller of your signed per-trade limit \(20 USDG\)/);
    const reach = ui.container.querySelector(".perps-reach")!;
    const rows = Array.from(reach.querySelectorAll("li")).map((li) => li.textContent);
    assert.deepEqual(rows, ["BTC-PERP — checked when the agent next reads the venue", "ETH-PERP — checked when the agent next reads the venue"]);
  });

  it("when the agent found every market out of reach, it says so beside the markets", async () => {
    routes["GET /api/grants"] = () => json(grantsBody({ perps: { ...REFUSE_REPORT, mode: "live", blocker: "perps-cap-below-min" } }));
    await shown();
    const reach = ui.container.querySelector(".perps-reach")!;
    assert.ok((reach.textContent ?? "").includes(perpsBlockerText("perps-cap-below-min").what));
  });

  it("no signed permission: the cap is not set, and no number is shown for it", async () => {
    routes["GET /api/grants"] = () => json(grantsBody({ exists: false }));
    await shown();
    assert.match(text(), /no signed permission yet, so its per-trade limit isn't set/);
    assert.doesNotMatch(text(), /Each open is at most/);
  });

  it("the stop reads as a share of margin at the chosen leverage", async () => {
    await shown();
    assert.match(text(), /A 5% move against a position triggers its stop\. At 2x that is about 10% of the margin posted for it — up to about 14\.2%/);
    assert.match(text(), /Liquidation comes before a 50% move\./);
    await typeInto("perpsMaxLeverage", "10");
    await typeInto("perpsStopLossPct", "8");
    assert.match(text(), /At 10x that is about 80% of the margin/);
    assert.match(text(), /At 10x, liquidation comes before the stop plus the room before liquidation, so every open would be refused/);
  });

  it("the strategist driver says when the saved strategy can't drive it", async () => {
    stored = { strategy: "steady-basket" };
    await shown();
    await choose(ui.container.querySelector("select")!, "strategist");
    assert.match(text(), /Your saved strategy is steady-basket, not the LLM strategist/);
  });

  it("with the LLM strategist, no such warning", async () => {
    stored = { strategy: "llm-strategist", perpsDriver: "strategist" };
    await shown();
    assert.doesNotMatch(text(), /not the LLM strategist/);
  });
});

// ── the words, read from the source ──────────────────────────────────────

describe("what the section must go on saying", () => {
  const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("the attestation is the contract's sentence, word for word", () => {
    assert.equal(EN["settings.perps.consent.attest"], "I am not a resident of, or located in, an excluded region");
  });

  it("the consent names every excluded region and Lighter's terms", () => {
    const regions = EN["settings.perps.consent.regions"];
    for (const place of ["the US", "the UK", "Canada", "sanctioned", "Switzerland", "the UAE", "Singapore"]) {
      assert.ok(regions.includes(place), `the consent forgot ${place}`);
    }
    assert.match(src("./PerpsSettings.tsx"), /LIGHTER_TERMS_URL = "https:\/\/lighter\.xyz\/terms"/);
  });

  it("Settings mounts the section, and its save sends none of it", () => {
    const settings = src("./screens/Settings.tsx");
    assert.match(settings, /<PerpsSettings values=\{view\.values\} defaults=\{view\.defaults\} owner=\{view\.owner\}/);
    const saveFn = settings.slice(settings.indexOf("async function save()"), settings.indexOf("async function reloadView()"));
    assert.ok(saveFn.length > 0, "save() moved");
    assert.doesNotMatch(saveFn, /perps/, "the page's Save changes must not carry a perps key");
  });
});


describe("automatic setup is visible, current and bound to the owner", () => {
  const refresh = EN["settings.perps.status.refresh"];
  const limits = EN["settings.perps.setup.reviewLimits"];
  const report = (over: Record<string, unknown> = {}) => ({ ...LIVE_REPORT, positions: [], entriesHalted: false, venueReadAt: Date.now(), ...over });

  it("shows the saved default automatic rule and waiting state without inventing a resume action", async () => {
    stored = { ...CONSENTED, liveTradingEnabled: true };
    routes["GET /api/grants"] = () => json(grantsBody({ perps: report(), expiresAt: Math.floor(Date.now() / 1000) + 14 * 86400 }));
    await shown({ hosted: true });
    const setup = ui.container.querySelector('[aria-label="Automatic perpetual trading"]')!;
    assert.ok(setup.textContent?.includes(EN["settings.perps.driver.perpTrend"]));
    assert.match(setup.textContent ?? "", /you do not need to place each trade/);
    assert.ok(text().includes(EN["settings.perps.status.live"]));
    assert.equal(button("Resume perpetual entries"), null);
    assert.equal(writes().length, 0);
    assert.ok(calls.some(c => c.url === `/api/grants?owner=${OWNER}`));
    assert.equal(ui.container.querySelector<HTMLDetailsElement>("details")?.open, false);
    await press(button(limits), "review automatic rule and limits");
    assert.equal(ui.container.querySelector<HTMLDetailsElement>("details")?.open, true);
    assert.equal(writes().length, 0);
  });

  it("makes a seven-day grant and unreachable signed cap visible; choosing markets never widens a limit", async () => {
    stored = { ...CONSENTED, liveTradingEnabled: true, perpsMarkets: ["BTC-PERP", "ETH-PERP"], perpsPerTradeUsdg: 20 };
    routes["GET /api/grants"] = () => json(grantsBody({ expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400, perTradeUsdg: 10,
      perps: report({ entryMinimums: [{ market: "BTC-PERP", minNotionalMicro: "17000000" }, { market: "ETH-PERP", minNotionalMicro: "13000000" }] }) }));
    await shown();
    assert.match(text(), /more than 168 hours/);
    assert.match(text(), /BTC-PERP: 17 USDG/);
    assert.match(text(), /above your saved effective limit of 10 USDG/);
    assert.ok(ui.container.querySelector('a[href="/grant#resign"]'));
    assert.equal(writes().length, 0);
    await press(button(limits), "open limits");
    await press(button("SOL-PERP"), "choose another market within existing limits");
    await press(button(SAVE), "save market choice");
    assert.equal(writes().length, 1);
    assert.deepEqual(writes()[0].body, { owner: OWNER, perpsMarkets: ["BTC-PERP", "ETH-PERP", "SOL-PERP"] });
    assert.equal(stored.perpsPerTradeUsdg, 20);
    assert.equal(stored.perpsLiveConsentVersion, PERPS_LIVE_CONSENT_VERSION);
  });

  it("surfaces manual or incompatible automatic rules before the advanced fields", async () => {
    stored = { perpsEnabled: true, perpsDriver: "manual" };
    await shown();
    assert.ok(ui.container.querySelector('[aria-label="Automatic perpetual trading"]')?.textContent?.includes(EN["settings.perps.setup.manual"]));
    await press(button(limits), "review rule");
    await choose(ui.container.querySelector<HTMLSelectElement>("select")!, "perp-trend");
    await press(button(SAVE), "save automatic rule");
    assert.deepEqual(writes()[0].body, { owner: OWNER, perpsDriver: "perp-trend" });
    assert.equal(perpsAutonomyReadiness({ perpsEnabled: true, perpsMarkets: ["AAPL-PERP"] }, DEFAULTS, { state: "unread" }, Date.now()).noTrendMarkets, true);
    assert.equal(perpsAutonomyReadiness({ perpsEnabled: true, perpsDriver: "strategist", strategy: "steady" }, DEFAULTS, { state: "unread" }, Date.now()).strategistMismatch, true);
  });

  it("refresh and returning from signing follow funding and key setup without another setting change", async () => {
    stored = { ...CONSENTED, liveTradingEnabled: true };
    let blocker: string | null = "perps-awaiting-deposit";
    routes["GET /api/grants"] = () => json(grantsBody({ perps: report({ blocker }) }));
    await shown();
    assert.ok(text().includes(perpsBlockerText("perps-awaiting-deposit").what));
    blocker = "perps-key-pending";
    await press(button(refresh), "refresh setup");
    assert.ok(text().includes(perpsBlockerText("perps-key-pending").what));
    blocker = null;
    await act(async () => { ui.dom.window.dispatchEvent(new ui.dom.window.Event("focus")); });
    await until(() => !text().includes(perpsBlockerText("perps-key-pending").what), "worker completed setup");
    assert.equal(writes().length, 0);
    assert.equal(button("Resume perpetual entries"), null);
  });

  it("only a durable owner halt offers resume, and an incident retains the key-rotation gate", async () => {
    let current = report({ blocker: "perps-entries-halted" });
    routes["GET /api/grants"] = () => json(grantsBody({ perps: current }));
    await shown();
    assert.equal(button("Resume perpetual entries"), null);
    assert.ok(!text().includes("Resume them on the dashboard"));
    current = report({ blocker: "perps-entries-halted", entriesHalted: true });
    await press(button(refresh), "refresh owner pause");
    assert.ok(button("Resume perpetual entries"));
    current = report({ blocker: "perps-unknown-activity", entriesHalted: true, incident: true });
    await press(button(refresh), "refresh incident");
    assert.equal(button("Resume perpetual entries"), null);
    assert.match(text(), /key rotation before entries can resume/);
    assert.equal(writes().length, 0);
  });

  it("never marks stale or unread minimums eligible, and keeps them as last-observed facts", () => {
    const now = Date.now();
    const raw = report({ venueReadAt: now, entryMinimums: [{ market: "BTC-PERP", minNotionalMicro: "9000000" }] });
    const read = (extra: Record<string, unknown>) => perpsAutonomyReadiness({ perpsEnabled: true }, DEFAULTS,
      readPerpsGrant(grantsBody({ perps: { ...raw, ...extra }, perTradeUsdg: 10 })), now);
    assert.equal(read({}).minimums[0].fits, true);
    for (const extra of [{ venueReadAt: now - 900001 }, { venueReadAt: null }, { collateralMicro: null }, { venueReadAt: now + 1 }]) {
      assert.equal(read(extra).minimums[0].fits, null);
    }
    const invalidExpiry = readPerpsGrant(grantsBody({ expiresAt: NaN }));
    assert.ok(invalidExpiry.state === "read" && invalidExpiry.expiresAt === null);
    const short = readPerpsGrant(grantsBody({ expiresAt: Math.floor(now / 1000) + 168 * 3600 }));
    assert.equal(perpsAutonomyReadiness({ perpsEnabled: true, liveTradingEnabled: false }, DEFAULTS, short, now).authority, "short");
    assert.equal(perpsAutonomyReadiness({ perpsEnabled: true, liveTradingEnabled: false }, DEFAULTS, invalidExpiry, now).authority, null);
    assert.equal(perpsAutonomyReadiness({ perpsEnabled: true, liveTradingEnabled: true }, DEFAULTS, invalidExpiry, now).authority, "unknown");
  });

  it("an owner switch aborts a pending read and its delayed result cannot replace the new owner's report", async () => {
    let finishOld!: (r: Response) => void;
    let oldSignal!: AbortSignal;
    routes["GET /api/grants"] = (url, init) => {
      if (url.includes(OWNER)) {
        oldSignal = init!.signal as AbortSignal;
        return new Promise<Response>(resolve => { finishOld = resolve; });
      }
      return json(grantsBody({ perps: report({ blocker: "perps-not-granted" }), granted: false }));
    };
    await ui.render(createElement(Harness, { owner: OWNER, hosted: true }));
    await shown({ owner: ACCOUNT, hosted: true });
    assert.equal(oldSignal.aborted, true);
    assert.ok(text().includes(perpsBlockerText("perps-not-granted").what));
    await act(async () => { finishOld(json(grantsBody({ perps: report({ entriesHalted: true, blocker: "perps-entries-halted" }) }))); });
    await settle();
    assert.ok(text().includes(perpsBlockerText("perps-not-granted").what));
    assert.equal(button("Resume perpetual entries"), null);
    assert.equal(writes().length, 0);
  });

  it("a hung response body times out and the next automatic poll recovers with a fresh signal", async () => {
    const realTimeout = globalThis.setTimeout;
    const timers: { delay: number; run: () => void; id: ReturnType<typeof setTimeout> }[] = [];
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 10_000 || delay === 15_000) {
        const run = () => fn(...args);
        const id = realTimeout(run, 60_000);
        timers.push({ delay, run, id });
        return id;
      }
      return realTimeout(fn, delay, ...args);
    }) as typeof setTimeout;
    try {
      let attempts = 0;
      const signals: AbortSignal[] = [];
      routes["GET /api/grants"] = (_url, init) => {
        signals.push(init!.signal as AbortSignal);
        return ++attempts === 1 ? { ok: true, json: () => new Promise(() => {}) } as Response : json(grantsBody({ perps: report() }));
      };
      await ui.render(createElement(Harness, { owner: OWNER, hosted: true }));
      const fire = async (delay: number) => {
        const timer = timers.filter(t => t.delay === delay).at(-1)!;
        assert.ok(timer);
        clearTimeout(timer.id);
        await act(async () => { timer.run(); });
        await settle();
      };
      await fire(10_000);
      assert.ok(text().includes(EN["settings.perps.status.unread"]));
      assert.equal(signals[0].aborted, true);
      await fire(15_000);
      assert.equal(attempts, 2);
      assert.notEqual(signals[1], signals[0]);
      assert.equal(signals[1].aborted, false);
      assert.ok(text().includes(EN["settings.perps.status.live"]));
      assert.equal(writes().length, 0);
    } finally {
      globalThis.setTimeout = realTimeout;
      for (const timer of timers) clearTimeout(timer.id);
    }
  });
});
