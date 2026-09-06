/**
 * WHAT PRIVY IS NOT ALLOWED TO BE HERE.
 *
 * Two Privy features would quietly replace architecture merrymen already has,
 * and both are opt-in — which means the only thing standing between "not
 * enabled" and "enabled" is that nobody imported them. That is not a boundary,
 * it is an absence, so this file makes the absence a test.
 *
 *   SMART WALLETS. Privy can create its own ERC-4337 account. Merrymen already
 *   has Kernel v3.3, the permission wall, existing smart-account addresses and
 *   a bundler path. A second smart-account implementation beside them means two
 *   answers to "where are the funds", and the ledger keys on one of them.
 *
 *   SERVER-SIDE SIGNERS. Privy can be delegated authority to sign on a user's
 *   behalf from a backend. Merrymen's whole custody story is that the server is
 *   never custodian — the hosted grant intake returns 422 for a payload
 *   carrying key material. A delegated signer is that, with extra steps.
 *
 * And the secret boundary: PRIVY_APP_SECRET belongs to the web service alone.
 * Brain has no environment to receive it, worker children have it stripped at
 * fork, and it appears in no prompt, decision record or log line.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * The file with its COMMENTS REMOVED.
 *
 * These assertions are about what the code does, and this repo documents what
 * it deliberately does not do — Providers.tsx names every banned symbol in
 * prose precisely so a reader knows they were considered and refused. Scanning
 * the raw text would make that documentation the violation.
 */
const codeOf = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

function sources(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name)) out.push(rel);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

const ALL = () => sources(["web/src", "worker/src", "packages/core/src", "services/brain", "mobile/src"]);

describe("privy smart wallets are absent, not merely unused", () => {
  it("nothing imports the smart-wallets subpath or its hooks", () => {
    const banned = [
      "@privy-io/react-auth/smart-wallets",
      "SmartWalletsProvider",
      "useSmartWallets",
    ];
    const offenders: string[] = [];
    for (const f of ALL()) {
      if (f.endsWith("privy-boundary.test.ts")) continue;
      const src = codeOf(f);
      for (const b of banned) if (src.includes(b)) offenders.push(`${f}: ${b}`);
    }
    assert.deepEqual(offenders, [], `smart wallets must stay absent: ${offenders.join(", ")}`);
  });

  it("`permissionless` is not installed — the smart-wallet peer never arrived", () => {
    // The strongest available proof: the dependency Privy's smart wallets
    // require is not in the tree at all, so the feature cannot be reached even
    // by an accidental import.
    assert.equal(
      existsSync(join(ROOT, "node_modules", "permissionless")),
      false,
      "permissionless is installed — check why; merrymen must not gain a second smart-account stack",
    );
  });
});

describe("privy server-side signers are absent", () => {
  it("nothing calls the delegation APIs", () => {
    const banned = [
      "useSigners",
      "addSigners",
      "useSessionSigners",
      "addSessionSigners",
      "useHeadlessDelegatedActions",
      "delegateWallet",
      "walletApi",
      "keyQuorums",
    ];
    const offenders: string[] = [];
    for (const f of ALL()) {
      if (f.endsWith("privy-boundary.test.ts")) continue;
      const src = codeOf(f);
      for (const b of banned) if (src.includes(b)) offenders.push(`${f}: ${b}`);
    }
    assert.deepEqual(offenders, [], `server-side signing must stay absent: ${offenders.join(", ")}`);
  });

  it("the server client is only ever used to VERIFY", () => {
    const src = read("web/src/lib/privy.ts");
    assert.match(src, /verifyAccessToken/);
    // `wallets()` and `policies()` on the node client are the write surfaces.
    for (const write of [".wallets()", ".policies()", ".keyQuorums()"]) {
      assert.ok(!src.includes(write), `privy.ts must not reach for ${write}`);
    }
  });
});

describe("the app secret belongs to the web service alone", () => {
  it("PRIVY_APP_SECRET is READ in exactly one file", () => {
    // Naming it is fine and necessary — CHILD_SECRET_STRIP has to say which
    // variables it removes. Reading it out of the environment is the thing that
    // may happen in exactly one place.
    const readers = ALL().filter(
      (f) => !f.endsWith("privy-boundary.test.ts") && /process\.env\.PRIVY_APP_SECRET/.test(codeOf(f)),
    );
    assert.deepEqual(readers, ["web/src/lib/privy.ts"], `only the verifier may read the secret: ${readers.join(", ")}`);
  });

  it("it is stripped from every worker child at fork", () => {
    const src = read("worker/src/orchestrator.ts");
    const start = src.indexOf("CHILD_SECRET_STRIP");
    assert.ok(start > 0, "the strip list must exist");
    const strip = src.slice(start, src.indexOf("];", start));
    assert.match(strip, /PRIVY_APP_SECRET/, "children must not inherit the privy secret");
  });

  it("Brain never mentions Privy at all", () => {
    // Brain is outside the money and identity trust domains entirely. It gets
    // no Privy environment, and the reason it cannot leak one is that it has
    // never heard of it.
    const offenders = sources(["services/brain"]).filter((f) => /privy/i.test(read(f)));
    assert.deepEqual(offenders, [], `brain must not know about privy: ${offenders.join(", ")}`);
  });

  it("the public app id is public, and the secret is never NEXT_PUBLIC_", () => {
    // Anything prefixed NEXT_PUBLIC_ is inlined into the browser bundle. The
    // app id is meant to be; the secret would be a total compromise.
    const offenders = ALL().filter(
      (f) => !f.endsWith("privy-boundary.test.ts") && codeOf(f).includes("NEXT_PUBLIC_PRIVY_APP_SECRET"),
    );
    assert.deepEqual(offenders, []);
  });
});

