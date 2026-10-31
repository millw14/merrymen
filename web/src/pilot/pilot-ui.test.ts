import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { before, beforeEach, afterEach, test, mock } from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { PilotIdentity } from "./PilotJoin";
import type { PilotAccess, PilotAdminData } from "./pilot-client";

const OWNER = `0x${"a".repeat(40)}`, OTHER = `0x${"b".repeat(40)}`;
const require = createRequire(import.meta.url), originalFetch = globalThis.fetch;
let testDom: typeof import("../terminal/test-dom").testDom, json: typeof import("../terminal/test-dom").json, deferred: typeof import("../terminal/test-dom").deferred;
let Join: typeof import("./PilotJoin").PilotJoinView, Admin: typeof import("./PilotAdmin").PilotAdmin;
let ui: ReturnType<typeof testDom>, tenant: string | null, status: PilotAccess["status"], admin: boolean, available: boolean;
let writes: { url: string; body: Record<string, unknown>; authorization: string | null }[], reads: string[];
let tokenWait: ReturnType<typeof deferred<string | null>> | null, postWait: ReturnType<typeof deferred<Response>> | null;
let sessionWait: ReturnType<typeof deferred<Response>> | null, adminWait: ReturnType<typeof deferred<Response>> | null;
let data: PilotAdminData, rejectPost: number, redeemStatus: PilotAccess["status"];
const identity = (owner = OWNER, did = "did:privy:alice"): PilotIdentity => ({ owner, did, getAccessToken: () => tokenWait?.promise ?? Promise.resolve("fresh-token") });
const access = () => ({ tenant, status, revision: 1, paperAvailable: available, admin });

before(async () => {
  const boot = new JSDOM("<!doctype html>", { pretendToBeVisual: true });
  Object.assign(globalThis, { window: boot.window, document: boot.window.document });
  ({ testDom, json, deferred } = await import("../terminal/test-dom"));
  const loader = Module as unknown as { _load: (id: string, parent: unknown, main: boolean) => unknown }, load = loader._load;
  const hook = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: unknown, main: boolean) {
    if (id.endsWith(".css")) return {};
    if (id === "@privy-io/react-auth") return { usePrivy: () => ({}) };
    if (id === "../terminal/usePrivyOwner") return { usePrivyOwner: () => null };
    if (id === "../terminal/HostedControls") return { PRIVY_BETA: false, SignIn: ({ onDone }: { onDone: () => void }) => React.createElement("button", { onClick: () => { tenant = OWNER; onDone(); } }, "Test sign in") };
    if (id === "../terminal/SignOut") return { SignOut: ({ onStart, after }: { onStart: () => void; after: () => void }) => React.createElement("button", { onClick: () => { onStart(); tenant = null; after(); } }, "Test sign out") };
    return load.call(this, id, parent, main);
  });
  try { Join = require("./PilotJoin.tsx").PilotJoinView; Admin = require("./PilotAdmin.tsx").PilotAdmin; }
  finally { hook.mock.restore(); boot.window.close(); }
});
beforeEach(() => {
  ui = testDom(); tenant = OWNER; status = "not-admitted"; redeemStatus = "pending"; admin = false; available = true; rejectPost = 0;
  writes = []; reads = []; tokenWait = null; postWait = null; sessionWait = null; adminWait = null;
  data = { tenant: OWNER, revision: 1, capacity: 100, requestLimit: 1000, requests: [], admissions: [{ owner: OTHER, status: "allowed", revision: 4, updatedAt: 1_790_000_000_000 }], invites: [] };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)); writes.push({ url, body, authorization: new Headers(init.headers).get("authorization") });
      if (postWait) return postWait.promise;
      if (rejectPost) return json({ error: "This record changed. Refresh before updating it." }, rejectPost);
      if (url === "/api/perps/pilot/redeem?wallet=perps") { status = redeemStatus; return json(access()); }
      if (url === "/api/perps/pilot/admin?wallet=perps") {
        if (body.action === "create-invite") return json({ code: "PRIVATE-CODE", invite: { id: "invite-1", createdAt: Date.now(), expiresAt: Date.now() + 86_400_000, maxUses: 1, uses: 0, revoked: false } });
        if (body.action === "set-admission") {
          data.revision++;
          data.requests = data.requests.filter(row => row.owner !== body.owner);
          data.admissions = data.admissions.filter(row => row.owner !== body.owner);
          data.admissions.push({ owner: body.owner, status: body.status, revision: data.revision, updatedAt: Date.now() });
        }
        return json({ ok: true });
      }
      throw new Error(`Unexpected write: ${url}`);
    }
    reads.push(url);
    if (url === "/api/auth/session") return sessionWait?.promise ?? json({ hosted: true, address: tenant });
    if (url === "/api/perps/pilot?wallet=perps") return json(access());
    if (url === "/api/perps/pilot/admin?wallet=perps") return adminWait?.promise ?? json(data);
    throw new Error(`Unexpected read: ${url}`);
  };
});
afterEach(async () => { await ui.close(); globalThis.fetch = originalFetch; });
async function input(id: string, value: string) {
  const element = ui.container.querySelector(`#${id}`) as HTMLInputElement; assert.ok(element, id);
  await act(async () => {
    Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  });
}
async function submit(id: string) {
  const form = ui.container.querySelector(`#${id}`)!.closest("form")!;
  await act(async () => { form.dispatchEvent(new ui.dom.window.Event("submit", { bubbles: true, cancelable: true })); });
}
const renderJoin = (owner: PilotIdentity | null = identity()) => ui.render(React.createElement(Join, { identity: owner, signInEnabled: true }));

