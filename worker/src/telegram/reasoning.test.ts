/**
 * A REASONING MODEL'S THINKING IS NOT AN ANSWER, AND A NUMBER IS NOT A TRADE.
 *
 * Reasoning models spend the completion budget on chain-of-thought and then
 * hand back either an empty `content` or the thought itself. The owner saw
 * `Here's a thinking process…` in Telegram, or a reply truncated to `Draft: "I`.
 *
 * The fix has two halves and only one of them is universal, which is the thing
 * these tests exist to keep straight:
 *
 *   UNIVERSAL   the response side. `llm.ts` reads the answer out of `content`
 *               and discards `reasoning_content` / `reasoning` outright. No
 *               model list, nothing to keep up to date, cannot be wrong.
 *   BEST EFFORT the request side. `quietReasoning` asks the provider not to
 *               produce it, and there is no portable way to ask — so it is a
 *               model list, it is allowed to be incomplete, and it must never
 *               be the thing the correctness depends on.
 *
 * The second half of this file is about what the original change ALSO carried,
 * which had nothing to do with reasoning: a mechanism where a message
 * consisting of "5" became a live buy, with the ticker guessed from an earlier
 * message and the side resolved by which of "buy" or "sell" appeared in it.
 * That is removed, and this is what stops it coming back.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { stripThinkingBlock } from "./interpreter";
import { quietReasoning } from "../llm";

const at = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
/** Source with comments removed — these files describe at length what they refuse to do. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const creds = (model: string) =>
  ({ provider: "groq", transport: "openai", baseUrl: "https://x/v1", apiKey: "k", model }) as Parameters<
    typeof quietReasoning
  >[0];

describe("asking a model to keep its thinking to itself", () => {
  it("only the reasoning families are asked, and every family is", () => {
    for (const m of [
      "openai/gpt-oss-120b",
      "deepseek-r1-distill-llama-70b",
      "Qwen3-Thinking-30B",
      "nvidia/nemotron-4-340b",
    ]) {
      assert.deepEqual(
        quietReasoning(creds(m)),
        { reasoning_effort: "none", include_reasoning: false },
        `${m} should be asked to stay quiet`,
      );
    }
  });

  it("an ordinary model's request is left exactly as it was", () => {
    // The request body reaches every provider including the classifier's. An
    // unknown key there is one strict-schema provider away from a 400 that
    // takes the whole natural-language surface down.
    for (const m of ["llama-3.3-70b-versatile", "gpt-4o-mini", "claude-sonnet-5", "gemini-2.0-flash"]) {
      assert.deepEqual(quietReasoning(creds(m)), {}, `${m} must get no extra fields`);
    }
  });

  it("REGRESSION: `extra_body` is not a wire field and is not sent", () => {
    // It is a python-SDK convenience the SDK unwraps before sending. Posted as
    // JSON it is an unknown key, so `include_reasoning: false` nested inside it
    // was never actually sent to anybody.
    const sent = quietReasoning(creds("openai/gpt-oss-120b"));
    assert.ok(!("extra_body" in sent), "extra_body reaches no provider");
    assert.equal(sent.include_reasoning, false, "the field is sent where it actually lives");
    assert.ok(!code(at("../llm.ts")).includes("extra_body"), "and it is gone from the source");
  });

  it("INVARIANT: the answer never comes from the reasoning channel", () => {
    const src = code(at("../llm.ts"));
    // The discard is what makes the response side universal. If anything ever
    // appends reasoning to content, the model list above stops being an
    // optimisation and becomes the only defence.
    assert.ok(
      !/content\s*\+[=\s]*.*reasoning/i.test(src),
      "reasoning must never be concatenated into content",
    );
    assert.match(src, /reasoning_content/, "but it is read, so an answer-less reply can be detected");
  });
});

describe("thinking that arrives inside `content` anyway", () => {
  it("strips a closed block, both spellings, anywhere", () => {
    assert.equal(stripThinkingBlock("<think>plotting</think>the answer"), "the answer");
    assert.equal(stripThinkingBlock("<|think|>plotting<|/think|>the answer"), "the answer");
    assert.equal(stripThinkingBlock("before <think>mid\nline</think> after"), "before  after");
  });

  it("REGRESSION: an unterminated opener takes everything after it", () => {
    // The common real case: the model runs out of budget mid-thought, so there
    // is no closing tag and the paired rules match nothing.
    assert.equal(stripThinkingBlock("<think>The user is asking about"), "");
    assert.equal(stripThinkingBlock("here you go <think>but actually"), "here you go");
  });

  it("a message that was entirely thinking becomes nothing at all", () => {
    assert.equal(stripThinkingBlock("<think>all of it</think>"), "");
    assert.equal(stripThinkingBlock("   "), "");
    assert.equal(stripThinkingBlock(""), "");
  });

  it("ordinary text is untouched", () => {
    assert.equal(stripThinkingBlock("bought 5 USDG of NVDA"), "bought 5 USDG of NVDA");
    assert.equal(stripThinkingBlock("I think NVDA is fine"), "I think NVDA is fine");
  });

  it("INVARIANT: the send path fails closed, not open", () => {
    // It was `strippedReply || reply` — so a reply that was ENTIRELY thinking
    // stripped to "" and the raw thinking went out instead, in exactly the case
    // the strip exists for.
    const src = code(at("./service.ts"));
    assert.ok(
      !/strippedReply\s*\|\|\s*reply\b/.test(src),
      "a fully-stripped reply must not fall back to the unstripped one",
    );
    assert.match(at("./service.ts"), /came back as reasoning with no answer in it/);
  });
});

describe("a bare number is not a trade", () => {
  const service = at("./service.ts");

  it("INVARIANT: no chat-keyed ask-amount context exists", () => {
    // The removed mechanism, by name and by shape. It let "5" become a live buy
    // with no confirmation, primed by regex-matching the bot's own outbound
    // prose, keyed by chat rather than sender, with no expiry.
    assert.ok(!/askAmountCtx/.test(service), "askAmountCtx must not return");
    assert.ok(
      !/pendingAsk/.test(service),
      "nor the variable that read it",
    );
  });

  it("INVARIANT: no command is ever built from a bare-number match", () => {
    const src = code(service);
    const i = src.indexOf("bareMatch");
    assert.ok(i > 0, "the bare-number branch must still exist — it is what keeps the LLM out of it");
    const branch = src.slice(i, i + 700);
    assert.match(branch, /kind: "chat"/, "it answers with a nudge");
    for (const kind of ['kind: "buy"', 'kind: "sell"', 'kind: "transfer"', "pendingAsk.side"]) {
      assert.ok(!branch.includes(kind), `a bare number must not produce ${kind}`);
    }
  });

  it("INVARIANT: a ticker is never derived from prose", () => {
    const src = code(service);
    // The removed heuristic took the first 1-6 letter word of an earlier
    // message and stoplisted the obvious ones. Nothing in this repo should
    // resolve a symbol that way — that is what the typed Command enum is for.
    assert.ok(!/\["BUY", "SELL", "TELL"/.test(src), "the stoplist heuristic is gone");
    assert.ok(
      !/\/sell\/i\.test\([a-zA-Z]+\)\s*\?\s*"sell"/.test(src),
      "and so is the side-from-substring guess",
    );
  });

  it("INVARIANT: capability questions answer from HELP_TEXT, not from memory", () => {
    // What the agent can actually do depends on this deployment's settings, and
    // only HELP_TEXT knows it. A model answering in its own words promises
    // powers the owner may not have enabled.
    const interp = at("./interpreter.ts");
    const i = interp.indexOf("Capability questions");
    assert.ok(i > 0, "the classifier must still be told what to do with them");
    const rule = interp.slice(i, i + 400);
    assert.match(rule, /kind "help"/);
    assert.ok(!/kind "chat"/.test(rule), "they must not be answered in the model's own voice");
  });
});

describe("the stored soul header is scrubbed by this agent's own name", () => {
  it("INVARIANT: no tenant's name is hardcoded into the scrub", () => {
    const src = at("./service.ts");
    assert.ok(!/mr rex/i.test(src), "the scrub was pinned to one deployment's agent name");
    assert.match(src, /function soulHeaderRe/, "it is built from getName() instead");
    assert.match(src, /escapeRe\(getName\(\)\)/, "and the name is escaped before it enters a RegExp");
  });

  it("INVARIANT: a turn that scrubs to nothing is dropped, not restored", () => {
    const src = code(at("./service.ts"));
    assert.ok(
      !/content: c \|\| t\.content/.test(src),
      "restoring the unscrubbed text is the one case the scrub exists for",
    );
    assert.match(src, /filter\(\(t\) => t\.content\.length > 0\)/);
  });
});
