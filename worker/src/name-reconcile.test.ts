import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createNameReconciler, mirrorNameOnArm, type NameRoster } from "./name-reconcile";
import { carryStoredName, getName, nameSeat, setName } from "./soul";

/**
 * Run against the REAL soul in a throwaway home, not a fake seat: the whole
 * point of the reconcile is that it converges with what setName/getName
 * actually do to a name, and a fake would agree with whatever this file
 * assumed.
 */
let home: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.MERRYMEN_HOME;
  home = mkdtempSync(path.join(os.tmpdir(), "mm-name-reconcile-"));
  process.env.MERRYMEN_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.MERRYMEN_HOME;
  else process.env.MERRYMEN_HOME = prev;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const identityFile = () => path.join(home, "soul", "IDENTITY.md");

function roster(agentId: string | null = "0xagent") {
  const rows: { id: string; name: string }[] = [];
  const warns: { id: string; message: string }[] = [];
  const logs: string[] = [];
  let resolved = 0;
  const r: NameRoster = {
    agentId: async () => {
      resolved++;
      return agentId;
    },
    setAgentName: async (id, name) => {
      rows.push({ id, name });
    },
    warn: async (id, message) => {
      warns.push({ id, message });
    },
    log: (line) => logs.push(line),
  };
  return { r, rows, warns, logs, resolvedCount: () => resolved };
}

/** The seat index.ts wires — the same object, not a copy of it. */
const reconciler = () => createNameReconciler(nameSeat);

describe("the configured name reaches the soul and the roster", () => {
  it("a new name is written to the soul and mirrored onto the agent's row", async () => {
    const reconcile = reconciler();
    const { r, rows } = roster();
    assert.equal(await reconcile("Amber Heron", r), "renamed");
    assert.equal(getName(), "Amber Heron");
    assert.deepEqual(rows, [{ id: "0xagent", name: "Amber Heron" }]);
  });

  it("converges: the next tick with the same name writes nothing and resolves no agent", async () => {
    // Guarded on a real difference, so a normal tick costs one file read. The
    // agent id is resolved lazily because resolving it is an upsert.
    const reconcile = reconciler();
    await reconcile("Amber Heron", roster().r);
    const before = statSync(identityFile()).mtimeMs;
    const second = roster();
    assert.equal(await reconcile("Amber Heron", second.r), "unchanged");
    assert.equal(second.resolvedCount(), 0);
    assert.deepEqual(second.rows, []);
    assert.equal(statSync(identityFile()).mtimeMs, before);
  });

  it("compares in the soul's own shape, so spacing or composition never rewrites every tick", async () => {
    // The soul stores NFC with whitespace collapsed. Comparing the raw
    // configured value would make `want !== getName()` true forever for
    // "Little  John" or a decomposed "José" — an identity-file rewrite every
    // tick that logs nothing because setName says ok.
    const reconcile = reconciler();
    await reconcile("José", roster().r);
    const decomposed = "José";
    const spaced = roster();
    assert.equal(await reconcile(`  ${decomposed}  `, spaced.r), "unchanged");
    assert.deepEqual(spaced.rows, []);
    await reconcile("Little John", roster().r);
    const collapsed = roster();
    assert.equal(await reconcile("Little   John", collapsed.r), "unchanged");
    assert.deepEqual(collapsed.rows, []);
  });

  it("nothing configured leaves the soul's own name alone", async () => {
    // A chat rename lives in the soul; an empty setting must not stamp over it.
    const reconcile = reconciler();
    setName("Shogun");
    for (const configured of [undefined, "", "   "]) {
      const { r, rows } = roster();
      assert.equal(await reconcile(configured, r), "unchanged");
      assert.deepEqual(rows, []);
    }
    assert.equal(getName(), "Shogun");
  });

  it("with no agent to key the row on, the soul still takes the name", async () => {
    // A killed agent has no grant and no armed handle. The soul is what chat
    // answers with, so it moves anyway; the row follows at the next arm.
    const reconcile = reconciler();
    const { r, rows } = roster(null);
    assert.equal(await reconcile("Quiet Wren", r), "renamed");
    assert.equal(getName(), "Quiet Wren");
    assert.deepEqual(rows, []);
  });
});

/**
 * WHAT THE SOUL REFUSES FROM SETTINGS.
 *
 * Not "007": a name that is already stored is carried as it was stored (see
 * the describe block below). These are names the soul never admitted under
 * any rule — the shapes a partner app can still enroll, since its enrollment
 * checks only the length — so the refusal path is exercised by something that
 * can actually reach it.
 */