describe("the identity a session is minted for comes from a verified token", () => {
  it("the route reads the DID from the verifier, never from the request body", () => {
    const src = read("web/src/app/api/auth/privy/route.ts");
    assert.match(src, /const verdict = await verifyPrivyToken\(privyTokenOf\(req\)\)/);
    assert.match(src, /const \{ did \} = verdict\.identity/);
    // A body-supplied did/tenant/address must never reach the session.
    assert.ok(!/body\.did/.test(src), "the did must not come from the request body");
    assert.ok(!/mintSession\(\s*tenantFromWallet/.test(src), "the session follows the DID's tenant, not the wallet");
    assert.match(src, /mintSession\(resolved\.tenant\)/);
  });

  it("the address is RECOVERED from the signature, not taken from the body", () => {
    const src = read("web/src/app/api/auth/privy/route.ts");
    assert.match(src, /recoverMessageAddress\(/);
    assert.ok(
      !/isAddr\(body\.address\)/.test(src),
      "a body-supplied address would let a verified login claim somebody else's tenant",
    );
  });

  it("the nonce is consumed before the signature is trusted", () => {
    // Compare the CALL SITES, not the imports — both names appear in the
    // import block, in the other order.
    const src = codeOf("web/src/app/api/auth/privy/route.ts");
    const burn = src.indexOf("consumeChallengeNonce(nonce, origin)");
    const recover = src.indexOf("await recoverMessageAddress({");
    assert.ok(burn > 0 && recover > 0, "both steps must exist");
    assert.ok(burn < recover, "a captured signature must not be replayable");
  });
});

describe("the beta flag is separate from the credentials", () => {
  it("privy stays off until the beta switch is on, even with a valid app id", () => {
    // Shipping the code and enabling the login are two decisions. Merging must
    // not change what a user sees; one variable must.
    const src = codeOf("web/src/lib/privy-client.ts");
    assert.match(src, /NEXT_PUBLIC_MERRYMEN_PRIVY_BETA/);
    assert.match(src, /return BETA && /, "both the switch AND a well-formed id");
  });

  it("the provider and the button ask the same question", () => {
    // If they ever disagreed, the button renders, calls usePrivy(), and throws
    // because no provider is above it.
    assert.match(codeOf("web/src/terminal/Providers.tsx"), /privyEnabled()/);
    assert.match(codeOf("web/src/terminal/HostedControls.tsx"), /PRIVY_BETA = privyEnabled()/);
  });
});

describe("the client picks the embedded wallet deliberately", () => {
  it("it never indexes into useWallets()", () => {
    const src = codeOf("web/src/terminal/PrivySignIn.tsx");
    assert.match(src, /getEmbeddedConnectedWallet\(/);
    assert.ok(
      !/wallets\[0\]/.test(src),
      "with the wallet login enabled, index zero can be the user's MetaMask — signing with it makes THEIR address the tenant",
    );
  });

  it("X is the primary login method and the config uses the v3 shape", () => {
    const src = read("web/src/terminal/Providers.tsx");
    // X first, email second, and NO wallet. An external wallet can authenticate
    // somebody but cannot be the Kernel owner — that has to be the embedded
    // wallet — so offering it produced exactly one outcome in testing: a
    // session whose wallet was not its owner, and a mismatch error nobody could
    // act on.
    assert.match(src, /loginMethods:\s*\["twitter",\s*"email"\]/, "X first, and no wallet login");
    assert.doesNotMatch(src, /loginMethods:[^\]]*"wallet"/, "the wallet door is closed");
    assert.match(
      src,
      /embeddedWallets:\s*\{\s*ethereum:\s*\{\s*createOnLogin:\s*"all-users"\s*\}\s*\}/,
      "the flat v2 shape is silently ignored on v3 — no wallet, no error",
    );
    assert.match(src, /supportedChains:\s*\[robinhoodChain\]/);
    assert.ok(!/defineChain\(/.test(src), "chain 4663 comes from @merrymen/core, never a second definition");
  });
});
