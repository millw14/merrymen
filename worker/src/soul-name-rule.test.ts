import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AGENT_NAME_RE, STORED_AGENT_NAME_RE, normalizeAgentName } from "../../packages/core/src/agent-name";
import { DEFAULT_NAME, carryStoredName, getName, setName } from "./soul";

/**
 * THE SOUL KEEPS A NAME EXACTLY WHEN THE WEB TIER'S RULE SAYS IT MAY.
 *
 * The settings form, the wizard and partner enrollment all test a name against
 * packages/core's AGENT_NAME_RE before storing it, and the worker reconciles
 * the stored name into the soul. If the soul refused a name the web tier had
 * stored, the owner was told "saved" and the agent kept answering to its old
 * name. This used to be held together by reading soul.ts as text and compiling
 * the regex found there; now the soul imports core's rule, and this runs names
 * through the real writers in a throwaway home — which is what the worker
 * actually does with them.
 */
let home: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.MERRYMEN_HOME;
  home = mkdtempSync(path.join(os.tmpdir(), "mm-soul-name-rule-"));
  process.env.MERRYMEN_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.MERRYMEN_HOME;
  else process.env.MERRYMEN_HOME = prev;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// Built, not written: invisible characters typed literally cannot be told from
// a typo in an editor.
const ZWNJ = String.fromCharCode(0x200c);
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const ACUTE = String.fromCharCode(0x301);

/** Names either side of every edge the rule has: alphabet, marks, format characters, the letter, the length. */
const NAMES = [
  "Robin", "José", `Jose${ACUTE}`, "Müller", "Робин", "小红", "रोबिन", "โรบิน", "رَوبِن", `محمد${ZWNJ}رضا`,
  "O'Brien", "St. John", "  Little   John ", "Amber Heron", "R2", "Agent 47", "小红2",
  "007", "2024", "99.5", "1 2 3", "١٢٣",
  `Robin${RLO}evil`, `Robin${ZWSP}x`, `${ACUTE}Robin`, "-Robin", "@007", "", "a".repeat(24), "a".repeat(25),
];

describe("the soul enforces core's name rules", () => {
  it("a name chosen now is kept exactly when AGENT_NAME_RE accepts its stored shape", () => {
    for (const raw of NAMES) {
      const norm = normalizeAgentName(raw);
      const r = setName(raw);
      assert.equal(r.ok, AGENT_NAME_RE.test(norm), `setName(${JSON.stringify(raw)}) must agree with the web tier's rule`);
      if (r.ok) {
        assert.equal(r.name, norm, "stored in the shape the web tier stores");
        assert.equal(getName(), norm, "and read back as that name");
      }
    }
  });

  it("a name settings already holds is carried exactly when STORED_AGENT_NAME_RE accepts it", () => {
    for (const raw of NAMES) {
      const norm = normalizeAgentName(raw);
      const r = carryStoredName(raw);
      assert.equal(r.ok, STORED_AGENT_NAME_RE.test(norm), `carryStoredName(${JSON.stringify(raw)}) must agree with the web tier's stored rule`);
      if (r.ok) assert.equal(getName(), norm);
    }
  });

  it("a stored letterless name reads back as itself, not as the default", () => {
    // Read back through the new-name rule, "007" came out as "Robin" — a
    // rename nobody asked for.
    assert.equal(carryStoredName("007").ok, true);
    assert.equal(getName(), "007");
    assert.notEqual(getName(), DEFAULT_NAME);
  });
});