describe("a name the soul refuses is never a silent refusal", () => {
  it("the owner is told what was refused, why, and what the agent is still called", async () => {
    const reconcile = reconciler();
    await reconcile("Amber Heron", roster().r);
    const { r, warns, rows } = roster();
    assert.equal(await reconcile("@Shogun", r), "refused");
    assert.equal(getName(), "Amber Heron", "the soul keeps its last good name");
    assert.deepEqual(rows, []);
    assert.equal(warns.length, 1);
    assert.equal(warns[0]!.id, "0xagent");
    assert.match(warns[0]!.message, /"@Shogun"/);
    assert.match(warns[0]!.message, /1-24 characters/);
    assert.match(warns[0]!.message, /Amber Heron/);
  });

  it("the reason given is the rule the name actually failed", async () => {
    // A stored name is held to the rule it was stored under, which has no
    // letter requirement. Telling the owner "it needs a letter" about "@Shogun"
    // would send them to fix the wrong thing — and about "007" it would be
    // false outright, because "007" is kept.
    const reconcile = reconciler();
    const { r, warns } = roster();
    await reconcile("@Shogun", r);
    assert.doesNotMatch(warns[0]!.message, /at least one letter/);
  });

  it("said once per refused value, not once per tick", async () => {
    // The reconcile runs every tick. An undeduped warn would bury the owner's
    // event feed in one sentence, which is its own way of hiding everything
    // else the wall said.
    const reconcile = reconciler();
    const first = roster();
    await reconcile("@Shogun", first.r);
    for (let i = 0; i < 5; i++) {
      const again = roster();
      assert.equal(await reconcile("@Shogun", again.r), "refused");
      assert.deepEqual(again.warns, []);
      assert.deepEqual(again.logs, []);
      assert.equal(again.resolvedCount(), 0, "a repeat does not even upsert the agent row");
    }
    assert.equal(first.warns.length, 1);
    // A DIFFERENT bad value is a different refusal and is said again.
    const other = roster();
    await reconcile("-Robin", other.r);
    assert.equal(other.warns.length, 1);
  });

  it("a refusal before there was an agent to tell is told once there is one", async () => {
    const reconcile = reconciler();
    const nobody = roster(null);
    await reconcile("@Shogun", nobody.r);
    assert.deepEqual(nobody.warns, []);
    assert.equal(nobody.logs.length, 1, "the operator log still has it");
    const armed = roster("0xnew");
    await reconcile("@Shogun", armed.r);
    assert.equal(armed.warns.length, 1);
    assert.equal(armed.warns[0]!.id, "0xnew");
  });

  it("fixing the name and then breaking it again announces the new refusal", async () => {
    const reconcile = reconciler();
    await reconcile("@Shogun", roster().r);
    await reconcile("Bold Otter", roster().r);
    const again = roster();
    await reconcile("@Shogun", again.r);
    assert.equal(again.warns.length, 1);
  });

  it("going back to the current name and then to the bad one again is told again", async () => {
    // Setting the name the agent already has converges without a write; the
    // refusal memory must still clear there, or the second "@Shogun" is silent.
    const reconcile = reconciler();
    await reconcile("Amber Heron", roster().r);
    await reconcile("@Shogun", roster().r);
    assert.equal(await reconcile("Amber Heron", roster().r), "unchanged");
    const again = roster();
    await reconcile("@Shogun", again.r);
    assert.equal(again.warns.length, 1);
  });

  it("the identity file is untouched by a refusal", async () => {
    const reconcile = reconciler();
    await reconcile("Amber Heron", roster().r);
    const before = readFileSync(identityFile(), "utf8");
    await reconcile("Robin!", roster().r);
    assert.equal(readFileSync(identityFile(), "utf8"), before);
  });
});

/**
 * AN AGENT THAT ALREADY HAS A NAME KEEPS IT.
 *
 * The letter rule arrived after agents had been named "007". Applied to what
 * was already stored, it reads that name back as "Robin", the reconcile refuses
 * the configured "007" and tells the owner their agent "is still called Robin"
 * — false, it was 007 until that deploy — and the first re-arm (every restart
 * is one) writes "Robin" onto the roster the leaderboard reads, while the
 * owner's feed and the Brain persona still say 007. The rule is for a
 * name somebody is choosing now: the settings form, chat /name, the wizard.
 */
