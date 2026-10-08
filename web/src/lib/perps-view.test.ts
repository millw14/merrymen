/**
 * WHAT THE WEB MAKES OF THE WORKER'S PERPS REPORT (lib/perps-view.ts,
 * lib/perps-exposure.ts) — and the one sentence it must never say.
 *
 * docs/perps.md rule 13: every kill and discard message is built by
 * custodySentence and "never says 'your funds stay in your smart account'
 * while anything remains on Lighter". Rule 11: unknown is never zero. So the
 * table below walks every way a report can arrive — absent, practice, unread,
 * stale, holding, flat — with and without the perps marker on the grant, and
 * pins that the home-sentence appears for exactly the cases where nothing can
 * be at Lighter, and never where anything is open or unread.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { custodySentence, type PerpExposure, type PerpsReport } from "@merrymen/core";
import { exposureFromStatus, killPerpsFromStatus } from "./perps-exposure";
import { readKillAnswer } from "./kill-answer";
import {
  custodyText,
  grantMentionsPerps,
  HOSTED_RECOVER_PATH,
  killedCustodyText,
  killWarning,
  liqDistancePct,
  PERPS_REPORT_STALE_MS,
  perpExposureOfReport,
  perpsBookOf,
  perpsFeedOf,
} from "./perps-view";

const NOW = 1_790_697_060_000;

const LIVE: PerpsReport = {
  v: 1,
  mode: "live",
  blocker: null,
  venueReadAt: NOW - 60_000,
  protectAt: NOW - 10_000,
  accountIndex: 22149,
  positions: [
    {
      market: "BTC-PERP",
      side: "long",
      baseAmount: "0.00030",
      entryPrice: "83218.6",
      markPrice: "83220.1",
      leverage: 2,
      marginMicro: "12482790",
      liqPrice: "41931.3",
      unrealizedMicro: "-450000",
      stopTrigger: "79057.7",
      fundingMicro: "-12000",
    },
  ],
  openNotionalMicro: "24965580",
  collateralMicro: "17517210",
  inTransitMicro: "2000000",
  minLiqDistanceBps: 4961,
  stopsMissing: 0,
  incident: false,
};

/** The known zero of an agent with no venue account (worker perps/lane.ts flatReport). */
const FLAT_OFF: PerpsReport = {
  v: 1,
  mode: "off",
  blocker: "perps-off",
  venueReadAt: null,
  protectAt: null,
  accountIndex: null,
  positions: [],
  openNotionalMicro: "0",
  collateralMicro: "0",
  inTransitMicro: "0",
  minLiqDistanceBps: null,
  stopsMissing: 0,
  incident: false,
};

const PAPER: PerpsReport = { ...LIVE, mode: "paper", accountIndex: null };
/** Lighter could not be read: the ledger's rows, every venue figure null (worker perps/view.ts). */
const VENUE_UNREAD: PerpsReport = {
  ...LIVE,
  blocker: "perps-venue-unreachable",
  positions: [{ ...LIVE.positions[0]!, markPrice: null, liqPrice: null, unrealizedMicro: null, stopTrigger: null }],
  openNotionalMicro: null,
  collateralMicro: null,
  inTransitMicro: null,
  minLiqDistanceBps: null,
  stopsMissing: 1,
};
const STALE: PerpsReport = { ...LIVE, venueReadAt: NOW - PERPS_REPORT_STALE_MS - 1 };
const FLAT_ACCOUNT: PerpsReport = { ...FLAT_OFF, mode: "live", blocker: null, venueReadAt: NOW - 1_000, accountIndex: 22149 };

const HOME = /stay in your smart account/i;

