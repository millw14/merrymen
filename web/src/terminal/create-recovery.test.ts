import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { sameGrantPermission, type Grant, type GrantRetryProof } from "@/lib/session";
import type { AccountState } from "./HostedControls";
import { markPermissionForReplacement } from "@/lib/permission-replacement";
import { RISK_PROFILES } from "@merrymen/core";

const tenant = `0x${"a".repeat(40)}`;
const grant = { smartAccount: `0x${"b".repeat(40)}`, owner: tenant, sessionKeyAddress: `0x${"c".repeat(40)}`, chainId: 4663, grantedAt: 1, expiresAt: 604801, binding: { version: "privy-did-owner-v1" }, caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 24 } } as Grant;
const account: AccountState = { session: { hosted: true, address: tenant }, status: { exists: false, tenant } };
let stored: Grant | null;
let snapshots: Grant[];
let trusted: boolean;
let storageFailed: boolean;
let mintCalls: number;
let handoffOk: boolean;
let signerAddress: string;
let beforeRetrySubmit: (() => void) | null;
let retryProof: GrantRetryProof | undefined;
let signerReady: boolean;
let writes: string[];
let settingsReads: number;
let settingsWrite: Record<string,unknown>|null;
let setupResponse: unknown;
let setupReads: number;
let approvalBodies: Array<Record<string,unknown>>;
let approvalResponse: (()=>Promise<Response>)|null;
let mintFailure: Error|null;
let current: { kind: "ready"; account: AccountState } | { kind: "changed" };
let CreateAgent: typeof import("./screens/CreateAgent").CreateAgent;
let testDom: typeof import("./test-dom").testDom;
let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;

before(async () => {
  const boot = new JSDOM("<!doctype html><p></p>");
  Object.assign(globalThis, { window: boot.window, document: boot.window.document });
  ({ testDom } = await import("./test-dom"));
  Reflect.deleteProperty(globalThis, "window"); Reflect.deleteProperty(globalThis, "document"); boot.window.close();
  const screen = fileURLToPath(new URL("./screens/CreateAgent.tsx", import.meta.url));
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const load = loader._load;
  const intercepted = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename === screen) {
      if (id === "@/terminal/usePrivyOwner") return { usePrivyOwner: () => signerReady ? ({ account: { address: signerAddress }, did: "did:privy:test" }) : null };
      if (id === "@/lib/trencher-permission") return { TRENCHER_FACTORY: `0x${"e".repeat(40)}` };
      if (id === "@/lib/verified-adapter") return { verifiedAdapter: async () => undefined };
      if (id === "../tier") return { loadTier: async () => null, newAgentQualifies: () => true };
      if (id === "../account-session") return { fetchAccountForSession: async () => current };
      if (id === "@/lib/saved-grant-binding") return {
        loadRecoveryGrants: () => { if (storageFailed) throw new Error("storage unreadable"); return snapshots; },
        trustedSavedGrant: async (candidate: Grant) => !!candidate && trusted,
      };
      if (id === "@/lib/session") return {
        sameGrantPermission,
        loadGrant: () => stored,
        retryGrantHandoff: async (_grant: Grant, proof?: GrantRetryProof) => {
          retryProof=proof;beforeRetrySubmit?.();await proof?.beforeSubmit();
          writes.push("/api/grants"); return { ok: true };
        },
        isPrivyOwned: () => true,
        createPrivyOwnedWallet: async () => { mintCalls++; if(mintFailure)throw mintFailure; return { local: grant, handoff: { ok: handoffOk, ...(handoffOk?{}:{error: "temporary activation failure"}) } }; },
      };
    }
    return load.call(this, id, parent, isMain);
  });
  try { CreateAgent = createRequire(import.meta.url)(screen).CreateAgent; }
  finally { intercepted.mock.restore(); }
});

