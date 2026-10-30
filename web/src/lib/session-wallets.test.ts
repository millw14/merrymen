/**
 * ONE OWNER, TWO WALLETS, IN THE BROWSER SIGNER (perps slice 5b).
 *
 * The dashboard's mint (session.ts mintGrant) is where a wallet's grant meets
 * this browser's storage and the server. Each of these is a rule a slip would
 * break silently:
 *
 * - SPOT'S STORAGE SLOT IS `merrymen.grant.v1`, BYTE FOR BYTE. Every owner who
 *   signed before Perps has their grant there, and for a legacy owner it is the
 *   only copy of the owner key: a renamed slot is a wallet the page cannot find.
 *   Perps has a slot of its own, so neither wallet's mint overwrites, archives
 *   over or reads the other's grant.
 * - THE ACCOUNT-LINK CLAIM NAMES THE WALLET (core bindingMessage, "Account
 *   purpose: perps"), so the server verifies it for that wallet and no other:
 *   a Perps claim replayed as Spot, or the reverse, recovers to nobody.
 * - THE GRANT IS HANDED TO THE WALLET IT SIGNED FOR, through walletUrl: Spot's
 *   POST is the request it always was, Perps' says `?wallet=perps`.
 *
 * Driven through the real signer (createPrivyOwnedWallet → mintGrant →
 * prepareGrantCore → signBinding → postGrant) over the canonical-wall fixture's
 * stub chain, with the real server-side binding check (auth.ts
 * verifyGrantBinding) answering the POST, and a real browser storage (jsdom).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { privateKeyToAccount } from "viem/accounts";
// FIRST, before ./session: the fixture pins the Trencher factory's trusted
// bytecode hash in the environment, which trencher-permission.ts reads once.
import { TEST_CAPS, withStubChain } from "./canonical-wall-fixture";
import { GRANT_PERP_LIGHTER, LIGHTER_ROUTE_V1, type GrantPurpose, type StoredGrant } from "@merrymen/core";
import { issueChallengeNonce, verifyGrantBinding } from "./auth";
import {
  clearGrant,
  createPrivyOwnedWallet,
  listSavedWallets,
  loadGrant,
  localGrantsSnapshot,
  retryGrantHandoff,
  setPrivyTokenSource,
  type Grant,
} from "./session";

const ORIGIN = "https://app.merrymen.dev";
const SPOT_ACCOUNT = "0x000000000000000000000000000000000005b071" as const;
const PERPS_ACCOUNT = "0x00000000000000000000000000000000000e1e1e" as const;
const owner = privateKeyToAccount(`0x${"42".repeat(32)}`);
const DID = "did:privy:two-wallets";

const savedEnv = new Map(["MERRYMEN_HOME", "MERRYMEN_SESSION_SECRET", "MERRYMEN_HOSTED", "DATABASE_URL"].map((k) => [k, process.env[k]]));
const home = mkdtempSync(join(tmpdir(), "merrymen-session-wallets-"));
process.env.MERRYMEN_HOME = home;
process.env.MERRYMEN_SESSION_SECRET = "disposable-session-wallets-test-secret-32-chars";
delete process.env.MERRYMEN_HOSTED;
delete process.env.DATABASE_URL;

const originalFetch = globalThis.fetch;
let dom: JSDOM;
beforeEach(() => {
  dom = new JSDOM("", { url: ORIGIN });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
  dom.window.close();
  setPrivyTokenSource(null);
  globalThis.fetch = originalFetch;
});
after(() => {
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** A grant as a browser saved it before Perps existed: no purpose, under merrymen.grant.v1. */
const PRE_PERPS = JSON.stringify({
  smartAccount: `0x${"a".repeat(40)}`, owner: `0x${"b".repeat(40)}`, chainId: 4663, demoOwnerPrivateKey: `0x${"1".repeat(64)}`,
  caps: TEST_CAPS, grantedAt: 1, expiresAt: 2, grantFeatures: ["tradeable-v2"],
});