describe("perpExposureOfReport: none only where the report says no perps", () => {
  const cases: Array<[string, PerpsReport | null, boolean, PerpExposure["kind"]]> = [
    ["no report, no perps marker on the grant (rule 3: that wall cannot deposit)", null, false, "none"],
    ["no report, the grant carries perps", null, true, "unread"],
    ["the known zero of an agent with no venue account", FLAT_OFF, true, "none"],
    ["the known zero, no marker", FLAT_OFF, false, "none"],
    ["a practice report for a grant with perps says nothing about the real venue", PAPER, true, "unread"],
    ["a practice report, no marker: no real venue account can exist", PAPER, false, "none"],
    ["Lighter could not be read", VENUE_UNREAD, true, "unread"],
    ["Lighter could not be read, even without the marker", VENUE_UNREAD, false, "unread"],
    ["a stale read", STALE, true, "unread"],
    ["open positions", LIVE, true, "known"],
    ["open positions shown without the marker are still exposure", LIVE, false, "known"],
    ["a venue account that reads flat is known, not none", FLAT_ACCOUNT, true, "known"],
  ];
  for (const [name, report, marked, kind] of cases) {
    it(name, () => {
      assert.equal(perpExposureOfReport(report, { grantMentionsPerps: marked, nowMs: NOW }).kind, kind);
    });
  }

  it("KNOWN CARRIES THE REPORT'S FIGURES, in-transit counted as still on Lighter, and says what it cannot see", () => {
    const e = perpExposureOfReport(LIVE, { grantMentionsPerps: true, nowMs: NOW });
    assert.equal(e.kind, "known");
    if (e.kind !== "known") return;
    assert.equal(e.openPositions, 1);
    assert.equal(e.collateralMicro, 17_517_210n + 2_000_000n);
    assert.equal(e.otherAccounts, null, "the report does not read sub-accounts: unknown, never none");
    const s = custodySentence(e);
    assert.match(s, /Still on Lighter: 1 open position/);
    assert.match(s, /19\.52 USDG of collateral/);
    assert.match(s, /stops resting at Lighter stay in place/);
    assert.match(s, /merrymen recover/);
  });
});

describe("THE CUSTODY SENTENCE NEVER SENDS THE MONEY HOME WHILE ANYTHING IS, OR MAY BE, ON LIGHTER", () => {
  const reports: Array<[string, PerpsReport | null]> = [
    ["no report", null],
    ["open positions", LIVE],
    ["unread venue", VENUE_UNREAD],
    ["stale", STALE],
    ["practice book", PAPER],
    ["flat venue account", FLAT_ACCOUNT],
    ["incident", { ...FLAT_ACCOUNT, incident: true }],
    ["money in transit only", { ...FLAT_ACCOUNT, accountIndex: null, inTransitMicro: "5000000" }],
  ];
  for (const [name, report] of reports) {
    it(`${name}, grant carrying perps`, () => {
      const e = perpExposureOfReport(report, { grantMentionsPerps: true, nowMs: NOW });
      assert.notEqual(e.kind, "none");
      assert.doesNotMatch(custodyText(e), HOME);
      assert.ok(killWarning(e, true), "a kill that stands perps down says so before it is confirmed");
      assert.ok(killWarning(e, false), "a kill that does NOT stand perps down says that before it is confirmed");
    });
  }

  it("unread says it could not look, and names the owner's way to", () => {
    const s = custodyText(perpExposureOfReport(VENUE_UNREAD, { grantMentionsPerps: true, nowMs: NOW }));
    assert.match(s, /could not be read/);
    assert.match(s, /merrymen recover/);
  });

  it("ONLY none says the funds are home, and a spot-only kill carries no perps warning", () => {
    const e = perpExposureOfReport(FLAT_OFF, { grantMentionsPerps: false, nowMs: NOW });
    assert.match(custodyText(e), HOME);
    assert.equal(killWarning(e, true), null);
    assert.equal(killWarning(e, false), null);
  });

  it("SELF-HOSTED, the warning names what the stand-down does: reduce-only closes at market, which can realize a loss, and collateral home", () => {
    const w = killWarning(perpExposureOfReport(LIVE, { grantMentionsPerps: true, nowMs: NOW }), true)!;
    assert.match(w, /attempts to close its open perpetual position on Lighter at market/);
    assert.match(w, /reduce-only/);
    assert.match(w, /can realize a loss/);
    assert.match(w, /requests withdrawal of free collateral to your smart account/);
    assert.match(w, /request can fail or leave a partial fill/);
    assert.match(killWarning({ kind: "unread" }, true)!, /could not be read/);
  });

  it("HOSTED, WHERE NOTHING STANDS PERPS DOWN YET, it never promises a close — it says they stay open on their stops", () => {
    const e = perpExposureOfReport(LIVE, { grantMentionsPerps: true, nowMs: NOW });
    for (const w of [killWarning(e, false)!, killWarning(e, null)!, killWarning({ kind: "unread" }, false)!]) {
      assert.doesNotMatch(w, /closed at market|is closed|are closed|withdrawn to your smart account/);
      assert.match(w, /stay(s)? open/);
      assert.match(w, /resting at Lighter/);
      assert.match(w, /28 days/);
    }
    assert.match(killWarning(e, false)!, /does NOT close its perpetuals: this server cannot stand them down yet/);
    assert.match(killWarning(e, null)!, /could not confirm that stopping the agent closes its perpetuals/);
  });

  it("the hosted custody sentence names the hosted owner's way to look, not only the CLI", () => {
    const s = custodyText(perpExposureOfReport(LIVE, { grantMentionsPerps: true, nowMs: NOW }), { hosted: true });
    assert.ok(s.includes(HOSTED_RECOVER_PATH));
    assert.match(s, /open Withdraw on the dashboard/);
    assert.match(killedCustodyText({ state: "unreadable" }, NOW, { hosted: true })!, /open Withdraw on the dashboard/);
  });
});

