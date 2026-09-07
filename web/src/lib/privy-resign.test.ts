/**
 * A RE-SIGN AND A BRAND-NEW AGENT ARE THE SAME CALL WITH A DIFFERENT OWNER.
 *
 * The Kernel address derives from the sudo validator alone, so `mintGrant` run
 * with an owner that is not the one an agent was minted under produces a
 * different address — quietly, successfully, with no error anywhere. The caller
 * hands the server a valid grant for an account holding nothing, while the
 * funded account it meant to re-sign keeps its old wall and its money.
 *
 * That was survivable while the only re-sign path was `restoreAgentWallet` with
 * a key read out of THIS grant: same key, same account, by construction. It
 * stops being survivable the moment a Privy owner can re-sign, because
 * `usePrivyOwner` returns whichever embedded wallet is connected RIGHT NOW —
 * and a different Privy login in the same browser is a different owner.
 *
 * The other half of this file is the invariant Wallet.tsx states about itself
 * and had not finished keeping: "ONE SIGNING CONTROL, ONE SET OF CONDITIONS,
 * and everything else points at it."
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

const SESSION = codeOf(readFileSync(new URL("./session.ts", import.meta.url), "utf8"));
const WALLET = codeOf(readFileSync(new URL("../terminal/screens/Wallet.tsx", import.meta.url), "utf8"));
const OWNER = codeOf(readFileSync(new URL("../terminal/usePrivyOwner.ts", import.meta.url), "utf8"));

describe("re-signing lands on the account it claims", () => {
  it("THE SIGNER REFUSES AN OWNER THAT DERIVES A DIFFERENT ACCOUNT", () => {
    assert.match(SESSION, /if \(expectAccount && sudoOnlyAccount\.address\.toLowerCase\(\) !== expectAccount\.toLowerCase\(\)\)/);
    assert.match(SESSION, /refusing to sign: this owner derives/);
  });

  it("and checks it BEFORE the wall is pinned to anything", () => {
    // The wall pins its swap recipient and vault receiver to this address. A
    // check after that point would be a check on a grant already built around
    // the wrong account.
    const derive = SESSION.indexOf("assertDerivedAccount(sudoOnlyAccount.address");
    const expect = SESSION.indexOf("if (expectAccount &&");
    const wall = SESSION.indexOf("buildWallPolicies(");
    assert.ok(derive > 0 && expect > derive, "after the zero-derivation refusal");
    assert.ok(wall > expect, "and before the wall is built");
  });

  it("IT LIVES IN THE ONE SIGNING FUNNEL, not at a call site", () => {
    // A caller that knows which account it is re-signing cannot forget to say
    // so, and every entry point forwards it.
    assert.equal(
      (SESSION.match(/o\.expectAccount,/g) ?? []).length,
      3,
      "createAgentWallet, createPrivyOwnedWallet and restoreAgentWallet must all forward it",
    );
    assert.match(SESSION, /expectAccount\?: Address;/, "and MintOptions carries it");
  });

  it("but a fresh mint is unaffected — absent means nothing to expect", () => {
    // Minting a new agent and restoring a wallet this browser has never seen
    // both legitimately do not know an address. The guard is opt-in on purpose.
    assert.match(SESSION, /if \(expectAccount &&/, "guarded on presence, not on a sentinel");
  });
});

describe("a Privy agent can re-sign at all", () => {
  it("THE RENEW PATH TAKES EITHER OWNER", () => {
    // It used to `return` on a missing owner key — which a Privy agent never
    // has, by design — so the cohort CreateAgent mints had no re-sign path.
    assert.match(WALLET, /const resignBy: "owner-key" \| "privy" \| null/);
    assert.match(WALLET, /isPrivyOwned\(grant\) && privyOwner/);
    assert.match(WALLET, /if \(!grant \|\| !resignBy\) return;/);
    assert.match(WALLET, /createPrivyOwnedWallet\(privyOwner!\.account, privyOwner!\.did, options\)/);
  });

  it("and it states which account it is re-signing", () => {
    assert.match(WALLET, /expectAccount: grant\.smartAccount as `0x\$\{string\}`/);
  });

  it("both owners share ONE set of options", () => {
    // The fresh settings, the selected chain, the current caps and the adapter
    // verification are the conditions; branching before them would be two
    // signing controls wearing one name.
    const opts = WALLET.indexOf("const options = {");
    const branch = WALLET.indexOf('resignBy === "privy"');
    assert.ok(opts > 0 && branch > opts, "the branch comes after the options are built");
  });

  it("the owner comes from the embedded wallet, never wallets[0]", () => {
    // usePrivyOwner's own rule, which re-signing now depends on: index zero can
    // be the user's MetaMask, and deriving a Kernel account from THAT would
    // hand them a different agent with a straight face.
    assert.match(OWNER, /getEmbeddedConnectedWallet\(wallets\)/);
    assert.ok(!/wallets\[0\]/.test(OWNER));
  });
});

describe("one signing control, and everything else points at it", () => {
  it("EXACTLY ONE PLACE CALLS renewKey", () => {
    // The file states this rule about itself, after a real hole: a second
    // button called renewKey() with `disabled={renewing}` as its only guard,
    // and it became a chain-move bypass the moment the panel gained one. The
    // uncovered-tokens prompt was still the same shape.
    assert.equal(
      (WALLET.match(/void renewKey\(\)/g) ?? []).length,
      1,
      "every other prompt must scroll to the control, not sign",
    );
  });

  it("and the prompts that used to sign now scroll", () => {
    assert.equal(
      (WALLET.match(/getElementById\("resign"\)/g) ?? []).length,
      2,
      "the expiry prompt and the uncovered-tokens prompt both point at it",
    );
    assert.match(WALLET, /id="resign"/, "and the control it points at exists");
  });
});

describe("what a Privy owner is told when they cannot re-sign", () => {
  it("NOT 'PASTE YOUR KEY' — there is no key, by design", () => {
    // The old panel told the entire Privy cohort to paste a key that does not
    // exist for their account: advice that cannot be followed, which is the
    // failure this codebase keeps refusing.
    assert.match(WALLET, /there is no key to paste, which\s+is the point of it/);
    assert.match(WALLET, /sign in as that account and this control comes back/);
  });

  it("and the two remedies are behind isPrivyOwned, not behind a missing key", () => {
    // A missing key means two different things — session.ts:104-120 says so at
    // length — and the binding version is the durable signal.
    const at = WALLET.indexOf("Re-signing {short(grant.smartAccount)} needs the login");
    assert.ok(at > 0, "the Privy sentence must exist");
    assert.ok(WALLET.lastIndexOf("isPrivyOwned(grant) ?", at) > 0, "chosen by the binding version");
  });

  it("the expiry and uncovered warnings reach Privy owners too", () => {
    // Both were gated on the owner key, so the cohort least able to act was
    // also the one never told it needed to.
    assert.match(WALLET, /secsLeft > 3 \* 86_400 \|\| !resignBy/);
    assert.match(WALLET, /uncoveredNames\.length > 0 && resignBy/);
  });
});
