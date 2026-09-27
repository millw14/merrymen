/**
 * THE CHAT KNOWS ITS ENERGY FROM ITS WORKER, AND NEVER TYPES AN ADDRESS.
 *
 * Energy reaches the chat as a block the SERVER adds — the worker's own report
 * read from the agents row — never as something the browser sends: the web's
 * `state` is the browser's account of things, and iOS sends no state at all.
 * What must hold:
 *
 *   - with a report, the prompt carries the ENERGY block, marked as the
 *     worker's and authoritative; without one there is no block, and the model
 *     is told to say it cannot see its energy rather than guess;
 *   - the block carries NO ADDRESS. A model that retypes one can get one
 *     character wrong, and tokens sent there are gone for good — so the rule
 *     says never type one, and the data gives it none to type;
 *   - an unread count stays null in the block, never 0;
 *   - the prompt no longer says money cannot fix the Circle lock, and it says
 *     $MERRYMEN is energy and nothing more;
 *   - /api/chat reads the report itself, for the caller's own agent.
 *
 * Driven through the real reply builder with a completion stub that captures
 * the request, the way agent-chat-stream.test.ts drives it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { EnergyStatus } from "@merrymen/core";
import type { LlmCreds } from "../../../worker/src/llm";
import { energyForPrompt, generateAgentReply, type AgentChatOptions } from "./agent-chat";

const credentials = (): LlmCreds => ({ provider: "test", transport: "openai", baseUrl: "https://example.com/v1", model: "m", apiKey: "k", vision: false });

const REPORT: EnergyStatus = {
  v: 1,
  gated: true,
  mode: "enforce",
  level: "low",
  agentTokens: 2_000,
  holderTokens: null,
  needTokens: 100_000,
  day: "2026-09-27",
  resetsAt: 1_790_553_600,
  reviews: { used: 3, allowed: 3 },
  entries: { used: 2, allowed: 2 },
  spent: true,
  buy: "ready",
  estimateUsdg: 37,
  at: 1_790_500_000,
};

async function ask(message: string, extra: Partial<AgentChatOptions> = {}) {
  let seen: { system: string; prompt: string } | undefined;
  const complete: AgentChatOptions["complete"] = async (_creds, req) => {
    seen = { system: req.system, prompt: req.prompt };
    return "Right you are.";
  };
  const out = await generateAgentReply(
    { message, state: { name: "Robin", smartAccount: "0x" + "c".repeat(40) } },
    { credentials, complete, ...extra },
  );
  assert.equal(out.reply, "Right you are.");
  return seen!;
}

describe("the ENERGY block", () => {
  it("IS THERE WITH A REPORT, marked as the worker's own", async () => {
    const { prompt } = await ask("why are you quiet?", { energy: { ...REPORT, ceilingUsdg: 25 } });
    assert.match(prompt, /ENERGY \(your worker's own report — authoritative\):/);
    const block = JSON.parse(prompt.split("ENERGY (your worker's own report — authoritative):\n")[1]!.split("\n")[0]!);
    assert.equal(block.spent, true);
    assert.equal(block.level, "low");
    assert.equal(block.buy, "ready");
    assert.equal(block.estimateUsdg, 37);
    assert.equal(block.ceilingUsdg, 25, "the one figure the model may size a proposal against");
    assert.equal(block.holderTokens, null, "an unread count stays null, never 0");
    assert.equal(block.resetsAt, new Date(REPORT.resetsAt * 1000).toISOString(), "a time, not a bare epoch");
  });

  it("AND IS ABSENT WITHOUT ONE — the model says it cannot see, rather than guessing", async () => {
    const { prompt } = await ask("why are you quiet?");
    assert.doesNotMatch(prompt, /ENERGY \(/);
    const none = await ask("why are you quiet?", { energy: null });
    assert.doesNotMatch(none.prompt, /ENERGY \(/);
  });

  it("CARRIES NO ADDRESS — not from the report, not smuggled in beside it", async () => {
    const polluted = { ...REPORT, ceilingUsdg: 25, holder: "0x" + "a".repeat(40), account: "0x" + "b".repeat(40) } as never;
    const { prompt } = await ask("what's my address?", { energy: polluted });
    const block = prompt.split("ENERGY (your worker's own report — authoritative):\n")[1]!.split("\n")[0]!;
    assert.doesNotMatch(block, /0x[0-9a-fA-F]{40}/, "the block is a whitelist, not a spread");
    assert.doesNotMatch(JSON.stringify(energyForPrompt(polluted)), /0x/);
  });

  it("THE PARTNER SURFACE GETS NONE — its prompt already says unavailable is unavailable", async () => {
    const { prompt } = await ask("energy?", { surface: "partner", energy: { ...REPORT, ceilingUsdg: 25 } });
    assert.doesNotMatch(prompt, /ENERGY \(/);
  });
});

describe("what the model is told", () => {
  it("IT SAYS WHAT TO DO WITHOUT A BLOCK, AND NEVER TO TYPE AN ADDRESS", async () => {
    const { system } = await ask("hello");
    assert.match(system, /If there is NO ENERGY block/);
    assert.match(system, /NEVER TYPE AN ADDRESS/);
    assert.match(system, /Propose show-address or open-deposit/);
  });

  it("$MERRYMEN IS ENERGY, NOTHING MORE — no price talk, and changing nothing is a fine answer", async () => {
    const { system } = await ask("hello");
    assert.match(system, /\$MERRYMEN IS ENERGY, NOTHING MORE/);
    assert.match(system, /changing nothing is a fine answer/);
  });

  it("THE DOORS STAY OPEN — exits and the owner's own orders are never limited, and it says so", async () => {
    const { system } = await ask("hello");
    assert.match(system, /Selling, stop-losses, take-profits and your owner's own orders are NEVER limited by it/);
    assert.match(system, /never that they hold nothing; a null count is unknown, not zero/);
  });

  it("MONEY CAN FIX THE CIRCLE LOCK NOW, so the prompt stops saying it cannot", async () => {
    const { system } = await ask("hello");
    assert.doesNotMatch(system, /no amount of money fixes it/);
    assert.doesNotMatch(system, /no matter how well funded/);
    assert.match(system, /between them, and below that the strategy stays idle however much USDG you hold — USDG only changes it once it has been turned into \$MERRYMEN \(get-energy\)/);
  });

  it("PAPER NEVER BUYS IT, AND THE PRACTICE ANSWER IS UNCHANGED", async () => {
    const { system } = await ask("hello");
    assert.match(system, /If `buy` is "paper" you will not spend real USDG while practising — say so and do not propose it/);
    // The consent copy an owner already confirmed stays true: Paper mode is not
    // something money changes.
    assert.match(system, /money will NOT change it/);
  });

  it("\"GET YOUR MERRYMEN\" MAPS TO get-energy, and the spec names its one argument", async () => {
    const { system } = await ask("hello");
    assert.match(system, /"get your merrymen" \/ "top up your energy" \/ "buy the tokens you need" → get-energy/);
    assert.match(system, /get-energy \{usdgAmount\}/);
    assert.match(system, /today's energy is spent \(the ENERGY block says so\)/);
  });
});

describe("/api/chat injects it on the server", () => {
  const ROUTE = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

  it("READS THE REPORT FOR THE CALLER'S OWN AGENT", () => {
    assert.match(ROUTE, /readAgentEnergy\(/);
    assert.match(ROUTE, /hosted \? await hostedAgentFor\(req\) : await diskAgent\(\)/, "the caller cannot name the agent");
    assert.match(ROUTE, /ceilingFor\(req, hosted\)/);
    assert.match(ROUTE, /agentReplyResponse\(body, \{ stream, signal: req\.signal \}, \{ energy \}\)/);
  });

  it("AND NEVER FROM THE BODY", () => {
    assert.ok(!/body\.energy|body\.state\.energy/.test(ROUTE), "a client must not be able to write the worker's report");
  });
});