beforeEach(() => {
  ui = testDom(); stored = null; snapshots = []; trusted = true; storageFailed = false; mintCalls = 0; handoffOk=false; signerAddress = tenant; signerReady=true; writes = [];
  beforeRetrySubmit=null;retryProof=undefined;
  settingsReads=0;settingsWrite=null;setupResponse=null;setupReads=0;approvalBodies=[];approvalResponse=null;mintFailure=null;
  current = { kind: "ready", account };
  globalThis.fetch = async (input, init) => {
    const route = String(input);
    if (init?.method && init.method !== "GET") writes.push(route);
    if (route.startsWith("/api/mcp/approvals/")) {
      if(init?.method==="POST"){
        const body=JSON.parse(String(init.body));approvalBodies.push(body);
        if(approvalResponse)return approvalResponse();
        const next={...(setupResponse as Record<string,unknown>),status:body.decision==="approve"?"applied":"rejected",result:body.decision==="approve"?{setup_only:true}:null};
        setupResponse=next;return Response.json(next);
      }
      setupReads++;return setupResponse instanceof Response ? setupResponse : Response.json(setupResponse);
    }
    if (route === "/api/settings") { if(init?.method==="PUT")settingsWrite=JSON.parse(String(init.body));else settingsReads++; return Response.json({ values: {} }); }
    if (route === "/api/grants") return Response.json({ ok: true });
    throw new Error(`Unexpected request: ${route}`);
  };
});
afterEach(async () => { await ui.close(); globalThis.fetch = originalFetch; });
const screen = () => React.createElement(CreateAgent, { account, onRefresh() {}, onSignedIn() {}, onBack() {}, onDone() {}, onFund() {} });

async function limits() {
  await ui.render(screen());
  await ui.click("Customise strategy and limits");
  await act(async () => { ui.container.querySelector<HTMLInputElement>('input[value="steady-basket"]')!.click(); });
  const input = ui.container.querySelector<HTMLInputElement>("#agent-name")!;
  assert.ok(input, "new-agent form is reachable for an account without a saved wallet");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "Test agent");
    input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  });
  await ui.click("Set trading limits");
  await ui.click("Continue");
}
async function failedActivation() {
  await limits(); await ui.click("Create agent");
  assert.equal(mintCalls, 1);
  assert.match(ui.container.textContent!, /Retry activation/);
  writes = [];
}

it("a verified stopped local wallet resumes instead of minting another permission", async () => {
  stored = grant;
  await ui.render(screen());
  assert.match(ui.container.textContent!, /Resume your saved wallet/);
  assert.equal(ui.container.querySelector("a")?.getAttribute("href"), "/grant#resign");
  assert.equal(ui.container.querySelector("#agent-name"), null);
  assert.equal(mintCalls, 0); assert.deepEqual(writes, []);
});
it("a verified public recovery snapshot resumes without a browser's full grant", async () => {
  snapshots = [grant];
  await ui.render(screen());
  assert.match(ui.container.textContent!, /Resume your saved wallet/);
  assert.equal(mintCalls, 0); assert.deepEqual(writes, []);
});
it("another tenant's unverified saved metadata is not adopted", async () => {
  stored = grant; trusted = false;
  await ui.render(screen());
  assert.ok(ui.container.querySelector("#agent-name"));
  assert.doesNotMatch(ui.container.textContent!, /Resume your saved wallet/);
});
it("an unreadable recovery journal fails closed", async () => {
  storageFailed = true;
  await ui.render(screen());
  assert.match(ui.container.textContent!, /Couldn.t check your saved wallet/);
  assert.equal(ui.container.querySelector("#agent-name"), null);
  assert.equal(mintCalls, 0);
});
it("a saved wallet appearing after setup opens blocks all mint and settings writes", async () => {
  await limits(); stored = grant;
  await ui.click("Create agent");
  assert.match(ui.container.textContent!, /Resume your saved wallet/);
  assert.equal(mintCalls, 0); assert.deepEqual(writes, []);
});
it("a replacement marker added after rendering prevents Retry activation from posting", async () => {
  await failedActivation();
  markPermissionForReplacement(grant);
  await ui.click("Retry activation");
  assert.deepEqual(writes, []);
  assert.match(ui.container.textContent!, /Resume your saved wallet/);
});
it("Retry activation rechecks the signed-in account and never posts after a tenant change", async () => {
  await failedActivation(); current = { kind: "changed" };
  await ui.click("Retry activation");
  assert.deepEqual(writes, []);
  assert.match(ui.container.textContent!, /could not be verified for your current account/);
});

