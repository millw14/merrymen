import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { llmAgentTurn, llmText, llmTextStream, llmToolCall, type LlmCreds } from "./llm";
import { describeLlmFailure, isLlmProviderFailure } from "./llm-failure";
import { interpretWithLlm } from "./telegram/interpreter";

/** Exercise the real SDK against HTTP, including the 404 seen in Vector's DM. */
describe("Anthropic failures keep their provider and actionable cause", () => {
  let server: Server;
  let originalBaseUrl: string | undefined;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  const originalError = console.error;
  const logs: string[] = [];
  const creds: LlmCreds = {
    provider: "anthropic", transport: "anthropic", baseUrl: "",
    apiKey: "private-credential-for-anthropic-regression", model: "gpt-5.6-luna", vision: true,
  };
  const fail = (status: number, type: string, message: string) => {
    handler = (_req, res) => {
      res.writeHead(status, { "content-type": "application/json", "x-should-retry": "false" });
      res.end(JSON.stringify({ type: "error", error: { type, message } }));
    };
  };

  before(async () => {
    server = createServer((req, res) => { req.resume(); handler(req, res); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => {
    if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    logs.length = 0;
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    fail(404, "not_found_error", "model: gpt-5.6-luna");
  });
  afterEach(() => { console.error = originalError; });

  const paths = {
    tool: () => llmToolCall(creds, {
      system: "s", messages: [{ role: "user", content: "hello" }],
      tool: { name: "command", description: "route", schema: { type: "object" } },
    }),
    agent: () => llmAgentTurn(creds, { system: "s", messages: [{ role: "user", text: "hello" }], tools: [] }),
    text: () => llmText(creds, { system: "s", prompt: "hello" }),
    stream: () => llmTextStream(creds, { system: "s", prompt: "hello" }, () => {}),
  };
  for (const [name, call] of Object.entries(paths)) {
    it(`${name}: a missing model remains a provider failure`, async () => {
      await assert.rejects(call(), (error: Error) => {
        assert.equal(error.message, "anthropic 404 — not_found_error: model: gpt-5.6-luna");
        assert.equal(isLlmProviderFailure(error.message), true);
        assert.equal(describeLlmFailure(error.message).kind, "model-missing");
        return true;
      });
    });
    it(`${name}: an echoed credential is redacted before the error leaves the transport`, async () => {
      fail(401, "authentication_error", `invalid x-api-key ${creds.apiKey}`);
      await assert.rejects(call(), (error: Error) => {
        assert.match(error.message, /^anthropic 401 — authentication_error: invalid x-api-key/);
        assert.ok(!error.message.includes(creds.apiKey));
        assert.doesNotMatch(error.message, /[{}]/);
        return true;
      });
    });
  }

  for (const example of [
    { status: 404, type: "not_found_error", message: "model: gpt-5.6-luna", kind: "model-missing", reply: /Anthropic says the model.*Check the model name in Settings/ },
    { status: 401, type: "authentication_error", message: `invalid x-api-key ${creds.apiKey}`, kind: "key-rejected", reply: /Anthropic rejected the API key.*Settings/ },
    { status: 429, type: "rate_limit_error", message: "too many requests", kind: "rate-limited", reply: /Anthropic is rate-limiting me/ },
  ]) {
    it(`the owner hears the ${example.kind} remedy for an SDK ${example.status}`, async () => {
      fail(example.status, example.type, example.message);
      const result = await interpretWithLlm("Why can't you reply?", { state: "idle" }, creds);
      assert.equal(result.cmd.kind, "chat");
      const reply = (result.cmd as { reply: string }).reply;
      assert.match(reply, example.reply);
      assert.doesNotMatch(reply, /don't recognise|[{}]|gpt-5\.6-luna/);
      assert.match(reply, /\/status/);
      assert.equal(result.remember, "");
      assert.equal(logs.length, 1);
      assert.ok(logs[0]!.includes(`(${example.kind}): anthropic ${example.status}`));
      assert.ok(![reply, ...logs].some((text) => text.includes(creds.apiKey)));
    });
  }

  it("an SDK failure inside a stream stays a redacted failure, not a partial answer", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I was going to say" } })}\n\n`);
      res.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: `overloaded ${creds.apiKey}` } })}\n\n`);
    };
    const pieces: string[] = [];
    await assert.rejects(llmTextStream(creds, { system: "s", prompt: "hello" }, (text) => pieces.push(text)), (error: Error) => {
      assert.match(error.message, /^anthropic stream failed — overloaded_error: overloaded/);
      assert.ok(!error.message.includes(creds.apiKey));
      assert.doesNotMatch(error.message, /[{}]/);
      return true;
    });
    assert.deepEqual(pieces, ["I was going to say"]);
  });

  it("a local stream consumer error keeps its identity", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } })}\n\n`);
    };
    const localError = new Error("consumer failed");
    await assert.rejects(llmTextStream(creds, { system: "s", prompt: "hello" }, () => { throw localError; }), (error: unknown) => error === localError);
  });

  it("an SDK connection failure is explained as a network failure", async () => {
    handler = (req) => { req.socket.destroy(); };
    await assert.rejects(llmText(creds, { system: "s", prompt: "hello" }), (error: Error) => {
      assert.equal(error.message, "anthropic network request failed");
      assert.equal(describeLlmFailure(error.message).kind, "unreachable");
      return true;
    });
  });

  it("a caller's abort remains an SDK abort", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      llmTextStream(creds, { system: "s", prompt: "hello", signal: controller.signal }, () => {}),
      (error: unknown) => error instanceof Anthropic.APIUserAbortError,
    );
  });
});
