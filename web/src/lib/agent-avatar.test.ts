import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mintSlug, SLUG_RE } from "@merrymen/identity-store";
import { avatarGradient, faceSeed, initialsOf } from "./agent-avatar";

describe("what a face is seeded on", () => {
  it("a real public id seeds the face, so two agents with one name look different", () => {
    // Every "Robin" used to get the same gradient because the seed was the
    // name. The slug is minted once per agent and never changes.
    const gradients = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const slug = mintSlug();
      assert.equal(faceSeed("Robin", slug), slug);
      gradients.add(avatarGradient(faceSeed("Robin", slug)));
    }
    // 100 draws over 360 hues: a birthday collision or two is expected, a
    // name-seeded face would give exactly one.
    assert.ok(gradients.size >= 75, `100 Robins got only ${gradients.size} different faces`);
  });

  it("renaming an agent does not move its face", () => {
    const slug = mintSlug();
    assert.equal(avatarGradient(faceSeed("Robin", slug)), avatarGradient(faceSeed("Amber Heron", slug)));
  });

  it("anything that is not a public id falls back to the name, which is at least stable", () => {
    // The terminal gives an unlinked leaderboard row the placeholder slug
    // `unlinked-<index>`. Seeding on that would recolour the face whenever the
    // board reordered — a face that moves between refreshes is worse than a
    // shared one.
    for (const slug of [null, undefined, "", "unlinked-3", "UNLINKED", "0123456789ABCDEF", "too-short"]) {
      assert.equal(faceSeed("Robin", slug), "Robin", `"${slug}" must not seed a face`);
    }
  });

  it("recognises exactly the ids the identity store mints", () => {
    // The shape is restated here rather than imported — identity-store.ts
    // reads the filesystem and this file renders in the browser — so the two
    // are held together by running the real minter against it.
    for (let i = 0; i < 200; i++) {
      const slug = mintSlug();
      assert.ok(SLUG_RE.test(slug), "sanity: the store accepts its own slug");
      assert.equal(faceSeed("x", slug), slug);
    }
    for (const near of ["0123456789abcdeu", "0123456789abcdei", "0123456789abcdel", "0123456789abcdeo"]) {
      assert.equal(SLUG_RE.test(near), false, "sanity: the store refuses i, l, o and u");
      assert.equal(faceSeed("x", near), "x");
    }
  });

  it("initials stay the name's, because the name is what the reader reads beside them", () => {
    assert.equal(initialsOf("Robin"), "RO");
    assert.equal(initialsOf("Amber Heron"), "AH");
  });
});
