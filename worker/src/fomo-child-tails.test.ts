/**
 * FomoChild's read-only tail accessors: tails(), holds() and
 * followReadiness(). They report; they decide nothing. fomo-child.test.ts
 * pins the follow path itself and is untouched by this change.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EarlyCandidateBook } from "./early-candidates";
import { FomoChild, memoryExplorationStore, type FomoChildSettings, type FomoLiveFacts } from "./fomo-child";
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
  totals: null,
};

function rig(o: { settings?: Partial<FomoChildSettings>; live?: Partial<FomoLiveFacts>; fileAccess?: FomoAccess; tails?: ChildTail[] | undefined; off?: boolean } = {}) {
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
  const file: ChildFomoFile = {
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
    readFile: (): ChildFomoRead => ({ file, reason: "ok", droppedSignals: 0 }),
    now: () => T0,
  });
  const tick = (held: { token: string }[] = []) =>
    child.tick({
      context: "agent:paper:1:brain",
      equity6: 1_000_000_000n,
      held: held.map((x) => ({ token: x.token, symbol: "PONS", decimals: 18, valueUsdg6: 1_000_000n, price8: 100_000_000n, priceStale: false })),
      basis: async () => null,
      entrySec: async () => null,
    });
  return { child, tick };
}

describe("FomoChild tail accessors", () => {
  it("tails(): the file's block, copied, and nothing without data access or with Fomo off", () => {
    const r = rig({ tails: [TAIL] });
    assert.deepEqual(r.child.tails(), [], "nothing before the first read");
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
