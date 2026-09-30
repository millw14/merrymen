import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { createServer, type Server, type ServerResponse } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  llmAgentTurn,
  llmText,
  llmTextStream,
  llmToolCall,
  resetAnthropicCapabilitiesForTest,
  type LlmCreds,
} from "./llm";
import { interpretWithLlm } from "./telegram/interpreter";

const THINKING_UNSUPPORTED = '"thinking.type.disabled" is not supported for this model.';
const FORCED_TOOL_UNSUPPORTED = 'tool_choice: type "tool" and "any" are not supported for this model.';
const TOOL = {
  name: "command",
  description: "Select a command",
  schema: {
    type: "object",
    properties: { kind: { type: "string", enum: ["chat", "status"] } },
    required: ["kind"],
    additionalProperties: false,
  },
};
const INPUT = { kind: "status" };
const PUBLIC_TEXT = "Here are the launches.";
const REASONING: Anthropic.ContentBlock[] = [
  { type: "thinking", thinking: "Private reasoning, never owner-facing", signature: "signed-reasoning" },
  { type: "redacted_thinking", data: "opaque-reasoning" },
];

type WireRequest = {
  model: string;
  max_tokens: number;
  thinking?: { type: string; display?: string };
  output_config?: { effort?: string; format?: { type: string; schema: unknown } };
  tools?: { input_schema?: unknown }[];
  tool_choice?: unknown;
  messages: { role: string; content: unknown }[];
  stream?: boolean;
};
type ReceivedRequest = { path: string; body: WireRequest };

