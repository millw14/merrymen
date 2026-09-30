/**
 * THE CHAT'S REPLY, STREAMED — AND THE SAME FAILURES STILL FAIL.
 *
 * `llmTextStream` is llmText a piece at a time, added so the owner's chat can
 * show the agent's words as they are written instead of after the slowest
 * completion. It is ADDITIVE: llmText and every other caller are untouched.
 * What it must keep from llmText is everything that made llmText honest —
 * reasoning never reaches the reply, an empty completion is an error rather
 * than an answer, a provider that refuses the reasoning hint is asked again
 * without it, and a provider's refusal arrives in its own words.
 *
 * Driven against a local server that speaks each provider's real wire format,
 * cutting its events at awkward places (mid-line, mid-JSON), because that is
 * what a network does.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";

import { llmTextStream, resetReasoningRefusalsForTest, type LlmCreds } from "./llm";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
}

/** OpenAI-compatible stream chunks for these deltas. */
const oa = (deltas: Record<string, unknown>[], finish = "stop") =>
  [
    ...deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: d, finish_reason: null }] })}\n\n`),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");

/** Write `text` in pieces of `n` bytes, so no event arrives whole. */
async function dribble(res: ServerResponse, text: string, n = 7) {
  for (let i = 0; i < text.length; i += n) {
    res.write(text.slice(i, i + n));
    await new Promise((r) => setImmediate(r));
  }
  res.end();
}

let handler: (body: Record<string, unknown>, res: ServerResponse, req: IncomingMessage) => Promise<void> | void;
const seen: Record<string, unknown>[] = [];
let server: Server;
let port = 0;

before(async () => {
  server = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    seen.push(body);
    await handler(body, res, req);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  seen.length = 0;
  resetReasoningRefusalsForTest();
});

const openai = (model = "llama-3.3-70b"): LlmCreds => ({
  provider: "groq",
  transport: "openai",
  baseUrl: `http://127.0.0.1:${port}/v1`,
  apiKey: "gsk_secret_value_123",
  model,
  vision: false,
});

async function collect(creds: LlmCreds, signal?: AbortSignal) {
  const pieces: string[] = [];
  const text = await llmTextStream(creds, { system: "s", prompt: "p", signal }, (p) => pieces.push(p));
  return { text, pieces };
}