it("Retry activation requests a fresh proof for the same owner and permission", async () => {
  await failedActivation();
  await ui.click("Retry activation");
  assert.equal(mintCalls,1);
  assert.equal(retryProof?.ownerSigner.account.address,tenant);
  assert.equal(retryProof?.ownerSigner.binding,"privy-did-owner-v1");
  assert.equal(retryProof?.tenant,tenant);
  assert.deepEqual(writes,["/api/grants"]);
});

it("a lost success response recovers from authenticated stored permission status without posting again", async () => {
  await failedActivation();
  current={kind:"ready",account:{...account,status:{exists:true,tenant,grant}}};
  await ui.click("Retry activation");
  assert.deepEqual(writes,[]);
  assert.equal(retryProof,undefined);
  assert.equal(mintCalls,1);
  assert.match(ui.container.textContent!,/Your wallet is connected/);
});

for(const change of ["caps","expiry"] as const){
  const changedGrant=()=>change==="caps"?{...grant,caps:{...grant.caps,perTradeUsdg:1}}:{...grant,expiresAt:grant.expiresAt+1000};
  it(`reusing a session key with different ${change} cannot recover a lost response as success`,async()=>{
    await failedActivation();
    current={kind:"ready",account:{...account,status:{exists:true,tenant,grant:changedGrant()}}};
    await ui.click("Retry activation");
    assert.deepEqual(writes,[]);assert.equal(retryProof,undefined);
    assert.match(ui.container.textContent!,/Another permission is active/);
    assert.doesNotMatch(ui.container.textContent!,/Your wallet is connected/);
  });
  it(`reusing a session key with different ${change} during signing cannot allow a stale repost`,async()=>{
    await failedActivation();
    beforeRetrySubmit=()=>{current={kind:"ready",account:{...account,status:{exists:true,tenant,grant:changedGrant()}}};};
    await ui.click("Retry activation");
    assert.deepEqual(writes,[]);
    assert.match(ui.container.textContent!,/Another permission is active/);
    assert.doesNotMatch(ui.container.textContent!,/Your wallet is connected/);
  });
}

it("changing login during the retry signature prevents the handoff", async () => {
  await failedActivation();
  beforeRetrySubmit=()=>{current={kind:"changed"};};
  await ui.click("Retry activation");
  assert.deepEqual(writes,[]);
  assert.match(ui.container.textContent!,/signed-in account changed while confirming/);
});

it("selecting revocation during the retry signature prevents the handoff", async () => {
  await failedActivation();
  beforeRetrySubmit=()=>markPermissionForReplacement(grant);
  await ui.click("Retry activation");
  assert.deepEqual(writes,[]);
  assert.match(ui.container.textContent!,/Resume your saved wallet/);
});

it("a newer permission arriving during the retry signature is not replaced", async () => {
  await failedActivation();
  beforeRetrySubmit=()=>{current={kind:"ready",account:{...account,status:{exists:true,tenant,grant:{...grant,sessionKeyAddress:`0x${"e".repeat(40)}`}}}};};
  await ui.click("Retry activation");
  assert.deepEqual(writes,[]);
  assert.match(ui.container.textContent!,/Another permission is active/);
});

it("a stale Privy signer from another hosted login cannot mint or change settings", async () => {
  await limits(); signerAddress = `0x${"d".repeat(40)}`;
  await ui.render(screen());
  await ui.click("Create agent");
  assert.equal(mintCalls, 0); assert.deepEqual(writes, []);
  assert.match(ui.container.textContent!, /Your signing wallet changed/);
});