describe("the storage slots", () => {
  it("SPOT'S SLOT IS merrymen.grant.v1: a grant saved before Perps is still the Spot wallet's, and never the Perps wallet's", () => {
    localStorage.setItem("merrymen.grant.v1", PRE_PERPS);
    assert.deepEqual(loadGrant("spot"), JSON.parse(PRE_PERPS));
    assert.equal(loadGrant("perps"), null);
    assert.deepEqual(listSavedWallets("spot").map((w) => [w.smartAccount, w.current]), [[`0x${"a".repeat(40)}`, true]]);
    assert.deepEqual(listSavedWallets("perps"), []);
    assert.deepEqual(localGrantsSnapshot("spot"), { current: JSON.parse(PRE_PERPS), archived: [] });
    assert.deepEqual(localGrantsSnapshot("perps"), { current: undefined, archived: [] });
    assert.equal(localStorage.getItem("merrymen.grant.v1"), PRE_PERPS, "reading never rewrites it");
  });

  it("each wallet reads its own slot and its own archives; a Perps grant in Spot's slot is nobody's Spot grant", () => {
    const perps = { purpose: "perps", smartAccount: PERPS_ACCOUNT, owner: owner.address, chainId: 4663, caps: TEST_CAPS, grantFeatures: [] };
    const archivedPerps = { ...perps, smartAccount: `0x${"c".repeat(40)}` };
    localStorage.setItem("merrymen.grant.v1", PRE_PERPS);
    localStorage.setItem("merrymen.grant.perps.v1", JSON.stringify(perps));
    localStorage.setItem(`merrymen.grant.archive.${archivedPerps.smartAccount}`, JSON.stringify(archivedPerps));
    assert.equal(loadGrant("perps")?.smartAccount, PERPS_ACCOUNT);
    assert.equal(loadGrant("spot")?.smartAccount, `0x${"a".repeat(40)}`);
    assert.deepEqual(listSavedWallets("perps").map((w) => [w.smartAccount, w.current]), [[PERPS_ACCOUNT, true], [archivedPerps.smartAccount, false]]);
    assert.deepEqual(listSavedWallets("spot").map((w) => w.smartAccount), [`0x${"a".repeat(40)}`], "a Spot page never offers a Perps wallet as its own");
    assert.deepEqual(localGrantsSnapshot("perps").archived, [archivedPerps]);
    assert.deepEqual(localGrantsSnapshot("spot").archived, []);
    // The two slots are not interchangeable.
    localStorage.setItem("merrymen.grant.v1", JSON.stringify(perps));
    assert.equal(loadGrant("spot"), null);
    assert.equal(localGrantsSnapshot("spot").current, undefined);
    // A wallet this build does not know reads nothing.
    assert.equal(loadGrant("solana" as never), null);
    assert.throws(() => clearGrant("solana" as never));
  });
});

/** Mint through the real signer with app requests answered here; returns what was posted where. */
async function mint(wallet: GrantPurpose | undefined, account: `0x${string}`) {
  const posts: { url: string; body: Grant }[] = [];
  setPrivyTokenSource(async () => "token");
  const minted = await withStubChain(account, async () => {
    const rpc = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/challenge") return Response.json({ origin: ORIGIN, nonce: issueChallengeNonce(ORIGIN) });
      if (url.startsWith("/api/")) {
        posts.push({ url, body: JSON.parse(String(init?.body)) as Grant });
        return Response.json({ ok: true });
      }
      return rpc(input, init);
    }) as typeof fetch;
    return createPrivyOwnedWallet(owner, DID, {
      ...(wallet ? { purpose: wallet } : {}),
      caps: TEST_CAPS, onStatus: () => {}, chainId: 4663, hostedAs: owner.address,
    });
  });
  return { minted, posts };
}

/** The server's binding check, as POST /api/grants runs it for the wallet the request names. */
const verifyFor = (g: Grant, purpose: GrantPurpose) =>
  verifyGrantBinding({
    origin: ORIGIN, tenant: owner.address, owner: g.owner, smartAccount: g.smartAccount, chainId: g.chainId, purpose,
    ...g.binding!, verifiedDid: DID,
  });