describe("an OpenAI-compatible provider", () => {
  it("STREAMS THE CONTENT, piece by piece, and returns the whole reply", async () => {
    handler = async (_b, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      await dribble(res, oa([{ content: "Hello" }, { content: " there," }, { content: " owner." }]));
    };
    const { text, pieces } = await collect(openai());
    assert.equal(text, "Hello there, owner.");
    assert.equal(pieces.join(""), "Hello there, owner.");
    assert.ok(pieces.length >= 3, "it arrived in pieces, not at the end");
    assert.equal(seen[0]!.stream, true, "the provider was asked to stream");
  });

  it("REASONING NEVER REACHES THE REPLY — neither the side channel nor inline", async () => {
    handler = async (_b, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      await dribble(
        res,
        oa([{ reasoning_content: "I should say buy" }, { reasoning: "definitely buy" }, { content: "<think>hmm</think>" }, { content: "Holding for now." }]),
      );
    };
    const { text, pieces } = await collect(openai());
    assert.equal(text, "Holding for now.");
    assert.ok(!pieces.join("").includes("should say buy"), "the side channel is never content");
    assert.ok(!pieces.join("").includes("definitely"), "the side channel is never content");
  });

  it("AN EMPTY COMPLETION IS A FAILURE, and says why", async () => {
    handler = async (_b, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      await dribble(res, oa([{ reasoning_content: "thinking thinking" }], "length"));
    };
    await assert.rejects(collect(openai()), /ran out of tokens before writing a reply/);
  });

  it("a provider that refuses the reasoning hint is asked again without it", async () => {
    handler = async (b, res) => {
      if ("reasoning_effort" in b) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "`reasoning_effort` must be one of `low`, `medium`, or `high`" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      await dribble(res, oa([{ content: "ok" }]));
    };
    const { text } = await collect(openai("openai/gpt-oss-120b"));
    assert.equal(text, "ok");
    assert.equal(seen.length, 2);
    assert.ok("reasoning_effort" in seen[0]!);
    assert.ok(!("reasoning_effort" in seen[1]!));
  });

  it("A REFUSAL ARRIVES IN THE PROVIDER'S OWN WORDS, with the key redacted", async () => {
    handler = (_b, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "invalid_api_key", message: "Invalid API Key gsk_secret_value_123" } }));
    };
    await assert.rejects(collect(openai()), (e: Error) => {
      assert.match(e.message, /^groq 401 — invalid_api_key: Invalid API Key/);
      assert.ok(!e.message.includes("gsk_secret_value_123"), "the key must not reach a browser");
      return true;
    });
  });

  it("an error in the middle of the stream is an error, not a short reply", async () => {
    handler = async (_b, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      await dribble(res, `data: ${JSON.stringify({ choices: [{ delta: { content: "Yes, I'd sell" } }] })}\n\ndata: ${JSON.stringify({ error: { message: "overloaded" } })}\n\n`);
    };
    await assert.rejects(collect(openai()), /overloaded/);
  });

  it("A STREAM THAT STOPS SHORT IS NOT A REPLY — no finish, no [DONE], no answer", async () => {
    // A connection that drops mid-reply ends the body like any other end. The
    // half that arrived was returned as the whole, and the chat then sent it
    // as `done`: half a sentence about somebody's money, presented as final.
    handler = async (_b, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      await dribble(res, `data: ${JSON.stringify({ choices: [{ delta: { content: "Yes, I'd sell" }, finish_reason: null }] })}\n\n`);
    };
    await assert.rejects(collect(openai()), /ended before the reply was finished/);
  });

  it("a stream that says it finished is whole even without [DONE]", async () => {
    handler = async (_b, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      await dribble(
        res,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "All done." }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
    };
    assert.equal((await collect(openai())).text, "All done.");
  });

  it("a provider that ignores `stream` and answers JSON is still read", async () => {
    handler = (_b, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "Whole reply." }, finish_reason: "stop" }] }));
    };
    const { text, pieces } = await collect(openai());
    assert.equal(text, "Whole reply.");
    assert.deepEqual(pieces, ["Whole reply."]);
  });

  it("the caller can stop it", async () => {
    handler = (_b, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "start" } }] })}\n\n`);
      // never ends
    };
    const ctl = new AbortController();
    const running = collect(openai(), ctl.signal);
    setTimeout(() => ctl.abort(), 50);
    await assert.rejects(running);
  });
});

describe("the Anthropic transport", () => {
  const anthropicEvents = (texts: string[]) =>
    [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      ...texts.map((t) => `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })}\n\n`),
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");

  let saved: string | undefined;
  before(() => {
    saved = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  });
  after(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved;
  });

  it("STREAMS TEXT DELTAS and returns the whole reply", async () => {
    handler = async (_b, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      await dribble(res, anthropicEvents(["Hi", " from", " Sherwood."]), 11);
    };
    const creds: LlmCreds = { provider: "anthropic", transport: "anthropic", baseUrl: "", apiKey: "sk-ant-x", model: "claude-x", vision: true };
    const { text, pieces } = await collect(creds);
    assert.equal(text, "Hi from Sherwood.");
    assert.deepEqual(pieces, ["Hi", " from", " Sherwood."]);
    assert.equal(seen[0]!.stream, true);
  });

  it("AN ANTHROPIC STREAM THAT STOPS SHORT IS NOT A REPLY either", async () => {
    handler = async (_b, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Everything up to the text, and then the connection goes: no stop.
      const whole = anthropicEvents(["Yes, I'd", " sell"]);
      await dribble(res, whole.slice(0, whole.indexOf("event: content_block_stop")), 11);
    };
    const creds: LlmCreds = { provider: "anthropic", transport: "anthropic", baseUrl: "", apiKey: "sk-ant-x", model: "claude-x", vision: true };
    await assert.rejects(collect(creds), /ended before the reply was finished/);
  });

  it("an empty Anthropic reply is a failure too", async () => {
    handler = async (_b, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      await dribble(res, anthropicEvents([]), 50);
    };
    const creds: LlmCreds = { provider: "anthropic", transport: "anthropic", baseUrl: "", apiKey: "sk-ant-x", model: "claude-x", vision: true };
    await assert.rejects(collect(creds), /empty reply/);
  });
});
