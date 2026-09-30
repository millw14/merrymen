/**
 * THE HOUSE BOT TOKEN MUST NOT REACH A CHILD.
 *
 * Two facts that are each harmless and together are not:
 *
 *   1. `settings.ts` resolves the token as `str(file.telegramBotToken,
 *      env.MERRYMEN_TELEGRAM_BOT_TOKEN)` — the tenant's own file FIRST, the
 *      environment as a FALLBACK. That is right for a self-hosted install,
 *      where the environment is the owner's.
 *   2. Hosted, every child inherits the orchestrator's environment minus
 *      `CHILD_SECRET_STRIP`.
 *
 * So an orchestrator environment that ever carried this variable would hand
 * the house bot to every tenant who had not set one of their own. They would
 * all long-poll the same bot, and a `/link` from any chat would bind to
 * whichever child answered first — control of one stranger's agent handed to
 * another, silently, and looking exactly like the product working.
 *
 * AND THE GUARD BUILT FOR THIS CANNOT SEE IT. The bot claims (claimGate over
 * `telegram_bot_claims`, telegram-claims.ts) are judged on the tokens in
 * tenants' SETTINGS; a token arriving by environment is invisible to them, so
 * the one collision they exist to prevent is the one they would miss.
 *
 * Latent when written — the variable is set nowhere in this repo and was
 * absent from the deployed environment. Stripped anyway: the cost is one line
 * and the failure mode is silent and cross-tenant.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_ENV = "MERRYMEN_TELEGRAM_BOT_TOKEN";

describe("the house bot token cannot reach a child", () => {
  it("IS STRIPPED FROM A CHILD'S ENVIRONMENT", () => {
    const src = readFileSync(path.join(WORKER_SRC, "orchestrator.ts"), "utf8");
    const i = src.indexOf("const CHILD_SECRET_STRIP = [");
    assert.ok(i > 0, "the strip list must exist for this to mean anything");
    const block = src.slice(i, src.indexOf("] as const;", i));
    assert.ok(block.includes(TOKEN_ENV), `${TOKEN_ENV} is not stripped from a child's environment`);
  });

  it("and the strip is LOAD-BEARING, because the env is still a fallback", () => {
    // The pairing is the whole point. If someone later removes the env
    // fallback, this assertion fails and tells the next reader the strip has
    // become belt-and-braces rather than the only thing standing between a
    // house token and every tenant's child. If someone removes the STRIP, the
    // test above fails instead. Neither half is safe to delete alone.
    const src = readFileSync(path.join(WORKER_SRC, "settings.ts"), "utf8");
    assert.match(
      src,
      new RegExp(`telegramBotToken:\\s*str\\(file\\.telegramBotToken,\\s*env\\.${TOKEN_ENV}\\)`),
      "settings.ts no longer resolves the bot token with an env fallback — re-read why the strip exists",
    );
  });

  it("is not set anywhere in this repo's own configuration", () => {
    // If a deploy config ever starts setting it, that is a deliberate act and
    // the strip above is what keeps it from leaking. Nothing here should be
    // seeding it by accident.
    for (const f of ["settings.ts", "orchestrator.ts"]) {
      const src = readFileSync(path.join(WORKER_SRC, f), "utf8");
      const assigns = src.match(new RegExp(`${TOKEN_ENV}\\s*=`, "g")) ?? [];
      assert.deepEqual(assigns, [], `${f} assigns ${TOKEN_ENV}`);
    }
  });
});
