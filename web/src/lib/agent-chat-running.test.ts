/**
 * THE CHAT MUST NOT DENY IT IS STOPPED, AND MUST NOT QUOTE ITS FIELD NAMES.
 *
 * On 2026-10-10 a tester made a new agent that no worker ever started — the
 * orchestrator's rollout list did not name it. His chat, ordered by its prompt
 * that it was "always RUNNING" and handed `stopped: true` beside an IDLE
 * label, told him it was running and that the flag in its own state was just
 * a record. Two defects in one sentence: a running claim the facts denied, and
 * a field name said to an owner.
 *
 * What must hold now:
 *   - the dashboard prompt no longer asserts it is running, and says whether
 *     it is running is a fact in the STATE;
 *   - "not started" rests on `workerHeardFrom` alone — IDLE and `stopped` are
 *     also what a beating worker before its first pass shows;
 *   - the browser actually sends `workerHeardFrom` and the desk's own reason,
 *     and they survive the state budget;
 *   - an authenticated recovery hold still wins over both;
 *   - with no state at all (iOS, Android) the model claims neither way;
 *   - the partner prompt, which already said this, is unchanged.
 *
 * Driven through the real reply builder with a completion stub that captures
 * the request, as agent-chat-energy.test.ts does.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autonomyOf } from "@merrymen/core";
import type { FleetRecoveryView } from "../../../worker/src/fleet-recovery";
import type { LlmCreds } from "../../../worker/src/llm";
import { chatStateOf } from "../terminal/chat-payload";
import type { LiveMine } from "../terminal/live";
import { generateAgentReply, type AgentChatOptions } from "./agent-chat";
import { STATE_BUDGET } from "./chat-state";

const credentials = (): LlmCreds => ({ provider: "test", transport: "openai", baseUrl: "https://example.com/v1", model: "m", apiKey: "k", vision: false });
const recovery: FleetRecoveryView = { state: "history-only", tradingPaused: true, history: "available", memory: "unknown",
  checkedAt: 1_791_111_100, lastVerifiedHeartbeatAt: null };

async function ask(state: unknown, extra: Partial<AgentChatOptions> = {}) {
  let seen!: { system: string; prompt: string };
  await generateAgentReply(
    { message: "are you running? how do I start you?", ...(state === undefined ? {} : { state: JSON.stringify(state) }) },
    { credentials, complete: async (_c, req) => { seen = req; return "Aye."; }, ...extra },
  );
  return seen;
}
const stateOf = (prompt: string) => JSON.parse(prompt.split("STATE:\n")[1]!.split("\n\n")[0]!) as Record<string, unknown>;

/** A brand-new agent, as App.tsx builds it: never heard from, so IDLE with no reason. */
const NEW_AGENT: LiveMine = {
  name: "Example Robin", slug: "example", handle: null, owner: "you", equity: null, chg24: null, mode: null,
  statusLabel: "IDLE", moves: [], thesis: null, autonomy: autonomyOf({ mode: null, liveBlocker: null }),
  glance: { id: "custom", label: "", cashUsd: undefined }, workerHeardFrom: false,
};
const stateFor = (mine: LiveMine, stopped = true) =>
  chatStateOf({ mine, settings: { values: {} }, liveBlocker: null, perTrade: null, perDay: null, stopped });

describe("the dashboard prompt reads whether it is running instead of asserting it", () => {
  it("NO LONGER ORDERS THE MODEL TO SAY IT IS RUNNING", async () => {
    const { system } = await ask(stateFor(NEW_AGENT));
    assert.doesNotMatch(system, /always RUNNING/);
    assert.doesNotMatch(system, /You are always/i);
    assert.doesNotMatch(system, /tell them you are already running/i);
    assert.match(system, /Never claim to be always running\./);
  });

  it("keeps the no-button rule and the tester it was written for", async () => {
    const { system } = await ask(stateFor(NEW_AGENT));
    assert.match(system, /THERE IS NO START, STOP, PAUSE OR RESUME BUTTON, AND YOU MUST NEVER SEND THEM LOOKING FOR ONE/);
    assert.match(system, /"go to his profile and click start or resume"/);
  });

  it("says running is a fact in the STATE, and what each answer of it means", async () => {
    const { system } = await ask(stateFor(NEW_AGENT));
    assert.match(system, /WHETHER YOU ARE RUNNING IS A FACT IN YOUR STATE, NEVER A GIVEN/);
    // Not started: plainly, not theirs to switch on, and no invented remedy.
    assert.match(system, /`workerHeardFrom` false — you have NOT started yet/);
    assert.match(system, /"I haven't started yet"/);
    assert.match(system, /it is not something they switch on: new agents are started automatically/);
    assert.match(system, /Do NOT invent a cause or a remedy/);
    assert.match(system, /Tell them to fund, re-sign or turn anything on only when the STATE itself shows that cause/);
    // Started, not trading: the reason only from the STATE.
    assert.match(system, /"I'm not trading right now"/);
    assert.match(system, /give a reason only when the STATE gives one: `liveBlocker` \(below\), `workerReason`, the ENERGY block or a RECOVERY block/);
    // The reviewer's case: IDLE before the first pass is not "not started".
    assert.match(system, /`stopped` true or IDLE ALONE NEVER MEANS YOU HAVE NOT STARTED/);
    assert.match(system, /Only `workerHeardFrom` false means not started/);
    // Unknown, including no STATE at all: neither claim.
    assert.match(system, /`workerHeardFrom` missing or null, or no STATE at all — you cannot see whether you have started/);
  });

  it("SAYS WHAT A FIELD MEANS, NEVER ITS NAME — near the top, ahead of the rules that name fields", async () => {
    const { system } = await ask(stateFor(NEW_AGENT));
    const rule = system.indexOf("SAY WHAT A FIELD MEANS, NEVER ITS NAME");
    assert.ok(rule > 0, "the rule is in the prompt");
    assert.ok(rule < system.indexOf("THERE IS NO START, STOP, PAUSE OR RESUME BUTTON"), "and it comes before the first backticked field");
    assert.ok(rule < system.indexOf("`"), "no field name is shown to the model before it is told not to repeat one");
    assert.match(system, /Never put a field name, a raw true, false or null, a blocker code or any JSON in a reply/);
    assert.match(system, /The command line that ends a proposal is the only place such names belong/);
    // The one switch it must name is a screen label, so it is quoted, not backticked.
    assert.ok(!system.includes("`Live trading`"), "Live trading is said to owners, so it is not marked as a field");
    assert.match(system, /Say "Live trading is off"/);
  });
});

