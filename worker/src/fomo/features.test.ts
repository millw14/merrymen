import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDossier, type BuildDossierInput } from "./dossier";
import {
  changeSummary,
  convictionChanges,
  earlyDiscovery,
  narrativeDevelopment,
  participationBreadth,
  positionDeterioration,
  thesisChanges,
} from "./features";
import { robinhoodChain, tokenIdentity } from "./identity";
import type { Thesis, TraderEvent } from "./types";

const NOW = 1_790_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TOKEN = tokenIdentity(robinhoodChain(), "0x" + "ab".repeat(20))!;
const NEW_TOKEN = tokenIdentity(robinhoodChain(), "0x" + "ef".repeat(20))!;

function author(userId: string) {
  return { userId, handle: userId, displayName: null, verified: null };
}

function event(eventKey: string, kind: TraderEvent["kind"], userId: string, over: Partial<TraderEvent> = {}): TraderEvent {
  return {
    eventKey,
    identityBasis: "provider-event-id",
    identityAmbiguous: false,
    source: "stream",
    kind,
    trader: author(userId),
    token: TOKEN,
    tokenLabel: { symbol: "PEPE", name: "Pepe" },
    tradeId: null,
    swapId: null,
    transferId: null,
    txHash: null,
    fillUsd: null,
    fillUsdBasis: null,
    positionValueUsd: null,
    positionRealizedPnlUsdCumulative: null,
    sourceEventAt: NOW - HOUR,
    execAt: null,
    observedAt: NOW - HOUR + 5_000,
    verification: "provider-reported",
    text: null,
    replay: false,
    ...over,
  };
}

function thesis(id: string, text: string, over: Partial<Thesis> = {}): Thesis {
  return {
    id,
    tradeId: null,
    author: author(`u-${id}`),
    token: TOKEN,
    tokenLabel: { symbol: "PEPE", name: "Pepe" },
    text,
    likes: null,
    replies: null,
    authorEquityUsd: null,
    isDev: null,
    postedAt: NOW - HOUR,
    familyKey: `fam-${id}`,
    ...over,
  };
}

function input(over: Partial<BuildDossierInput> = {}): BuildDossierInput {
  return {
    token: TOKEN,
    label: { symbol: "PEPE", name: "Pepe" },
    theses: [],
    thesisCoverage: { pagesRequested: 1, pagesReturned: 1, providerTotal: null, capped: false, stale: false, ageSeconds: null, chainFilterHonoured: true },
    events: [],
    cohortUserIds: new Set(),
    stats: null,
    marketContext: ["market cap 2M"],
    routeContext: ["depth ok"],
    ownFamilies: new Set(),
    selfNames: [],
    previous: null,
    now: NOW,
    window: "24h",
    ...over,
  };
}

describe("earlyDiscovery", () => {
  it("finds coins newly entering cohort purchases, from buys only", () => {
    const events = [
      event("n1", "buy", "alice", { token: NEW_TOKEN, sourceEventAt: NOW - 2 * HOUR }),
      event("n2", "buy", "bob", { token: NEW_TOKEN, sourceEventAt: NOW - HOUR }),
      event("n3", "buy", "outsider", { token: NEW_TOKEN }),
      event("old", "buy", "alice"),
      event("air", "airdrop", "alice", { token: tokenIdentity(robinhoodChain(), "0x" + "11".repeat(20)) }),
      event("xin", "transfer-in", "bob", { token: tokenIdentity(robinhoodChain(), "0x" + "22".repeat(20)) }),
    ];
    const found = earlyDiscovery(events, new Map([[TOKEN.key, NOW - 10 * DAY]]), new Set(["alice", "bob"]));
    assert.equal(found.length, 1);
    const d = found[0]!;
    assert.equal(d.tokenKey, NEW_TOKEN.key);
    assert.equal(d.cohortBuyers, 2);
    assert.equal(d.cohortBuyEvents, 2);
    assert.equal(d.firstCohortBuyAt, NOW - 2 * HOUR);
    assert.match(d.note, /reason to investigate, not an instruction to buy/);
  });
});