/** Real SDK wire tests: these refusals must adapt safely before Telegram routing. */
describe("Anthropic model capability compatibility", () => {
  let server: Server;
  let baseUrl: string;
  let originalBaseUrl: string | undefined;
  let handler: (body: WireRequest, res: ServerResponse) => void;
  const requests: ReceivedRequest[] = [];
  const creds: LlmCreds = {
    provider: "anthropic", transport: "anthropic", baseUrl: "",
    apiKey: "local-regression-key", model: "adaptive-only-model", vision: true,
  };

  function fail(res: ServerResponse, message: string, status = 400): void {
    res.writeHead(status, { "content-type": "application/json", "x-should-retry": "false" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
  }

  function message(res: ServerResponse, content: unknown[], stopReason = "end_turn"): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_local", type: "message", role: "assistant", model: creds.model,
      content, stop_reason: stopReason, stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 5 },
    }));
  }

  function event(type: string, payload: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  }

  function streamSuccess(res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([
      event("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
      event("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Private stream reasoning" } }),
      event("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "private-signature" } }),
      event("content_block_stop", { index: 0 }),
      event("content_block_start", { index: 1, content_block: { type: "redacted_thinking", data: "private-opaque-data" } }),
      event("content_block_stop", { index: 1 }),
      event("content_block_start", { index: 2, content_block: { type: "text", text: "" } }),
      event("content_block_delta", { index: 2, delta: { type: "text_delta", text: PUBLIC_TEXT } }),
      event("content_block_stop", { index: 2 }),
      event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
      event("message_stop", {}),
    ].join(""));
  }

  function success(body: WireRequest, res: ServerResponse): void {
    if (body.stream) return streamSuccess(res);
    if (body.output_config?.format) return message(res, [{ type: "text", text: JSON.stringify(INPUT) }]);
    if (body.tool_choice) return message(res, [{ type: "tool_use", id: "tool_local", name: TOOL.name, input: INPUT }], "tool_use");
    message(res, [...REASONING, { type: "text", text: PUBLIC_TEXT }]);
  }

  function requireBothCapabilities(body: WireRequest, res: ServerResponse): void {
    if (body.thinking?.type === "disabled") return fail(res, THINKING_UNSUPPORTED);
    if (body.tool_choice) return fail(res, FORCED_TOOL_UNSUPPORTED);
    success(body, res);
  }

  function assertAdaptive(body: WireRequest): void {
    assert.deepEqual(body.thinking, { type: "adaptive", display: "omitted" });
    assert.equal(body.output_config?.effort, "low");
  }

  function assertStructured(body: WireRequest): void {
    assert.deepEqual(body.output_config?.format, { type: "json_schema", schema: TOOL.schema });
    assert.equal(body.tools, undefined);
    assert.equal(body.tool_choice, undefined);
  }

  const paths = {
    tool: {
      budget: 1024,
      call: (maxTokens?: number, modelCreds = creds) => llmToolCall(modelCreds, {
        system: "Route owner commands", messages: [{ role: "user", content: "Show launches" }], tool: TOOL, maxTokens,
      }),
      expected: INPUT,
    },
    agent: {
      budget: 1500,
      call: (maxTokens?: number, modelCreds = creds) => llmAgentTurn(modelCreds, {
        system: "Answer owner", messages: [{ role: "user", text: "Show launches" }], tools: [TOOL], maxTokens,
      }).then((turn) => turn.text),
      expected: PUBLIC_TEXT,
    },
    text: {
      budget: 400,
      call: (maxTokens?: number, modelCreds = creds) => llmText(modelCreds, { system: "Answer owner", prompt: "Show launches", maxTokens }),
      expected: PUBLIC_TEXT,
    },
    stream: {
      budget: 400,
      call: async (maxTokens?: number, modelCreds = creds) => {
        const visible: string[] = [];
        const text = await llmTextStream(modelCreds, { system: "Answer owner", prompt: "Show launches", maxTokens }, (piece) => visible.push(piece));
        assert.deepEqual(visible, [PUBLIC_TEXT]);
        return text;
      },
      expected: PUBLIC_TEXT,
    },
  };

  before(async () => {
    originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as WireRequest;
      requests.push({ path: req.url ?? "", body });
      handler(body, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  beforeEach(() => {
    resetAnthropicCapabilitiesForTest();
    process.env.ANTHROPIC_BASE_URL = baseUrl;
    requests.length = 0;
    handler = success;
  });
  after(async () => {
    resetAnthropicCapabilitiesForTest();
    if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  for (const [name, path] of Object.entries(paths)) {
    it(`${name}: models accepting disabled thinking keep their original request and token budget`, async () => {
      assert.deepEqual(await path.call(), path.expected);
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0]!.body.thinking, { type: "disabled" });
      assert.equal(requests[0]!.body.output_config, undefined);
      assert.equal(requests[0]!.body.max_tokens, path.budget);
      if (name === "tool") {
        assert.deepEqual(requests[0]!.body.tool_choice, { type: "tool", name: TOOL.name });
        assert.deepEqual(requests[0]!.body.tools, [{ name: TOOL.name, description: TOOL.description, input_schema: TOOL.schema }]);
      }
    });

    it(`${name}: retries a disabled-thinking refusal once and remembers adaptive support without raising the budget`, async () => {
      handler = (body, res) => body.thinking?.type === "disabled" ? fail(res, THINKING_UNSUPPORTED) : success(body, res);
      assert.deepEqual(await path.call(73), path.expected);
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0]!.body.thinking, { type: "disabled" });
      assertAdaptive(requests[1]!.body);
      assert.deepEqual(requests.map((r) => r.body.max_tokens), [73, 73]);
      assert.deepEqual(requests[1]!.body.messages, requests[0]!.body.messages);
      assert.deepEqual(await path.call(81), path.expected);
      assert.equal(requests.length, 3);
      assertAdaptive(requests[2]!.body);
      assert.equal(requests[2]!.body.max_tokens, 81);
    });

    it(`${name}: unrelated 400s and other status codes are not compatibility retries`, async () => {
      for (const [status, detail] of [
        [400, "messages: thinking blocks are invalid"],
        [400, "tool_choice: forced choice requires a tool"],
        [401, THINKING_UNSUPPORTED],
      ] as const) {
        requests.length = 0;
        handler = (_body, res) => fail(res, detail, status);
        await assert.rejects(path.call(), new RegExp(`anthropic ${status}`));
        assert.equal(requests.length, 1, `${status}: ${detail}`);
      }
    });

    it(`${name}: a repeated capability refusal terminates after the adaptive retry`, async () => {
      handler = (_body, res) => fail(res, THINKING_UNSUPPORTED);
      await assert.rejects(path.call(), /anthropic 400/);
      assert.equal(requests.length, 2);
      assertAdaptive(requests[1]!.body);
    });
  }

  it("forced tool rejection alone selects the same schema as JSON without changing thinking", async () => {
    handler = (body, res) => body.tool_choice ? fail(res, FORCED_TOOL_UNSUPPORTED) : success(body, res);
    assert.deepEqual(await paths.tool.call(91), INPUT);
    assert.equal(requests.length, 2);
    assertStructured(requests[1]!.body);
    assert.deepEqual(requests[1]!.body.thinking, { type: "disabled" });
    assert.equal(requests[1]!.body.output_config?.effort, undefined);
    assert.deepEqual(requests.map((r) => r.body.max_tokens), [91, 91]);
    assert.deepEqual(await paths.tool.call(), INPUT);
    assert.equal(requests.length, 3);
    assertStructured(requests[2]!.body);
  });

  for (const order of ["thinking-first", "tool-first"] as const) {
    it(`combines both compatibility changes in at most three requests (${order})`, async () => {
      handler = order === "thinking-first" ? requireBothCapabilities : (body, res) => {
        if (body.tool_choice) return fail(res, FORCED_TOOL_UNSUPPORTED);
        if (body.thinking?.type === "disabled") return fail(res, THINKING_UNSUPPORTED);
        success(body, res);
      };
      assert.deepEqual(await paths.tool.call(107), INPUT);
      assert.equal(requests.length, 3);
      assertAdaptive(requests[2]!.body);
      assertStructured(requests[2]!.body);
      assert.deepEqual(requests.map((r) => r.body.max_tokens), [107, 107, 107]);
      assert.deepEqual(requests[2]!.body.messages, requests[0]!.body.messages);
    });
  }

  it("the owner's launches message reaches Telegram command coercion after both capability refusals", async () => {
    handler = (body, res) => {
      if (body.thinking?.type === "disabled") return fail(res, THINKING_UNSUPPORTED);
      if (body.tool_choice) return fail(res, FORCED_TOOL_UNSUPPORTED);
      message(res, [{ type: "text", text: JSON.stringify({ kind: "chat", reply: PUBLIC_TEXT, remember: "" }) }]);
    };
    const result = await interpretWithLlm("Let’s look at those launches", { state: "idle" }, creds);
    assert.deepEqual(result, { cmd: { kind: "chat", reply: PUBLIC_TEXT }, remember: "" });
    assert.equal(requests.length, 3);
    assertAdaptive(requests[2]!.body);
    assert.deepEqual(requests[2]!.body.output_config?.format, {
      type: "json_schema", schema: requests[0]!.body.tools![0]!.input_schema,
    });
    assert.equal(requests[2]!.body.tools, undefined);
    assert.equal(requests[2]!.body.tool_choice, undefined);
    assert.deepEqual(requests.map((r) => r.body.max_tokens), [1024, 1024, 1024]);
    assert.deepEqual(requests[2]!.body.messages, requests[0]!.body.messages);
  });

  it("capabilities are shared across call types and isolated by both model and actual SDK endpoint", async () => {
    handler = requireBothCapabilities;
    await paths.tool.call();
    assert.equal(requests.length, 3);
    await paths.tool.call();
    assert.equal(requests.length, 4);
    assertStructured(requests[3]!.body);
    await paths.text.call();
    assert.equal(requests.length, 5);
    assertAdaptive(requests[4]!.body);
    assert.equal(requests[4]!.body.output_config?.format, undefined);

    await paths.tool.call(undefined, { ...creds, model: "another-model" });
    assert.equal(requests.length, 8);
    assert.deepEqual(requests[5]!.body.thinking, { type: "disabled" });
    assert.ok(requests[5]!.body.tool_choice);
    process.env.ANTHROPIC_BASE_URL = `${baseUrl}/another-endpoint`;
    await paths.tool.call();
    assert.equal(requests.length, 11);
    assert.match(requests[8]!.path, /^\/another-endpoint\//);
    assert.deepEqual(requests[8]!.body.thinking, { type: "disabled" });
    assert.ok(requests[8]!.body.tool_choice);
  });

  for (const invalid of [
    { label: "malformed JSON", text: "not JSON", stop: "end_turn" },
    { label: "JSON null", text: "null", stop: "end_turn" },
    { label: "JSON array", text: "[]", stop: "end_turn" },
    { label: "JSON string", text: '"status"', stop: "end_turn" },
    { label: "refusal", text: JSON.stringify(INPUT), stop: "refusal" },
    { label: "truncation", text: JSON.stringify(INPUT), stop: "max_tokens" },
  ]) {
    it(`rejects ${invalid.label} in a structured command without replaying it`, async () => {
      handler = (body, res) => body.tool_choice
        ? fail(res, FORCED_TOOL_UNSUPPORTED)
        : message(res, [{ type: "text", text: invalid.text }], invalid.stop);
      await assert.rejects(paths.tool.call());
      assert.equal(requests.length, 2);
      assertStructured(requests[1]!.body);
    });
  }

  it("preserves signed and redacted thinking blocks exactly on the next tool turn while returning only public text", async () => {
    const content: Anthropic.ContentBlock[] = [
      ...REASONING,
      { type: "text", text: PUBLIC_TEXT, citations: null },
      { type: "tool_use", id: "launch_lookup", name: TOOL.name, input: INPUT, caller: { type: "direct" } },
    ];
    handler = (_body, res) => message(res, content, "tool_use");
    const turn = await llmAgentTurn(creds, {
      system: "Answer owner", messages: [{ role: "user", text: "Show launches" }], tools: [TOOL],
    });
    assert.equal(turn.text, PUBLIC_TEXT);
    assert.deepEqual(turn.toolUses, [{ id: "launch_lookup", name: TOOL.name, input: INPUT }]);
    assert.deepEqual(turn.anthropicContent, content);
    await llmAgentTurn(creds, {
      system: "Answer owner",
      messages: [
        { role: "user", text: "Show launches" },
        { role: "assistant", ...turn },
        { role: "tools", results: [{ id: "launch_lookup", name: TOOL.name, output: "Found launches" }] },
      ],
      tools: [TOOL],
    });
    assert.deepEqual(requests[1]!.body.messages[1], { role: "assistant", content });
    assert.deepEqual(requests[1]!.body.messages[2], {
      role: "user", content: [{ type: "tool_result", tool_use_id: "launch_lookup", content: "Found launches" }],
    });
  });

  it("does not replay a partial stream even when its error mentions disabled thinking", async () => {
    handler = (_body, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Partial reply" } })
        + event("error", { error: { type: "invalid_request_error", message: THINKING_UNSUPPORTED } }),
      );
    };
    const visible: string[] = [];
    await assert.rejects(llmTextStream(creds, { system: "s", prompt: "hello" }, (piece) => visible.push(piece)), /anthropic stream failed/);
    assert.deepEqual(visible, ["Partial reply"]);
    assert.equal(requests.length, 1);
    handler = success;
    await paths.text.call();
    assert.deepEqual(requests[1]!.body.thinking, { type: "disabled" });
  });

  it("preserves caller aborts without sending or retrying a request", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      llmTextStream(creds, { system: "s", prompt: "hello", signal: controller.signal }, () => {}),
      (error: unknown) => error instanceof Anthropic.APIUserAbortError,
    );
    assert.equal(requests.length, 0);
  });
});
