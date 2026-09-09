/**
 * /api/circle ANSWERED ABOUT THE HOUSE AND PRESENTED IT AS THE CALLER'S.
 *
 * It read `homePaths.settings()` — one process-level file — and returned
 * `settings.holderAddress`, its balance and its tier under the key
 * `holderAddress`, with no session and no identity check anywhere in the
 * handler. Hosted, that file is the OPERATOR'S. So every tenant who opened this
 * URL was shown somebody else's standing as their own, and a tenant who had
 * linked a wallet through /api/holder was shown a wallet they had never named.
 *
 * It is not a hypothetical URL. The tester who found the Circle gate said, in
 * as many words, that he "had to go to /api/circle to check that" — this was
 * the endpoint people actually read to answer "am I in the Circle?", and it was
 * answering a different question with a confident number.
 *
 * So the two properties worth pinning are the two that were wrong: WHOSE wallet
 * it resolves, and whether a failed read can be mistaken for an empty one.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const ROUTE = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

/** Comments stripped — this header names what it refuses, the way /api/alpha's does. */
const CODE = ROUTE.replace(/\/\*[\s\S]*?\*\//g, " ")
  .split(/\r?\n/)
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n");

describe("whose wallet it answers about", () => {
  it("THE CALLER'S, resolved the same way every other holder surface resolves it", () => {
    assert.match(CODE, /tenantOf\(req\)/, "it must know who is asking");
    assert.match(
      CODE,
      /holderWalletFor\(/,
      "one function decides proven-wallet-first for the worker, /alpha, /tier and this",
    );
    assert.match(CODE, /export async function GET\(req: Request\)/, "a route with no req had no caller");
  });

  it("the settings file is reachable ONLY on the self-hosted branch", () => {
    // There it is the operator's own declaration about their own wallet, and
    // there is no second tenant for it to be wrong about. Hosted, it is a
    // different person's answer.
    const hosted = CODE.indexOf("isHostedMode()");
    assert.ok(hosted > 0, "the branch exists");
    // The file read lives in a helper whose NAME is the scope. What matters is
    // where it is called: below the branch, and exactly once.
    const calls = [...CODE.matchAll(/await selfHostedHolder\(\)/g)].map((m) => m.index!);
    assert.equal(calls.length, 1, "one call site, on the else arm");
    assert.ok(calls[0]! > hosted, "and it sits below the hosted check");
    assert.equal(
      [...CODE.matchAll(/homePaths\.settings\(\)/g)].length,
      1,
      "the settings file is opened in that helper and nowhere else",
    );
    const beforeBranch = CODE.slice(CODE.indexOf("export async function GET"), hosted);
    assert.ok(
      !/homePaths|readFile|selfHostedHolder/.test(beforeBranch),
      "nothing above the branch may take the wallet from a local file",
    );
  });
});

describe("an unread balance is not an empty one", () => {
  it("THE CATCH REPORTS why:\"unreadable\", WITH NO TIER AND NO ZERO", () => {
    const catchArm = CODE.slice(CODE.lastIndexOf("} catch"));
    assert.match(catchArm, /why: "unreadable"/);
    assert.match(catchArm, /balance: null/, "a 0 here sends somebody to buy tokens they already own");
    assert.match(catchArm, /tier: null/, "and the outsider tier is a verdict we did not earn");
    assert.ok(!/tierForBalance/.test(catchArm), "no tier may be derived from a read that did not happen");
  });

  it("every arm names its reason", () => {
    for (const why of ['"sign-in"', '"no-wallet"', '"ok"', '"unreadable"']) {
      assert.ok(CODE.includes(`why: ${why}`), `no response produces ${why}`);
    }
    assert.ok(
      !/configured: (true|false)/.test(CODE),
      "'configured' collapsed signed-out, unset and unreadable into one boolean",
    );
  });

  it("the tier TABLE is served to everyone, including the signed-out", () => {
    // It is the same list as the marketing page and discloses nothing about
    // anybody. Withholding it would make the signed-out answer useless, which
    // is what sent the tester to read raw JSON in the first place.
    assert.match(CODE, /const table = \{ baseFeeBps, token, tiers \}/);
    const signedOut = CODE.slice(CODE.indexOf('why: "sign-in"'));
    assert.match(signedOut.slice(0, 200), /\.\.\.table/, "the signed-out arm still carries the table");
  });
});
