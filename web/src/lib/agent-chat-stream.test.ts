/**
 * /api/chat, STREAMED: THE SAME REPLY, THE SAME PROPOSAL RULE, SOONER.
 *
 * The browser now asks for `text/event-stream` and shows the agent's words as
 * they arrive. Nothing about WHAT may be proposed changes: the prompt is built
 * and defanged exactly as before, and the command is read by splitCommand from
 * the COMPLETE reply — so the end-anchored marker rule is checked against the
 * whole text, never a prefix, and no piece of a marker is ever sent as text.
 *
 * Driven through the real response builder with a scripted provider that
 * emits the reply in awkward pieces, and read back with the browser's own
 * stream reader.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import { agentReplyResponse, generateAgentReply, onHouseKey, type AgentChatOptions } from "./agent-chat";
import { readReplyStream } from "./chat-stream";
import Anthropic from "@anthropic-ai/sdk";
import type { LlmCreds } from "../../../worker/src/llm";

const credentials = (): LlmCreds => ({ provider: "test", transport: "openai", baseUrl: "https://example.com/v1", model: "m", apiKey: "k", vision: false });

/** A provider that writes `reply` in pieces of `n` characters. */
function provider(reply: string, n = 3, seen?: { prompt?: string }): AgentChatOptions["stream"] {
  return async (_creds, req, onText) => {
    if (seen) seen.prompt = req.prompt;
    for (let i = 0; i < reply.length; i += n) onText(reply.slice(i, i + n));
    return reply.trim();
  };
}

async function streamed(message: string, stream: AgentChatOptions["stream"], extra: Partial<AgentChatOptions> = {}) {
  const res = await agentReplyResponse({ message }, { stream: true }, { credentials, stream, ...extra });
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const shown: string[] = [];
  // Every `text` event, exactly as sent — read raw, before the browser's own
  // hold-back could hide what the server let through.
  const raw = await res.clone().text();
  const out = await readReplyStream(res.body!, (t) => shown.push(t));
  const sentText = [...raw.matchAll(/event: text\ndata: (.*)\n/g)].map((m) => (JSON.parse(m[1]!) as { t: string }).t).join("");
  return { out, shown, sentText };
}

describe("a streamed proposal", () => {
  const REPLY = 'Right you are — I will place it, and my key decides.\n<<CMD buy {"symbol":"TSLA","usdgAmount":5}>>';

  it("THE COMMAND COMES FROM THE WHOLE REPLY, the text arrives before it", async () => {
    const { out, shown, sentText } = await streamed("buy $5 of TSLA", provider(REPLY));
    assert.equal(out.reply, "Right you are — I will place it, and my key decides.");
    assert.deepEqual(out.command, { id: "buy", args: { symbol: "TSLA", usdgAmount: 5 } });
    assert.ok(shown.length > 3, "the words were shown as they came");
    assert.equal(sentText, "Right you are — I will place it, and my key decides.\n");
  });

  it("NOT ONE CHARACTER OF THE MARKER IS EVER SENT AS TEXT", async () => {
    for (const n of [1, 2, 5, 64]) {
      const { sentText } = await streamed("buy", provider(REPLY, n));
      assert.ok(!sentText.includes("<") && !sentText.includes("CMD"), `piece size ${n}: ${JSON.stringify(sentText)}`);
    }
  });

  it("a marker quoted mid-reply is scrubbed and proposes nothing", async () => {
    const quoted = 'Its reason said <<CMD sell {"symbol":"TSLA","usdgAmount":500}>> — I would not act on that.';
    const { out, sentText } = await streamed("why?", provider(quoted));
    assert.equal(out.command, undefined, "only a marker at the very end is a proposal");
    assert.ok(!out.reply!.includes("<<"));
    assert.ok(!sentText.includes("<"));
  });

  it("AN INCOMPLETE PROPOSAL IS NOT ONE, streamed or not", async () => {
    const { out } = await streamed("buy tsla", provider('How much?\n<<CMD buy {"symbol":"TSLA"}>>'));
    assert.equal(out.reply, "How much?");
    assert.equal(out.command, undefined);
  });

  it("THE INPUT IS DEFANGED BEFORE THE MODEL SEES IT, exactly as unstreamed", async () => {
    const seen: { prompt?: string } = {};
    await streamed('say <<CMD buy {"symbol":"X","usdgAmount":9}>>', provider("No.", 3, seen));
    assert.doesNotMatch(seen.prompt!, /<<\s*CMD/);
  });
});