test("sign-up submits the signed-in owner for review without a wallet field, URL code, permission setup, or trade", async () => {
  tenant = null; await renderJoin();
  await input("pilot-code", "INVITE-ONE"); await submit("pilot-code");
  assert.equal(writes.length, 0); assert.match(ui.container.textContent!, /Sign in or create your account/);
  await ui.click("Test sign in");
  assert.deepEqual(writes, [{ url: "/api/perps/pilot/redeem?wallet=perps", body: { code: "INVITE-ONE", expectedTenant: OWNER }, authorization: "Bearer fresh-token" }]);
  assert.match(ui.container.textContent!, /Waiting for administrator approval/);
  assert.equal(ui.container.querySelector('input[name="wallet"]'), null);
  assert.equal(ui.container.querySelector('a[href="/create?for=perps"]'), null);
  assert.equal(ui.container.querySelector('a[href="/perps"]'), null);
  assert.equal(ui.container.querySelector("#pilot-code"), null);
  assert.ok(reads.every(url => !url.includes("INVITE-ONE")));
  assert.equal(ui.dom.window.localStorage.length, 0);
});
test("submitting while paper is off remains pending without offering permission setup", async () => {
  available = false; await renderJoin(); await input("pilot-code", "EARLY"); await submit("pilot-code");
  assert.match(ui.container.textContent!, /Waiting for administrator approval/);
  assert.equal(ui.container.querySelector('a[href="/create?for=perps"]'), null);
  assert.equal(ui.container.querySelector('a[href="/perps"]'), null);
  assert.equal(writes.length, 1);
});
test("merely signing in never redeems an invitation", async () => {
  await renderJoin(); await input("pilot-code", "NOT-SUBMITTED");
  assert.equal(writes.length, 0);
});
test("a signed-in session with a different embedded owner is refused before requesting a token", async () => {
  await renderJoin(identity(OTHER)); await input("pilot-code", "INVITE"); await submit("pilot-code");
  assert.equal(writes.length, 0); assert.match(ui.container.textContent!, /does not own the account/);
});
test("an unmounted screen cannot redeem after a delayed token arrives", async () => {
  tokenWait = deferred(); await renderJoin(); await input("pilot-code", "INVITE"); await submit("pilot-code");
  await ui.remount(React.createElement("p", null, "gone"));
  await act(async () => tokenWait!.resolve("late-token"));
  assert.equal(writes.length, 0);
});
test("A→B→A signer changes invalidate the original redemption even when the final address matches", async () => {
  tokenWait = deferred(); await renderJoin(); await input("pilot-code", "INVITE"); await submit("pilot-code");
  await renderJoin(identity(OTHER, "did:privy:bob")); await renderJoin(identity());
  await act(async () => tokenWait!.resolve("late-token"));
  assert.equal(writes.length, 0);
});
test("a changed server session during mutation preflight prevents redemption", async () => {
  await renderJoin(); sessionWait = deferred();
  await input("pilot-code", "INVITE"); await submit("pilot-code");
  tenant = OTHER;
  const pending = sessionWait; sessionWait = null;
  await act(async () => pending.resolve(json({ hosted: true, address: OTHER })));
  assert.equal(writes.length, 0);
});
test("a lost redemption reply is not automatically retried", async () => {
  rejectPost = 503; await renderJoin(); await input("pilot-code", "INVITE"); await submit("pilot-code");
  assert.equal(writes.length, 1); assert.match(ui.container.textContent!, /error \(503\)/);
});
test("a non-admin never requests or renders the private admin list", async () => {
  await ui.render(React.createElement(Admin));
  assert.match(ui.container.textContent!, /Admin access is required/);
  assert.ok(!reads.includes("/api/perps/pilot/admin?wallet=perps"));
  assert.ok(!ui.container.textContent!.includes(OTHER));
});
test("admin wallet removal is explicitly confirmed and sends the reviewed list revision", async () => {
  admin = true; await ui.render(React.createElement(Admin)); await ui.click("Remove access");
  assert.equal(writes.length, 0); await ui.click("Confirm change");
  assert.deepEqual(writes[0]!.body, { expectedTenant: OWNER, action: "set-admission", owner: OTHER, status: "revoked", expectedRevision: 1 });
  assert.equal(writes.length, 1);
});
test("an old admin confirmation cannot post after the session switches", async () => {
  admin = true; await ui.render(React.createElement(Admin)); await ui.click("Remove access");
  tenant = OTHER; await ui.click("Confirm change");
  assert.equal(writes.length, 0);
});
test("invitation defaults are one use and seven days; raw code only appears after explicit confirmation", async () => {
  admin = true; await ui.render(React.createElement(Admin)); await ui.click("Review invitation");
  assert.equal(writes.length, 0); await ui.click("Confirm change");
  assert.deepEqual(writes[0]!.body, { expectedTenant: OWNER, action: "create-invite", maxUses: 1, expiresInDays: 7 });
  assert.match(ui.container.textContent!, /PRIVATE-CODE/);
  assert.equal(ui.dom.window.localStorage.length, 0);
  await ui.click("Test sign out");
  assert.ok(!ui.container.textContent!.includes("PRIVATE-CODE"));
});
test("stale admin revisions show refusal and do not retry or report success", async () => {
  admin = true; rejectPost = 409; await ui.render(React.createElement(Admin)); await ui.click("Remove access"); await ui.click("Confirm change");
  assert.equal(writes.length, 1); assert.match(ui.container.textContent!, /record changed/); assert.doesNotMatch(ui.container.textContent!, /Admission updated/);
});
test("an admin list for another tenant is never displayed", async () => {
  admin = true; data.tenant = OTHER; await ui.render(React.createElement(Admin));
  assert.match(ui.container.textContent!, /admin response belongs to an unknown account/);
  assert.equal(ui.container.querySelector("table"), null);
});

