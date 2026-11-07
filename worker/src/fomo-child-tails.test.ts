/**
 * FomoChild's read-only tail accessors: tails(), holds() and
 * followReadiness(). They report; they decide nothing. fomo-child.test.ts
 * pins the follow path itself and is untouched by this change.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EarlyCandidateBook } from "./early-candidates";
import { FOMO_CHILD, FomoChild, memoryExplorationStore, type FomoChildSettings, type FomoLiveFacts } from "./fomo-child";
import type { ChildFomoRead } from "./fomo/child-file";
import type { ChildFomoFile, ChildTail, FomoAccess } from "./fomo/contract";
import { robinhoodChain, tokenIdentity } from "./fomo/identity";

const T0 = 1_800_000_000_000;
const TENANT = "0x00000000000000000000000000000000000000a1";
const COIN = `0x${"12".repeat(20)}`;

const TAIL: ChildTail = {
  userId: "7b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  handle: "unipcs",
  createdAt: T0 - 3_600_000,
  expiresAt: T0 + 3_600_000,
  ended: false,
  consider: true,
  events: [
    {
      eventKey: "ev-1",
      kind: "buy",
      token: tokenIdentity(robinhoodChain(), COIN),
      label: { symbol: "PONS", name: null },
      at: T0 - 60_000,
      observedAt: T0 - 55_000,
      positionValueUsd: null,
      text: null,
    },
  ],
  totals: null, markTally: null,
};

function rig(o: { settings?: Partial<FomoChildSettings>; live?: Partial<FomoLiveFacts>; fileAccess?: FomoAccess; tails?: ChildTail[] | undefined; off?: boolean; noFile?: boolean } = {}) {
  const clock = { now: T0 };
  let reads = 0;
  const settings: FomoChildSettings = {
    dataAccess: true,
    monitoring: false,
    follow: true,
    strategy: "trencher",
    trencherFast: true,
    scoutEnabled: true,
    scoutBudgetUsdg: 20,
    scoutPerTokenUsdg: 10,
    ...o.settings,
  };
  let file: ChildFomoFile = {
    version: 1,
    writtenAt: T0 - 1_000,
    tenant: TENANT,
    access: o.fileAccess ?? { dataAccess: true, monitoring: false, follow: true },
    health: { state: "research-only", detail: "", cohortSize: null, cohortVersion: null, cohortTarget: 150, lastEventAt: null },
    signals: [],
    ...(o.tails ? { tails: o.tails } : {}),
  };
  const live = (): FomoLiveFacts => ({
    agentId: "0xagent",
    settings,
    rail: "paper",
    paused: false,
    liveFollowAllowed: false,
    sponsorship: { sponsoredFlow: false, available: null },
    scoutHeldCost6: 0n,
    perTrade6: 25_000_000n,
    dailyHeadroom6: 100_000_000n,
    vault: true,
    knownAsset: () => true,
    routeVerified: () => true,
    depthUsd: () => 60_000,
    price: () => null,
    pricesAt: null,
    ...o.live,
  });
  const child = new FomoChild({
    broker: () => null,
    off: () => o.off === true,
    ownTenant: () => TENANT,
    home: () => "/nonexistent-home",
    live,
    earlyBook: () => new EarlyCandidateBook(() => T0),
    counters: { takeFollowEntry: () => false, refundFollowEntry: () => {} },
    ledgerStore: memoryExplorationStore(),
    readFile: (): ChildFomoRead => {
      reads++;
      return o.noFile ? { file: null, reason: "absent", droppedSignals: 0 } : { file, reason: "ok", droppedSignals: 0 };
    },
    now: () => clock.now,
  });
  const tick = (held: { token: string }[] = []) =>
    child.tick({
      context: "agent:paper:1:brain",
      equity6: 1_000_000_000n,
      held: held.map((x) => ({ token: x.token, symbol: "PONS", decimals: 18, valueUsdg6: 1_000_000n, price8: 100_000_000n, priceStale: false })),
      basis: async () => null,
      entrySec: async () => null,
    });
  /** The orchestrator rewrites fomo.json (a new block). */
  const rewrite = (tails: ChildTail[]) => {
    file = { ...file, writtenAt: clock.now, tails };
  };
  return { child, tick, clock, rewrite, reads: () => reads, settings };
}