describe("perpsFeedOf: a separate array, and unknown is never flat", () => {
  it("not said → both null; unreadable → rows null and the account says so", () => {
    assert.deepEqual(perpsFeedOf({ state: "not-said" }, NOW), { perps: null, perpsAccount: null });
    assert.deepEqual(perpsFeedOf({ state: "unreadable" }, NOW), { perps: null, perpsAccount: { state: "unreadable" } });
  });

  it("rows carry the venue's strings exactly and money in whole USDG; the account sums what is at Lighter", () => {
    const { perps, perpsAccount } = perpsFeedOf({ state: "ok", report: LIVE }, NOW);
    assert.deepEqual(perps, [
      {
        market: "BTC-PERP",
        side: "long",
        paper: false,
        size: "0.00030",
        entry_price: "83218.6",
        mark_price: "83220.1",
        leverage: 2,
        margin_usdg: 12.48279,
        liq_price: "41931.3",
        liq_distance_pct: 49.6,
        unrealized_usdg: -0.45,
        stop_trigger: "79057.7",
        funding_usdg: -0.012,
      },
    ]);
    assert.ok(perpsAccount && perpsAccount.state === "ok");
    if (perpsAccount?.state !== "ok") return;
    assert.equal(perpsAccount.at_lighter_usdg, 17.51721 + 2 - 0.45);
    assert.equal(perpsAccount.venue_read, true);
    assert.equal(perpsAccount.stale, false);
    assert.equal(perpsAccount.active, true);
    assert.equal(perpsAccount.min_liq_distance_pct, 49.61);
  });

  it("A VENUE THAT COULD NOT BE READ: rows kept, figures null, nothing summed into a fake total", () => {
    const { perps, perpsAccount } = perpsFeedOf({ state: "ok", report: VENUE_UNREAD }, NOW);
    assert.equal(perps?.length, 1, "the ledger's last record is still shown, never 'no positions'");
    assert.equal(perps?.[0]?.mark_price, null);
    assert.equal(perps?.[0]?.liq_distance_pct, null);
    assert.ok(perpsAccount?.state === "ok");
    if (perpsAccount?.state !== "ok") return;
    assert.equal(perpsAccount.venue_read, false);
    assert.equal(perpsAccount.at_lighter_usdg, null);
    assert.equal(perpsAccount.collateral_usdg, null);
    assert.match(perpsAccount.blocker_text ?? "", /Lighter cannot be reached/);
  });

  it("ONE UNREAD P&L MAKES THE TOTAL UNREAD, not a partial sum", () => {
    const report = { ...LIVE, positions: [...LIVE.positions, { ...LIVE.positions[0]!, market: "ETH-PERP" as const, unrealizedMicro: null }] };
    const { perpsAccount } = perpsFeedOf({ state: "ok", report }, NOW);
    assert.ok(perpsAccount?.state === "ok" && perpsAccount.at_lighter_usdg === null);
  });

  it("the practice book is labelled on every row; the known zero is not a panel", () => {
    const paper = perpsFeedOf({ state: "ok", report: PAPER }, NOW);
    assert.ok(paper.perps?.every((r) => r.paper));
    assert.ok(paper.perpsAccount?.state === "ok" && paper.perpsAccount.paper);
    const off = perpsFeedOf({ state: "ok", report: FLAT_OFF }, NOW);
    assert.deepEqual(off.perps, []);
    assert.ok(off.perpsAccount?.state === "ok" && off.perpsAccount.active === false);
  });

  it("a stale read is said to be stale", () => {
    const { perpsAccount } = perpsFeedOf({ state: "ok", report: STALE }, NOW);
    assert.ok(perpsAccount?.state === "ok" && perpsAccount.stale);
  });
});

