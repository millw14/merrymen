/**
 * TWO REPORTS, ONE SHAPE: A FACT THE PRODUCT HELD AND NEVER HANDED OVER.
 *
 *   "Could not load AI models. Check your provider and key, or enter a model
 *    name." — seen by somebody whose chat was working perfectly.
 *
 *   "when i ask bot to trade it says basket empty but basket is not empty"
 *
 * Neither is a lie the code tells on purpose. In both, something downstream was
 * asked a question it had not been given the answer to, and answered anyway.
 *
 * THE MODEL LIST read only the tenant's stored settings, while everything else
 * in the product resolves a key as `str(file, env)` — the tenant's own if they
 * brought one, the house key otherwise. The house pays for inference and
 * GROQ_API_KEY is set on the web service, so a tenant who had never pasted a
 * key of their own got no Authorization header at all, a 401, and a message
 * telling them to check the key that was working.
 *
 * THE BASKET was never in the chat state. The prompt names it five times —
 * "buy when X is already in your basket", "anything off your basket" — and the
 * payload never carried it, so the model guessed, and the natural guess about a
 * list you were never shown is that it is empty.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("the model list falls back to the house key", () => {
  it("A TENANT WITH NO KEY OF THEIR OWN STILL GETS A LIST", () => {
    const src = read("../app/api/models/route.ts");
    assert.match(src, /saved\.groqApiKey \|\| process\.env\.GROQ_API_KEY \|\| ""/);
    assert.match(src, /saved\.anthropicApiKey \|\| process\.env\.ANTHROPIC_API_KEY \|\| ""/);
  });

  it("AND THE HOUSE KEY NEVER GOES TO A CALLER-INFLUENCED URL", () => {
    // Every other provider has a base URL that is a constant in this repo, so
    // there is nothing to aim our credential at. `custom` does not, and pairing
    // the house key with an address somebody else chose is the exfiltration
    // oracle the guard in this file already exists to prevent.
    const src = read("../app/api/models/route.ts");
    const line = src.split("\n").find((l) => l.includes('prov.id === "custom"') && l.includes("apiKey ="));
    assert.ok(line, "the custom branch must still assign a key explicitly");
    assert.match(line!, /apiKey = saved\.llmApiKey \?\? "";/);
    assert.ok(
      !/process\.env/.test(line!),
      "a custom provider must never reach for the house key — its base URL is not ours",
    );
  });

  it("and the existing URL/key pairing guard is untouched", () => {
    // A caller-supplied base URL may still only be probed with a
    // caller-supplied key. Widening the key source must not widen this.
    const src = read("../app/api/models/route.ts");
    assert.match(src, /bodyUrl && bodyUrl !== saved\.llmBaseUrl && !body\.apiKey/);
  });

  it("AND THE FAILURE STOPS BLAMING THE READER FOR OUR OMISSION", () => {
    // The route already returns what actually happened — "provider returned
    // 401", a 502, a timeout — and Settings captured it into state and then
    // rendered one fixed sentence about the user's key instead. Telling
    // somebody to check a working key because we sent no key is the same shape
    // as reporting the market closed when it was our read that failed.
    const ui = read("../terminal/screens/Settings.tsx");
    assert.match(ui, /Could not load the model list — \{modelsError\}/);
    assert.ok(
      !/Could not load AI models\. Check your provider and key, or enter a model name\.<\/p>/.test(ui),
      "the fixed key-blaming sentence must be gone",
    );
    // And it still says the list is optional, because it is.
    assert.match(ui, /the list is a convenience, not a requirement/);
  });
});

describe("the agent can see its own basket", () => {
  it("THE BASKET REACHES THE MODEL", () => {
    // Settings is already fetched in this exact function for `strategy` and
    // `paperTradingEnabled`; the basket was the field beside them that never
    // travelled.
    const agent = read("../terminal/screens/Agent.tsx");
    assert.match(agent, /basketSymbols:\(settings\?\.values\?\.basketSymbols \?\? settings\?\.defaults\?\.basketSymbols \?\? null\)/);
  });

  it("AND NULL IS NOT READ AS EMPTY", () => {
    // preflight.ts already records the same distinction about the same field:
    // "An ABSENT basketSymbols is not an empty basket". The prompt has to carry
    // it, because null here means the settings read failed — the defaults are
    // already substituted one line earlier when they exist.
    const chat = read("../app/api/chat/route.ts");
    assert.match(chat, /Never say it is empty unless that array is present and empty/);
    assert.match(chat, /do NOT report it as empty/);
  });

  it("and it is the field that decides buy versus snipe", () => {
    // The prompt sends `buy` for something already in the basket and `snipe`
    // for anything off it — a decision it could not previously make from the
    // payload it was given.
    const chat = read("../app/api/chat/route.ts");
    assert.match(chat, /it settles whether a coin they name gets \\`buy\\` \(already in it\) or \\`snipe\\` \(not\)/);
  });
});
