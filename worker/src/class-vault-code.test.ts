/**
 * "NO CODE" IS AN ANSWER. IT IS NOT A FAILURE TO ANSWER.
 *
 * The class vault is a CREATE2 prediction: it does not exist until the first
 * class buy creates it, and nothing else ever creates one. So on this route —
 * and on no other route in the product — an address with no code is the
 * ORDINARY state, and the state every new grant starts in.
 *
 * viem's `getCode` maps the RPC's "0x" to `undefined` before the caller sees
 * it. The dispatch then wrote `.catch(() => undefined)` and tested
 * `vaultCode === undefined` to mean "could not read", which folded the two
 * answers together and read the ordinary state as an unreadable one.
 *
 * That deadlocked the whole route, and it deadlocked it silently. Every tick
 * found a qualifying launch, built a valid leg, proposed it, and refused it
 * with `class-vault-unreadable` against an address that was answering
 * perfectly well and saying "nothing here yet". The vault could only be
 * created by a buy; the buy was refused because the vault did not exist. For
 * ever, with a fresh honest-looking refusal every four minutes.
 *
 * The comment above the code said the right thing the whole time — "'could not
 * tell' must never read as 'no'" — while the code did the exact opposite and
 * read "no" as "could not tell".
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createPublicClient, custom } from "viem";

const IDX = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

/** A transport that answers eth_getCode with whatever the test wants. */
const clientReturning = (answer: unknown) =>
  createPublicClient({
    transport: custom({
      request: async ({ method }) => {
        if (method === "eth_getCode") {
          if (answer instanceof Error) throw answer;
          return answer;
        }
        if (method === "eth_chainId") return "0x1237";
        throw new Error(`unexpected ${method}`);
      },
    }),
  });

const ADDR = "0x5fce8e09ce46433f7e7b21a2cdb78becb3fe05cd" as const;

describe("what viem actually returns for an address with no code", () => {
  it("maps the RPC's \"0x\" to undefined — the fact this whole bug rested on", async () => {
    // Pinned as a BEHAVIOUR of the installed viem, not as folklore. If an
    // upgrade ever starts passing "0x" through, the dispatch's `deployed`
    // test has to keep working — which is why it checks both spellings — and
    // this test is where that change announces itself instead of arriving as a
    // vault that reads as deployed and a buy that silently buys nothing.
    const code = await clientReturning("0x").getCode({ address: ADDR });
    assert.equal(code, undefined, "viem still folds \"0x\" into undefined");
  });

  it("returns the bytecode for an address that has some", async () => {
    const code = await clientReturning("0xdeadbeef").getCode({ address: ADDR });
    assert.equal(code, "0xdeadbeef");
  });

  it("THROWS when the node cannot answer — the case that must still refuse", async () => {
    // The distinction the fix restores. A thrown read and a codeless address
    // are different events, and only one of them justifies sending nothing.
    await assert.rejects(() => clientReturning(new Error("node is down")).getCode({ address: ADDR }));
  });
});

describe("the class dispatch tells those two apart", () => {
  /** The vault-existence block inside the class dispatch. */
  const BLOCK = (() => {
    const start = IDX.indexOf("        // ── DOES THE VAULT EXIST? A FRESH READ, EVERY TIME ──");
    assert.ok(start > 0, "the vault-existence read moved — re-point this test, do not delete it");
    return IDX.slice(start, IDX.indexOf("if (!deployed && !isBuy)", start));
  })();

  it("refuses on a THROWN read, not on an empty one", () => {
    // The failure must come from the catch. Folding it back into the value
    // loses the distinction again, so that shape is banned here by name.
    //
    // Against the comment-stripped source: this codebase explains its refusals
    // right where it makes them, and the prose above names the forbidden shape.
    // Asserting against the raw text fails on the explanation rather than on
    // the code — which it did, on the first run of this very test.
    const code = BLOCK.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(code, /\.catch\(\(\) => undefined\)/, "the catch must not be folded back into the value");
    assert.match(BLOCK, /try \{[\s\S]*?getCode\(\{ address: vault \}\)[\s\S]*?\} catch \{/);
    const catchArm = BLOCK.slice(BLOCK.indexOf("} catch {"));
    assert.match(catchArm, /class-vault-unreadable/, "a genuine read failure still refuses");
    assert.match(catchArm, /releaseBudget\(\);[\s\S]*?return;/, "and still sends nothing");
  });

  it("treats BOTH spellings of no-code as not-deployed", () => {
    // undefined is what viem gives today. "0x" is what a different transport
    // or a future version might. Reading either as deployed is the codeless
    // CALL trap: the buy approves USDG, no-ops, and reports `landed`.
    assert.match(
      BLOCK,
      /const deployed = vaultCode !== undefined && vaultCode !== "0x";/,
      "an undeployed vault must be not-deployed under either spelling",
    );
  });

  it("and an undeployed vault still gets a deploy leg prepended", () => {
    // The point of getting `deployed` right. Without the deploy call the batch
    // reaches a codeless address; with it, the vault exists before anything
    // references it.
    const dispatch = IDX.slice(IDX.indexOf("const deployed = vaultCode !== undefined"));
    assert.match(
      dispatch.slice(0, 3000),
      /deployed \|\| !isBuy \? \[\] : \[buildClassVaultDeployCall\(/,
      "a buy against an uncreated vault must carry its deploy",
    );
  });
});

describe("the arm-time report tells them apart too", () => {
  const BLOCK = (() => {
    const start = IDX.indexOf("      let vaultCode: string | undefined;");
    assert.ok(start > 0, "the arm-time vault report moved — re-point this test");
    return IDX.slice(start, IDX.indexOf("} else if (cfg.ponsClassVaultFactory", start));
  })();

  it("says 'could not read' only when the read actually failed", () => {
    assert.match(BLOCK, /if \(vaultUnread\) \{/, "the warning is gated on the throw, not on the value");
    assert.match(BLOCK, /could not read your class vault/);
  });

  it("keeps the ordinary case ordinary — an 'ok', not a 'warn'", () => {
    // Every class-enabled grant starts with no vault. Reporting that as a
    // warning teaches owners to ignore warnings on the one route where the
    // real ones matter.
    const ordinary = BLOCK.slice(BLOCK.indexOf("} else if (noVaultCode) {"));
    assert.match(ordinary, /"ok"/, "an uncreated vault is not a fault");
    assert.match(ordinary, /hasn't been created yet/);
  });

  it("can still detect a vault that NOTHING can create", () => {
    // This branch was unreachable: it tested `vaultCode === "0x"`, which viem
    // never returns. It is the only thing standing between an owner and a
    // route that can never work, so a dead branch here is a silent one.
    assert.match(BLOCK, /noVaultCode && \(!sealedFactory \|\| \(!factoryUnread && noFactoryCode\)\)/);
    // And an UNREAD factory must not be reported as a dead one — unread is not
    // absent, which is the rule this whole file is about.
    assert.ok(BLOCK.includes("!factoryUnread"), "a factory we could not read is not a factory with no code");
  });
});
