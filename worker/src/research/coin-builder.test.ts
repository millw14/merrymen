/**
 * WHAT THE BUILDER ANALYST IS TOLD, AND WHAT IT IS NEVER TOLD.
 *
 * The fetch is tested where it happens (hey.test.ts). What is left here is the
 * part that only exists in prose, and it is the part that decides whether a
 * model draws a conclusion the evidence does not support: the silence on an
 * unlisted contract, the refusal to render an absent field as a zero or a
 * denial, and the standing refusal to be read as a safety check.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderBuilder } from "./coin-builder";
import { unlisted, type BuilderRecord } from "./builder";

const NOW = 1_770_000_000;
const ADDR = "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32";

const recordOf = (over: Partial<BuilderRecord> = {}): BuilderRecord => ({
  address: ADDR,
  readAt: NOW,
  found: true,
  name: "Merrymen",
  symbol: "MERRYMEN",
  status: "Shipping",
  statusHelp: "Shipped something meaningful in the last 7 days.",
  verified: true,
  activity: {
    commits30d: 87,
    commitsPartial: false,
    releases30d: 7,
    ships30d: 11,
    lastShip: "2026-09-21",
  },
  // DELIBERATELY NOT THE REAL SUPPLIER'S STRINGS. The renderer is the shape
  // and not the source, so a fixture naming a directory would put that name in
  // a file the boundary test does not allow it in — and would quietly stop
  // proving that this prose works for whatever the next supplier is.
  url: "https://example.invalid/project/merrymen",
  disclaimer: "Public, source-backed activity this directory recorded.",
  ...over,
});

const render = (over: Partial<BuilderRecord> = {}, now = NOW) =>
  renderBuilder({ symbol: "TFBA7B32", record: recordOf(over), now });

describe("AN UNLISTED CONTRACT PRODUCES NO BLOCK", () => {
  it("null, not a sentence about having looked", () => {
    const out = renderBuilder({ symbol: "TFBA7B32", record: unlisted(ADDR, NOW), now: NOW });
    assert.equal(
      out,
      null,
      "a directory's coverage gap rendered as prose is read as a finding about the token",
    );
  });

  it("and that holds however much else the record happens to carry", () => {
    // Belt to the adapter's braces. `normalizeHey` already strips everything
    // from a not-found body; if some future supplier does not, the renderer
    // still refuses, because the rule lives in both places on purpose.
    const out = render({ found: false });
    assert.equal(out, null);
  });
});

describe("a listed contract is quoted, and attributed in the same breath", () => {
  it("the first clause says whose claim this is", () => {
    const out = render()!;
    assert.match(
      out.slice(0, 120),
      /directory/i,
      "attribution leads; a caveat at the end arrives after the block has been read as ours",
    );
    assert.ok(out.includes("Merrymen"));
    assert.ok(out.includes("Shipping"));
  });

  it("the status help is the directory's own gloss, not one we wrote", () => {
    const out = render()!;
    assert.ok(out.includes("Shipped something meaningful in the last 7 days."));
    const bare = render({ statusHelp: null })!;
    assert.ok(
      !/last 7 days/.test(bare),
      "with no gloss supplied the block does not invent a definition for the word",
    );
  });

  it("and the directory's own disclaimer travels verbatim", () => {
    assert.ok(render()!.includes("Public, source-backed activity this directory recorded."));
  });
});

describe("an absent number never becomes a zero", () => {
  it("a missing count is simply not mentioned", () => {
    const out = render({
      activity: { commits30d: null, commitsPartial: false, releases30d: 7, ships30d: null, lastShip: null },
    })!;
    assert.ok(out.includes("7 releases"));
    // The word survives in the standing caveat ("a diligent rug also commits");
    // what must not survive is a COUNT of them.
    assert.ok(!/\d+ commits?\b/.test(out), "unknown commits are silence, not 0 commits");
    assert.ok(!/\b0 \w/.test(out), "nothing is rendered as zero that was not measured as zero");
  });

  it("a real zero IS mentioned, because the directory measured it", () => {
    const out = render({
      activity: { commits30d: 0, commitsPartial: false, releases30d: null, ships30d: null, lastShip: null },
    })!;
    assert.ok(out.includes("0 commits"));
  });

  it("a listed page with no numbers at all says which gap it is", () => {
    const out = render({
      activity: { commits30d: null, commitsPartial: false, releases30d: null, ships30d: null, lastShip: null },
    })!;
    assert.match(out, /not a measurement of zero/i);
  });

  it("and singulars read as singulars", () => {
    const out = render({
      activity: { commits30d: 1, commitsPartial: false, releases30d: 1, ships30d: 1, lastShip: null },
    })!;
    assert.ok(out.includes("1 commit,"));
    assert.ok(!out.includes("1 commits"));
  });
});

describe("A FLOOR IS SAID TO BE A FLOOR", () => {
  it("the count is prefixed and the caveat is stated", () => {
    const out = render({
      activity: { commits30d: 87, commitsPartial: true, releases30d: null, ships30d: null, lastShip: null },
    })!;
    assert.ok(out.includes("at least 87 commits"));
    assert.match(out, /FLOOR/);
  });

  it("and a complete count is not hedged into one", () => {
    const out = render()!;
    assert.ok(!out.includes("at least"));
    assert.ok(!/FLOOR/.test(out));
  });
});

describe("verified is three states and the block renders three", () => {
  it("verified says so", () => {
    assert.match(render({ verified: true })!, /records the builder as verified/);
  });

  it("not-verified says so, and says it is the directory's process", () => {
    const out = render({ verified: false })!;
    assert.match(out, /NOT verified/);
    assert.match(out, /its own checks, not a finding about the team/);
  });

  it("UNKNOWN SAYS NOTHING — an absent field is not a denial", () => {
    const out = render({ verified: null })!;
    assert.ok(
      !/verified/i.test(out),
      "rendering null as unverified manufactures a negative finding out of silence",
    );
  });
});

describe("the block refuses to be read as a safety check", () => {
  it("it names every probe that is not behind it", () => {
    const out = render()!;
    assert.match(out, /honeypot/i);
    assert.match(out, /sell-path/i);
    assert.match(out, /LP-lock/i);
    assert.match(out, /proxy-upgrade/i);
    assert.match(out, /a diligent rug also commits/i);
  });

  it("and says the contract-to-project link is the directory's claim", () => {
    assert.match(render()!, /DIRECTORY'S claim rather than an onchain fact/);
  });

  it("and disclaims price outright", () => {
    assert.match(render()!, /none of it is a statement about price/i);
  });
});

describe("an old reading says it is old", () => {
  it("a fresh one is quoted as current", () => {
    assert.ok(!/may have moved since/.test(render({}, NOW + 60)!));
  });

  it("a stale one carries its age", () => {
    const out = render({}, NOW + 30 * 3600)!;
    assert.match(out, /30h ago/);
    assert.match(out, /may have moved since/);
  });
});

describe("the block is bounded and is one paragraph", () => {
  it("it never exceeds the per-lens ceiling", () => {
    const out = render({ disclaimer: "x".repeat(2000), statusHelp: "y".repeat(2000) })!;
    assert.ok(out.length <= 1200);
  });

  it("and carries no newline a fence could be broken across", () => {
    assert.ok(!render()!.includes("\n"));
  });
});