const proposalId=`prp_${"f".repeat(32)}`;
function setup(owner=tenant) {
  const expires_at=Math.floor(Date.now()/1000)+3600;
  const {maxImpactBps:_,...risk}=RISK_PROFILES.careful.settings;
  return {id:proposalId,binding_hash:"1".repeat(64),kind:"agent_draft",status:"applied",binding:{purpose:"create",tenant:owner,expires_at,risk_level:"careful",settings:{agentName:"Little Robin",strategy:"weekend-gap",basketSymbols:["TSLA"],assetMode:"stocks",...risk}},expires_at,requested_by:"ChatGPT",result:{setup_only:true}};
}
async function assistantSetup() {
  ui.dom.window.history.replaceState(null,"",`/create?proposal=${proposalId}`);
  setupResponse=setup();
  await ui.render(screen());
}
it("assistant setup carries name, strategy, basket and reviewed risk into actual wallet creation",async()=>{
  await assistantSetup();
  assert.match(ui.container.textContent!,/Little Robin/);assert.match(ui.container.textContent!,/Weekend gap/);
  assert.equal(ui.container.querySelector<HTMLInputElement>('input[name="mode"]')?.checked,true,"chat cannot opt a user into live trading");
  assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
  await ui.click("Create agent");
  assert.equal(setupReads,2,"setup standing is re-read before creation");
  assert.equal(mintCalls,1);
  assert.deepEqual({name:settingsWrite?.agentName,strategy:settingsWrite?.strategy,basket:settingsWrite?.basketSymbols,live:settingsWrite?.liveTradingEnabled}, {name:"Little Robin",strategy:"weekend-gap",basket:["TSLA"],live:false});
  for(const key of ["slippageBps","strategistStopLossBps","takeProfitBps","buyPerTickUsdg","llmMaxActionUsdg"]){
    assert.equal(settingsWrite?.[key],RISK_PROFILES.careful.settings[key as keyof typeof RISK_PROFILES.careful.settings]);
  }
  assert.equal(settingsWrite?.maxImpactBps,undefined);
});
it("revoking a connection after loading a setup blocks settings and wallet signing",async()=>{
  await assistantSetup();
  setupResponse=Response.json({error:"This assistant connection was revoked."},{status:403});
  await ui.click("Create agent");
  assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
  assert.match(ui.container.textContent!,/no longer available to your signed-in account or assistant connection/);
});
it("a foreign or expired setup never offers wallet creation",async()=>{
  ui.dom.window.history.replaceState(null,"",`/create?proposal=${proposalId}`);
  setupResponse=setup(`0x${"d".repeat(40)}`);
  await ui.render(screen());
  assert.match(ui.container.textContent!,/not approved for your current account/);
  assert.equal(ui.container.querySelector("#agent-name"),null);assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
  const expired=setup();expired.expires_at=1;expired.binding.expires_at=1;setupResponse=expired;
  await ui.remount(screen());
  assert.match(ui.container.textContent!,/not approved for your current account/);
  assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
});
it("a login change invalidates a previously loaded assistant setup",async()=>{
  await assistantSetup();
  const other=`0x${"d".repeat(40)}`;
  const changed={...account,session:{...account.session,address:other}};
  await ui.render(React.createElement(CreateAgent,{account:changed,onRefresh(){},onSignedIn(){},onBack(){},onDone(){},onFund(){}}));
  assert.match(ui.container.textContent!,/not approved for your current account/);
  assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
});