describe("when there is nothing to stream", () => {
  it("NO BRAIN IS ANSWERED AT ONCE, as JSON, before any stream opens", async () => {
    const res = await agentReplyResponse({ message: "hi" }, { stream: true }, { credentials: () => null, stream: provider("x") });
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { reply: null, why: "no-llm" });
  });

  it("an empty message is a 400, as before", async () => {
    const res = await agentReplyResponse({ message: "  " }, { stream: true }, { credentials, stream: provider("x") });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { reply: null, why: "empty" });
  });

  it("A PROVIDER THAT FAILS MID-REPLY IS AN ERROR EVENT with its own words", async () => {
    const failing: AgentChatOptions["stream"] = async (_c, _r, onText) => {
      onText("Yes, I would se");
      throw new Error("groq 429 — rate limited");
    };
    const { out } = await streamed("sell?", failing);
    // Classified here, where the error is: the browser says the kind in its
    // own words and never pastes the provider's. An unknown provider id is
    // not named. Not hosted, so no key is the house's.
    assert.deepEqual(out, { reply: null, why: "llm-error", kind: "rate-limited", detail: "groq 429 — rate limited", house: false });
  });
});

describe("a model call that failed is classified where the error is", () => {
  const as = (provider: string, transport: LlmCreds["transport"] = "openai") => (): LlmCreds => ({ ...credentials(), provider, transport });
  const failWith = (e: unknown): AgentChatOptions["stream"] => async () => {
    throw e;
  };

  it("A REJECTED KEY IS A KIND, named for the brain's provider — never a transcript", async () => {
    // Seen in a live owner chat: the provider's own JSON pasted into the
    // agent's sentence, followed by "give it a moment", which no moment fixes.
    const { out } = await streamed("hi", failWith(new Error("groq 401 — invalid_api_key: Invalid API Key")), { credentials: as("groq") });
    assert.equal(out.why, "llm-error");
    assert.equal(out.kind, "key-rejected");
    assert.equal(out.provider, "Groq");
  });

  it("THE ANTHROPIC SDK'S ERROR IS READ FOR WHAT IT IS, not for its message", async () => {
    // Its message is the status and the whole JSON body. providerError never
    // saw it, so it reached the owner as "401 {\"type\":\"error\",…}".
    const e = new Anthropic.AuthenticationError(
      401,
      { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" }, request_id: "req_011" },
      undefined,
      new Headers(),
    );
    assert.match(e.message, /^401 \{"type":"error"/, "the SDK's own message, as the reviewer saw it");
    const { out } = await streamed("hi", failWith(e), { credentials: as("anthropic", "anthropic") });
    assert.equal(out.kind, "key-rejected");
    assert.equal(out.provider, "Anthropic");
    assert.doesNotMatch(out.detail ?? "", /[{}]|request_id|req_011/, "no JSON rides along either");
    const overloaded = new Anthropic.InternalServerError(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, undefined, new Headers());
    assert.equal((await streamed("hi", failWith(overloaded), { credentials: as("anthropic", "anthropic") })).out.kind, "provider-down");
    const gone = new Anthropic.APIConnectionError({ message: undefined });
    assert.equal((await streamed("hi", failWith(gone), { credentials: as("anthropic", "anthropic") })).out.kind, "unreachable");
  });

  it("THE DETAIL THAT RIDES ALONG IS REDACTED — the brain's own key and anything shaped like a secret", async () => {
    // `detail` goes to the browser in the SSE error event and the JSON
    // failure. Every other test's key is "k", and redaction ignores a known
    // secret shorter than eight characters, so nothing could see it happen.
    const KEY = "brain-key-0f3a9c7e51d2";
    const BLOB = "gsk_" + "Q".repeat(24);
    const withKey = () => ({ ...credentials(), provider: "anthropic", transport: "anthropic" as const, apiKey: KEY });
    const e = new Anthropic.AuthenticationError(
      401,
      { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY} (also tried ${BLOB})` } },
      undefined,
      new Headers(),
    );
    const { out } = await streamed("hi", failWith(e), { credentials: withKey });
    assert.equal(out.kind, "key-rejected", "still classified");
    assert.match(out.detail ?? "", /\[redacted\]/, "the detail is still there, with the secrets marked");
    assert.ok(!(out.detail ?? "").includes(KEY), "not the key");
    assert.ok(!(out.detail ?? "").includes(BLOB), "not a secret-shaped blob");
    // An error thrown with the key in its own message — not through the SDK,
    // not through providerError — is redacted the same way.
    const plain = await streamed("hi", failWith(new Error(`request to https://api.example.com?key=${KEY} failed, reason: ECONNRESET`)), { credentials: withKey });
    assert.ok(!(plain.out.detail ?? "").includes(KEY), "nor a key an error message carried on its own");
    // Redacted before it is cut to length: a key straddling the cut would
    // otherwise leave its first half behind, and no whole key to match.
    const head = "anthropic 401 — authentication_error: ";
    const straddle = new Anthropic.AuthenticationError(
      401,
      { type: "error", error: { type: "authentication_error", message: `${"x".repeat(300 - head.length - 6)} ${KEY}` } },
      undefined,
      new Headers(),
    );
    const cut = (await streamed("hi", failWith(straddle), { credentials: withKey })).out.detail ?? "";
    assert.equal(cut.length, 300);
    assert.ok(!cut.includes(KEY.slice(0, 5)), "no half of a key at the cut");
    // And the unstreamed answer carries the same redacted detail.
    const res = await agentReplyResponse({ message: "hi" }, { stream: false }, { credentials: withKey, complete: failWith(e) as unknown as AgentChatOptions["complete"] });
    const body = (await res.json()) as { detail?: string };
    assert.ok(body.detail && !body.detail.includes(KEY) && !body.detail.includes(BLOB), "unstreamed too");
  });

  it("each situation an owner can act on has its kind", async () => {
    const cases: [string, string][] = [
      ["groq 429 — rate_limit_exceeded: slow down", "rate-limited"],
      ["groq 404 — model_not_found: The model does not exist", "model-missing"],
      ["groq 503 — service unavailable", "provider-down"],
      ["fetch failed", "unreachable"],
      ["groq llama returned an empty reply (finish_reason: stop)", "other"],
    ];
    for (const [message, kind] of cases) {
      assert.equal((await streamed("hi", failWith(new Error(message)), { credentials: as("groq") })).out.kind, kind, message);
    }
  });

  it("A PROVIDER STREAM CUT MID-REPLY IS A CUT-OFF, which asking again can fix", async () => {
    const { out } = await streamed("hi", failWith(new Error("groq llama stream ended before the reply was finished")), { credentials: as("groq") });
    assert.deepEqual(out, { reply: null, why: "cut-off" });
  });

  it("the unstreamed answer is classified the same way", async () => {
    const res = await agentReplyResponse({ message: "hi" }, { stream: false }, {
      credentials: as("groq"),
      complete: async () => {
        throw new Error("groq 401 — invalid_api_key: Invalid API Key");
      },
    });
    const body = (await res.json()) as { why?: string; kind?: string; provider?: string };
    assert.equal(body.why, "llm-error");
    assert.equal(body.kind, "key-rejected");
    assert.equal(body.provider, "Groq");
  });

  it("a custom provider is not named by its catalogue label", async () => {
    const { out } = await streamed("hi", failWith(new Error("fetch failed")), { credentials: as("custom") });
    assert.equal(out.kind, "unreachable");
    assert.equal(out.provider, undefined);
  });
});

/**
 * WHOSE KEY A FAILED CALL RAN ON. 2026-10-09: the house Groq account was held
 * over an unpaid bill, and a new hosted agent sent its tester to "its setup" —
 * while /api/chat logged nothing at all. The kind, the house flag and the log
 * line are decided here, where the error and the creds are.
 */
describe("a failed call on the house's key", () => {
  const HOUSE = "gsk_house_fleet_key_0123456789abcdef";
  const SAVED = "gsk_owner_saved_key_fedcba9876543210";
  const HELD =
    "groq 400 — organization_delinquent: Organization has been restricted because of overdue payment(s). " +
    "Please update the payment method at https://console.groq.com/settings/billing/manage and then contact support.";
  const ENV = ["GROQ_API_KEY", "MERRYMEN_LLM_API_KEY", "ANTHROPIC_API_KEY"] as const;
  const saved = new Map(ENV.map((k) => [k, process.env[k]]));
  const groq = (apiKey: string) => (): LlmCreds => ({ provider: "groq", transport: "openai", baseUrl: "https://api.groq.com/openai/v1", model: "m", apiKey, vision: false });
  const failWith = (e: unknown): AgentChatOptions["stream"] => async () => {
    throw e;
  };
  let warned: string[] = [];

  before(() => {
    // As the deployment sets it — with the stray whitespace an env file carries.
    process.env.GROQ_API_KEY = ` ${HOUSE}\n`;
    delete process.env.MERRYMEN_LLM_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    mock.method(console, "warn", (...args: unknown[]) => {
      warned.push(args.map(String).join(" "));
    });
  });
  beforeEach(() => {
    warned = [];
  });
  after(() => {
    mock.restoreAll();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("HOSTED, ON THE DEPLOYMENT'S OWN KEY: billing, and house — streamed and not", async () => {
    const { out } = await streamed("hi", failWith(new Error(HELD)), { credentials: groq(HOUSE), hosted: true });
    assert.equal(out.why, "llm-error");
    assert.equal(out.kind, "billing", "not 'a reason I don't recognise'");
    assert.equal(out.house, true);
    assert.equal(out.provider, "Groq");
    const res = await agentReplyResponse({ message: "hi" }, { stream: false }, {
      credentials: groq(HOUSE),
      hosted: true,
      complete: async () => {
        throw new Error(HELD);
      },
    });
    const body = (await res.json()) as { kind?: string; house?: unknown };
    assert.equal(body.kind, "billing");
    assert.equal(body.house, true, "the JSON answer carries it too");
  });

  it("A KEY THE OWNER SAVED IS THEIRS: house is false, hosted or not", async () => {
    assert.equal((await streamed("hi", failWith(new Error(HELD)), { credentials: groq(SAVED), hosted: true })).out.house, false);
    // Self-hosted the env is the owner's own machine: its key is theirs too.
    assert.equal((await streamed("hi", failWith(new Error(HELD)), { credentials: groq(HOUSE), hosted: false })).out.house, false);
    assert.equal((await streamed("hi", failWith(new Error(HELD)), { credentials: groq(HOUSE) })).out.house, false, "unsaid is not hosted");
  });

  it("THE HOLDER GATEWAY'S UPSTREAM IS THE HOUSE'S: its hold and its model are ours, hosted or not; an expired claim is the holder's", async () => {
    // gateway/lib/core.mjs relays its upstream's status and body untouched,
    // so the house Groq account's hold reached holders as "merrymen 400 — …",
    // and a holder token is no env key: by value it was the holder's bill.
    const holder = (): LlmCreds => ({ provider: "merrymen", transport: "openai", baseUrl: "https://gateway.example/v1", model: "merrymen-fast", apiKey: "mm_holder_claim_token_0123456789", vision: false });
    const said = async (line: string, hosted?: boolean) =>
      (await streamed("hi", failWith(new Error(line)), { credentials: holder, ...(hosted === undefined ? {} : { hosted }) })).out;
    for (const hosted of [undefined, false, true]) {
      const held = await said(HELD.replace(/^groq /, "merrymen "), hosted);
      assert.equal(held.kind, "billing");
      assert.equal(held.house, true, `hosted: ${hosted}`);
      assert.equal(held.provider, "Merrymen AI");
      const gone = await said("merrymen 404 — model_not_found: The model `merrymen-fast` does not exist or you do not have access to it.", hosted);
      assert.equal(gone.kind, "model-missing");
      assert.equal(gone.house, true, `the gateway forces its model (hosted: ${hosted})`);
    }
    const expired = await said("merrymen 401 — invalid or expired Merrymen AI token — re-claim at /claim");
    assert.equal(expired.kind, "key-rejected");
    assert.equal(expired.house, false, "the gateway's own 401 is the holder's claim to renew");
    assert.match(warned.find((l) => l.includes("(billing")) ?? "", /^\[chat\] model call failed \(billing, house\): merrymen 400/);
  });

  it("onHouseKey: by value, against each of the deployment's three key variables, and only hosted", () => {
    const env = { GROQ_API_KEY: "g-house-key-1", MERRYMEN_LLM_API_KEY: " l-house-key-2 ", ANTHROPIC_API_KEY: "a-house-key-3" };
    for (const key of ["g-house-key-1", "l-house-key-2", "a-house-key-3", " g-house-key-1 "]) {
      assert.equal(onHouseKey(key, true, env), true, key);
      assert.equal(onHouseKey(key, false, env), false, `self-hosted: ${key}`);
    }
    assert.equal(onHouseKey("an-owner-key", true, env), false);
    assert.equal(onHouseKey("", true, { GROQ_API_KEY: "" }), false, "a keyless brain (Ollama) is nobody's house key");
    assert.equal(onHouseKey("g-house-key", true, env), false, "a prefix is not the key");
  });

  it("ONLY THE BOOLEAN LEAVES — never the key, nor any part of it", async () => {
    // A provider that echoes the key back, in the worst place it could.
    const echo = new Error(`groq 400 — organization_delinquent: overdue payment(s) on ${HOUSE}`);
    const res = await agentReplyResponse({ message: "hi" }, { stream: true }, { credentials: groq(HOUSE), hosted: true, stream: failWith(echo) });
    const raw = await res.text();
    assert.match(raw, /"house":true/);
    assert.ok(!raw.includes(HOUSE.slice(0, 12)), raw);
    assert.ok(warned.length === 1 && !warned[0]!.includes(HOUSE.slice(0, 12)), warned.join("\n"));
  });

  it("THE FAILURE IS LOGGED, which /api/chat never did: kind, whose key, and the redacted line", async () => {
    await streamed("hi", failWith(new Error(HELD)), { credentials: groq(HOUSE), hosted: true });
    assert.deepEqual(warned, [`[chat] model call failed (billing, house): ${HELD}`]);
    warned = [];
    await generateAgentReply({ message: "hi" }, {
      credentials: groq(SAVED),
      hosted: true,
      complete: async () => {
        throw new Error("groq 401 — invalid_api_key: Invalid API Key");
      },
    });
    assert.deepEqual(warned, ["[chat] model call failed (key-rejected, own): groq 401 — invalid_api_key: Invalid API Key"]);
  });

  it("the partner surface logs it too, and answers exactly as before", async () => {
    const out = await generateAgentReply({ message: "hi" }, {
      surface: "partner",
      credentials: groq(HOUSE),
      hosted: true,
      complete: async () => {
        throw new Error(HELD);
      },
    });
    assert.deepEqual(out, { reply: null, why: "llm-error" }, "no kind, no house, no detail for a partner");
    assert.equal(warned.length, 1);
    assert.match(warned[0]!, /^\[chat\] model call failed \(billing, partner\): groq 400 — organization_delinquent/);
  });

  it("a request the owner walked away from is not logged as the model failing", async () => {
    const gone = new AbortController();
    gone.abort();
    await generateAgentReply({ message: "hi" }, {
      credentials: groq(HOUSE),
      hosted: true,
      complete: async () => {
        throw new Error("This operation was aborted");
      },
    }, gone.signal);
    assert.deepEqual(warned, []);
  });
});

describe("the unstreamed answer is unchanged", () => {
  it("A CLIENT THAT DID NOT ASK FOR A STREAM GETS THE SAME JSON AS EVER", async () => {
    const res = await agentReplyResponse({ message: "open settings" }, { stream: false }, {
      credentials,
      complete: async () => "Here you go.\n<<CMD open-settings {}>>",
    });
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await res.json(), { reply: "Here you go.", command: { id: "open-settings", args: {} } });
  });
});
