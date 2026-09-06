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
  //
  // The condition gained a SECOND arm when Privy became a possible owner: a
  // Privy-owned grant has no key to omit, because merrymen never holds one.
  // Both arms are asserted, because either going missing is a different
  // disaster — dropping `hostedAs` posts a key to the server, and dropping the
  // binding check makes a Privy grant read `privateKey` off a signer that has
  // no such field.
  assert.match(
    SESSION,
    /hostedAs \|\| ownerSigner\.binding !== "legacy-wallet-owner-v1"/,
    "hosted grants must not send the owner key, and a privy owner has none to send",
  );
  assert.match(
    SESSION,
    /demoOwnerPrivateKey: ownerSigner\.privateKey/,
    "the browser copy of a browser-generated owner still carries its key",
  );
});

test("A PRIVY-OWNED GRANT HAS NO OWNER KEY ANYWHERE — and the trade-off is stated", () => {
  // The custody this file exists to protect changes shape rather than
  // disappearing. There is no localStorage key to destroy on a kill, which
  // removes that whole class of irreversible loss — and equally means merrymen
  // cannot sweep such an account from a backed-up key, because none exists.
  // Recovery for a Privy-owned Merryman is signer-based and NOT yet built, so
  // the code must say so where somebody will read it.
  const at = SESSION.indexOf("export async function createPrivyOwnedWallet");
  assert.notEqual(at, -1, "the privy-owned mint path must exist");
  // Whitespace-normalised: a doc comment wraps, so a phrase that reads as one
  // sentence is several lines with ` * ` between them. Matching the raw text
  // would make this assertion fail on a reflow rather than on a real change.
  const doc = SESSION.slice(Math.max(0, at - 1400), at).replace(/\s*\*\s*/g, " ").replace(/\s+/g, " ");
  assert.match(doc, /no key for merrymen to hold/i);
  assert.match(doc, /NOT yet built/i, "the recovery gap must be stated, not implied");
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

test("AN ABSENT KEY IS NOT AN UNREADABLE KEY — the screens tell each truth", () => {
  // A tester with a working Privy account was shown "recovery key is only a
  // bunch of dots", then "couldn't read your owner key — don't fund this
  // account, and tell us". Nothing had gone wrong. A Privy-owned account HAS
  // no key here by design, and reading its absence as a failure warned
  // somebody off funding an account that was fine — on the screen where being
  // wrong costs the most.
  //
  // The binding version is the durable signal, sealed into the grant at
  // signing time, so it cannot drift from what the account actually is.
  // Same URL-relative form the rest of this file uses.
  const create = readFileSync(new URL("../terminal/screens/CreateAgent.tsx", import.meta.url), "utf8");
  const wallet = readFileSync(new URL("../terminal/screens/Wallet.tsx", import.meta.url), "utf8");

  for (const [name, src] of [["CreateAgent", create], ["Wallet", wallet]] as const) {
    assert.match(src, /isPrivyOwned\(/, `${name} must distinguish the two owner models`);
  }

  // The unreadable-key warning may still exist — it is correct for a legacy
  // grant — but it must be unreachable for a privy-owned one.
  // Anchored on the row itself, not the first mention of the phrase.
  const rowAt = wallet.indexOf("<span className=\"rk\">owner key</span>");
  assert.notEqual(rowAt, -1, "the owner-key row must exist");
  const keyRow = wallet.slice(rowAt, rowAt + 1800);
  assert.ok(
    keyRow.indexOf("isPrivyOwned(grant)") < keyRow.indexOf("couldn't read your owner key"),
    "the privy branch must be taken BEFORE the unreadable-key fallback",
  );

  // And the privy backup step must not ask somebody to confirm they saved
  // something that does not exist.
  const privyStep = create.slice(create.indexOf("isPrivyOwned(grant)"), create.indexOf("!isPrivyOwned(grant)"));
  assert.ok(!/saved my recovery key/.test(privyStep), "nothing was shown, so nothing can be saved");
  assert.match(privyStep, /merrymen cannot recover these funds/, "the real trade-off must be stated instead");
});
