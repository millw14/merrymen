/**
 * THE WALLET THAT SIGNED A CHAIN NOBODY CHOSE.
 *
 * Reported from the beta, and reproducible: create an agent, pick "paper mode",
 * go to Wallet & permissions to re-sign — and it lands on the Backup step with
 * MAINNET selected. Re-sign back to testnet and the chat then says "This
 * agent's permission is for a different network than the one trading happens
 * on… funds sent here will sit unused." The tester found the trigger himself:
 * it happens after "discard & start over".
 *
 * THREE THINGS COMBINED, and each is defensible alone.
 *
 * One: "paper mode" in the create wizard is `paperTradingEnabled`, a SETTING.
 * The chain there is a hardcoded 4663 and the step even prints "Network:
 * Robinhood Chain". A reasonable person reads "paper" as "test network".
 *
 * Two: `chainId` on the wallet screen initialises to MAINNET, and the mount
 * effect only overwrites it `if (stored)`. That default is deliberate — the
 * comment there explains that defaulting to testnet would let a mainnet owner
 * click renew and silently re-sign onto the sandbox.
 *
 * Three: `discard()` reset six pieces of state and not those two. So after a
 * start-over there is no stored grant, the selector falls back to its initial
 * value, and the next signature seals a chain the owner never picked on that
 * screen — in either direction.
 *
 * A signature is the one thing here that cannot be undone by an edit, so the
 * state that decides what it seals must not survive a "start over".
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SRC = readFileSync(new URL("./screens/Wallet.tsx", import.meta.url), "utf8");
const CREATE = readFileSync(new URL("./screens/CreateAgent.tsx", import.meta.url), "utf8");

/** The body of a named function, so a rule cannot be matched from a neighbour. */
const fn = (name: string): string => {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} went missing`);
  return SRC.slice(at, SRC.indexOf("\n  }", at));
};

describe("start over starts the chain over too", () => {
  it("DISCARD RESETS THE CHAIN", () => {
    // Without this the next re-sign seals whatever the discarded wallet had.
    assert.match(fn("discard"), /setChainId\(MAINNET\)/);
  });

  it("AND THE CAPS, which a signature also seals", () => {
    assert.match(fn("discard"), /setCaps\(PRESETS\[0\]!\.caps\)/);
  });

  it("and it still resets everything it already did", () => {
    // A regression here would be silent: the grant would clear and some other
    // piece of the discarded wallet would persist into the next signature.
    const d = fn("discard");
    for (const call of ["setGrant(null)", "setBackedUp(false)", "setMainnetAck(false)", "setFunding(null)"]) {
      assert.ok(d.includes(call), `discard no longer does ${call}`);
    }
  });
});

describe("the chain a hosted owner cannot use says so before they pick it", () => {
  it("THE PRACTICE CARD WARNS ON THE HOSTED SERVICE", () => {
    // The worker trades Robinhood Chain, so a hosted key signed for the sandbox
    // cannot trade at all. That was only discoverable afterwards, from the chat.
    assert.match(SRC, /Not for this service — your agent trades Robinhood Chain/);
  });

  it("AND SO DOES THE MOVE-TO-TESTNET CHECKBOX", () => {
    assert.match(SRC, /on this service it cannot be used for anything/);
  });

  it("and both point at the thing that DOES give practice", () => {
    // Paper trading is a setting on the same chain, needs no signature, and is
    // what the owner meant. Naming it is the difference between a refusal and
    // an answer.
    assert.equal((SRC.match(/paper trading/gi) ?? []).length >= 2, true);
  });
});

describe("and the wizard stops reading like a network choice", () => {
  it("PAPER MODE SAYS IT IS A SETTING, NOT A CHAIN", () => {
    assert.match(CREATE, /This is a setting, not a different network/);
    assert.match(CREATE, /stays on Robinhood Chain either way/);
  });

  it("and the wizard still mints on the one chain it always did", () => {
    // The fix is in the words, not the behaviour: creation has never had a
    // chain choice, and adding one here would be a new way to get this wrong.
    assert.match(CREATE, /chainId:4663/);
  });
});
