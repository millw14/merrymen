/**
 * THE WALLET SCREEN'S RESTORE AND RENEWAL ASK THE PERPS WALLET FIRST (restore-perps-owner.ts).
 *
 * The grant POST refuses a Spot grant whose owner key is not the Perps
 * wallet's, and the restore and the renewal send that POST last, after their
 * stop and their on-chain revocation. So either one the POST would refuse is
 * refused here, before both, and the screen asks this before its first step.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  RENEWAL_PERPS_OWNER_DIFFERS, RENEWAL_PERPS_UNREAD, RESTORE_PERPS_HOSTED, RESTORE_PERPS_OWNER_DIFFERS, RESTORE_PERPS_UNREAD,
  renewalPerpsRefusal, restorePerpsRefusal,
} from "./restore-perps-owner";

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

  it("HOSTED, NO KEY IS RESTORED WHILE A PERPS WALLET EXISTS OR IS STORED, the login's own included: each is refused after the stop otherwise", async () => {
    const login = K1.toUpperCase().replace("0X", "0x");
    for (const body of [
      { exists: true, tenant: K1, grant: { owner: K1 } },
      // A record the store holds but will not show: stopped for a renewal, or one the file store cannot parse.
      { exists: false, tenant: K1, stored: true },
    ]) {
      assert.equal(await restorePerpsRefusal(K2, answering(200, body)), RESTORE_PERPS_HOSTED, `another key, ${JSON.stringify(body)}`);
      assert.equal(await restorePerpsRefusal(login, answering(200, body)), RESTORE_PERPS_HOSTED, `the login's own key, ${JSON.stringify(body)}`);
    }
    assert.match(RESTORE_PERPS_HOSTED, /Nothing was stopped or signed/);
    assert.doesNotMatch(RESTORE_PERPS_HOSTED, /Kill all|Restore with that owner key/, "the self-hosted way out leads nowhere on hosted");
    assert.equal(await restorePerpsRefusal(K2, answering(200, { exists: false, stored: true })), RESTORE_PERPS_UNREAD, "no tenant to compare: unread");
    assert.equal(await restorePerpsRefusal(K2, answering(200, { exists: false, tenant: K1 })), null, "no record at all: none");
    assert.equal(await restorePerpsRefusal(K2, answering(200, { exists: false, tenant: null })), null, "signed out: none here; the POST asks for a sign-in");
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
      assert.equal(await renewalPerpsRefusal(K1, read), RENEWAL_PERPS_UNREAD, what);
    }
    // A Perps wallet that stays unreadable is not "try again" alone: the way out is named, and what it depends on.
    assert.match(RESTORE_PERPS_UNREAD, /Kill all agents stops both wallets and says whether it removed this one/);
  });
});

describe("renewalPerpsRefusal", () => {
  it("compares the key the renewal re-signs with to the Perps wallet's owner, hosted (through the tenant) as self-hosted", async () => {
    assert.equal(await renewalPerpsRefusal(K1, answering(200, { exists: false })), null);
    assert.equal(await renewalPerpsRefusal(K1, answering(200, { exists: true, grant: { owner: K1.toUpperCase().replace("0X", "0x") } })), null);
    assert.equal(await renewalPerpsRefusal(K2, answering(200, { exists: true, grant: { owner: K1 } })), RENEWAL_PERPS_OWNER_DIFFERS);
    // Hosted, a renewal re-signs with the login (Privy), which is the Perps wallet's owner: it goes ahead.
    assert.equal(await renewalPerpsRefusal(K1, answering(200, { exists: true, tenant: K1, grant: { owner: K1 } })), null);
    assert.equal(await renewalPerpsRefusal(K1, answering(200, { exists: false, tenant: K1, stored: true })), null);
    assert.equal(await renewalPerpsRefusal(K2, answering(200, { exists: false, tenant: K1, stored: true })), RENEWAL_PERPS_OWNER_DIFFERS);
    // Said after the renewal's own "This attempt kept your existing permission unchanged.": neither claims a stop.
    for (const said of [RENEWAL_PERPS_OWNER_DIFFERS, RENEWAL_PERPS_UNREAD]) assert.doesNotMatch(said, /stopped|Nothing was/);
  });
});

describe("the Wallet screen asks before its first step", () => {
  const src = readFileSync(new URL("../terminal/screens/Wallet.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const fn = (name: string) => {
    const start = src.indexOf(`async function ${name}(`);
    assert.ok(start > 0, `${name} is there`);
    return src.slice(start, src.indexOf("\n  }\n", start));
  };
  /** The check is one unconditional statement at the function's own level, followed by its throw, and comes before every step. */
  const asksFirst = (body: string, statement: RegExp, steps: string[]) => {
    const found = statement.exec(body);
    assert.ok(found, `asks: ${statement}`);
    assert.match(body.slice(0, found.index), /\n {6}$/, "a statement of its own, at the try block's level: not inside an if or a ternary");
    assert.match(body.slice(found.index + found[0].length, found.index + found[0].length + 80), /^\s*if \(perpsRefusal\) throw new Error\(perpsRefusal\);/);
    for (const step of steps) {
      const at = body.indexOf(step);
      assert.ok(at > 0, `${step} is there`);
      assert.ok(found.index < at, `asked before ${step}`);
    }
  };

  it("the restore asks restorePerpsRefusal with the restored key's own owner, whichever account it restores, before its funding check, stop, revocation or signature", () => {
    asksFirst(fn("onRestore"), /const perpsRefusal = await restorePerpsRefusal\(privateKeyToAccount\(ownerKey\)\.address\);/,
      ["assertRevocationFunded(", "stopAgentForReplacement(", "revokeFromBrowser(", "restoreAgentWallet("]);
  });

  it("the renewal asks renewalPerpsRefusal with the key it re-signs with, before anything is marked, preflighted, stopped, revoked or signed", () => {
    asksFirst(fn("renewKey"),
      /const perpsRefusal = await renewalPerpsRefusal\(\s*resignBy === "privy" \? privyOwner!\.account\.address : privateKeyToAccount\(grant\.demoOwnerPrivateKey as `0x\$\{string\}`\)\.address,\s*\);/,
      ["preflightAgentGrant(", "saveRecoveryGrant(", "markPermissionForReplacement(", "stopAgentForReplacement(", "revokeFromBrowser(", "createPrivyOwnedWallet(", "restoreAgentWallet("]);
  });
});
