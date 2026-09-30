/**
 * End-to-end proof against real soul files: a fact old enough that the previous
 * newest-15 window could never reach it comes back when the owner asks about it.
 *
 * MERRYMEN_HOME is set before importing soul.ts so everything runs in a throwaway
 * directory. node --test gives each file its own process, so this never leaks.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "mm-mem-"));
process.env.MERRYMEN_HOME = HOME;
mkdirSync(path.join(HOME, "soul"), { recursive: true });

const { identityBlock, memoryBlock, soulPromptBlock } = await import("../soul");

const NOW = Math.floor(Date.UTC(2026, 6, 27) / 1000);
const DAY = 86_400;
const dateOf = (d: number) => new Date((NOW - d * DAY) * 1000).toISOString().slice(0, 10);

// One buried fact + 30 newer unrelated ones — the exact shape that defeats
// position-based slicing.
const lines = [`- (${dateOf(60)}) The BIM coursework is due 12 August.`];
for (let i = 0; i < 30; i++) lines.push(`- (${dateOf(29 - i)}) Ran a paper trade on QQQ, batch ${i}.`);
writeFileSync(path.join(HOME, "soul", "NOTES.md"), `# Notes\n\n${lines.join("\n")}\n`, "utf8");
writeFileSync(
  path.join(HOME, "soul", "OWNER.md"),
  `# What I know about my owner\n\n- (${dateOf(90)}) They like to be called Mummy.\n`,
  "utf8",
);
writeFileSync(path.join(HOME, "soul", "IDENTITY.md"), "# Robin of the merrymen\nborn: 2026-01-01\n", "utf8");

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("eviction demotes to the archive — it never destroys", () => {
  it("a fact pushed past the cap is still findable afterwards", async () => {
    // Own home so the corpus above isn't disturbed.
    const home2 = mkdtempSync(path.join(os.tmpdir(), "mm-arch-"));
    const prev = process.env.MERRYMEN_HOME;
    process.env.MERRYMEN_HOME = home2;
    try {
      mkdirSync(path.join(home2, "soul"), { recursive: true });
      const soul = await import(`../soul?arch=${Date.now()}`);
      soul.rememberOwnerFact("They keep an allotment in Peckham.", NOW);
      // Push well past MAX_OWNER_FACTS (60) so the first fact must be evicted.
      for (let i = 0; i < 70; i++) soul.rememberOwnerFact(`Filler owner fact number ${i}.`, NOW);

      const working = soul.ownerFacts().join("\n");
      assert.ok(!working.includes("allotment"), "it really did leave the working set");
      const archived = soul.archivedLines().join("\n");
      assert.ok(archived.includes("allotment"), "…but it was archived, not deleted");

      // And crucially: still reachable through normal recall.
      const block = soul.memoryBlock("do they have an allotment?", NOW);
      assert.ok(block.includes("allotment"), "an evicted fact is demoted, not forgotten");
    } finally {
      if (prev === undefined) delete process.env.MERRYMEN_HOME;
      else process.env.MERRYMEN_HOME = prev;
      rmSync(home2, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe("memoryBlock reaches what the old slice could not", () => {
  it("recalls a 60-day-old note when the owner asks about it", () => {
    const block = memoryBlock("when is the BIM coursework due?", NOW);
    assert.ok(block.includes("BIM coursework"), "the buried note is retrieved");
  });

  it("the OLD path genuinely could not — proving this is a real change", () => {
    // soulPromptBlock still takes the newest 15 notes by position. The BIM note
    // is the 31st-newest, so it is structurally unreachable there.
    const old = soulPromptBlock(null, 0, NOW);
    assert.ok(!old.includes("BIM coursework"), "newest-15 slicing cannot see it");
  });

  it("recalls an owner fact from 90 days back when asked", () => {
    const block = memoryBlock("what should you call me?", NOW);
    assert.ok(block.includes("called Mummy"));
  });

  it("still shows recent notes when the question matches nothing", () => {
    const block = memoryBlock("xyzzy plugh nothing matches", NOW);
    assert.ok(block.includes("batch 29"), "the recency floor holds — never worse than before");
  });

  it("identityBlock carries identity but NOT recalled memory (classifier budget)", () => {
    const id = identityBlock(null, 0, NOW);
    assert.ok(id.includes("Robin"), "identity is present");
    assert.ok(!id.includes("BIM coursework"), "memory is not in the router's context");
    assert.ok(!id.includes("called Mummy"));
  });

  it("the memory block stays inside its char budget", () => {
    const block = memoryBlock("trade", NOW);
    assert.ok(block.length < 2600, `memory block was ${block.length} chars`);
  });
});
