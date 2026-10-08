import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, it, mock } from "node:test";
import { encodeErrorResult, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bindingMessage, type GrantPurpose, type StoredGrant } from "@merrymen/core";
import { signerGrant } from "@/lib/canonical-wall-fixture";
const saved = Object.fromEntries(["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_STORE_DEK", "MERRYMEN_SESSION_SECRET", "DATABASE_URL"].map(k => [k, process.env[k]]));
const origin = "https://merrymen.example", spot = `0x${"11".repeat(20)}` as const, perps = `0x${"22".repeat(20)}` as const;
const wallet = privateKeyToAccount(generatePrivateKey()), owner = privateKeyToAccount(generatePrivateKey());
const oldFetch = globalThis.fetch;
let deriveAddress: `0x${string}` = spot;
let home: string, auth: typeof import("@/lib/auth"), store: typeof import("@merrymen/grant-store"), identities: typeof import("@merrymen/identity-store"), settings: typeof import("@merrymen/settings-store");
let POST: (req: Request) => Promise<Response>, DELETE: typeof POST, spotGrant: StoredGrant, perpsGrant: StoredGrant;
before(async () => {
 home = mkdtempSync(path.join(os.tmpdir(), "mm-dual-grant-intake-")); process.env.MERRYMEN_HOME = home; process.env.MERRYMEN_HOSTED = "1";
 process.env.MERRYMEN_SESSION_SECRET = "a".repeat(64); process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 5).toString("base64"); delete process.env.DATABASE_URL;
 const require = createRequire(import.meta.url);
 store = require("../../../../../worker/src/grant-store.ts"); settings = require("../../../../../worker/src/settings-store.ts"); identities = require("../../../../../worker/src/identity-store.ts");
 store.resetGrantStoreForTest(); settings.resetSettingsStoreForTest(); identities.resetIdentityStoreForTest();
 for (const purpose of ["spot", "perps"] as const) { store.getGrantStore(purpose); settings.getSettingsStore(purpose); }
 identities.getIdentityStore();
 // Only durable nonce consumption and the network derivation are stood in for.
 // Grant, settings and identity storage use the real encrypted filesystem stores.
 process.env.DATABASE_URL = "postgres://127.0.0.1:1/test-nonce-only";
 const { SqlNonceStore } = require("../../../../../worker/src/auth-nonce-store.ts");
 mock.method(SqlNonceStore.prototype, "consume", async () => true);
 globalThis.fetch = async (_input, init) => {
  const request = JSON.parse(String(init?.body));
  const one = (r: { id: unknown; method: string }) => {
   if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: toHex(4663) };
   if (r.method === "eth_getCode") return { jsonrpc: "2.0", id: r.id, result: "0x" };
   if (r.method === "eth_call") return { jsonrpc: "2.0", id: r.id, error: { code: 3, message: "execution reverted", data: encodeErrorResult({ abi: [{ type: "error", name: "SenderAddressResult", inputs: [{ name: "sender", type: "address" }] }], errorName: "SenderAddressResult", args: [deriveAddress] }) } };
   throw new Error(`unexpected network method ${r.method}`);
  };
  return Response.json(Array.isArray(request) ? request.map(one) : one(request));
 };
 auth = await import("@/lib/auth"); ({ POST, DELETE } = await import("./route"));
 spotGrant = (await signerGrant({ owner, account: spot })).grant;
 perpsGrant = (await signerGrant({ owner, account: perps, purpose: "perps" })).grant;
});
after(() => { globalThis.fetch = oldFetch; mock.restoreAll(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } store.resetGrantStoreForTest(); settings.resetSettingsStoreForTest(); identities.resetIdentityStoreForTest(); rmSync(home, { recursive: true, force: true }); });
async function post(grant: StoredGrant, purpose: GrantPurpose, options?: { signaturePurpose?: GrantPurpose; signedOut?: boolean }) {
 const nonce = auth.issueChallengeNonce(origin), message = bindingMessage({ origin, nonce, owner: owner.address, smartAccount: grant.smartAccount, chainId: grant.chainId, purpose: options?.signaturePurpose ?? purpose });
 const body = { ...grant, binding: { nonce, walletSignature: await wallet.signMessage({ message }), ownerSignature: await owner.signMessage({ message }) } };
 deriveAddress = purpose === "perps" ? perps : spot;
 return POST(new Request(`${origin}/api/grants${purpose === "perps" ? "?purpose=perps" : ""}`, { method: "POST", headers: options?.signedOut ? {} : { cookie: `mm_session=${auth.mintSession(wallet.address)}` }, body: JSON.stringify(body) }));
}
it("one login creates separately signed wallets without replacing the Spot authority or public profile", async () => {
 const a = await post(spotGrant, "spot"); assert.equal(a.status, 200, JSON.stringify(await a.json()));
 const before = readFileSync(path.join(home, "tenants", `${wallet.address.toLowerCase()}.json`), "utf8");
 const identity = await identities.getIdentityStore().get(wallet.address); assert.equal(identity?.accounts[0], spot);
 const b = await post(perpsGrant, "perps"); assert.equal(b.status, 200, JSON.stringify(await b.json()));
 assert.equal(readFileSync(path.join(home, "tenants", `${wallet.address.toLowerCase()}.json`), "utf8"), before);
 assert.equal((await store.getGrantStore("perps").get(wallet.address))?.smartAccount, perps);
 const after = await identities.getIdentityStore().get(wallet.address);
 assert.equal(after?.slug, identity?.slug); assert.deepEqual(after?.accounts, [spot, perps]);
});
it("rejects purpose replay, mismatch, unsupported chains and signed-out creation before changing authority", async () => {
 assert.equal((await post(perpsGrant, "perps", { signaturePurpose: "spot" })).status, 403);
 assert.equal((await post(perpsGrant, "spot")).status, 400);
 assert.equal((await post({ ...perpsGrant, chainId: 46630 }, "perps")).status, 400);
 assert.equal((await post(perpsGrant, "perps", { signedOut: true })).status, 401);
 assert.equal((await store.getGrantStore().get(wallet.address))?.smartAccount, spot);
});
it("retains legacy Spot perpetual authority until it has been explicitly retired", async () => {
 const s = store.getGrantStore(), real = s.get;
 s.get = async () => ({ ...spotGrant, grantFeatures: [...(spotGrant.grantFeatures ?? []), "perp-lighter-v1"] });
 try { const response = await post(perpsGrant, "perps"); assert.equal(response.status, 409); assert.equal((await response.json()).code, "legacy-perps-retirement-required"); }
 finally { s.get = real; }
});
it("revoking Perps through the same session leaves Spot armed", async () => {
 // No perps venue permission was signed in this paper setup; removal needs no live venue action.
 delete process.env.DATABASE_URL;
 const response = await DELETE(new Request(`${origin}/api/grants?purpose=perps`, { method: "DELETE", headers: { cookie: `mm_session=${auth.mintSession(wallet.address)}` } }));
 assert.equal(response.status, 200); assert.equal(await store.getGrantStore("perps").get(wallet.address), null);
 assert.equal((await store.getGrantStore().get(wallet.address))?.smartAccount, spot);
});
