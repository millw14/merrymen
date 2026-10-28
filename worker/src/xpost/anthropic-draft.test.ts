import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { resetAnthropicCapabilitiesForTest, type LlmCreds } from "../llm";
import { tryDraft } from "./writer";

test("Anthropic wire token exhaustion stays distinct from an empty X draft", async (t) => {
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
  let stopReason = "max_tokens", requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the SDK request */ }
    requests++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_local", type: "message", role: "assistant", model: "test-model",
      content: [{ type: "thinking", thinking: "Private reasoning, never public", signature: "signed" }],
      stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 },
    }));
  });
  t.after(async () => {
    resetAnthropicCapabilitiesForTest();
    if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  resetAnthropicCapabilitiesForTest();
  const creds: LlmCreds = { provider: "anthropic", transport: "anthropic", baseUrl: "", apiKey: "local-test-key", model: "test-model", vision: true };
  const prompt = { system: "public words only", prompt: "hello" };
  assert.deepEqual(await tryDraft(creds, prompt), { ok: false, reason: "out-of-tokens" });
  stopReason = "end_turn";
  assert.deepEqual(await tryDraft(creds, prompt), { ok: false, reason: "empty" });
  assert.equal(requests, 2, "neither response is retried");
});
