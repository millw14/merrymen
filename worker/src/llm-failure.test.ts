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

  /** Verbatim from production: every house-key call from 2026-10-09 01:45 UTC. */
  const GROQ_DELINQUENT =
    "groq 400 — organization_delinquent: Organization has been restricted because of overdue payment(s). " +
    "Please update the payment method at https://console.groq.com/settings/billing/manage and then contact support.";

  it("A PROVIDER HOLDING THE ACCOUNT FOR MONEY IS 'billing' — the production line, not 'a reason I don't recognise'", () => {
    const f = describeLlmFailure(GROQ_DELINQUENT);
    assert.equal(f.kind, "billing");
    assert.equal(
      f.text,
      "Groq has put the account behind the API key I'm using on hold over billing, so I can't answer in my own words until that's settled. " +
        "If it's a Groq key you saved in this agent's Settings, settle it with Groq or switch provider; " +
        "if you never added one, it's the house key and that's ours to fix, not yours.",
    );
    assert.doesNotMatch(f.text, /[{}]|400|organization_delinquent|console\.groq\.com|recognise/);
  });

  it("each provider's own words for a billing hold, and a bare 402, are 'billing'", () => {
    for (const m of [
      // Anthropic: a 400, which would otherwise be nothing at all.
      "anthropic 400 — invalid_request_error: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      // OpenAI: a 429 whose code says "quota" — it used to be read as a rate limit, "try again shortly".
      "openai 429 — insufficient_quota: You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
      // OpenRouter: its code is the number, so providerError writes "402: …".
      "openrouter 402 — 402: Insufficient credits. Add more using https://openrouter.ai/settings/credits",
      "openrouter 402 — 402: This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 1200.",
      "custom 402",
    ]) {
      const f = describeLlmFailure(m);
      assert.equal(f.kind, "billing", m);
      assert.match(f.text, /on hold over billing/, m);
      assert.doesNotMatch(f.text, /try again|rate-limit/i, `a bill does not pass with time: ${m}`);
    }
  });

  it("A BILLING URL OR THE WORD 'BILLING' ON A RATE LIMIT IS STILL A RATE LIMIT", () => {
    // Groq's ordinary daily limit ends by pointing at its billing page, and
    // Gemini's per-minute one says "check your plan and billing details".
    // Both pass on their own: called a billing hold, the retry that fixes them
    // would stop.
    for (const m of [
      "groq 429 — rate_limit_exceeded: Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_01hzq6v3kexample` " +
        "service tier `on_demand` on tokens per day (TPD): Limit 100000, Used 99837, Requested 1290. Please try again in 16m31.2s. " +
        "Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing",
      "gemini 429 — 429: You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.",
    ]) {
      assert.equal(describeLlmFailure(m).kind, "rate-limited", m);
    }
  });

  it("THE HOLDER GATEWAY RELAYS THE HOUSE'S HOLD — said as ours, never as the holder's bill", () => {
    // gateway/lib/core.mjs passes the upstream's status and body through, so
    // the house Groq account's hold reached holders as "merrymen 400 — …" and
    // told them to "settle it with Merrymen", for a perk with no bill.
    const held = describeLlmFailure(GROQ_DELINQUENT.replace(/^groq /, "merrymen "));
    assert.equal(held.kind, "billing", "still billing, so the rooms back off the same way");
    assert.equal(
      held.text,
      "Merrymen AI's own provider has paused the account it runs on, so I can't answer in my own words right now. That's ours to fix, not yours — your holder token is fine.",
    );
    assert.doesNotMatch(held.text, /billing|overdue|settle|Settings|[{}]|400/);
    assert.equal(describeLlmFailure("merrymen 402").kind, "billing");
    assert.match(describeLlmFailure("merrymen 402").text, /ours to fix, not yours/);
    // The gateway forces its model: one missing upstream is ours too.
    const gone = describeLlmFailure("merrymen 404 — model_not_found: The model `merrymen-fast` does not exist or you do not have access to it.");
    assert.equal(gone.kind, "model-missing");
    assert.match(gone.text, /ours to fix, not yours/);
    assert.doesNotMatch(gone.text, /Check the model name/);
    // The gateway's OWN 401 is an expired holder claim: the holder's to renew.
    const expired = describeLlmFailure("merrymen 401 — invalid or expired Merrymen AI token — re-claim at /claim");
    assert.equal(expired.kind, "key-rejected");
    assert.doesNotMatch(expired.text, /ours to fix/);
  });

  it("billing words outside a provider line are not a provider's billing hold", () => {
    // Only providerError's shape is read for it, like every other kind: a
    // tool's own "insufficient_quota" is not a model provider's bill.
    assert.equal(describeLlmFailure("insufficient_quota: tool ran out").kind, "other");
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

/**
 * THE INCIDENT, END TO END: Groq's real 400 body for an account held over an
 * unpaid bill, through the real providerError and the real interpreter. What
 * fails if providerError's shape drifts from what the classifier reads.
 */
describe("interpretWithLlm on an account held over billing", () => {
  let server: Server;
  let port = 0;
  const originalError = console.error;
  const logs: string[] = [];

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message:
              "Organization has been restricted because of overdue payment(s). Please update the payment method at https://console.groq.com/settings/billing/manage and then contact support.",
            type: "invalid_request_error",
            code: "organization_delinquent",
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
  });
  after(async () => {
    console.error = originalError;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("tells the owner whose bill it is, and the operator log says 'billing'", async () => {
    const r = await interpretWithLlm(
      "Hii",
      { state: "idle" } as never,
      { provider: "groq", transport: "openai", baseUrl: `http://127.0.0.1:${port}`, apiKey: "gsk_not_a_real_key", model: "llama-3.3-70b-versatile", vision: false },
    );
    const reply = (r.cmd as { reply: string }).reply;
    assert.match(reply, /^Groq has put the account behind the API key I'm using on hold over billing/, reply);
    assert.match(reply, /house key and that's ours to fix, not yours/, reply);
    assert.doesNotMatch(reply, /recognise|[{}]|400|organization_delinquent/, reply);
    assert.ok(logs.some((l) => l.includes("(billing): groq 400 — organization_delinquent: Organization has been restricted")), logs.join("\n"));
  });

  it("through the holder gateway, which relays the same body, it is ours — not a bill the holder can pay", async () => {
    // This server stands in for gateway/lib/core.mjs, which passes the
    // upstream's 400 and body straight through to a holder's token.
    const r = await interpretWithLlm(
      "Hii",
      { state: "idle" } as never,
      { provider: "merrymen", transport: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "mm_holder_token_not_real", model: "merrymen-fast", vision: false },
    );
    const reply = (r.cmd as { reply: string }).reply;
    assert.match(reply, /^Merrymen AI's own provider has paused the account it runs on/, reply);
    assert.match(reply, /ours to fix, not yours — your holder token is fine/, reply);
    assert.doesNotMatch(reply, /settle|billing|overdue|recognise|[{}]|400/, reply);
    assert.ok(logs.some((l) => l.includes("(billing): merrymen 400 — organization_delinquent")), logs.join("\n"));
  });
});