describe("participationBreadth", () => {
  it("separates one trader repeatedly adding from distinct buyers", () => {
    const single = [1, 2, 3, 4].map((i) => event(`s${i}`, "buy", "whale", { sourceEventAt: NOW - i * HOUR }));
    const broad = ["a", "b", "c", "d"].map((u, i) => event(`b${u}`, "buy", u, { token: NEW_TOKEN, sourceEventAt: NOW - (i + 1) * 10 * 60_000 }));
    const out = participationBreadth([...single, ...broad], DAY, NOW);
    const s = out.find((x) => x.tokenKey === TOKEN.key)!;
    assert.equal(s.reading, "single-trader");
    assert.equal(s.distinctBuyers, 1);
    assert.equal(s.repeatAdds, 3);
    const b = out.find((x) => x.tokenKey === NEW_TOKEN.key)!;
    assert.equal(b.reading, "broad");
    assert.equal(b.distinctBuyers, 4);
  });

  it("describes same-moment buyers as uncertain, never as common ownership", () => {
    const at = NOW - HOUR;
    const events = ["a", "b", "c"].map((u) => event(`c${u}`, "buy", u, { sourceEventAt: at }));
    const out = participationBreadth(events, DAY, NOW)[0]!;
    assert.equal(out.sameMomentBuyers, 3);
    const note = out.notes.find((n) => /same few seconds/.test(n))!;
    assert.match(note, /unknown/);
    assert.doesNotMatch(note, /same owner|controlled by|sybil|one person controls/i);
  });
});

describe("convictionChanges", () => {
  it("accumulation comes only from buy events, never from a rising position value", () => {
    const events = [
      event("b1", "buy", "alice", { positionValueUsd: 10_000, sourceEventAt: NOW - 5 * HOUR }),
      event("o1", "other", "alice", { positionValueUsd: 30_000, sourceEventAt: NOW - 2 * HOUR }),
      event("t1", "transfer-in", "alice", { positionValueUsd: 50_000, sourceEventAt: NOW - HOUR }),
    ];
    assert.deepEqual(convictionChanges(events), []);
    const added = convictionChanges([...events, event("b2", "buy", "alice", { sourceEventAt: NOW - 30 * 60_000 })]);
    assert.equal(added.length, 1);
    assert.equal(added[0]!.change, "accumulation");
    assert.equal(added[0]!.buyEvents, 2);
    assert.deepEqual(added[0]!.evidence.map((e) => e.id), ["fomo:event/b1", "fomo:event/b2"]);
  });

  it("classifies sells as reduction, exit or unclassified; transfers out are not sells", () => {
    const out = convictionChanges([
      event("r", "sell", "red", { positionValueUsd: 4_000 }),
      event("x", "sell", "exit", { positionValueUsd: 0 }),
      event("u", "sell", "unk"),
      event("tout", "transfer-out", "mover"),
    ]);
    const by = new Map(out.map((c) => [c.userId, c.change]));
    assert.equal(by.get("red"), "reduction");
    assert.equal(by.get("exit"), "exit");
    assert.equal(by.get("unk"), "sell-unclassified");
    assert.equal(by.has("mover"), false);
  });
});

describe("thesisChanges", () => {
  it("reports claims kept, strengthened, weakened, new and gone", () => {
    const a = buildDossier(input({ theses: [thesis("e1", "early"), thesis("r1", "rug"), thesis("r2", "rug again here"), thesis("n1", "listing soon")] })).dossier;
    const b = buildDossier(
      input({ theses: [thesis("e1", "early"), thesis("e2", "so early"), thesis("r1", "rug"), thesis("u1", "big unlock")], previous: a }),
    ).dossier;
    const c = thesisChanges(a, b);
    assert.deepEqual(c.strengthened.map((x) => x.claimKey), ["thesis:momentum:supporting"]);
    assert.deepEqual(c.weakened.map((x) => x.claimKey), ["thesis:team:opposing"]);
    assert.match(c.weakened[0]!.reason, /fell from 2 to 1/);
    assert.deepEqual(c.added, ["thesis:supply:opposing"]);
    assert.deepEqual(c.dropped, ["thesis:narrative:supporting"]);
    assert.deepEqual(thesisChanges(null, a).added.length, a.claims.length);
  });
});

describe("narrativeDevelopment", () => {
  it("finds emerging topics in families and flags that popularity is not merit", () => {
    const theses = [
      thesis("a", "big listing coming", { postedAt: NOW - HOUR }),
      thesis("b", "listing on a major venue", { postedAt: NOW - 2 * HOUR }),
      thesis("b-copy", "listing on a major venue", { postedAt: NOW - 2 * HOUR, familyKey: "fam-b" }),
      thesis("old", "chart momentum", { postedAt: NOW - 30 * HOUR }),
      thesis("undated", "listing", { postedAt: null }),
    ];
    const out = narrativeDevelopment(theses, DAY, NOW);
    const n = out.topics.find((t) => t.topic === "narrative")!;
    assert.equal(n.recentFamilies, 2);
    assert.equal(n.emerging, true);
    assert.equal(n.popularityIsNotMerit, true);
    const m = out.topics.find((t) => t.topic === "momentum")!;
    assert.equal(m.recentFamilies, 0);
    assert.equal(m.priorFamilies, 1);
    assert.equal(m.emerging, false);
    assert.equal(out.undated, 1);
    assert.match(out.note, /popularity, not evidence/);
  });
});

