/**
 * INSTRUMENTATION NEVER COSTS A TRADE ITS RECORD, AND NEVER CROWDS THE
 * OWNER'S VIEW. The decision funnel is called on the trading path (one call
 * sits right before a fill's ledger row is written), and the Brain gate's
 * fields ride in the same signals_json the owner's 24-scalar view reads.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { FunnelRecorder, classifyStage } from "./decision-funnel";

const TOKEN = "0x00000000000000000000000000000000000000aa";

describe("the decision funnel never throws", () => {
  it("record, note and block swallow their own failures", () => {
    let broken = false;
    const f = new FunnelRecorder({ now: () => { if (broken) throw new Error("clock"); return 0; } });
    broken = true;
    assert.equal(f.record({ token: TOKEN, symbol: "AA", stage: "candidate", detail: "x" } as never), false);
    assert.equal(f.note(TOKEN, "AA", classifyStage({ kind: "candidate-skip", skip: "token-paused" })), false);
    assert.doesNotThrow(() => f.block({ kind: "no-candidates" } as never));
  });

  it("and the entry note before addTrade is guarded where it is called", () => {
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("function noteEntryFunnel("), src.indexOf("function noteEntryFunnel(") + 700);
    assert.match(fn, /\{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*try \{/, "the whole body is inside try");
    const at = src.indexOf('noteEntryFunnel(intent, classifyStage({ kind: "trade"');
    assert.ok(at > 0 && src.indexOf("await addTrade({ ...row, decision_id })", at) > at, "it is the call right before addTrade");
  });
});

describe("the Brain gate's fields come last in a decision row's signals_json", () => {
  it("after execution_connected, so the owner's first 24 scalars are what they were", () => {
    const src = readFileSync(new URL("./brain-shadow.ts", import.meta.url), "utf8");
    const connected = src.indexOf('execution_connected: source === "brain",');
    const gate = src.indexOf("...gate,", connected);
    const close = src.indexOf("}),", connected);
    assert.ok(connected > 0 && gate > connected && gate < close, "the spread is the last thing in the object");
  });
});