it("the compact handoff carries the approved setup straight to explicit signing and returns to chat",async()=>{
  ui.dom.window.history.replaceState(null,"",`/connect/setup/${proposalId}?proposal=untrusted&name=Injected`);
  setupResponse=setup();handoffOk=true;
  let returned=0;
  await ui.render(React.createElement(CreateAgent,{account,assistantProposalId:proposalId,onRefresh(){},onSignedIn(){},onBack(){},onDone(){returned++;},onFund(){}}));
  assert.match(ui.container.textContent!,/Little Robin/);
  assert.match(ui.container.textContent!,/Weekend gap/);
  assert.match(ui.container.textContent!,/Your limits. Your call/);
  assert.equal(ui.container.querySelector("#agent-name"),null,"the owner does not repeat chat's name and strategy choices");
  assert.equal(ui.container.querySelector<HTMLInputElement>('input[name="mode"]')?.checked,true);
  assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
  assert.equal(ui.container.querySelector('button[aria-label="Back to approved setup"]'),null,"the review and limits share one screen");
  await ui.click("Create practice agent");
  assert.equal(setupReads,2);assert.equal(mintCalls,1);
  assert.equal(settingsWrite?.agentName,"Little Robin");assert.equal(settingsWrite?.strategy,"weekend-gap");
  assert.equal(settingsWrite?.liveTradingEnabled,false);
  assert.match(ui.container.textContent!,/Wallet connected/);
  assert.match(ui.container.textContent!,/refresh Merryman to check activation/);
  assert.match(ui.container.textContent!,/Copy a status-check message/);
  assert.doesNotMatch(ui.container.textContent!,/Done — return to chat/);
  assert.equal(returned,0,"the complete return-to-chat instructions need no second completion click");
});

it("compact handoff still blocks a revoked setup at the moment of signing",async()=>{
  setupResponse=setup();
  await ui.render(React.createElement(CreateAgent,{account,assistantProposalId:proposalId,onRefresh(){},onSignedIn(){},onBack(){},onDone(){},onFund(){}}));
  setupResponse=Response.json({error:"forbidden"},{status:403});
  await ui.click("Create practice agent");
  assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
  assert.match(ui.container.textContent!,/no longer available/);
});

it("an unavailable compact setup sends the owner back to chat instead of restarting the full wizard",async()=>{
  setupResponse=Response.json({error:"expired"},{status:410});
  await ui.render(React.createElement(CreateAgent,{account,assistantProposalId:proposalId,onRefresh(){},onSignedIn(){},onBack(){},onDone(){},onFund(){}}));
  assert.match(ui.container.textContent!,/Return to the same chat/);
  assert.equal(ui.container.querySelector('a[href="/create"]'),null);
  assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
});

it("an older approved crypto-only setup without a crypto basket cannot reach signing",async()=>{
  const old=setup();const settings=old.binding.settings as Record<string,unknown>;
  settings.assetMode="crypto";delete settings.basketSymbols;setupResponse=old;
  await ui.render(React.createElement(CreateAgent,{account,assistantProposalId:proposalId,onRefresh(){},onSignedIn(){},onBack(){},onDone(){},onFund(){}}));
  assert.match(ui.container.textContent!,/Crypto-only setup needs an explicit basket/);
  assert.match(ui.container.textContent!,/Return to the same chat/);
  assert.equal(Array.from(ui.container.querySelectorAll("button")).some(button=>button.textContent==="Create practice agent"),false);
  assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
});

function pendingSetup(){return {...setup(),status:"awaiting_approval",result:null};}
const combinedScreen=(ownerAccount=account)=>React.createElement(CreateAgent,{account:ownerAccount,assistantProposalId:proposalId,onRefresh(){},onSignedIn(){},onBack(){},onDone(){},onFund(){}});

it("the owner review formats monetary strategy settings in the reader's locale",async()=>{
  ui.dom.window.document.documentElement.lang="pt-BR";
  setupResponse=pendingSetup();
  await ui.render(combinedScreen());
  const rows=Array.from(ui.container.querySelectorAll("details dl > div"));
  for(const label of ["Amount per buy","Maximum AI trade"]){
    const row=rows.find(item=>item.querySelector("dt")?.textContent===label);
    assert.match(row?.querySelector("dd")?.textContent??"",/^US\$\s10,00$/);
  }
  assert.equal(settingsWrite,null);assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
});

