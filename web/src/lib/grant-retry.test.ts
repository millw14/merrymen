import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { bindingMessage } from "@merrymen/core";
import { issueChallengeNonce, verifyGrantBinding } from "./auth";
import { retryGrantHandoff, sameGrantPermission, setPrivyTokenSource, type Grant, type GrantRetryProof } from "./session";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis,"window");
const savedEnv = new Map(["MERRYMEN_HOME", "MERRYMEN_SESSION_SECRET", "MERRYMEN_HOSTED", "DATABASE_URL"].map(key => [key, process.env[key]]));
const home = mkdtempSync(join(tmpdir(), "merrymen-grant-retry-"));
process.env.MERRYMEN_HOME = home;
process.env.MERRYMEN_SESSION_SECRET = "disposable-grant-retry-test-secret-32-characters";
delete process.env.MERRYMEN_HOSTED; delete process.env.DATABASE_URL;
const ORIGIN = "https://app.merrymen.dev";
const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const DID = "did:privy:grant-retry";
let grant: Grant;
let requests: { url: string; init: RequestInit | undefined }[];
let tokenReads: number;
const proof = (beforeSubmit: () => Promise<void> = async () => {}): GrantRetryProof => ({ ownerSigner: { account: owner, binding: "privy-did-owner-v1", did: DID }, tenant: owner.address, beforeSubmit });
const verify = (value: Grant) => verifyGrantBinding({ origin: ORIGIN, tenant: owner.address, owner: value.owner, smartAccount: value.smartAccount, chainId: value.chainId, purpose: "spot",
  ...value.binding!, verifiedDid: DID });

