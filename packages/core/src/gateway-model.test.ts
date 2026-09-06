/**
 * THE GATEWAY'S FORCED MODEL MUST BE ONE THAT EXISTS.
 *
 * The Merrymen AI gateway picks the model server-side — that is the whole point
 * of the proxy, and it means the gateway is the only place the choice can be
 * wrong. It was wrong for weeks: both defaults still named
 * `llama-3.3-70b-versatile`, which Groq retired along with the rest of the
 * Llama 3.x chat line.
 *
 * The consequence was not a degraded answer. It was silence with no error
 * anywhere a user could see:
 *
 *   - chat answered `{reply: null, why: "llm-error"}` and the terminal rendered
 *     "Your agent could not reply";
 *   - the strategist caught the throw and returned `[]`, so an agent on this
 *     provider proposed NOTHING, every window, and looked merely quiet;
 *   - the settings page showed "Could not load AI models. Check your provider
 *     and key" — blaming a key that was perfectly good.
 *
 * The same retirement was already fixed once, for the groq provider
 * (`SETTINGS_DEFAULTS.groqModel`, and the trace in llm-providers.ts). The
 * gateway was missed because it is a separate deploy in a language the test
 * glob does not cover: `package.json` runs `worker|web|packages/*` `.ts` tests,
 * and `gateway/selftest.mjs` runs only under `npm run check` inside `gateway/`.
 *
 * So this test lives HERE, inside the glob, and reads the `.mjs` as text. It
 * pins the two defaults AGAINST THE CONSTANT rather than against a literal, so
 * the next time a model is retired they cannot part again: fixing the settings
 * default without fixing the gateway fails this test.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { SETTINGS_DEFAULTS } from "./settings";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Every file that carries a `MERRYMEN_GATEWAY_MODEL ||` fallback. */
const DEFAULT_SITES = [
  // The standalone node server.
  "gateway/server.mjs",
  // The serverless path (gateway/api/*). Fixing only the server above leaves
  // the Vercel deploy answering 404 for every completion — which is exactly
  // how this shipped half-fixed the first time.
  "gateway/lib/instance.mjs",
] as const;

describe("the gateway forces a model that exists", () => {
  it("EVERY DEFAULT EQUALS THE SETTINGS CONSTANT", () => {
    const want = SETTINGS_DEFAULTS.groqModel;
    assert.ok(want, "settings must declare a groq model to pin against");
    for (const file of DEFAULT_SITES) {
      const src = read(file);
      const m = src.match(/MERRYMEN_GATEWAY_MODEL\s*\|\|\s*"([^"]+)"/);
      assert.ok(m, `${file} no longer declares a MERRYMEN_GATEWAY_MODEL default`);
      assert.equal(
        m![1],
        want,
        `${file} forces "${m![1]}" while settings say "${want}" — the two parted again`,
      );
    }
  });

  it("the retired model name is gone from the gateway entirely", () => {
    // Including the example env file: an operator copying it would re-mint the
    // dead name into a fresh deploy, and the failure is silent.
    for (const file of [...DEFAULT_SITES, "gateway/.env.example"]) {
      assert.ok(
        !read(file).includes("llama-3.3"),
        `${file} still names a retired model`,
      );
    }
  });

  it("both deploy shapes serve a models list", () => {
    // An openai-transport provider is expected to have /models — web's route
    // assumes it for every such provider, correctly. The gateway was the
    // outlier, and its catch-all 404 read to a user as a bad API key.
    assert.match(read("gateway/lib/core.mjs"), /function models\(\)/);
    assert.match(read("gateway/server.mjs"), /pathname === "\/v1\/models"/);
    assert.match(read("gateway/api/models.js"), /getGateway\(\)\.models\(\)/);
  });

  it("THE UPSTREAM MODEL NAME NEVER LEAVES THE GATEWAY, on any status", () => {
    // The brand rewrite matched only `"model":"<id>"` — the shape of a SUCCESS
    // body. An upstream error names the model in prose, so for the whole time
    // the forced model was dead, every caller learned the upstream id from the
    // error string. The one fact this proxy exists to withhold, leaking on the
    // path nobody tests.
    const src = read("gateway/lib/core.mjs");
    const chat = src.slice(src.indexOf("async function chat("));
    assert.match(chat, /\.split\(model\)\s*\n?\s*\.join\(brandModel\)/, "the substitution must not be shape-dependent");
    // And the status must still pass through — a strategist that cannot tell
    // 429 from 404 retries a permanent failure forever.
    assert.match(chat, /status: upstream\.status/);
  });
});
