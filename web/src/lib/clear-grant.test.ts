import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * KILLING AN AGENT MUST NOT DESTROY THE ONLY COPY OF THE OWNER KEY.
 *
 * `mintGrant` deliberately omits `demoOwnerPrivateKey` from the payload it sends
 * the server when hosted, so that the server is never custodian of an owner key.
 * The consequence is that the browser's localStorage holds the ONLY copy in
 * existence — and `clearGrant()` was a bare `removeItem`.
 *
 * Three call sites reached it, including the kill switch, whose own comment read
 * "server unreachable — still destroy the local key below". So pressing KILL on
 * the hosted service permanently removed the ability to withdraw, for anyone,
 * while the UI said "grant destroyed · worker halts on its next tick". The funds
 * remain on-chain and become unreachable by construction.
 *
 * These are source assertions rather than behavioural ones on purpose: the
 * module is browser-only (it touches `localStorage` at import-scope paths) and
 * the property worth pinning is structural — that the archive happens BEFORE the
 * removal, in this function, forever.
 */

const SESSION = readFileSync(new URL("./session.ts", import.meta.url), "utf8");

/** The body of a top-level `export function <name>(...)` block. */
function bodyOf(src: string, name: string): string {
  const start = src.indexOf(`export function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

test("clearGrant ARCHIVES before it removes — the key survives a kill", () => {
  const body = bodyOf(SESSION, "clearGrant");
  const archiveAt = body.indexOf("archivePreviousGrant");
  const removeAt = body.indexOf("removeItem");
  assert.notEqual(archiveAt, -1, "clearGrant must archive the grant before discarding it");
  assert.notEqual(removeAt, -1, "clearGrant must still remove the live grant");
  assert.ok(
    archiveAt < removeAt,
    "the archive must happen BEFORE the removal — after it, there is nothing left to copy",
  );
});

test("the server copy still omits the owner key — the reason this matters", () => {
  // If this ever stops being true the severity changes completely, so the two
  // facts are pinned together rather than in separate files that could drift.
  assert.match(
    SESSION,
    /hostedAs \? \{\} : \{ demoOwnerPrivateKey: ownerPrivateKey \}/,
    "hosted grants must not send the owner key to the server",
  );
});

test("the archive helper is keyed by account, so a kill cannot clobber another wallet", () => {
  // Private, so read it straight out of the source rather than via bodyOf.
  const at = SESSION.indexOf("function archivePreviousGrant(");
  assert.notEqual(at, -1, "the archive helper must exist");
  const body = SESSION.slice(at, at + 800);
  assert.match(body, /ARCHIVE_PREFIX/, "archives must be namespaced");
  assert.match(
    body,
    /prev\.smartAccount/,
    "and keyed by smart account, so archiving one wallet cannot clobber another",
  );
});

test("the kill switch does not tell the user their wallet is gone", () => {
  const kill = readFileSync(new URL("../components/KillSwitch.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(
    kill,
    /destroy the local key/,
    "the kill path must no longer describe itself as destroying the key",
  );
  assert.match(kill, /recovery key is kept/, "and must say the money is still reachable");
});
