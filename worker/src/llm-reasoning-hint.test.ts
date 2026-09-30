/**
 * THE REASONING HINT IS DROPPED WHEN A PROVIDER REFUSES IT — ON EVERY PATH.
 *
 * `quietReasoning` sends `reasoning_effort: "none"` to reasoning models so they
 * do not spend the completion budget thinking. Groq validates that field and
 * answers 400 for "none". The first fix taught `llmText` to retry without the
 * hint and remember the base URL — and left `llmToolCall`, the path the
 * Telegram interpreter uses, building its body ONCE outside its retry loop, so
 * its one retry re-sent the same hint and 400'd again. The owner's chat was
 * therefore still dead on Groq gpt-oss after the "fix", masked only by an
 * unrelated 401 in the one live case anyone looked at.
 *
 * This drives the REAL `llmToolCall` against a local server that behaves the
 * way Groq does: 400 with Groq's exact message while the hint is present, 200
 * with a tool call once it is gone. The assertion is on what the server saw.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { llmToolCall, resetReasoningRefusalsForTest, type LlmCreds } from "./llm";

const GROQ_400 = { error: { message: "`reasoning_effort` must be one of `low`, `medium`, or `high`", type: "invalid_request_error" } };
const TOOL_OK = { choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ kind: "chat", reply: "hello" }) } }] } }] };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
}

describe("llmToolCall on a provider that refuses reasoning_effort", () => {
  let server: Server;
  let port = 0;
  /** Every request body the server saw, in order. */
  const seen: Record<string, unknown>[] = [];

  before(async () => {
    server = createServer(async (req, res) => {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      seen.push(body);
      if ("reasoning_effort" in body) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify(GROQ_400));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(TOOL_OK));
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

  const creds = (): LlmCreds => ({
    provider: "groq",
    transport: "openai",
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: "gsk_test",
    // Must match REASONING_MODELS or no hint is sent and the test proves nothing.
    model: "openai/gpt-oss-120b",
    vision: false,
  });
  const call = () =>
    llmToolCall(creds(), {
      system: "s",
      messages: [{ role: "user", content: "Hii" }],
      tool: { name: "command", description: "d", schema: { type: "object", properties: {} } },
    });

  it("retries WITHOUT the hint and returns the tool call", async () => {
    const out = await call();
    assert.deepEqual(out, { kind: "chat", reply: "hello" });
    assert.equal(seen.length, 2, "exactly one refusal and one retry");
    assert.ok("reasoning_effort" in seen[0]!, "the first attempt carries the hint");
    assert.ok(!("reasoning_effort" in seen[1]!), "the retry must not carry the hint — this is the bug");
  });

  it("remembers the refusal, so the next call never sends the hint at all", async () => {
    await call();
    seen.length = 0;
    await call();
    assert.equal(seen.length, 1, "no refusal round trip the second time");
    assert.ok(!("reasoning_effort" in seen[0]!));
  });

  it("still throws a real 400 that does not name the field", async () => {
    // Narrowness is the property: a malformed request must not be quietly
    // retried without its hint and then reported as some other error.
    const bad = createServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "messages: invalid role", type: "invalid_request_error", code: "bad_request" } }));
    });
    await new Promise<void>((resolve) => bad.listen(0, "127.0.0.1", resolve));
    const p = (bad.address() as { port: number }).port;
    try {
      await assert.rejects(
        llmToolCall({ ...creds(), baseUrl: `http://127.0.0.1:${p}` }, {
          system: "s",
          messages: [{ role: "user", content: "x" }],
          tool: { name: "t", description: "d", schema: { type: "object", properties: {} } },
        }),
        /groq 400 — bad_request: messages: invalid role/,
      );
    } finally {
      await new Promise<void>((resolve) => bad.close(() => resolve()));
    }
  });
});
