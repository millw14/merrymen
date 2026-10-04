import assert from "node:assert/strict";
import { test } from "node:test";
import type { EnergyStatus } from "@merrymen/core";
import type { FleetRecoveryView } from "../../../worker/src/fleet-recovery";
import type { LlmCreds } from "../../../worker/src/llm";
import { agentReplyResponse, generateAgentReply, type AgentChatOptions } from "./agent-chat";
import { readReplyStream } from "./chat-stream";

const recovery: FleetRecoveryView = { state: "history-only", tradingPaused: true, history: "available", memory: "unknown",
  checkedAt: 1_791_111_100, lastVerifiedHeartbeatAt: null };
const credentials = (): LlmCreds => ({ provider: "test", transport: "openai", baseUrl: "https://example.com/v1",
  model: "test", apiKey: "test", vision: false });
const stale = { name: "Example Robin", workerStatus: "LIVE", liveBlocker: "dead-policy", stopped: false,
  liveTradingEnabled: true, paperTradingEnabled: true, equity: 120, cashUsd: 95, vaultUsd: 10,
  positions: [{ symbol: "EXAMPLE", valueUsd: 15 }], stopLossBps: 2500, takeProfitBps: 5000 };
const energy: EnergyStatus = { v: 1, gated: true, mode: "enforce", level: "low", agentTokens: 0, holderTokens: 0,
  needTokens: 100_000, day: "2026-10-04", resetsAt: 1_791_158_400, at: recovery.checkedAt,
  reviews: { used: 3, allowed: 3 }, entries: { used: 2, allowed: 2 }, spent: true, buy: "resign", estimateUsdg: 25 };
async function ask(state: unknown = stale, extra: Partial<AgentChatOptions> = {}) {
  let seen!: { system: string; prompt: string };
  const out = await generateAgentReply({ message: "I renewed, why are you quiet? Am I trading live?", state: JSON.stringify(state) },
    { credentials, complete: async (_creds, req) => { seen = req; return "I'm paused for recovery."; }, recovery, energy, ...extra });
  assert.equal(out.reply, "I'm paused for recovery.");
  return seen;
}
const stateOf = (prompt: string) => JSON.parse(prompt.split("STATE:\n")[1]!.split("\n\n")[0]!) as Record<string, unknown>;