describe("FomoChild tail accessors", () => {
  it("tails(): the file's block, copied, and nothing without data access or with Fomo off", () => {
    const r = rig({ tails: [TAIL] });
    r.tick();
    const got = r.child.tails();
    assert.deepEqual(got, [TAIL]);
    got[0]!.events.length = 0;
    assert.equal(r.child.tails()[0]!.events.length, 1, "a copy: the caller cannot change the child's view");
    const noAccess = rig({ tails: [TAIL], settings: { dataAccess: false } });
    noAccess.tick();
    assert.deepEqual(noAccess.child.tails(), [], "the owner's setting narrows the file");
    const off = rig({ tails: [TAIL], off: true });
    off.tick();
    assert.deepEqual(off.child.tails(), []);
    const none = rig();
    none.tick();
    assert.deepEqual(none.child.tails(), [], "a file without the block has no tails");
  });

  it("tails() never waits for the trading tick: a never-ticked child (no grant, a killed agent) reads the file itself (review 2026-10-07)", () => {
    // An owner who only researches (data access on, no signed grant) never
    // runs the trading tick; her tails used to be [] forever.
    const r = rig({ tails: [TAIL], settings: { follow: false, monitoring: false }, fileAccess: { dataAccess: true, monitoring: false, follow: false } });
    assert.deepEqual(r.child.tails(), [TAIL], "no tick needed");
    // The tail ends: the orchestrator's next file says so, and it is seen
    // with no tick, once the read interval has passed (not on every ask).
    r.rewrite([{ ...TAIL, ended: true, totals: { buys: 1, sells: 0, theses: 0, coins: 1, capped: false } }]);
    assert.equal(r.child.tails()[0]!.ended, false, "read at most every fileReadEveryMs");
    const n = r.reads();
    r.clock.now += FOMO_CHILD.fileReadEveryMs;
    assert.equal(r.child.tails()[0]!.ended, true, "the end is seen, so its summary is sent");
    assert.equal(r.reads(), n + 1);
    // Ended and gone: nothing more, so the notifier stops reading its log.
    r.rewrite([]);
    r.clock.now += FOMO_CHILD.fileReadEveryMs;
    assert.deepEqual(r.child.tails(), []);
    // The tick's own view is untouched by these reads: the follow path sees what it saw.
    assert.equal(r.child.health().read, "not-read");
  });

  it("tails() with no tick still honours the owner's data access, read now, and the file's", () => {
    const r = rig({ tails: [TAIL] });
    assert.equal(r.child.tails().length, 1);
    r.settings.dataAccess = false;
    assert.deepEqual(r.child.tails(), [], "her setting, read at the moment of asking");
    r.settings.dataAccess = true;
    assert.equal(r.child.tails().length, 1);
    assert.deepEqual(rig({ tails: [TAIL], fileAccess: { dataAccess: false, monitoring: false, follow: false } }).child.tails(), [], "the file narrows it");
    assert.deepEqual(rig({ tails: [TAIL], noFile: true }).child.tails(), [], "no file, no tails");
    assert.deepEqual(rig({ tails: [TAIL], off: true }).child.tails(), [], "Fomo off here");
    assert.deepEqual(rig({ tails: [TAIL], live: { settings: undefined as never } }).child.tails(), [], "a live read that throws is no tails");
  });

  it("tailsResearched(): my own read comes only with data access and monitoring or follow, from her settings now and the file (review 2026-10-07)", () => {
    const on = rig({ tails: [TAIL], settings: { monitoring: true, follow: false }, fileAccess: { dataAccess: true, monitoring: true, follow: false } });
    assert.equal(on.child.tailsResearched(), true, "no tick needed");
    on.settings.monitoring = false;
    assert.equal(on.child.tailsResearched(), false, "her setting, read now");
    assert.equal(rig({ tails: [TAIL], settings: { monitoring: false, follow: false } }).child.tailsResearched(), false, "the defaults: no research");
    assert.equal(rig({ tails: [TAIL], settings: { follow: true }, fileAccess: { dataAccess: true, monitoring: false, follow: false } }).child.tailsResearched(), false, "the file narrows it");
    assert.equal(rig({ tails: [TAIL], off: true }).child.tailsResearched(), false);
    assert.equal(rig({ tails: [TAIL], settings: { dataAccess: false } }).child.tailsResearched(), false);
  });

  it("holds(): a held Robinhood coin by its token key, as of the last tick", () => {
    const r = rig();
    r.tick([{ token: COIN.toUpperCase().replace("0X", "0x") }]);
    assert.equal(r.child.holds(tokenIdentity(robinhoodChain(), COIN)!.key), true);
    assert.equal(r.child.holds(tokenIdentity(robinhoodChain(), `0x${"34".repeat(20)}`)!.key), false);
  });

  it("followReadiness(): paper and able, or the closed list of what blocks it, read from the follow path's own conditions", () => {
    const able = rig();
    able.tick();
    assert.deepEqual(able.child.followReadiness(), { mode: "paper", blockers: [] });
    const cases: [Parameters<typeof rig>[0], { mode: string; blockers: string[] }][] = [
      [{ settings: { follow: false } }, { mode: "off", blockers: ["follow-off"] }],
      [{ fileAccess: { dataAccess: true, monitoring: false, follow: false } }, { mode: "off", blockers: ["follow-off"] }],
      [{ settings: { strategy: "steady-basket" } }, { mode: "paper", blockers: ["not-fast-trencher"] }],
      [{ settings: { trencherFast: false } }, { mode: "paper", blockers: ["not-fast-trencher"] }],
      [{ settings: { scoutEnabled: false } }, { mode: "paper", blockers: ["scout-off"] }],
      [{ settings: { scoutBudgetUsdg: 0 } }, { mode: "paper", blockers: ["scout-off"] }],
      [{ live: { paused: true } }, { mode: "paper", blockers: ["paused"] }],
      [{ live: { rail: "refuse" } }, { mode: "off", blockers: ["rail-refused"] }],
      [{ live: { rail: "live", liveFollowAllowed: false } }, { mode: "live", blockers: ["live-not-allowed"] }],
      [{ live: { rail: "live", liveFollowAllowed: true } }, { mode: "live", blockers: [] }],
      // Every follow entry is a vault-custody entry (verifyAskAllowed, grantCoversToken): no vault, no entry.
      [{ live: { vault: false } }, { mode: "paper", blockers: ["no-vault"] }],
      [{ live: { vault: false, paused: true } }, { mode: "paper", blockers: ["paused", "no-vault"] }],
      [{ off: true }, { mode: "off", blockers: ["follow-off"] }],
    ];
    for (const [o, want] of cases) {
      const r = rig(o);
      r.tick();
      assert.deepEqual(r.child.followReadiness(), want, JSON.stringify(o));
    }
  });

  it("asking changes nothing: no nomination, no report, no durable write", () => {
    const r = rig({ tails: [TAIL] });
    r.tick();
    const before = JSON.stringify(r.child.health());
    for (let i = 0; i < 3; i++) {
      r.child.followReadiness();
      r.child.tails();
      r.child.holds("x");
    }
    assert.equal(JSON.stringify(r.child.health()), before);
    assert.equal(r.child.health().followNominations, 0);
  });
});