it("one explicit action approves the displayed draft before saving settings and signing",async()=>{
  setupResponse=pendingSetup();handoffOk=true;
  await ui.render(combinedScreen());
  assert.match(ui.container.textContent!,/Little Robin/);
  assert.match(ui.container.textContent!,/Review strategy settings/);
  assert.match(ui.container.textContent!,/Setup expires/);
  assert.match(ui.container.textContent!,/Decline setup/);
  assert.equal(ui.container.querySelector<HTMLInputElement>('input[name="mode"]')?.checked,true);
  assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
  await ui.click("Approve and create practice agent");
  assert.deepEqual(approvalBodies,[{decision:"approve",hash:"1".repeat(64)}]);
  assert.deepEqual(writes,[`/api/mcp/approvals/${proposalId}`,"/api/settings"]);
  assert.equal(setupReads,3,"standing is rechecked after the owner decision");
  assert.equal(mintCalls,1);assert.equal(settingsWrite?.liveTradingEnabled,false);
  assert.match(ui.container.textContent!,/Wallet connected/);
});

it("declining the combined setup changes no settings and signs nothing",async()=>{
  setupResponse=pendingSetup();
  await ui.render(combinedScreen());
  await ui.click("Decline setup");
  assert.deepEqual(approvalBodies,[{decision:"reject",hash:"1".repeat(64)}]);
  assert.equal(mintCalls,0);assert.equal(settingsWrite,null);
  assert.match(ui.container.textContent!,/Setup declined/);
});

it("an authenticated owner without a protected signer can review and decline, but cannot approve creation",async()=>{
  setupResponse=pendingSetup();signerReady=false;
  await ui.render(combinedScreen());
  assert.match(ui.container.textContent!,/Little Robin/);
  assert.match(ui.container.textContent!,/protected signing wallet is not ready/);
  const create=Array.from(ui.container.querySelectorAll("button")).find(b=>b.textContent==="Approve and create practice agent")!;
  assert.ok(create);assert.equal(create.disabled,true);
  await act(async()=>{create.click();});
  assert.deepEqual(writes,[]);assert.deepEqual(approvalBodies,[]);assert.equal(mintCalls,0);
  await ui.click("Decline setup");
  assert.deepEqual(approvalBodies,[{decision:"reject",hash:"1".repeat(64)}]);
  assert.equal(settingsWrite,null);assert.equal(mintCalls,0);
  assert.match(ui.container.textContent!,/Setup declined/);
});

it("a proposal URL also reaches review and decline without a protected signer",async()=>{
  ui.dom.window.history.replaceState(null,"",`/create?proposal=${proposalId}`);
  setupResponse=pendingSetup();signerReady=false;
  await ui.render(screen());
  assert.match(ui.container.textContent!,/Little Robin/);
  const create=Array.from(ui.container.querySelectorAll("button")).find(b=>b.textContent==="Approve and create practice agent")!;
  assert.ok(create);assert.equal(create.disabled,true);
  await ui.click("Decline setup");
  assert.deepEqual(approvalBodies,[{decision:"reject",hash:"1".repeat(64)}]);
  assert.equal(settingsWrite,null);assert.equal(mintCalls,0);
  assert.match(ui.container.textContent!,/Setup declined/);
});

it("an already-approved setup remains readable but cannot create without a protected signer",async()=>{
  setupResponse=setup();signerReady=false;
  await ui.render(combinedScreen());
  assert.match(ui.container.textContent!,/Little Robin/);
  assert.doesNotMatch(ui.container.textContent!,/Decline setup/);
  const create=Array.from(ui.container.querySelectorAll("button")).find(b=>b.textContent==="Create practice agent")!;
  assert.ok(create);assert.equal(create.disabled,true);
  await act(async()=>{create.click();});
  assert.deepEqual(writes,[]);assert.equal(mintCalls,0);
});