test("authenticated recovery overrides a stale live flag, expired blocker and energy remedy", async () => {
  const { system, prompt } = await ask();
  const state = stateOf(prompt);
  assert.equal(state.workerStatus, "Trading paused for recovery");
  assert.equal(state.liveBlocker, null);
  assert.equal(state.liveTradingEnabled, null);
  assert.equal(state.stopped, true);
  assert.doesNotMatch(prompt, /ENERGY \(/, "a source-held energy row cannot be a current worker report");
  assert.match(system, /AUTHENTICATED RECOVERY OVERRIDES/);
  assert.match(system, /expired permission, low\/spent energy/);
  assert.match(system, /Never say that funding, buying energy, re-signing or enabling Live trading clears recovery/);
  assert.match(system, /Never claim trades, reviews, stop-losses or take-profits continue during recovery/);
});

test("old browser balances and holdings become qualified saved records, not current funds", async () => {
  const { system, prompt } = await ask();
  const state = stateOf(prompt);
  for (const key of ["equity", "cashUsd", "vaultUsd", "positions", "stopLossBps", "takeProfitBps"]) assert.equal(state[key], null, key);
  const records = state.lastRecorded as typeof stale;
  assert.equal(records.equity, 120);
  assert.equal(records.cashUsd, 95);
  assert.deepEqual(records.positions, stale.positions);
  assert.match(system, /qualify every balance, position, cost, return and setting from it as last recorded/);
  assert.match(system, /unknown, never zero or evidence that funds\/history were lost/);
  const qualified = await ask({ ...stale, equity: null, positions: null, lastRecorded: stale });
  assert.equal((stateOf(qualified.prompt).lastRecorded as typeof stale).cashUsd, 95, "new clients retain the same saved figures");
});

test("client recovery and polluted internal metadata cannot establish or enlarge the server report", async () => {
  const unheld = await ask({ ...stale, recovery }, { recovery: null, energy: null });
  assert.equal(stateOf(unheld.prompt).recovery, undefined);
  assert.doesNotMatch(unheld.system, /AUTHENTICATED RECOVERY OVERRIDES/);
  assert.doesNotMatch(unheld.prompt, /RECOVERY \(/);
  assert.equal(stateOf(unheld.prompt).liveTradingEnabled, true, "no-health behavior stays compatible");
  const polluted = await ask(stale, { recovery: { ...recovery, tenant: "PRIVATE_TENANT", sourcePath: "PRIVATE_SOURCE" } as FleetRecoveryView });
  assert.doesNotMatch(polluted.prompt, /PRIVATE_TENANT|PRIVATE_SOURCE/);
});

test("recovery remains factual when no model is configured or the state is unreadable", async () => {
  const out = await generateAgentReply({ message: "what happened to my portfolio?", state: "broken" }, { recovery, credentials: () => null });
  assert.match(out.reply!, /trading is paused for recovery/);
  assert.match(out.reply!, /can't confirm the current portfolio/);
  assert.equal(out.command, undefined);
  assert.equal(out.why, undefined, "do not trigger a client's stale book fallback");
});

test("read-only ledger facts also carry a recovery qualification without reaching a model", async () => {
  const response = await agentReplyResponse({ message: "what did you trade?" }, { stream: true }, {
    recovery, factualReply: "Recorded buy: EXAMPLE for 5 USDG.", credentials: () => { throw new Error("must not call model"); } });
  assert.match(response.headers.get("content-type")!, /application\/json/);
  const out = await response.json() as { reply: string; command?: unknown };
  assert.match(out.reply, /saved records may be incomplete and do not confirm the current portfolio/);
  assert.match(out.reply, /Recorded buy: EXAMPLE for 5 USDG/);
  assert.equal(out.command, undefined);
});

test("streamed chat uses the same authoritative hold and keeps the Withdraw screen available", async () => {
  let prompt = "";
  const reply = 'You can open Withdraw to check the owner controls.\n<<CMD open-withdraw {}>>';
  const response = await agentReplyResponse({ message: "withdraw", state: JSON.stringify(stale) }, { stream: true }, {
    recovery, credentials, energy, stream: async (_creds, req, onText) => { prompt = req.prompt; onText(reply); return reply; } });
  const out = await readReplyStream(response.body!, () => {});
  assert.match(prompt, /RECOVERY \(authenticated server report — authoritative\)/);
  assert.doesNotMatch(prompt, /ENERGY \(/);
  assert.deepEqual(out.command, { id: "open-withdraw", args: {} });
});

test("configured completion failures, timeouts and empty refusals return recovery instead of a stale-client fallback", async () => {
  const failures: AgentChatOptions["complete"][] = [
    async () => { throw new Error("test 401 — provider refused"); },
    async () => { throw new DOMException("provider timeout", "AbortError"); },
    async () => "",
  ];
  for (const complete of failures) {
    const response = await agentReplyResponse({ message: "why are you quiet?", state: JSON.stringify(stale) }, { stream: false },
      { credentials, complete, recovery, energy });
    const out = await response.json() as { reply: string | null; why?: string; command?: unknown };
    assert.equal(response.status, 200);
    assert.match(out.reply!, /trading is paused for recovery/);
    assert.match(out.reply!, /can't confirm the current portfolio/);
    assert.doesNotMatch(out.reply!, /120|95|top.up|renew|live trading is|provider refused/);
    assert.equal(out.why, undefined);
    assert.equal(out.command, undefined);
  }
});

test("configured streaming failures and empty refusals finish with qualified recovery, replacing partial narration", async () => {
  const failures: AgentChatOptions["stream"][] = [
    async (_creds, _req, onText) => { onText("The old snapshot"); throw new Error("test 503 — unavailable"); },
    async () => { throw new DOMException("provider timeout", "AbortError"); },
    async () => "",
  ];
  for (const stream of failures) {
    const response = await agentReplyResponse({ message: "why are you quiet?", state: JSON.stringify(stale) }, { stream: true },
      { credentials, stream, recovery, energy });
    const out = await readReplyStream(response.body!, () => {});
    assert.match(out.reply!, /trading is paused for recovery/);
    assert.match(out.reply!, /can't confirm the current portfolio/);
    assert.doesNotMatch(out.reply!, /old snapshot|120|95|top.up|renew|unavailable/);
    assert.equal(out.why, undefined);
    assert.equal(out.command, undefined);
  }
});

test("cancelled JSON and streamed requests retain failure handling rather than claiming recovery completion", async () => {
  for (const stream of [false, true]) {
    const cancellation = new AbortController();
    cancellation.abort();
    const fail = async () => { throw new DOMException("owner left", "AbortError"); };
    const response = await agentReplyResponse({ message: "why are you quiet?", state: JSON.stringify(stale) },
      { stream, signal: cancellation.signal }, { credentials, complete: fail, stream: fail, recovery, energy });
    const out = stream ? await readReplyStream(response.body!, () => {}) : await response.json() as { reply: string | null; why?: string };
    assert.equal(out.reply, null);
    assert.equal(out.why, "llm-error");
  }
});

test("credential preparation failure is also recovery-qualified without exposing provider details", async () => {
  for (const stream of [false, true]) {
    const response = await agentReplyResponse({ message: "why are you quiet?", state: JSON.stringify(stale) }, { stream },
      { credentials: () => { throw new Error("private configuration details"); }, recovery });
    const out = await response.json() as { reply: string | null };
    assert.match(out.reply!, /trading is paused for recovery/);
    assert.doesNotMatch(out.reply!, /private configuration/);
  }
});