describe("an existing letterless name survives: the letter rule is for names chosen now", () => {
  /** An identity file exactly as setName wrote it for "007" before the rule. */
  const seed007 = () => {
    mkdirSync(path.join(home, "soul"), { recursive: true });
    writeFileSync(
      identityFile(),
      [
        "# 007 of the merrymen",
        "born: 2026-03-01",
        "",
        "I am 007, a merryman — an outlaw trader working Sherwood (Robinhood Chain)",
        "",
      ].join("\n"),
      "utf8",
    );
  };

  it("reads back as 007, not as the default", () => {
    seed007();
    assert.equal(getName(), "007");
  });

  it("survives a restart and an arm: nothing rewritten, nobody told anything, the roster says 007", async () => {
    seed007();
    const before = readFileSync(identityFile(), "utf8");
    // A restart is a new process: a fresh reconciler with no memory of what it
    // has already told anybody, against the soul on disk.
    const restarted = reconciler();
    const { r, rows, warns, logs } = roster();
    assert.equal(await restarted("007", r), "unchanged");
    assert.deepEqual(warns, [], "no warning on the owner's feed");
    assert.deepEqual(logs, [], "and no refusal in the operator log");
    assert.deepEqual(rows, []);
    assert.equal(readFileSync(identityFile(), "utf8"), before, "the identity file is not touched");

    // Every restart is a re-arm, and the arm mirrors the soul onto the row.
    const armed: { id: string; name: string }[] = [];
    await mirrorNameOnArm(nameSeat, "0xagent", async (id, name) => {
      armed.push({ id, name });
    });
    assert.deepEqual(armed, [{ id: "0xagent", name: "007" }]);
  });

  it("with nothing configured, the arm still mirrors the soul's own 007", async () => {
    seed007();
    assert.equal(await reconciler()(undefined, roster().r), "unchanged");
    const armed: string[] = [];
    await mirrorNameOnArm(nameSeat, "0xagent", async (_id, name) => {
      armed.push(name);
    });
    assert.deepEqual(armed, ["007"]);
  });

  it("survives a hosted redeploy, where the soul is rebuilt empty and settings still say 007", async () => {
    // A child home has no volume, so a redeploy rebuilds the soul as the
    // default. Settings is the durable seed; carrying it back is not a rename.
    const reconcile = reconciler();
    const { r, rows, warns } = roster();
    assert.equal(await reconcile("007", r), "renamed");
    assert.equal(getName(), "007");
    assert.deepEqual(warns, []);
    assert.deepEqual(rows, [{ id: "0xagent", name: "007" }]);
    assert.match(readFileSync(identityFile(), "utf8"), /^I am 007,/m);
    const armed: string[] = [];
    await mirrorNameOnArm(nameSeat, "0xagent", async (_id, name) => {
      armed.push(name);
    });
    assert.deepEqual(armed, ["007"]);
  });

  it("a later rename rewrites the introduction too, not only the title", () => {
    // setName finds the old introduction by the name getName() reads back. Read
    // back as "Robin", "I am 007," was never found and survived every rename.
    seed007();
    assert.deepEqual(setName("Bond"), { ok: true, name: "Bond" });
    const text = readFileSync(identityFile(), "utf8");
    assert.match(text, /^# Bond of the merrymen$/m);
    assert.match(text, /^I am Bond,/m);
    assert.doesNotMatch(text, /007/);
  });

  it("a name typed now still needs a letter — chat /name is new input", () => {
    seed007();
    for (const name of ["2024", "99.5", "1 2 3"]) {
      const r = setName(name);
      assert.equal(r.ok, false, `"${name}" is refused as a new name`);
      if (!r.ok) assert.match(r.reason, /at least one letter/);
    }
    assert.equal(getName(), "007", "and a refused new name leaves the kept one alone");
  });

  it("carrying a stored name is held to every other part of the rule", () => {
    // Grandfathering the letter requirement is all it does: a bidi override, a
    // leading mark or an over-long name is refused however it was stored.
    for (const name of ["@Shogun", "-Robin", `Robin${String.fromCharCode(0x202e)}evil`, "a".repeat(25)]) {
      assert.equal(carryStoredName(name).ok, false, `"${name}" is refused`);
    }
    assert.deepEqual(carryStoredName("007"), { ok: true, name: "007" });
  });
});