/**
 * PRACTICE HELD WHILE PRACTICE PERPS ARE OFF (worker perps/lane.ts
 * readPaperLocked): the rail reads "off", the report still carries the paper
 * position and the paper collateral, and the paper view has no account index.
 * Reading "not paper" as "real" drew it as real money at Lighter everywhere.
 */
const PAPER_OFF: PerpsReport = { ...PAPER, mode: "off", blocker: "perps-off", collateralMicro: "6000000", inTransitMicro: "0" };

describe("THE BOOK, NOT THE RAIL: practice is never shown as real money at Lighter", () => {
  it("perpsBookOf: mode first, then an account index, then the account's own book — else not said", () => {
    assert.equal(perpsBookOf(PAPER, null), "paper");
    assert.equal(perpsBookOf(LIVE, "paper"), "live", "a live rail is real whatever the heartbeat lags to");
    assert.equal(perpsBookOf({ ...LIVE, mode: "off" }, null), "live", "an account index is a real venue account (the MCP rule)");
    assert.equal(perpsBookOf(PAPER_OFF, "paper"), "paper");
    assert.equal(perpsBookOf({ ...PAPER_OFF, mode: "refuse", blocker: null }, "paper"), "paper");
    assert.equal(perpsBookOf(PAPER_OFF, "live"), "live");
    assert.equal(perpsBookOf(PAPER_OFF, "idle"), null);
    assert.equal(perpsBookOf(PAPER_OFF, null), null);
  });

  it("the desk labels it Paper, row and account, and never as real", () => {
    const { perps, perpsAccount } = perpsFeedOf({ state: "ok", report: PAPER_OFF, accountMode: "paper" }, NOW);
    assert.ok(perps?.every((r) => r.paper));
    assert.ok(perpsAccount?.state === "ok" && perpsAccount.paper && perpsAccount.book === "paper");
    const unknown = perpsFeedOf({ state: "ok", report: PAPER_OFF }, NOW);
    assert.ok(unknown.perpsAccount?.state === "ok" && unknown.perpsAccount.book === null && !unknown.perpsAccount.paper);
  });

  it("its custody is a practice report's: none without the marker, unread with it — never 'Still on Lighter'", () => {
    const e0 = perpExposureOfReport(PAPER_OFF, { grantMentionsPerps: false, nowMs: NOW, accountMode: "paper" });
    assert.equal(e0.kind, "none");
    const e1 = perpExposureOfReport(PAPER_OFF, { grantMentionsPerps: true, nowMs: NOW, accountMode: "paper" });
    assert.equal(e1.kind, "unread");
    for (const standsDown of [true, false]) assert.doesNotMatch(killWarning(e1, standsDown)!, /its open perpetual position on Lighter/);
    assert.doesNotMatch(custodyText(e1), /Still on Lighter: 1 open position|6\.00 USDG/);
    assert.equal(killedCustodyText({ state: "ok", report: PAPER_OFF, accountMode: "paper" }, NOW), custodySentence({ kind: "none" }));
  });

  it("A HELD BOOK THE REPORT CANNOT PLACE IS UNREAD, never defaulted to real — and never home", () => {
    for (const mode of [null, "idle"]) {
      const e = perpExposureOfReport(PAPER_OFF, { grantMentionsPerps: false, nowMs: NOW, accountMode: mode });
      assert.equal(e.kind, "unread");
      assert.doesNotMatch(custodyText(e), HOME);
    }
    // Nothing held and no account: the known zero, whatever the book.
    assert.equal(perpExposureOfReport(FLAT_OFF, { grantMentionsPerps: false, nowMs: NOW, accountMode: null }).kind, "none");
  });

  it("the browser's read carries the account's book and whether this server stands perps down", () => {
    const grant = { grantFeatures: ["perp-lighter-v1"] };
    const hosted = killPerpsFromStatus({ exists: true, grant, perps: PAPER_OFF, mode: "paper", perpsStanddownOnKill: false }, NOW);
    assert.deepEqual(hosted, { exposure: { kind: "unread" }, standsDown: false });
    assert.equal(killPerpsFromStatus({ exists: true, grant: {}, perps: PAPER_OFF, mode: "paper" }, NOW).exposure?.kind, "none");
    assert.equal(killPerpsFromStatus({ exists: true, grant, perps: LIVE, perpsStanddownOnKill: true }, NOW).standsDown, true);
    assert.equal(killPerpsFromStatus({ exists: true, grant, perps: LIVE }, NOW).standsDown, null, "not said is never a promise");
  });
});

