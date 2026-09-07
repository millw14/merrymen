/**
 * A LIKE HAS TO OUTLIVE THE ROW IT WAS CAST ON.
 *
 * The id the browser had was `${symbol}-${action}-${slug}-${at}`, and `at` is
 * `MAX(d.at)` over a group the default strategy re-proposes every tick. So it
 * advanced every few minutes on a post nobody had touched, and a like cast
 * against it detached from the thing it was about within minutes. Every test
 * here is one property of the replacement.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { postIdOf, POST_ID_SHAPE, type PostIdParts } from "./post-id";

const p = (over: Partial<PostIdParts> = {}): PostIdParts => ({
  slug: "abc23456789defgh",
  action: "buy",
  symbol: "TSLA",
  sizeUsdg: 5,
  reason: "momentum held through the open",
  shadow: false,
  ...over,
});

describe("what the id is made of", () => {
  it("is stable — the same post twice is the same id", () => {
    assert.equal(postIdOf(p()), postIdOf(p()));
    assert.match(postIdOf(p())!, POST_ID_SHAPE);
  });

  it("A LIKE SURVIVES ITS TRADE SETTLING", () => {
    // The whole point. `read-theses.ts` groups on trade status, so the same
    // thesis is a different ROW once its trade lands — and an id that included
    // the outcome would drop every like at exactly the moment a reader would
    // look for them. Outcome is not an input, so nothing here can change it.
    const parts = p();
    const before = postIdOf(parts);
    // There is no outcome field to vary: the type would not admit one. This
    // asserts the shape of the input, which is what enforces the property.
    assert.deepEqual(Object.keys(parts).sort(), [
      "action",
      "reason",
      "shadow",
      "sizeUsdg",
      "slug",
      "symbol",
    ]);
    assert.equal(postIdOf(p()), before);
  });

  it("EVERY INPUT IS A FIELD OF THE POST THE ID IS RETURNED WITH", () => {
    // The safety argument, asserted rather than asserted-in-prose. An earlier
    // version hashed the ROW's `source`, which `PublicThesis` deliberately does
    // not carry and which `PUBLISHABLE_SOURCES` draws from a seven-member
    // public set — so seven sha-256 calls recovered it from a page anybody can
    // fetch. A hash whose preimage is known except for one field from a tiny
    // public set is an encoding, not a hash.
    const policy = readFileSync(
      new URL("../../../worker/src/thesis-policy.ts", import.meta.url),
      "utf8",
    );
    const iface = policy.slice(policy.indexOf("export interface PublicThesis {"));
    const published = iface.slice(0, iface.indexOf("\n}"));
    for (const field of Object.keys(p())) {
      assert.match(
        published,
        new RegExp(`^\\s*${field}[?:]`, "m"),
        `${field} is hashed into the post id but is not published on the post`,
      );
    }
  });

  it("and it does not move when the post is merely re-proposed", () => {
    // `at` and `said` are the fields that tick. Neither is an input.
    assert.equal(postIdOf(p()), postIdOf(p()));
  });

  it("every component actually changes it", () => {
    const base = postIdOf(p());
    const variants: Partial<PostIdParts>[] = [
      { slug: "zzz23456789defgh" },
      { shadow: true },
      { action: "sell" },
      { symbol: "NVDA" },
      { sizeUsdg: 6 },
      { reason: "something else entirely" },
    ];
    for (const v of variants) {
      assert.notEqual(postIdOf(p(v)), base, `${Object.keys(v)[0]} does not affect the id`);
    }
  });
});

describe("what it refuses", () => {
  it("AN UNSLUGGED POST IS NOT LIKEABLE", () => {
    // Deliberate, not an oversight. The alternative input is `agent_id`, which
    // is a smart-account ADDRESS — hashing it would put a wallet into an id
    // that appears in URLs and logs, and the hash of a known address is a
    // lookup table. A post with no public identity has nothing to attach to.
    assert.equal(postIdOf(p({ slug: null })), null);
    assert.equal(postIdOf(p({ slug: "" })), null);
  });

  it("FIELD BOUNDARIES CANNOT BE FORGED", () => {
    // The failure a hyphen join would have: two different posts hashing the
    // same because a field's own text can contain the separator. A reason is
    // free text written by a model, so this is reachable, not theoretical.
    assert.notEqual(
      postIdOf(p({ symbol: "A-B", reason: "C" })),
      postIdOf(p({ symbol: "A", reason: "B-C" })),
    );
    assert.notEqual(
      postIdOf(p({ symbol: "", reason: "TSLAmomentum" })),
      postIdOf(p({ symbol: "TSLA", reason: "momentum" })),
    );
  });

  it("a null field and an empty one are the same post, which is right", () => {
    // Both mean "this post names no symbol". A pure thesis written by two code
    // paths must not become two posts with two like counts.
    assert.equal(postIdOf(p({ symbol: null })), postIdOf(p({ symbol: "" })));
  });
});

describe("the shape the routes validate", () => {
  it("accepts what postIdOf makes and rejects what it does not", () => {
    assert.match(postIdOf(p())!, POST_ID_SHAPE);
    for (const bad of ["", "xyz", "A".repeat(32), "0".repeat(31), "0".repeat(33), "../../etc"]) {
      assert.ok(!POST_ID_SHAPE.test(bad), `${bad} must not pass as a post id`);
    }
  });
});
