/**
 * THE WALLET SCREEN'S RESTORE ASKS THE PERPS WALLET FIRST (restore-perps-owner.ts).
 *
 * The grant POST refuses a Spot grant whose owner key is not the Perps
 * wallet's, and the restore sends that POST last, after its stop and its
 * on-chain revocation. So a restore under another owner key is refused here,
 * before either, and the screen asks this before its first step.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { RESTORE_PERPS_OWNER_DIFFERS, RESTORE_PERPS_UNREAD, restorePerpsRefusal } from "./restore-perps-owner";

const K1 = "0x00000000000000000000000000000000000000a1";
const K2 = "0x00000000000000000000000000000000000000B2";

/** A fetch answering `body` with `status`, recording the URLs it was asked. */
const answering = (status: number, body: unknown, asked: string[] = []) =>
  (async (url: string | URL | Request) => {
    asked.push(String(url));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

describe("restorePerpsRefusal", () => {
  it("asks the Perps wallet, and only it", async () => {
    const asked: string[] = [];
    await restorePerpsRefusal(K1, answering(200, { exists: false }, asked));
    assert.deepEqual(asked, ["/api/grants?wallet=perps"]);
  });

  it("no Perps wallet, or one with the same owner in any case: the restore goes ahead", async () => {
    assert.equal(await restorePerpsRefusal(K1, answering(200, { exists: false })), null);
    assert.equal(await restorePerpsRefusal(K1, answering(200, { exists: true, grant: { owner: K1.toUpperCase().replace("0X", "0x") } })), null);
  });

  it("a Perps wallet under another owner key: refused before anything is stopped or signed", async () => {
    const said = await restorePerpsRefusal(K2, answering(200, { exists: true, grant: { owner: K1 } }));
    assert.equal(said, RESTORE_PERPS_OWNER_DIFFERS);
    assert.match(said!, /Nothing was stopped or signed/);
  });

  it("a Perps wallet that cannot be read is refused too, never taken for none", async () => {
    const throwing = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    for (const [what, read] of [
      ["503", answering(503, { error: "Couldn't read your Perps wallet. Please try again." })],
      ["401", answering(401, { error: "sign in" })],
      ["not JSON", answering(200, "<html>")],
      ["no owner", answering(200, { exists: true, grant: {} })],
      ["no answer", answering(200, {})],
      ["network", throwing],
    ] as const) {
      assert.equal(await restorePerpsRefusal(K1, read), RESTORE_PERPS_UNREAD, what);
    }
  });
});

describe("the Wallet screen's restore", () => {
  it("asks restorePerpsRefusal, with the restored key's own owner, before its stop, its revocation or its funding check", () => {
    const src = readFileSync(new URL("../terminal/screens/Wallet.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const start = src.indexOf("async function onRestore(");
    assert.ok(start > 0, "onRestore is there");
    const body = src.slice(start, src.indexOf("\n  }\n", start));
    const asked = body.indexOf("restorePerpsRefusal(privateKeyToAccount(ownerKey).address)");
    assert.ok(asked > 0, "the restore asks, with the owner of the key it restores");
    for (const step of ["assertRevocationFunded(", "stopAgentForReplacement(", "revokeFromBrowser(", "restoreAgentWallet("]) {
      const at = body.indexOf(step);
      assert.ok(at > 0, `${step} is in the restore`);
      assert.ok(asked < at, `asked before ${step}`);
    }
    assert.match(body.slice(asked - 80, asked + 120), /if \(perpsRefusal\) throw new Error\(perpsRefusal\)/);
  });
});
