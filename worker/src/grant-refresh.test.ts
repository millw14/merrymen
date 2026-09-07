/**
 * A RE-SIGNED GRANT NEVER REACHED THE AGENT IT WAS SIGNED FOR.
 *
 * `writeGrantForChild` had exactly one caller — `spawnChild`. The reconcile
 * loop refreshed `settings.json` for every RUNNING child every fifteen seconds
 * and did not refresh `grant.json` at all. So:
 *
 *   a config change  → live agent in 15s
 *   a NEW SIGNATURE  → live agent never, until something restarts the child
 *
 * That is the documented purpose of the re-sign path failing silently.
 * `restoreAgentWallet` describes itself as "the RE-SIGN path for widening the
 * tradable set: adding a token in settings can't reach into an already-signed
 * key, so covering it means minting a new grant over the same account." An
 * owner does precisely that, the server accepts it, /grant shows it — and the
 * agent goes on refusing the token with `asset-allowlist`, enforcing the wall
 * it was handed at spawn, because that is the only file it has.
 *
 * The child was always willing: it re-reads `grant.json` each tick and re-arms
 * when the account or `grantedAt` changes. Nobody wrote the file.
 *
 * This is the same class as `curve-wiring.test.ts` — every layer looked wired,
 * the production CALL SITE was missing — and it is tested the same way, by
 * asserting the call site, because that is the bug.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const ORCH = codeOf(readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8"));
const INDEX = codeOf(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));

/** The body of the reconcile loop that walks RUNNING children. */
const RUNNING_LOOP = (() => {
  const at = ORCH.indexOf("for (const tenant of children.keys()) {");
  assert.ok(at > 0, "reconcile must walk the running children");
  return ORCH.slice(at, ORCH.indexOf("\n  }", at));
})();

describe("a running child is handed both halves of its configuration", () => {
  it("THE RECONCILE REFRESHES THE GRANT, NOT ONLY THE SETTINGS", () => {
    // The whole bug, in one assertion.
    assert.match(RUNNING_LOOP, /writeSettingsForChild\(/, "settings already reached a live agent");
    assert.match(RUNNING_LOOP, /refreshGrantForChild\(/, "and now the signature does too");
  });

  it("and the child is already willing to pick it up", () => {
    // Nothing to change on the child side: it re-reads the file each tick and
    // re-arms when the account or grantedAt moves. It was only ever missing the
    // file, which is why the fix belongs entirely in the orchestrator.
    assert.match(INDEX, /active\.grant\.grantedAt === grant\.grantedAt/);
  });
});

describe("what the refresh costs, and what it refuses to do", () => {
  const FN = (() => {
    const at = ORCH.indexOf("async function refreshGrantForChild(");
    assert.ok(at > 0, "refreshGrantForChild must exist");
    return ORCH.slice(at, ORCH.indexOf("\nasync function writeSettingsForChild(", at));
  })();

  it("WRITES ONLY ON CHANGE, comparing the whole grant rather than a key", () => {
    // `grantedAt` is whole seconds — index.ts makes that point about its own
    // dedup key — so a key comparison here could miss a re-sign, and the cost
    // of missing one is an agent enforcing a wall its owner has replaced.
    assert.match(FN, /readFileSync\(file, "utf8"\) === next/);
    assert.ok(!/grantedAt/.test(FN), "the comparison must not narrow to a key that can collide");
  });

  it("does NOT mint an identity — that is spawn-time work", () => {
    // writeGrantForChild also calls identityStore.ensure(). Idempotent, but a
    // store write, and running it for every tenant every fifteen seconds would
    // be pure waste.
    assert.ok(!/getIdentityStore\(\)/.test(FN), "identity minting stays at spawn");
  });

  it("AN UNREADABLE STORE IS NOT A REVOKED GRANT", () => {
    // The kill switch stands an agent down by REMOVING it from the wanted set,
    // further down the same function. A store that would not answer must leave
    // the child with the wall it has, not disarm it.
    assert.match(FN, /\} catch \{[\s\S]*?return;[\s\S]*?\}\s*\n\s*if \(!grant\) return;/);
    assert.ok(!/killChild|rmSync/.test(FN), "the refresh must never stand a child down");
  });

  it("and the file keeps the same owner-only mode as the spawn-time write", () => {
    // grant.json holds the SESSION key. A refresh that widened the mode would
    // quietly undo the permission the spawn path is careful to set.
    assert.match(FN, /mode: 0o600/);
  });
});
