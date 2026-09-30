import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { SIGNED_IN_RELOAD_GAP_MS, shouldJumpToResign, shouldReloadAfterSignIn } from "./resign-anchor";

describe("landing on /grant#resign", () => {
  it("jumps once the section exists, and only for #resign", () => {
    assert.equal(shouldJumpToResign("#resign", false, true), true);
    assert.equal(shouldJumpToResign("#resign", false, false), false, "not yet rendered: wait for it");
    assert.equal(shouldJumpToResign("", false, true), false, "no anchor, no jump");
    assert.equal(shouldJumpToResign("#fund", false, true), false);
  });

  it("never twice — a later re-render must not drag the owner back up", () => {
    assert.equal(shouldJumpToResign("#resign", true, true), false);
  });
});

describe("reloading after a sign-in, without a loop", () => {
  const NOW = 1_790_000_000_000;

  it("reloads a page that has no agent to show yet", () => {
    assert.equal(shouldReloadAfterSignIn(false, 0, NOW), true);
  });

  it("leaves a page alone that already shows the agent", () => {
    assert.equal(shouldReloadAfterSignIn(true, 0, NOW), false);
  });

  it("never reloads twice in a minute — the guard against Privy's automatic sign-in loop", () => {
    assert.equal(shouldReloadAfterSignIn(false, NOW - 5_000, NOW), false);
    assert.equal(shouldReloadAfterSignIn(false, NOW - SIGNED_IN_RELOAD_GAP_MS, NOW), true);
  });

  it("with unreadable storage it cannot remember, so it does not reload at all", () => {
    assert.equal(shouldReloadAfterSignIn(false, null, NOW), false);
  });
});

describe("INVARIANT: the grant page wires both", () => {
  const src = readFileSync(new URL("../terminal/screens/Wallet.tsx", import.meta.url), "utf8");
  const hosted = readFileSync(new URL("../terminal/HostedControls.tsx", import.meta.url), "utf8");

  it("the section keeps its anchor, and the page jumps to it through the rule above", () => {
    assert.match(src, /<div id="resign"/);
    assert.match(src, /shouldJumpToResign\(window\.location\.hash, resignJumped\.current, present\)/);
    assert.match(src, /\}, \[wizStep, grant, serverArmed\]\);/, "re-checked as the grant loads");
  });

  it("the reload goes through the loop guard", () => {
    assert.match(src, /shouldReloadAfterSignIn\(hasGrantRef\.current, lastAt, Date\.now\(\)\)/);
  });

  it("every sign-in announces itself", () => {
    assert.match(hosted, /const done=\(\)=>\{announceSignedIn\(\);onDone\(\);\};/);
    assert.match(hosted, /<PrivySignIn onDone=\{done\}\/>/);
    assert.match(hosted, /<WalletSignIn onDone=\{done\}\/>/);
  });
});
