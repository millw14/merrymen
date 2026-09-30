/**
 * WHAT THE OWNER HEARS WHEN THE MODEL CALL FAILS.
 *
 * Two layers. `describeLlmFailure` is pure and is tested as a table. The
 * interpreter test underneath is the one that bites: it runs the REAL
 * `interpretWithLlm` against a local server answering with Groq's exact 401
 * body, so the assertion is on the sentence an owner would actually read —
 * not on a string in a source file.
 *
 * The seed case is verbatim from a live owner chat on 2026-09-17:
 *
 *   couldn't reach my brain right now (groq 401: {"error":{"message":"Invalid
 *   API Key","type":"invalid_request_error","code":"invalid_api_key"}}). Try a
 *   slash command like /status.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { describeLlmFailure } from "./llm-failure";
import { interpretWithLlm } from "./telegram/interpreter";
import type { LlmCreds } from "./llm";

describe("describeLlmFailure", () => {
  it("turns a refused key into the one fact the owner can act on", () => {
    const f = describeLlmFailure("groq 401 — invalid_api_key: Invalid API Key");
    assert.equal(f.kind, "key-rejected");
    assert.match(f.text, /Groq rejected the API key/);
    assert.match(f.text, /Settings/, "must say where the key lives");
    assert.match(f.text, /house key/, "must say a fallback exists, because it does");
    assert.doesNotMatch(f.text, /[{}]|401|invalid_api_key/, "no JSON, no status, no provider code");
  });

  it("classifies a bare 401/403 as a refused key even with an unfamiliar body", () => {
    // THE STATUS CARRIES THE MEANING, NOT GROQ'S WORDING. A mutation that broke
    // the status check passed every case above, because each one also carried
    // "invalid_api_key" and the wording regex covered for it. A provider that
    // says nothing recognisable — or nothing at all — with a 401 has still
    // refused the key, and the owner must still be sent to Settings.
    for (const m of ["groq 401", "openai 403 — forbidden: nope", "custom 401 — {\"detail\":\"no\"}"]) {
      const f = describeLlmFailure(m);
      assert.equal(f.kind, "key-rejected", m);
      assert.match(f.text, /rejected the API key/, m);
    }
  });

  it("does not call a refusal 'unreachable' — the provider answered", () => {
    assert.doesNotMatch(describeLlmFailure("groq 401 — invalid_api_key: Invalid API Key").text, /reach/i);
  });

  it("reserves 'unreachable' for a request that never completed", () => {
    for (const m of ["fetch failed", "connect ECONNREFUSED 127.0.0.1:443", "getaddrinfo ENOTFOUND api.groq.com"]) {
      const f = describeLlmFailure(m);
      assert.equal(f.kind, "unreachable", m);
      assert.match(f.text, /reach/i);
      assert.match(f.text, /not your key/i, "must not send the owner to Settings for a network blip");
    }
  });

  it("names a rate limit as a rate limit, not a key problem", () => {
    const f = describeLlmFailure("groq 429 — rate_limit_exceeded: Rate limit reached");
    assert.equal(f.kind, "rate-limited");
    assert.match(f.text, /Nothing is wrong with the key/);
  });

  it("names a missing model as a settings problem", () => {
    const f = describeLlmFailure("groq 404 — model_not_found: The model `x` does not exist");
    assert.equal(f.kind, "model-missing");
    assert.match(f.text, /model name in Settings/);
  });

  it("names a 5xx as the provider's problem", () => {
    const f = describeLlmFailure("groq 503 — service_unavailable: overloaded");
    assert.equal(f.kind, "provider-down");
    assert.match(f.text, /Not your key/);
  });

  it("never emits braces, whatever it is handed", () => {
    // The whole reason this module exists. A provider body may be anything;
    // none of it may reach the chat.
    for (const m of [
      'groq 401 — {"error":{"message":"x"}}',
      "anthropic 400 — invalid_request_error: {\"type\":\"error\"}",
      "",
      "something entirely unexpected {with} braces",
    ]) {
      assert.doesNotMatch(describeLlmFailure(m).text, /[{}]/, m);
    }
  });
});

/**
 * THE END-TO-END CASE: the real interpreter, a real HTTP round trip, Groq's
 * real 401 body. This is what fails if the classifier is bypassed, the reply
 * template regresses, or the catch block starts echoing again.
 */
describe("interpretWithLlm on a refused key", () => {
  let server: Server;
  let port = 0;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API Key", type: "invalid_request_error", code: "invalid_api_key" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const creds = (baseUrl: string): LlmCreds => ({
    provider: "groq",
    transport: "openai",
    baseUrl,
    apiKey: "gsk_not_a_real_key",
    model: "openai/gpt-oss-120b",
    vision: false,
  });

  it("replies with the owner's remedy and none of the provider's JSON", async () => {
    const r = await interpretWithLlm("Hii", { state: "idle" } as never, creds(`http://127.0.0.1:${port}`));
    assert.equal(r.cmd.kind, "chat");
    const reply = (r.cmd as { reply: string }).reply;
    assert.match(reply, /Groq rejected the API key/, reply);
    assert.match(reply, /Settings/, reply);
    assert.match(reply, /\/status/, "slash commands are still the fallback");
    assert.doesNotMatch(reply, /[{}]/, `provider JSON reached the chat: ${reply}`);
    assert.doesNotMatch(reply, /401|invalid_api_key/, `raw status or code reached the chat: ${reply}`);
    assert.doesNotMatch(reply, /couldn't reach/, "a refusal is not an unreachable provider");
  });

  it("says 'unreachable' only when nothing answered", async () => {
    // Port 1 on loopback is closed everywhere this can run.
    const r = await interpretWithLlm("Hii", { state: "idle" } as never, creds("http://127.0.0.1:1"));
    const reply = (r.cmd as { reply: string }).reply;
    assert.match(reply, /reach/i, reply);
    assert.doesNotMatch(reply, /Settings/, "a network failure must not send the owner to their key");
  });
});