beforeEach(async () => {
  requests = []; tokenReads = 0;
  setPrivyTokenSource(async () => `fresh-token-${++tokenReads}`);
  const nonce = issueChallengeNonce(ORIGIN);
  grant = { smartAccount: `0x${"b".repeat(40)}`, owner: owner.address, sessionKeyAddress: `0x${"c".repeat(40)}`,
    caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 24 }, chainId: 4663,
    grantedAt: 1, expiresAt: 604801, demoSessionPrivateKey: `0x${"d".repeat(64)}`, serialized: "same-signed-permission", binding: {
      version: "privy-did-owner-v1", nonce, did: DID,
      ownerSignature: await owner.signMessage({ message: bindingMessage({ origin: ORIGIN, nonce, owner: owner.address, smartAccount: `0x${"b".repeat(40)}`, chainId: 4663, version: "privy-did-owner-v1", did: DID }) }),
    } };
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (String(input) === "/api/auth/challenge") return Response.json({ origin: ORIGIN, nonce: issueChallengeNonce(ORIGIN) });
    assert.equal(String(input), "/api/grants");
    const result = await verify(JSON.parse(String(init?.body)) as Grant);
    return result.ok ? Response.json({ ok: true }) : Response.json({ error: result.why }, { status: 403 });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch; setPrivyTokenSource(null);
  if(originalWindow)Object.defineProperty(globalThis,"window",originalWindow);else Reflect.deleteProperty(globalThis,"window");
});
after(() => {
  for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

it("recovers after intake spent the old nonce, preserving the permission and requiring a fresh owner proof for every retry", async () => {
  const original = structuredClone(grant);
  assert.equal((await verify(grant)).ok, true, "initial intake consumed the binding before a later RPC/store failure");
  assert.deepEqual(await verify(grant), { ok: false, why: "nonce already used" });
  assert.deepEqual(await retryGrantHandoff(grant, proof()), { ok: true });
  assert.deepEqual(await retryGrantHandoff(grant, proof()), { ok: true });
  assert.equal(tokenReads, 2);
  assert.deepEqual(requests.map(request => request.url), ["/api/auth/challenge", "/api/grants", "/api/auth/challenge", "/api/grants"]);
  const submitted = requests.filter(request => request.url === "/api/grants");
  const nonces = new Set([grant.binding!.nonce]);
  for (const [index, request] of submitted.entries()) {
    assert.equal(new Headers(request.init?.headers).get("Authorization"), `Bearer fresh-token-${index + 1}`);
    const { binding, ...permission } = JSON.parse(String(request.init?.body)) as Grant;
    const { binding: _originalBinding, ...originalPermission } = original;
    assert.deepEqual(permission, originalPermission);
    assert.equal(nonces.has(binding!.nonce), false); nonces.add(binding!.nonce);
    assert.deepEqual(await verify({ ...permission, binding }), { ok: false, why: "nonce already used" }, "retry proof is still single-use");
  }
  assert.deepEqual(grant, original, "historical saved recovery evidence is not overwritten");
});

it("requires the matching owner, DID and tenant before asking for another signature", async () => {
  assert.equal((await retryGrantHandoff(grant)).ok, false);
  assert.equal((await retryGrantHandoff(grant, { ...proof(), tenant: `0x${"e".repeat(40)}` })).ok, false);
  assert.equal((await retryGrantHandoff(grant, { ...proof(), ownerSigner: { account: owner, binding: "privy-did-owner-v1", did: "did:privy:other" } })).ok, false);
  assert.equal((await retryGrantHandoff(grant, { ...proof(), ownerSigner: { account: privateKeyToAccount(`0x${"22".repeat(32)}`), binding: "privy-did-owner-v1", did: DID } })).ok, false);
  assert.deepEqual(requests, []);
});

it("does not submit after the account or replacement journal changes during approval", async () => {
  await assert.rejects(retryGrantHandoff(grant, proof(async () => { throw new Error("permission selected for replacement"); })), /selected for replacement/);
  assert.deepEqual(requests.map(request => request.url), ["/api/auth/challenge"]);
  assert.equal(tokenReads, 0);
});

it("does not claim activation when the refreshed proof is refused", async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => String(input) === "/api/grants"
    ? Response.json({ error: "permission could not be verified" }, { status: 403 }) : fetch(input, init);
  const result = await retryGrantHandoff(grant, proof());
  assert.equal(result.ok, false);
  assert.match(result.error!, /permission could not be verified/);
});

it("hosted retries omit a browser-held owner key while preserving its local recovery copy",async()=>{
  grant.demoOwnerPrivateKey=`0x${"11".repeat(32)}`;
  const original=structuredClone(grant);
  assert.deepEqual(await retryGrantHandoff(grant,proof()),{ok:true});
  const posted=JSON.parse(String(requests.find(request=>request.url==="/api/grants")!.init?.body)) as Grant;
  assert.equal(posted.demoOwnerPrivateKey,undefined);
  assert.equal(posted.serialized,original.serialized);
  assert.equal(posted.demoSessionPrivateKey,original.demoSessionPrivateKey);
  assert.deepEqual(grant,original);
});

it("unbound self-hosted retries retain their local owner key and need no hosted proof",async()=>{
  const {binding:_binding,...unbound}=grant;
  const local={...unbound,demoOwnerPrivateKey:`0x${"11".repeat(32)}` as `0x${string}`};
  globalThis.fetch=async(input,init)=>{requests.push({url:String(input),init});return Response.json({ok:true});};
  assert.deepEqual(await retryGrantHandoff(local),{ok:true});
  assert.deepEqual(requests.map(request=>request.url),["/api/grants"]);
  assert.deepEqual(JSON.parse(String(requests[0]!.init?.body)),local);
  assert.equal(new Headers(requests[0]!.init?.headers).get("authorization"),null);
  assert.equal(tokenReads,0);
});

it("a legacy bound retry still requires both its distinct login signer and owner proof",async()=>{
  const login=privateKeyToAccount(`0x${"22".repeat(32)}`);
  grant.binding={version:"legacy-wallet-owner-v1",nonce:"old-intake-nonce",ownerSignature:`0x${"ab".repeat(65)}`,walletSignature:`0x${"cd".repeat(65)}`};
  grant.demoOwnerPrivateKey=`0x${"11".repeat(32)}`;
  const methods:string[]=[];
  Object.defineProperty(globalThis,"window",{configurable:true,value:{ethereum:{request:async({method,params}:{method:string;params?:unknown[]})=>{
    methods.push(method);
    if(method==="eth_requestAccounts")return[login.address];
    assert.equal(method,"personal_sign");
    assert.equal(params?.[1],login.address);
    return login.signMessage({message:String(params?.[0])});
  }}}});
  globalThis.fetch=async(input,init)=>{
    requests.push({url:String(input),init});
    if(String(input)==="/api/auth/challenge")return Response.json({origin:ORIGIN,nonce:issueChallengeNonce(ORIGIN)});
    const value=JSON.parse(String(init?.body)) as Grant;
    assert.equal(value.demoOwnerPrivateKey,undefined);
    assert.equal(value.serialized,grant.serialized);
    const verdict=await verifyGrantBinding({origin:ORIGIN,tenant:login.address,owner:value.owner,smartAccount:value.smartAccount,chainId:value.chainId,purpose:"spot",...value.binding!});
    return verdict.ok?Response.json({ok:true}):Response.json({error:verdict.why},{status:403});
  };
  assert.deepEqual(await retryGrantHandoff(grant,{tenant:login.address,ownerSigner:{account:owner,binding:"legacy-wallet-owner-v1",privateKey:grant.demoOwnerPrivateKey},beforeSubmit:async()=>{}}),{ok:true});
  assert.deepEqual(methods,["eth_requestAccounts","personal_sign"]);
  assert.equal(tokenReads,0,"legacy authorization never obtains a Privy token");
});

it("permission status matching includes every bound and stable provenance field, not just the session key",()=>{
  const complete:Grant={...grant,grantFeatures:["scoped-spenders","tradeable-v2"],grantTokens:[`0x${"e".repeat(40)}`],
    v4AdapterAddress:`0x${"1".repeat(40)}`,ponsAdapterAddress:`0x${"2".repeat(40)}`,ponsClassVaultAddress:`0x${"3".repeat(40)}`,
    ponsClassVaultFactoryAddress:`0x${"4".repeat(40)}`,trencherVaultAddress:`0x${"5".repeat(40)}`,trencherFactoryAddress:`0x${"6".repeat(40)}`};
  const {serialized:_serialized,demoSessionPrivateKey:_session,...publicView}=complete;
  assert.equal(sameGrantPermission(publicView,complete),true);
  assert.equal(sameGrantPermission({...publicView,binding:{...publicView.binding!,nonce:"fresh-one-time-link",ownerSignature:"0x1234"}},complete),true);
  for(const key of ["perTradeUsdg","dailyUsdg","expiryDays","maxDrawdownPct","maxOpsPerDay"] as const){
    assert.equal(sameGrantPermission({...publicView,caps:{...publicView.caps,[key]:publicView.caps[key]+1}},complete),false,key);
    assert.equal(sameGrantPermission({...publicView,caps:{...publicView.caps,[key]:undefined}},complete),false,`missing ${key}`);
  }
  for(const key of ["chainId","grantedAt","expiresAt"] as const){
    assert.equal(sameGrantPermission({...publicView,[key]:publicView[key]+1},complete),false,key);
  }
  for(const key of ["owner","smartAccount","sessionKeyAddress","v4AdapterAddress","ponsAdapterAddress","ponsClassVaultAddress","ponsClassVaultFactoryAddress","trencherVaultAddress","trencherFactoryAddress"] as const){
    assert.equal(sameGrantPermission({...publicView,[key]:`0x${"f".repeat(40)}`},complete),false,key);
    assert.equal(sameGrantPermission({...publicView,[key]:undefined},complete),false,`missing ${key}`);
  }
  assert.equal(sameGrantPermission({...publicView,grantTokens:[]},complete),false);
  assert.equal(sameGrantPermission({...publicView,grantFeatures:[]},complete),false);
  assert.equal(sameGrantPermission({...publicView,binding:{...publicView.binding!,did:"did:privy:other"}},complete),false);
  assert.equal(sameGrantPermission({...publicView,binding:{...publicView.binding!,version:"legacy-wallet-owner-v1"}},complete),false);
});

it("a Privy Spot resume still matches its server view after perps slice 5b, and no other wallet's grant does", () => {
  // CreateAgent.retryActivation compares GET /api/grants' grant with the saved
  // one before skipping a handoff. Spot keeps main's denylist view (decision
  // D3): binding.did and the rest are still there, and neither side names a
  // wallet, which is Spot on both (core grantPurpose).
  const { serialized: _serialized, demoSessionPrivateKey: _session, ...spotView } = grant;
  assert.equal(grant.binding?.version, "privy-did-owner-v1");
  assert.equal(sameGrantPermission(spotView, grant), true);
  assert.equal(sameGrantPermission({ ...spotView, purpose: "spot" }, grant), true, "Spot, named or not, is Spot");
  // The wallet is part of the permission: a view of the other wallet, or one
  // naming no wallet this build knows, matches nothing.
  assert.equal(sameGrantPermission({ ...spotView, purpose: "perps" }, grant), false);
  assert.equal(sameGrantPermission(spotView, { ...grant, purpose: "perps" }), false);
  assert.equal(sameGrantPermission({ ...spotView, purpose: "solana" } as never, grant), false);
});