for(const blocker of ["active wallet","saved wallet","replacement wallet","unreadable recovery"] as const){
  it(`a pending draft remains declinable with ${blocker}, without reading settings or signing`,async()=>{
    const ownerAccount=blocker==="active wallet"?{...account,status:{...account.status,exists:true,grant}}:account;
    current={kind:"ready",account:ownerAccount};setupResponse=pendingSetup();signerReady=false;
    if(blocker==="unreadable recovery")storageFailed=true;else stored=grant;
    if(blocker==="replacement wallet")markPermissionForReplacement(grant);
    await ui.render(combinedScreen(ownerAccount));
    assert.match(ui.container.textContent!,/Little Robin/);
    assert.match(ui.container.textContent!,blocker==="active wallet"?/already set up/:blocker==="unreadable recovery"?/Couldn.t check your saved wallet/:/Resume your saved wallet/);
    assert.equal(ui.container.querySelector('input[name="mode"]'),null,"creation stays blocked");
    assert.doesNotMatch(ui.container.textContent!,/Approve and create/);
    assert.deepEqual(writes,[]);assert.equal(settingsReads,0);assert.equal(mintCalls,0);
    await ui.click("Decline setup");
    assert.deepEqual(approvalBodies,[{decision:"reject",hash:"1".repeat(64)}]);
    assert.equal(settingsReads,0);assert.equal(settingsWrite,null);assert.equal(mintCalls,0);
    assert.match(ui.container.textContent!,/Setup declined/);
  });
}

it("a wallet created in another tab blocks creation but preserves the pending decline",async()=>{
  setupResponse=pendingSetup();await ui.render(combinedScreen());
  const ownerAccount={...account,status:{...account.status,exists:true,grant}};
  current={kind:"ready",account:ownerAccount};stored=grant;
  await ui.render(combinedScreen(ownerAccount));
  assert.match(ui.container.textContent!,/already set up/);assert.match(ui.container.textContent!,/Little Robin/);
  assert.doesNotMatch(ui.container.textContent!,/Approve and create/);
  await ui.click("Decline setup");
  assert.deepEqual(approvalBodies,[{decision:"reject",hash:"1".repeat(64)}]);
  assert.equal(settingsReads,0);assert.equal(settingsWrite,null);assert.equal(mintCalls,0);
});

it("a creation blocker never exposes a foreign draft for decline",async()=>{
  const ownerAccount={...account,status:{...account.status,exists:true,grant}};
  setupResponse={...pendingSetup(),binding:{...pendingSetup().binding,tenant:`0x${"d".repeat(40)}`}};
  await ui.render(combinedScreen(ownerAccount));
  assert.match(ui.container.textContent!,/not approved for your current account/);
  assert.doesNotMatch(ui.container.textContent!,/Little Robin|Decline setup/);
  assert.equal(settingsReads,0);assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
});

it("approval rejection or an unapplied response never reaches settings or signing",async()=>{
  for(const response of [()=>Response.json({error:"refused"},{status:409}),()=>Response.json(pendingSetup())]){
    setupResponse=pendingSetup();approvalResponse=async()=>response();approvalBodies=[];writes=[];
    await ui.remount(combinedScreen());
    await ui.click("Approve and create practice agent");
    assert.equal(approvalBodies.length,1);assert.equal(mintCalls,0);assert.equal(settingsWrite,null);
    assert.ok(ui.container.querySelector('[role="alert"]'));
  }
});

it("a different binding hash after review is refused before approval",async()=>{
  setupResponse=pendingSetup();await ui.render(combinedScreen());
  setupResponse={...pendingSetup(),binding_hash:"2".repeat(64)};
  await ui.click("Approve and create practice agent");
  assert.deepEqual(writes,[]);assert.equal(mintCalls,0);
  assert.match(ui.container.textContent!,/setup changed/);
});

