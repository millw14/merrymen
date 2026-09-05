/**
 * EXECUTION IS DISCONNECTED BY ABSENCE, and this is what checks it.
 *
 * The shadow path's guarantee is not a flag someone can flip — it is that these
 * modules do not import or call the execution machinery at all. Connecting
 * execution later has to ADD an import, which shows up in a diff and needs a
 * reason given.
 *
 * COMMENTS ARE STRIPPED FIRST. The modules describe what they will not do, in
 * prose, using the names of the things they will not do — and the first version
 * of this check failed on its own documentation. What is under review is code.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const SHADOW_MODULES = ["brain-shadow", "brain-client", "brain-trigger", "brain-enabled"];

const FORBIDDEN_IMPORTS = ["./proposals", "./policy", "./executor", "./simulate", "./wall", "./intents"];
const FORBIDDEN_CALLS = [
  "proposalsToIntents",
  "checkPolicy",
  "simulateSwap",
  "sendUserOp",
  "buildCalldata",
  "executeIntent",
];

/** Source with comments removed, so prose about execution is not read as execution. */
function codeOnly(mod: string): string {
  const raw = readFileSync(new URL("./" + mod + ".ts", import.meta.url), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

describe("the shadow path cannot reach execution", () => {
  for (const mod of SHADOW_MODULES) {
    it(mod + " imports nothing that can move money", () => {
      const code = codeOnly(mod);
      const modules = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const bad of FORBIDDEN_IMPORTS) {
        const hit = modules.find((m) => m === bad || m.endsWith(bad.slice(1)));
        assert.equal(hit, undefined, mod + " imports " + bad + " — the shadow path must not reach execution");
      }
    });

    it(mod + " calls no execution function", () => {
      const code = codeOnly(mod);
      for (const fn of FORBIDDEN_CALLS) {
        assert.doesNotMatch(code, new RegExp("\\b" + fn + "\\s*\\("), mod + " calls " + fn);
      }
    });
  }

  it("the tick guards the shadow path and defaults to nobody", () => {
    const raw = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    assert.match(
      raw,
      /if \(shadowBrainEnabledFor\(agentId\) && cfg\.brainUrl && cfg\.brainToken/,
      "three guards: the agent is named AND the house configured a Brain",
    );
  });

  it("the tick does nothing with the outcome but log it", () => {
    // The decision is persisted inside runShadow and dropped here. If a future
    // edit routes `outcome` onward, this is the line that notices.
    const raw = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const from = raw.indexOf("const outcome = await runShadow(");
    assert.ok(from > 0, "the tick still calls runShadow");
    const block = raw.slice(from, from + 700).replace(/\/\/[^\n]*/g, " ");
    for (const fn of FORBIDDEN_CALLS) {
      assert.doesNotMatch(block, new RegExp("\\b" + fn + "\\b"), "the outcome reaches " + fn);
    }
  });
});

/**
 * ONE LEDGER TABLE, TWO REASONERS, AND ONLY ONE OF THEM MAY CLAIM A ROW.
 *
 * Brain writes shadow decisions into `decisions` under the SAME `agent_id` the
 * strategist uses. The desk's `recall` tool tells the strategist it is looking
 * at "what you proposed, what the wall did with it" — so an unfiltered read
 * hands one reasoner the other's thinking as its own history.
 *
 * On the canary, where both are enabled, that produced:
 *
 *     - buy TSLA 5 USDG: no trade came of it — you said: <Brain's thesis>
 *
 * Three lies in one line: the strategist proposed nothing; "no trade came of
 * it" says something tried and failed rather than that nothing was ever wired
 * to try; and the strategist could then publish a `strategist`-sourced thesis
 * about a buy it believed it had made — which passes the publication gate with
 * no shadow marking at all, because by then the row genuinely is a strategist
 * row. That is a laundering path, not a rendering bug.
 */
describe("one reasoner never inherits another's decisions", () => {
  it("recall excludes every shadow source", () => {
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const i = src.indexOf("recall: async () =>");
    assert.ok(i > 0, "the recall tool must still exist for this test to mean anything");
    const body = src.slice(i, i + 1400);
    assert.match(body, /recentDecisions\([^)]*SHADOW_SOURCES\)/, "recall must filter shadow sources out");
  });

  it("the store can actually exclude them, and does not when asked not to", () => {
    // The filter has to be real SQL, not a comment. Checked on the source
    // because exercising it needs a database.
    const store = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
    const i = store.indexOf("export async function recentDecisions");
    const body = store.slice(i, i + 1800);
    assert.match(body, /excludeSources/, "the parameter exists");
    assert.match(body, /d\.source NOT IN/, "and reaches the WHERE clause");
    assert.match(body, /excludeSources\.length \?/, "and is skipped entirely when nothing is excluded");
  });
});

/**
 * THE PERMANENT SHADOW-EXECUTION INVARIANTS.
 *
 * Everything below is a boundary that was found broken once, in production, and
 * must not be re-broken by a future edit that looks reasonable in isolation.
 * They are pinned HERE, in the disconnection test, because that is the file
 * anybody touching the shadow path will read.
 *
 * The shape of all three failures is the same: a shadow decision is a real row
 * with a real action and a real size, and every surface that reads it without
 * knowing it is shadow will describe a trade that never happened.
 */
describe("shadow-execution invariants — permanent", () => {
  const worker = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
  const stripped = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("INVARIANT: one reasoner never inherits another's decisions", () => {
    // Brain writes into `decisions` under the SAME agent_id the strategist
    // uses, and the desk tells the strategist that `recall` is "what you
    // proposed". Unfiltered, the strategist could publish a strategist-sourced
    // thesis about a buy it believed it had made — which passes the publication
    // gate with no shadow marking, because by then the row IS a strategist row.
    // A laundering path, not a rendering bug.
    const src = stripped(worker("index.ts"));
    const i = src.indexOf("recall: async () =>");
    assert.ok(i > 0, "the recall tool must exist for this invariant to mean anything");
    assert.match(src.slice(i, i + 1400), /recentDecisions\([^)]*SHADOW_SOURCES\)/);
  });

  it("INVARIANT: no surface rebuilds a head from `action`", () => {
    // `publishableThesis` bakes "would buy" into `head` precisely for the
    // surfaces that are not React components. `peer-view` was the only consumer
    // that reassembled the line from `t.action`, and it emitted "what they did
    // about it: buy TSLA 5 USDG" for a peer that did nothing.
    const src = stripped(worker("strategist/peer-view.ts"));
    assert.ok(
      !/\[\s*t\.action\s*,/.test(src),
      "peer-view must use t.head, not rebuild the line from t.action",
    );
    assert.match(src, /t\.shadow/, "and it must know whether the peer executed anything");
    assert.match(src, /executed nothing/);
  });

  it("INVARIANT: the words 'what they did' never describe a shadow decision", () => {
    const src = worker("strategist/peer-view.ts");
    const i = src.indexOf("if (t.shadow)");
    assert.ok(i > 0, "the shadow branch must exist");
    // Sliced to the branch itself, not a fixed window: the `else` immediately
    // after it legitimately says "what they did about it", for a peer that did.
    const end = src.indexOf("} else", i);
    assert.ok(end > i, "the shadow branch must be followed by an else");
    const branch = src.slice(i, end);
    assert.ok(!/what they did about it/.test(branch), "that framing is a claim about a trade");
    assert.match(branch, /SAID THEY WOULD DO/);
  });

  it("INVARIANT: a shadow row carrying a wall verdict is dropped, never rendered", () => {
    // Either the disconnection failed or a source that DOES reach the executor
    // was added to SHADOW_SOURCES. Both are bugs, and a public feed is not
    // where either gets disclosed.
    const src = stripped(worker("thesis-policy.ts"));
    assert.match(src, /if \(shadow && \(row\.status \|\| row\.dropped_rule \|\| row\.reject_rule\)\) return null;/);
  });

  it("INVARIANT: the shadow modules import nothing that executes", () => {
    // Restated here next to the others, because the four above are only worth
    // anything while this one holds.
    for (const f of ["brain-shadow.ts", "brain-client.ts", "brain-trigger.ts", "brain-material.ts"]) {
      const src = stripped(worker(f));
      for (const forbidden of ["proposalsToIntents", "checkPolicy", "./executor", "./simulate", "./wall"]) {
        assert.ok(!src.includes(forbidden), `${f} must not reach ${forbidden}`);
      }
    }
  });
});