describe("readKillAnswer — every kill control reads the server's answer before it changes anything", () => {
  const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  it("a deliberate refusal is refused, with the server's words", async () => {
    assert.deepEqual(await readKillAnswer(res(503, { error: "Couldn't ask the agent…", ownerFacing: true })), {
      kind: "refused",
      error: "Couldn't ask the agent…",
    });
  });
  it("done carries the server's custody sentence when it built one", async () => {
    assert.deepEqual(await readKillAnswer(res(200, { ok: true, custody: "Lighter reads empty." })), { kind: "done", custody: "Lighter reads empty." });
    assert.deepEqual(await readKillAnswer(res(200, { ok: true })), { kind: "done", custody: null });
  });
  it("any other failure is unconfirmed — never read as done, never as a refusal to keep", async () => {
    assert.deepEqual(await readKillAnswer(res(401, { error: "not signed in" })), { kind: "unconfirmed", status: 401, error: "not signed in" });
    assert.deepEqual(await readKillAnswer({ ok: false, status: 500, json: async () => { throw new Error("html"); } }), {
      kind: "unconfirmed",
      status: 500,
      error: null,
    });
  });
});

describe("killedCustodyText — a killed agent's status line, with no grant left to consult", () => {
  it("a report never written makes NO claim; unreadable is unread; a readable one says what it says", () => {
    assert.equal(killedCustodyText({ state: "not-said" }, NOW), null);
    assert.match(killedCustodyText({ state: "unreadable" }, NOW)!, /could not be read/);
    assert.match(killedCustodyText({ state: "ok", report: FLAT_OFF }, NOW)!, HOME);
    const open = killedCustodyText({ state: "ok", report: LIVE }, NOW)!;
    assert.match(open, /Still on Lighter/);
    assert.doesNotMatch(open, HOME);
    assert.doesNotMatch(killedCustodyText({ state: "ok", report: VENUE_UNREAD }, NOW)!, HOME);
  });
});

describe("small pieces", () => {
  it("liquidation distance is from the mark, on the side held, and absent without both prices", () => {
    assert.equal(liqDistancePct({ side: "long", markPrice: "100", liqPrice: "80" }), 20);
    assert.equal(liqDistancePct({ side: "short", markPrice: "100", liqPrice: "125" }), 25);
    assert.equal(liqDistancePct({ side: "long", markPrice: null, liqPrice: "80" }), null);
    assert.equal(liqDistancePct({ side: "long", markPrice: "100", liqPrice: null }), null);
  });

  it("a grant mentions perps by the marker OR a perp block — inclusive, because it only makes a surface more careful", () => {
    assert.equal(grantMentionsPerps({ grantFeatures: ["perp-lighter-v1"] }), true);
    assert.equal(grantMentionsPerps({ perp: { route: "perp-lighter-v1" } }), true);
    assert.equal(grantMentionsPerps({ grantFeatures: ["tradeable-v2"] }), false);
    assert.equal(grantMentionsPerps(null), false);
  });

  it("exposureFromStatus: no agent is null, an unreadable status is unread, and the wire is re-parsed strictly", () => {
    assert.equal(exposureFromStatus({ exists: false }, NOW), null);
    assert.deepEqual(exposureFromStatus("nonsense", NOW), { kind: "unread" });
    assert.deepEqual(exposureFromStatus({}, NOW), { kind: "unread" });
    const grant = { grantFeatures: ["perp-lighter-v1"] };
    assert.equal(exposureFromStatus({ exists: true, grant, perps: LIVE }, NOW)?.kind, "known");
    assert.equal(exposureFromStatus({ exists: true, grant, perps: { ...LIVE, v: 9 } }, NOW)?.kind, "unread");
    assert.equal(exposureFromStatus({ exists: true, grant: {}, perps: null }, NOW)?.kind, "none");
  });
});

it("preserves immutable position profile metadata while legacy positions remain absent", () => {
  const report: PerpsReport = { ...LIVE, positions: [{ ...LIVE.positions[0], entryStyle: "scalp-breakout", styleOpenedAtSec: 100, holdDeadlineSec: 1900 }] };
  const row = perpsFeedOf({ state: "ok", report }, NOW).perps![0];
  assert.equal(row.entry_style, "scalp-breakout");
  assert.equal(row.style_opened_at_sec, 100);
  assert.equal(row.hold_deadline_sec, 1900);
  assert.equal("entry_style" in perpsFeedOf({ state: "ok", report: LIVE }, NOW).perps![0], false);
});