it("a refused approval shows the bounded owner-facing remedy without continuing",async()=>{
  const description="You already have a Merryman. Open your agent instead. "+"x".repeat(700);
  setupResponse=pendingSetup();approvalResponse=async()=>Response.json({error:"refused",error_description:description},{status:409});
  await ui.render(combinedScreen());await ui.click("Approve and create practice agent");
  assert.equal(ui.container.querySelector('[role="alert"]')?.textContent,description.slice(0,600));
  assert.equal(settingsWrite,null);assert.equal(mintCalls,0);
});

it("duplicate clicks cannot approve or sign twice while approval is pending",async()=>{
  let resolve!:(response:Response)=>void;
  const pending=new Promise<Response>(r=>{resolve=r;});
  setupResponse=pendingSetup();approvalResponse=()=>pending;handoffOk=true;
  await ui.render(combinedScreen());
  const button=Array.from(ui.container.querySelectorAll("button")).find(b=>b.textContent==="Approve and create practice agent")!;
  await act(async()=>{button.click();button.click();});
  assert.equal(approvalBodies.length,1);assert.equal(mintCalls,0);assert.equal(settingsWrite,null);
  assert.equal(ui.container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.disabled,true);
  setupResponse=setup();
  await act(async()=>{resolve(Response.json(setupResponse));});
  assert.equal(mintCalls,1);assert.equal(writes.filter(route=>route==="/api/settings").length,1);
});

it("a revoked connection after approval stops before settings and signing",async()=>{
  setupResponse=pendingSetup();
  approvalResponse=async()=>{setupResponse=Response.json({error:"forbidden"},{status:403});return Response.json(setup());};
  await ui.render(combinedScreen());await ui.click("Approve and create practice agent");
  assert.equal(approvalBodies.length,1);assert.equal(mintCalls,0);assert.equal(settingsWrite,null);
  assert.match(ui.container.textContent!,/no longer available/);
});

it("a login change during approval stops before settings and signing",async()=>{
  setupResponse=pendingSetup();
  approvalResponse=async()=>{setupResponse=setup();current={kind:"changed"};return Response.json(setupResponse);};
  await ui.render(combinedScreen());await ui.click("Approve and create practice agent");
  assert.equal(mintCalls,0);assert.equal(settingsWrite,null);
  assert.match(ui.container.textContent!,/signed-in account changed/);
});

it("an existing or saved wallet appearing during approval is preserved",async()=>{
  for(const existing of [true,false]){
    current={kind:"ready",account};stored=null;setupResponse=pendingSetup();
    approvalResponse=async()=>{
      setupResponse=setup();
      if(existing)current={kind:"ready",account:{...account,status:{...account.status,exists:true}}};else stored=grant;
      return Response.json(setupResponse);
    };
    await ui.remount(combinedScreen());await ui.click("Approve and create practice agent");
    assert.equal(mintCalls,0);assert.equal(settingsWrite,null);
    assert.match(ui.container.textContent!,existing?/already active/:/Resume your saved wallet/);
  }
});

it("an approved setup reload requires a new owner action and does not reapprove",async()=>{
  setupResponse=setup();handoffOk=true;
  await ui.render(combinedScreen());await ui.remount(combinedScreen());
  assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
  assert.doesNotMatch(ui.container.textContent!,/Decline setup/);
  await ui.click("Create practice agent");
  assert.deepEqual(approvalBodies,[]);assert.equal(mintCalls,1);
});

it("a refused wallet signature keeps approval saved and requires an explicit retry",async()=>{
  setupResponse=pendingSetup();mintFailure=new Error("Signature was declined.");
  await ui.render(combinedScreen());await ui.click("Approve and create practice agent");
  assert.equal(approvalBodies.length,1);assert.equal(mintCalls,1);
  assert.match(ui.container.textContent!,/Signature was declined/);
  assert.doesNotMatch(ui.container.textContent!,/Wallet connected/);
  mintFailure=null;handoffOk=true;
  await ui.click("Create practice agent");
  assert.equal(approvalBodies.length,1,"the recorded approval is reused after explicit retry");assert.equal(mintCalls,2);
});
