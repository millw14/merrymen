/**
 * WHAT THE TERMINAL IS ALLOWED TO SAY HAPPENED.
 *
 * The redesign moved every screen in the product into `web/src/terminal` and
 * left the components that carried the old disclosures behind, unmounted. The
 * invariants those components protected did not move with them, so this file
 * re-pins the four that were being violated on live surfaces:
 *
 *   a decision nothing came of is not a trade
 *   a trade the chain has not confirmed is not a fill
 *   an unreadable ledger is not a quiet one
 *   a growth curve is not raw equity, and not one drawn over inferred deposits
 *
 * Each is written the way this repo writes them: the smallest possible unit
 * check where the logic is pure, and a source read where the property lives in
 * a render. A source read is not a fashion here — it is the only way to test a
 * claim that is made in words on a screen.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { beatsOf, verbOf } from "./beat";
import { lastLine, ledgerSeconds, readStateOf, seedLive, tradeOutcome, type LiveAgent, type Thesis } from "./live";
import { stampOf, whyLine } from "./why";

const at = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
/** Source with comments removed — these files describe at length what they will not do. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const t = (over: Partial<Thesis> = {}): Thesis =>
  ({
    name: "Little John",
    slug: "abc",
    handle: "@lj",
    action: "buy",
    symbol: "TSLA",
    sizeUsdg: 5,
    reason: null,
    paper: false,
    head: "would buy TSLA 5.00 USDG",
    ...over,
  }) as Thesis;

const agent = (over: Partial<LiveAgent> = {}): LiveAgent =>
  ({
    slug: "abc",
    name: "Little John",
    handle: "@lj",
    owner: null,
    pnlBps: null,
    curve: [],
    landed: 0,
    last: null,
    glance: { id: "custom", label: "Strategy" },
    thesis: "",
    ...over,
  }) as LiveAgent;

describe("a decision nothing came of is not a trade", () => {
  it("REGRESSION: the rail says 'would buy', not 'bought'", () => {
    // The published feed rendered "@robin bought TSLA" for a Brain decision
    // that never reached an executor. A shadow row carries a real action and a
    // real size — thesis-policy.ts calls it "indistinguishable, to every gate
    // below, from a real buy" — so a rail that reads only `action` claims a
    // trade happened.
    const [real] = beatsOf([t({ at: 1_788_000_000, shadow: false })], [agent()]);
    const [shadow] = beatsOf([t({ at: 1_788_000_000, shadow: true })], [agent()]);
    assert.ok(real && shadow);
    assert.equal(verbOf(real), "bought");
    assert.equal(verbOf(shadow), "would buy");
  });

  it("the outcome arm alone is enough, for a row written before the flag existed", () => {
    const [beat] = beatsOf([t({ at: 1, shadow: undefined, outcome: "shadow" })], [agent()]);
    assert.equal(verbOf(beat!), "would buy");
  });

  it("`lastLine` renders the publisher's own head, which carries the conditional", () => {
    assert.equal(lastLine(t()), "would buy TSLA 5.00 USDG");
    // And when there is no head at all, the reconstruction keeps the conditional.
    assert.equal(lastLine(t({ head: "", shadow: true })), "Would buy TSLA");
    assert.equal(lastLine(t({ head: "", shadow: false })), "Bought TSLA");
  });

  it("the stamp names it, and does so before every other arm", () => {
    assert.equal(stampOf(t({ shadow: true })), "shadow");
    // Ordering is the point: a shadow row that also looks paper or refused
    // must still read as shadow, or it renders as something that happened.
    assert.equal(stampOf(t({ shadow: true, paper: true })), "shadow");
    assert.equal(stampOf(t({ shadow: true, outcome: "refused", outcomeText: "the wall" })), "shadow");
  });

  it("the fallback sentence keeps the conditional too", () => {
    assert.equal(whyLine(t({ reason: null, shadow: true })), "Would buy TSLA");
    assert.equal(whyLine(t({ reason: null, shadow: true, action: "sell" })), "Would sell TSLA");
  });

  it("INVARIANT: no terminal module rebuilds a past-tense sentence from `action` alone", () => {
    for (const f of ["live.ts", "beat.ts", "why.ts", "wire.tsx"]) {
      const src = code(at(`./${f}`));
      // The shape that was wrong: a ternary on `action` producing a past-tense
      // verb with no shadow check anywhere near it.
      const hits = [...src.matchAll(/action === "buy" \?[^;]*?"Bought"/g)];
      for (const hit of hits) {
        const around = src.slice(Math.max(0, hit.index! - 400), hit.index! + 400);
        assert.match(around, /shadow/, `${f} builds a past-tense verb without consulting shadow`);
      }
    }
  });
});

describe("a trade the chain has not confirmed is not a fill", () => {
  it("REGRESSION: 'submitted' is pending, not landed", () => {
    // It was written as a negation — anything not 'rejected' and not 'reverted'
    // was published as "landed". `trades.status` is genuinely written
    // 'submitted' while an operation is in flight (ledger-mirror.ts keys its
    // resolution on `AND status = 'submitted'`) and /api/feed selects the
    // column with no WHERE clause, so unresolved rows reached the browser.
    assert.equal(tradeOutcome("submitted"), "pending");
    assert.equal(tradeOutcome("armed"), "pending");
    assert.equal(tradeOutcome("something-added-next-year"), "pending");
  });

  it("and the states that ARE resolved keep their meaning", () => {
    assert.equal(tradeOutcome("landed"), "landed");
    assert.equal(tradeOutcome("paper"), "landed");
    assert.equal(tradeOutcome("rejected"), "refused");
    assert.equal(tradeOutcome("reverted"), "reverted");
  });

  it("INVARIANT: the mapper is an allow-list, not a negation", () => {
    const src = code(at("./live.ts"));
    const i = src.indexOf("export function tradeOutcome");
    assert.ok(i > 0);
    const body = src.slice(i, i + 400);
    assert.ok(!/!==/.test(body), "a negation lets an unknown status through as a fill");
    assert.match(body, /return "pending"/, "anything unrecognised is unresolved");
  });
});

describe("a ledger timestamp is UTC, and is read as UTC", () => {
  it("REGRESSION: a space-separated stamp is not local time", () => {
    // lib/ledger.ts writes `toISOString().slice(0,19).replace("T"," ")` — a UTC
    // instant with the marker filed off. Date.parse of that is LOCAL in every
    // engine, so every age and the whole daily-spend gauge were out by the
    // viewer's offset.
    const seconds = 1_788_600_000;
    const written = new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ");
    assert.equal(ledgerSeconds(written), seconds);
  });

  it("an unparseable stamp is zero, not NaN", () => {
    assert.equal(ledgerSeconds("not a date"), 0);
    assert.equal(ledgerSeconds(""), 0);
  });
});

describe("an unreadable ledger is not a quiet one", () => {
  it("`source: \"none\"` means the read failed, however the request went", () => {
    // Every reader in web/src/lib publishes this shape rather than throwing,
    // so a 200 carrying it is a failure wearing a success's status code.
    assert.equal(readStateOf({ source: "none" }), "unreadable");
    assert.equal(readStateOf(null), "unreadable");
    assert.equal(readStateOf(undefined), "unreadable");
    assert.equal(readStateOf({ source: "sqlite" }), "ok");
    assert.equal(readStateOf({}), "ok", "a read with no source field answered");
  });

  it("the seed has asked nobody anything", () => {
    const seeded = seedLive();
    for (const [k, v] of Object.entries(seeded.reads)) {
      assert.equal(v, "unread", `${k} must start unread, not ok`);
    }
  });

  it("INVARIANT: the two lists that make claims about the world branch on the read", () => {
    // "Quiet." and "Nobody has traded yet." are affirmative statements. Both
    // shipped reachable from an empty seed and from a database outage.
    for (const [file, claim] of [
      ["./screens/Feed.tsx", "Quiet."],
      ["./screens/Board.tsx", "Nobody has traded yet."],
    ] as const) {
      const src = at(file);
      const i = src.indexOf(claim);
      assert.ok(i > 0, `${file} no longer contains ${claim} — update this test with it`);
      const around = src.slice(Math.max(0, i - 500), i + 200);
      assert.match(around, /ReadEmpty/, `${file} must render ${claim} only through ReadEmpty`);
    }
  });

  it("INVARIANT: ReadEmpty cannot say the quiet thing without an `ok` read", () => {
    const src = code(at("./ui.tsx"));
    const i = src.indexOf("export function ReadEmpty");
    assert.ok(i > 0);
    const body = src.slice(i, i + 900);
    assert.match(body, /state === "unread"/);
    assert.match(body, /state === "unreadable"/);
    // The caller's title is the last thing reached, after both refusals.
    const unread = body.indexOf('state === "unread"');
    const unreadable = body.indexOf('state === "unreadable"');
    const title = body.lastIndexOf("title={title}");
    assert.ok(unread < title && unreadable < title, "both refusals must precede the claim");
  });
});

describe("a growth curve is not raw equity", () => {
  it("INVARIANT: the profile chart draws only a growth series", () => {
    // `read-agent.ts` deletes the raw equity field on purpose: "equity_usdg
    // steps up the moment the owner funds the account… so drawn raw it shows a
    // book springing into existence at full value." The terminal profile fell
    // back to the leaderboard row, whose curve is exactly that.
    const src = at("./screens/Profile.tsx");
    const gate = src.indexOf("curveKind");
    const draw = src.indexOf("<PerformanceChart"); // the USE, not the import on line 1
    assert.ok(gate > 0, "the profile must check which quantity the curve is");
    assert.ok(draw > gate, "and it must check before it draws");
  });

  it("INVARIANT: and only when the deposits divided out were evidenced", () => {
    const src = at("./screens/Profile.tsx");
    const gate = src.indexOf("contributionsEvidenced");
    const draw = src.indexOf("<PerformanceChart"); // the USE, not the import on line 1
    assert.ok(gate > 0, "EquityLine's gate must exist on the screen that replaced it");
    assert.ok(draw > gate, "and it must precede the draw");
    assert.match(src, /inferred from balance changes/, "the refusal keeps EquityLine's words");
  });

  it("INVARIANT: the leaderboard row is labelled as equity, so the chart refuses it", () => {
    const src = code(at("./live.ts"));
    assert.match(src, /curveKind: "equity"/, "the board mapper must say what its curve is");
    const app = code(at("./App.tsx"));
    assert.match(app, /curveKind:"growth"/, "and the profile mapper must say what its curve is");
    assert.match(app, /contributionsEvidenced/, "and must carry the gate");
  });

  it("INVARIANT: a failed profile read is disclosed even when a board row exists", () => {
    // `agent = profile ?? listedAgent` makes a failed fetch invisible for any
    // agent that happens to be ranked.
    const src = at("./App.tsx");
    assert.match(
      src,
      /screen\.kind === "profile" && agent && profileError/,
      "the failure must be said even when something rendered",
    );
  });
});