describe("the browser sends the fact, and the server keeps it", () => {
  it("A NEW AGENT REACHES THE PROMPT AS NEVER HEARD FROM, with no invented reason", async () => {
    const state = stateFor(NEW_AGENT);
    assert.equal(state.workerHeardFrom, false);
    assert.equal(state.workerReason, null, "IDLE with nothing blocking has no reason to give");
    const seen = stateOf((await ask(state)).prompt);
    assert.equal(seen.workerHeardFrom, false);
    assert.equal(seen.workerReason, null);
    assert.equal(seen.stopped, true);
  });

  it("a beating worker that went quiet carries the desk's own sentence for it", async () => {
    const quiet = { ...NEW_AGENT, workerHeardFrom: true, statusLabel: "NOT RUNNING",
      autonomy: autonomyOf({ mode: "live", liveBlocker: null, workerSilentSince: 1_791_000_000 }) };
    const seen = stateOf((await ask(stateFor(quiet))).prompt);
    assert.equal(seen.workerHeardFrom, true);
    assert.match(String(seen.workerReason), /has not reported since/);
  });

  it("a screen that never said is unknown, not never-started", () => {
    const { workerHeardFrom: _drop, ...unsaid } = NEW_AGENT;
    assert.equal(stateFor(unsaid).workerHeardFrom, null);
  });

  it("SURVIVES THE STATE BUDGET: the tape is cut, the fact is not", async () => {
    const moves: LiveMine["moves"] = Array.from({ length: 8 }, (_, i) => ({
      name: "Example Robin", slug: "example", handle: null, action: "buy" as const, symbol: "TSLA", sizeUsdg: 5,
      reason: "r".repeat(400), paper: false, head: "refused", at: 1_791_000_000 - i * 60, outcome: "refused" as const,
      outcomeText: "o".repeat(1_000),
    }));
    const full = stateFor({ ...NEW_AGENT, moves });
    assert.ok(JSON.stringify(full).length > STATE_BUDGET, "the fixture must overflow the budget to test anything");
    const { prompt } = await ask(full);
    const raw = prompt.split("STATE:\n")[1]!.split("\n\n")[0]!;
    assert.ok(raw.length <= STATE_BUDGET);
    const seen = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(seen.truncated, true);
    assert.equal(seen.workerHeardFrom, false);
    assert.equal(seen.workerReason, null);
  });
});

describe("an authenticated recovery hold still answers instead", () => {
  it("THE SERVER CLEARS BOTH FIELDS UNDER A HOLD, whatever the browser sent", async () => {
    const { prompt, system } = await ask({ ...stateFor(NEW_AGENT), workerReason: "the account holds no USDG to trade with" }, { recovery });
    const seen = stateOf(prompt);
    assert.equal(seen.workerHeardFrom, null, "a hold is not 'never started'");
    assert.equal(seen.workerReason, null, "a hold is not the old remedy");
    assert.equal(seen.workerStatus, "Trading paused for recovery");
    assert.equal(seen.stopped, true);
    assert.match(system, /AUTHENTICATED RECOVERY OVERRIDES THE ORDINARY RUNNING AND REMEDY RULES ABOVE/);
  });

  it("and the browser never builds them for a held agent either", () => {
    const held = stateFor({ ...NEW_AGENT, workerHeardFrom: true, recovery,
      autonomy: autonomyOf({ mode: "paper", liveBlocker: "no-cash", realCashUsd: 0 }) }, false);
    assert.equal(held.workerHeardFrom, null);
    assert.equal(held.workerReason, null);
    assert.equal(held.stopped, true);
  });
});

describe("with no state at all — the iOS and Android chats", () => {
  it("THE PROMPT CARRIES NO STATE, and the rule for that case is in front of the model", async () => {
    const { prompt, system } = await ask(undefined);
    assert.doesNotMatch(prompt, /STATE:/);
    assert.match(system, /or no STATE at all — you cannot see whether you have started\. Say you can't see that from here and claim neither/);
  });
});

describe("the partner prompt is unchanged", () => {
  it("KEEPS ITS OWN HONEST RULE, AND GAINS NONE OF THE DASHBOARD'S", async () => {
    const { system } = await ask(stateFor(NEW_AGENT), { surface: "partner" });
    assert.match(system, /workerStatus is authoritative: awaiting_grant means no signed trading permission; starting means no heartbeat yet; stale means the last heartbeat is old and you cannot claim to be running now; running means a recent heartbeat, not a promise of trades\./);
    assert.match(system, /Do not claim to be always running\./);
    for (const dashboard of ["WHETHER YOU ARE RUNNING IS A FACT", "SAY WHAT A FIELD MEANS", "workerHeardFrom", "THERE IS NO START"]) {
      assert.ok(!system.includes(dashboard), `the partner prompt must not carry "${dashboard}"`);
    }
  });
});