describe("a mint for each wallet", () => {
  it("SPOT: posts to /api/grants exactly, binds a Spot claim, and saves under merrymen.grant.v1", async () => {
    const { minted, posts } = await mint(undefined, SPOT_ACCOUNT);
    assert.deepEqual(posts.map((p) => p.url), ["/api/grants"]);
    const posted = posts[0]!.body;
    assert.equal("purpose" in posted, false, "a Spot grant is the object it always was");
    // The claim verifies for Spot and, replayed, for nothing else. Refused
    // first: a failed signature check spends no nonce.
    assert.equal((await verifyFor(posted, "perps")).ok, false, "a Spot claim replayed as Perps");
    assert.equal((await verifyFor(posted, "spot")).ok, true);
    assert.equal(JSON.parse(localStorage.getItem("merrymen.grant.v1")!).smartAccount, minted.local.smartAccount);
    assert.equal(localStorage.getItem("merrymen.grant.perps.v1"), null);
  });

  it("PERPS: derives index 1, binds a Perps claim, posts to ?wallet=perps, and saves in its own slot, leaving Spot's byte for byte", async () => {
    localStorage.setItem("merrymen.grant.v1", PRE_PERPS);
    const { minted, posts } = await mint("perps", PERPS_ACCOUNT);
    assert.deepEqual(posts.map((p) => p.url), ["/api/grants?wallet=perps"]);
    const posted = posts[0]!.body as StoredGrant;
    assert.equal(posted.purpose, "perps");
    assert.deepEqual(posted.grantFeatures, []);
    // The Kernel index in the SDK's factory call (deployWithFactory's salt).
    const initCode = (JSON.parse(Buffer.from(posted.serialized, "base64").toString("utf8")) as { accountParams: { initCode: string } }).accountParams.initCode;
    assert.equal(BigInt(`0x${initCode.slice(2 + 8 + 64 * 2, 2 + 8 + 64 * 3)}`), 1n, "the Perps account is Kernel index 1");
    // Bound to the Perps wallet: replayed as Spot it recovers to nobody.
    assert.equal((await verifyFor(posted, "spot")).ok, false, "a Perps claim replayed as Spot");
    assert.equal((await verifyFor(posted, "perps")).ok, true);
    assert.equal(JSON.parse(localStorage.getItem("merrymen.grant.perps.v1")!).smartAccount, minted.local.smartAccount);
    assert.equal(localStorage.getItem("merrymen.grant.v1"), PRE_PERPS, "the Spot wallet's grant is untouched");
    assert.equal(localStorage.getItem(`merrymen.grant.archive.0x${"a".repeat(40)}`), null, "and not archived either: nothing replaced it");
  });

  it("a Perps mint reads only the Perps wallet's grants: the Spot wallet's armed grant is not 'another account' to it", async () => {
    // A Spot grant armed in this browser that claims perps (the legacy Spot
    // perp block). Signing a NEW Spot account would replace it, so a Spot
    // mint refuses (perp-other-account); a Perps mint replaces nothing of
    // Spot's, and its snapshot (localGrantsSnapshot("perps")) never sees it.
    localStorage.setItem("merrymen.grant.v1", JSON.stringify({
      ...JSON.parse(PRE_PERPS),
      grantFeatures: ["tradeable-v2", GRANT_PERP_LIGHTER],
      perp: { route: GRANT_PERP_LIGHTER, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: `0x${"1a".repeat(40)}` },
    }));
    await assert.rejects(mint(undefined, SPOT_ACCOUNT), (e: unknown) => (e as { code?: string }).code === "perp-other-account");
    const { posts } = await mint("perps", PERPS_ACCOUNT);
    assert.deepEqual(posts.map((p) => p.url), ["/api/grants?wallet=perps"]);
  });

  it("a retry of a saved Perps grant re-signs a Perps claim and posts it to the Perps wallet", async () => {
    const { minted } = await mint("perps", PERPS_ACCOUNT);
    const posts: { url: string; body: Grant }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/challenge") return Response.json({ origin: ORIGIN, nonce: issueChallengeNonce(ORIGIN) });
      posts.push({ url, body: JSON.parse(String(init?.body)) as Grant });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const result = await retryGrantHandoff(minted.local, {
      ownerSigner: { account: owner, binding: "privy-did-owner-v1", did: DID }, tenant: owner.address, beforeSubmit: async () => {},
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(posts.map((p) => p.url), ["/api/grants?wallet=perps"]);
    assert.equal((await verifyFor(posts[0]!.body, "spot")).ok, false);
    assert.equal((await verifyFor(posts[0]!.body, "perps")).ok, true);
  });
});

describe("how the signer names a wallet in a URL", () => {
  // Comments out, code kept: this codebase argues in prose beside the code.
  const code = (rel: string) =>
    readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("only through walletUrl: never ?purpose=, never a wallet query built by hand", () => {
    for (const rel of ["./session.ts", "./stop-agent.ts", "./saved-grant-binding.ts", "../terminal/screens/Wallet.tsx"]) {
      assert.doesNotMatch(code(rel), /[?&](?:purpose|wallet)=/, `${rel} builds a wallet query by hand`);
    }
    // And every grants request the signer and the stop make goes through it:
    // the bare path appears only as walletUrl's argument.
    for (const rel of ["./session.ts", "./stop-agent.ts"]) {
      const src = code(rel);
      const bare = [...src.matchAll(/"\/api\/grants"/g)].filter((m) => !/walletUrl\($/.test(src.slice(Math.max(0, m.index! - 10), m.index!)));
      // deleteAgent's kill names no wallet, on purpose: the one bare path allowed.
      assert.equal(bare.length, rel === "./stop-agent.ts" ? 1 : 0, `${rel} sends to /api/grants without naming the wallet`);
    }
    assert.match(code("./stop-agent.ts"), /deleteAgent[\s\S]*?requestStop\("\/api\/grants",/, "the bare path is the kill's");
  });
});
