import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { DEFAULT_AGENT_NAME, GENERATED_NAME_PARTS, agentNameForSlug } from "./agent-name";

/** A slug in the identity store's own shape: 16 chars of lowercase Crockford base32. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function slug(): string {
  return Array.from(randomBytes(16), (b) => ALPHABET[b & 31]).join("");
}

describe("a generated agent name", () => {
  it("is the same name every time for the same slug", () => {
    // Deterministic is the whole contract. The web tier suggests it on the
    // Agent screen and the grants route writes it; if the two computed
    // different names the owner would be offered one name and given another.
    for (let i = 0; i < 50; i++) {
      const s = slug();
      assert.equal(agentNameForSlug(s), agentNameForSlug(s));
    }
    assert.equal(agentNameForSlug("7y2kq0m4c1x9h3tb"), agentNameForSlug("7Y2KQ0M4C1X9H3TB"), "case is not identity");
  });

  it("is never the stock default, so a generated name cannot recreate the clone it replaces", () => {
    for (let i = 0; i < 2000; i++) assert.notEqual(agentNameForSlug(slug()), DEFAULT_AGENT_NAME);
  });

  it("spreads across the whole word list rather than a corner of it", () => {
    // A generator that indexed with a narrow slice of the hash would still be
    // "deterministic" and would still hand the fleet a handful of names. Every
    // word being reachable from real slugs is what rules that out.
    const adjectives = new Set<string>();
    const nouns = new Set<string>();
    const names = new Set<string>();
    for (let i = 0; i < 6000; i++) {
      const name = agentNameForSlug(slug())!;
      const [adjective, noun] = name.split(" ");
      adjectives.add(adjective!);
      nouns.add(noun!);
      if (i < 2000) names.add(name);
    }
    assert.equal(adjectives.size, GENERATED_NAME_PARTS.adjectives.length, "every adjective is reachable");
    assert.equal(nouns.size, GENERATED_NAME_PARTS.nouns.length, "every noun is reachable");
    // With 6,000+ combinations, 2,000 draws land ~1,700 distinct names. A
    // collapse to one list's worth would land at most ~80.
    assert.ok(names.size >= 1500, `2,000 slugs gave only ${names.size} distinct names`);
  });

  it("the two word lists never share a word, so no name is 'Fox Fox'", () => {
    const nouns = new Set(GENERATED_NAME_PARTS.nouns);
    for (const a of GENERATED_NAME_PARTS.adjectives) assert.ok(!nouns.has(a), `${a} is in both lists`);
    assert.equal(new Set(GENERATED_NAME_PARTS.adjectives).size, GENERATED_NAME_PARTS.adjectives.length);
    assert.equal(nouns.size, GENERATED_NAME_PARTS.nouns.length);
  });

  it("no slug means no name, never a shared fallback", () => {
    // A blank seed would give every slug-less caller the SAME generated name,
    // which is the clone problem again under a different name.
    assert.equal(agentNameForSlug(""), null);
    assert.equal(agentNameForSlug("   "), null);
  });
});
