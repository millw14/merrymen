/**
 * THE TWO COMMANDS THAT DECIDE WHETHER REAL MONEY MOVES, MIRRORED BY HAND.
 *
 * `web/src/lib/chat-commands.ts` is the authority, and
 * `android-native/.../ui/Commands.kt` is a hand-written copy of it in another
 * language. Nothing linked them, so nothing noticed when they disagreed.
 *
 * They did disagree. Both `go-paper` and `go-live` wrote `paperTradingEnabled`
 * alone — correct when that was the only field, and wrong from the moment
 * `liveTradingEnabled` became the mode. `paperTradingEnabled` is permission to
 * SIMULATE, consulted only after `canTradeForReal` has already failed and never
 * a term of it, so on the Kotlin client:
 *
 *   go-paper  did not stop real orders  — the owner asked for practice and kept
 *             spending real money, which is the exact defect the consent gate
 *             was built to remove, surviving in a second copy of the registry
 *   go-live   did not start them        — after the gate, an agent that neither
 *             trades nor practises
 *
 * Neither client is shipped from CI today (the published APK is the demo build
 * from `mobile/`, which has no chat-command registry at all), so this was found
 * before it reached anyone. That is the only reason it is a test and not an
 * incident, and it is precisely why the test exists now rather than later.
 *
 * Scope is deliberate: ONLY the consent pair. A full cross-language diff of
 * every command would fail on wording and argument formatting, get relaxed
 * until it proved nothing, and then miss this.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..", "..", "..");

const TS = readFileSync(path.join(REPO, "web", "src", "lib", "chat-commands.ts"), "utf8");
const KT = readFileSync(
  path.join(REPO, "android-native", "app", "src", "main", "java", "dev", "merrymen", "app", "ui", "Commands.kt"),
  "utf8",
);

/** The `fixed` booleans the TypeScript registry sets for one command id. */
function tsFixed(id: string): Record<string, boolean> {
  const start = TS.indexOf(`id: "${id}"`);
  assert.ok(start > 0, `${id} is missing from the TypeScript registry`);
  const next = TS.indexOf('id: "', start + 6);
  const block = TS.slice(start, next === -1 ? undefined : next);
  const fixed = block.match(/fixed:\s*\{([^}]*)\}/);
  assert.ok(fixed, `${id} has no fixed block in the TypeScript registry`);
  const out: Record<string, boolean> = {};
  for (const m of fixed[1]!.matchAll(/(\w+):\s*(true|false)/g)) out[m[1]!] = m[2] === "true";
  return out;
}

/** The same, from the Kotlin mirror's `fixed = mapOf(... to JsonPrimitive(x))`. */
function ktFixed(id: string): { fixed: Record<string, boolean>; writes: string[] } {
  const start = KT.indexOf(`"${id}", Via.SETTINGS`);
  assert.ok(start > 0, `${id} is missing from the Kotlin mirror`);
  const next = KT.indexOf("CommandSpec(", start);
  const block = KT.slice(start, next === -1 ? undefined : next);
  const fixed: Record<string, boolean> = {};
  for (const m of block.matchAll(/"(\w+)"\s+to\s+JsonPrimitive\((true|false)\)/g)) {
    fixed[m[1]!] = m[2] === "true";
  }
  const list = block.match(/listOf\(([^)]*)\)/);
  const writes = list ? [...list[1]!.matchAll(/"(\w+)"/g)].map((m) => m[1]!) : [];
  return { fixed, writes };
}

describe("the Android mirror agrees with the registry about consent", () => {
  for (const id of ["go-paper", "go-live"]) {
    it(`${id} writes the same fields with the same values on both clients`, () => {
      const ts = tsFixed(id);
      const kt = ktFixed(id);
      assert.deepEqual(
        kt.fixed,
        ts,
        `${id} has drifted between web/src/lib/chat-commands.ts and android-native Commands.kt. ` +
          `The TypeScript registry is the authority — change the Kotlin to match it.`,
      );
    });

    it(`${id} declares every field it intends to set`, () => {
      // The mechanism the drift rode in on: `settingsPayload` builds the PUT
      // body from the DECLARED key list, so a field that appears only in the
      // fixed map is at the mercy of that ordering. Declaring both removes the
      // question, and a partial PUT leaves anything undeclared untouched on the
      // server — which is how "go paper" silently left consent switched on.
      const kt = ktFixed(id);
      for (const field of Object.keys(kt.fixed)) {
        assert.ok(
          kt.writes.includes(field),
          `${id} sets ${field} but does not declare it in listOf(...)`,
        );
      }
    });
  }

  it("and liveTradingEnabled is the field both of them turn on the mode with", () => {
    // The assertion that would have caught the original drift on its own: the
    // consent flag must appear in both commands on both clients. If a future
    // edit drops back to paperTradingEnabled alone, this fails even if the two
    // registries agree with each other about being wrong.
    assert.equal(ktFixed("go-paper").fixed.liveTradingEnabled, false);
    assert.equal(ktFixed("go-live").fixed.liveTradingEnabled, true);
    assert.equal(tsFixed("go-paper").liveTradingEnabled, false);
    assert.equal(tsFixed("go-live").liveTradingEnabled, true);
  });
});