test("pending owners cannot submit another code and a status refresh reveals later approval without any writes", async () => {
  status = "pending"; await renderJoin();
  assert.equal(ui.container.querySelector("#pilot-code"), null);
  assert.equal(ui.container.querySelector('a[href="/create?for=perps"]'), null);
  assert.match(ui.container.textContent!, /checks for updates automatically/);
  status = "allowed"; await ui.click("Check approval status");
  assert.match(ui.container.textContent!, /Your paper access is approved/);
  assert.ok(ui.container.querySelector('a[href="/create?for=perps"]'));
  assert.equal(writes.length, 0);
});
test("approval before launch does not offer a permission or desk link", async () => {
  status = "pending"; available = false; await renderJoin();
  status = "allowed"; await ui.click("Check approval status");
  assert.match(ui.container.textContent!, /approved\. Launch is next/);
  assert.equal(ui.container.querySelector('a[href="/create?for=perps"]'), null);
  assert.equal(ui.container.querySelector('a[href="/perps"]'), null);
  assert.equal(writes.length, 0);
});
test("an admin rejection racing the successful request response is refreshed and never offers resubmission", async () => {
  redeemStatus = "revoked"; await renderJoin(); await input("pilot-code", "INVITE"); await submit("pilot-code");
  assert.match(ui.container.textContent!, /Access is not approved/);
  assert.equal(ui.container.querySelector("#pilot-code"), null);
  assert.equal(ui.container.querySelector('a[href="/create?for=perps"]'), null);
  assert.equal(writes.length, 1);
});
for (const refusal of [400, 403, 429]) test(`a refused invitation (${refusal}) never displays a submitted or approved request and is not retried`, async () => {
  rejectPost = refusal; await renderJoin(); await input("pilot-code", "INVALID"); await submit("pilot-code");
  assert.equal(writes.length, 1);
  assert.equal(ui.container.querySelector('[aria-label="Pending approval"]'), null);
  assert.equal(ui.container.querySelector('a[href="/create?for=perps"]'), null);
  assert.ok(ui.container.querySelector("#pilot-code"));
});
test("a pending status received while the token is delayed cancels duplicate request submission", async () => {
  tokenWait = deferred(); await renderJoin(); await input("pilot-code", "INVITE"); await submit("pilot-code");
  status = "pending";
  await act(async () => { ui.dom.window.dispatchEvent(new ui.dom.window.Event("focus")); });
  await act(async () => tokenWait!.resolve("late-token"));
  assert.equal(writes.length, 0);
  assert.equal(ui.container.querySelector("#pilot-code"), null);
  assert.match(ui.container.textContent!, /Waiting for administrator approval/);
});
for (const action of ["Approve", "Reject"] as const) test(`admin ${action.toLowerCase()} requires confirmation and sends the reviewed global revision`, async () => {
  admin = true; data.admissions = []; data.requests = [{ owner: OTHER, inviteId: "invite-1", submittedAt: 1_790_000_000_000 }];
  await ui.render(React.createElement(Admin));
  assert.match(ui.container.querySelector('[aria-label="Pending requests"]')!.textContent!, /1 of 1000 review queue places/);
  await ui.click(action); assert.equal(writes.length, 0);
  assert.match(ui.container.textContent!, new RegExp(`${action}.*${OTHER}`));
  await ui.click("Confirm change");
  assert.deepEqual(writes, [{ url: "/api/perps/pilot/admin?wallet=perps", body: { expectedTenant: OWNER, action: "set-admission", owner: OTHER, status: action === "Approve" ? "allowed" : "revoked", expectedRevision: 1 }, authorization: null }]);
  assert.doesNotMatch(ui.container.querySelector('[aria-label="Pending requests"]')!.textContent!, new RegExp(OTHER));
  assert.match(ui.container.textContent!, new RegExp(`${OTHER}${action === "Approve" ? "allowed" : "revoked"}`));
});
test("new pending requests with the same cohort revision appear on explicit refresh", async () => {
  admin = true; data.admissions = []; await ui.render(React.createElement(Admin));
  assert.match(ui.container.textContent!, /No requests awaiting review/);
  data.requests = [{ owner: OTHER, inviteId: "new-request", submittedAt: 1_790_000_000_000 }];
  await ui.click("Refresh access");
  const queue = ui.container.querySelector('[aria-label="Pending requests"]')!;
  assert.match(queue.textContent!, /new-request/);
  assert.match(queue.textContent!, new RegExp(OTHER));
  assert.equal(writes.length, 0);
});
test("a stale pending approval is not retried and never reports success", async () => {
  admin = true; rejectPost = 409; data.admissions = []; data.requests = [{ owner: OTHER, inviteId: "invite-1", submittedAt: 1_790_000_000_000 }];
  await ui.render(React.createElement(Admin)); await ui.click("Approve"); await ui.click("Confirm change");
  assert.equal(writes.length, 1); assert.match(ui.container.textContent!, /record changed/);
  assert.doesNotMatch(ui.container.textContent!, /Admission updated/);
  assert.match(ui.container.querySelector('[aria-label="Pending requests"]')!.textContent!, new RegExp(OTHER));
});
test("an account switch prevents a previously reviewed pending request approval", async () => {
  admin = true; data.admissions = []; data.requests = [{ owner: OTHER, inviteId: "invite-1", submittedAt: 1_790_000_000_000 }];
  await ui.render(React.createElement(Admin)); await ui.click("Approve");
  tenant = OTHER; await ui.click("Confirm change");
  assert.equal(writes.length, 0);
});
test("malformed, duplicate, or already resolved pending requests are never actionable", async () => {
  const { parsePilotAdmin } = await import("./pilot-client");
  const request = { owner: OTHER, inviteId: "invite-1", submittedAt: 1_790_000_000_000 };
  assert.throws(() => parsePilotAdmin({ ...data, admissions: [], requests: [{ ...request, submittedAt: -1 }] }, OWNER), /pending request/);
  assert.throws(() => parsePilotAdmin({ ...data, admissions: [], requests: [request, request] }, OWNER), /Conflicting pending/);
  assert.throws(() => parsePilotAdmin({ ...data, requests: [request] }, OWNER), /Conflicting pending/);
  assert.throws(() => parsePilotAdmin({ ...data, requests: [], requestLimit: 1001 }, OWNER), /could not be read/);
});

test("pending access polls for administrator approval at the existing read-only interval", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    status = "pending"; await renderJoin();
    status = "allowed";
    await act(async () => { mock.timers.tick(15_000); });
    assert.match(ui.container.textContent!, /Your paper access is approved/);
    assert.ok(ui.container.querySelector('a[href="/create?for=perps"]'));
    assert.equal(writes.length, 0);
  } finally { mock.timers.reset(); }
});