describe("positionDeterioration", () => {
  it("missing data is a reason to review, not reassurance", () => {
    const r = positionDeterioration(TOKEN.key, [], null, NOW);
    assert.equal(r.level, "review");
    assert.ok(r.signals.some((s) => s.code === "data-missing"));
    const empty = buildDossier(input()).dossier;
    assert.equal(positionDeterioration(TOKEN.key, [], empty, NOW).level, "review");
    const old = buildDossier(input({ events: [event("b", "buy", "a")], now: NOW - 10 * HOUR })).dossier;
    assert.ok(positionDeterioration(TOKEN.key, [], old, NOW).signals.some((s) => s.code === "dossier-stale"));
  });

  it("rising sellers and a flow reversal among the cohort call for review", () => {
    const events = [
      event("b1", "buy", "a", { sourceEventAt: NOW - 20 * HOUR }),
      event("b2", "buy", "b", { sourceEventAt: NOW - 18 * HOUR }),
      event("s1", "sell", "a", { sourceEventAt: NOW - 3 * HOUR }),
      event("s2", "sell", "b", { sourceEventAt: NOW - 2 * HOUR }),
      event("s3", "sell", "c", { sourceEventAt: NOW - HOUR }),
    ];
    const dossier = buildDossier(input({ events, cohortUserIds: new Set(["a", "b", "c"]) })).dossier;
    const r = positionDeterioration(TOKEN.key, events, dossier, NOW);
    assert.equal(r.level, "review");
    const codes = r.signals.map((s) => s.code);
    assert.ok(codes.includes("rising-sellers"));
    assert.ok(codes.includes("flow-reversal"));
    assert.ok(codes.includes("cohort-sellers-lead"));
    assert.ok(r.evidence.some((e) => e.id === "fomo:event/s3"));
  });

  it("a calm, fresh, buyer-led picture is none", () => {
    const events = [event("b1", "buy", "a"), event("b2", "buy", "b")];
    const dossier = buildDossier(input({ events, theses: [thesis("e", "early")] })).dossier;
    const r = positionDeterioration(TOKEN.key, events, dossier, NOW);
    assert.equal(r.level, "none");
    assert.deepEqual(r.signals, []);
  });
});

describe("changeSummary", () => {
  const base = input({ theses: [thesis("e", "early")], events: [event("b1", "buy", "a")] });
  const first = buildDossier(base).dossier;

  it("says nothing about change without a baseline or after a failed check", () => {
    const none = changeSummary(null, { dossier: first, checkedAt: NOW, scope: "24h", succeeded: true });
    assert.deepEqual(none, { comparable: false, noChange: false, changes: [], reason: "no-baseline" });
    const failed = changeSummary({ dossier: first, checkedAt: NOW - HOUR, scope: "24h" }, { dossier: first, checkedAt: NOW, scope: "24h", succeeded: false });
    assert.equal(failed.noChange, false);
    assert.equal(failed.reason, "check-failed");
    const scope = changeSummary({ dossier: first, checkedAt: NOW - HOUR, scope: "7d" }, { dossier: first, checkedAt: NOW, scope: "24h", succeeded: true });
    assert.equal(scope.reason, "different-scope");
    assert.equal(scope.noChange, false);
    const order = changeSummary({ dossier: first, checkedAt: NOW, scope: "24h" }, { dossier: first, checkedAt: NOW, scope: "24h", succeeded: true });
    assert.equal(order.reason, "baseline-not-earlier");
  });

  it("reports no change only against a comparable baseline after a successful check", () => {
    const same = buildDossier({ ...base, previous: first, now: NOW + 60_000 }).dossier;
    const r = changeSummary({ dossier: first, checkedAt: NOW, scope: "24h" }, { dossier: same, checkedAt: NOW + 60_000, scope: "24h", succeeded: true });
    assert.deepEqual(r, { comparable: true, noChange: true, changes: [], reason: "compared" });
  });

  it("lists what moved", () => {
    const next = buildDossier({
      ...base,
      theses: [...base.theses, thesis("r", "rug pull incoming")],
      events: [...base.events, event("b2", "buy", "b"), event("s1", "sell", "c")],
      previous: first,
      now: NOW + 60_000,
    }).dossier;
    const r = changeSummary({ dossier: first, checkedAt: NOW, scope: "24h" }, { dossier: next, checkedAt: NOW + 60_000, scope: "24h", succeeded: true });
    assert.equal(r.comparable, true);
    assert.equal(r.noChange, false);
    assert.ok(r.changes.some((c) => /^New: .*objections on team/.test(c)));
    assert.ok(r.changes.includes("Distinct buyers: 1 → 2."));
    assert.ok(r.changes.includes("Distinct sellers: 0 → 1."));
    assert.ok(r.changes.some((c) => /Strongest objection is now/.test(c)));
  });
});
