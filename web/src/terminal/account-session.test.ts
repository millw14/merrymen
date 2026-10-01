import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accountFeedRead, readAccountForSession } from "./account-session";
import type { AccountState } from "./HostedControls";

const A: AccountState["session"] = { hosted: true, address: `0x${"a".repeat(40)}` };
const B: AccountState["session"] = { hosted: true, address: `0x${"b".repeat(40)}` };

describe("the owner's feed read after grants answers", () => {
  it("keeps the loading state when grants wins the first-read race", () => {
    assert.equal(accountFeedRead(A, undefined, "unread"), "unread");
  });

  it("shows a completed feed only when it belongs to the confirmed tenant", () => {
    assert.equal(accountFeedRead(A, A.address, "ok"), "ok");
    assert.equal(accountFeedRead(A, B.address, "ok"), "unreadable");
    assert.equal(accountFeedRead(A, undefined, "ok"), "unreadable");
  });

  it("keeps failed feed reads failed", () => {
    assert.equal(accountFeedRead(A, undefined, "unreadable"), "unreadable");
    assert.equal(accountFeedRead(A, A.address, "unreadable"), "unreadable");
  });
});

describe("account reads across a session change", () => {
  it("detects another tab's login before a failing grants request can retain the old tenant", async () => {
    let grantsAsked = 0;
    const result = await readAccountForSession(
      A,
      async () => B,
      async () => {
        grantsAsked++;
        throw new Error("grant store unavailable");
      },
    );
    assert.deepEqual(result, { kind: "changed" });
    assert.equal(grantsAsked, 0, "the old tenant is invalidated without waiting for grants");
  });

  it("rejects a grant fetched while another tab changes the cookie", async () => {
    let reads = 0;
    const result = await readAccountForSession(
      A,
      async () => ++reads === 1 ? A : B,
      async () => ({ exists: true }),
    );
    assert.deepEqual(result, { kind: "changed" }, "an A session must not be paired with B's grant");
    assert.equal(reads, 2);
  });

  it("rejects A→B→A when both session reads say A but grants belongs to B", async () => {
    const result = await readAccountForSession(
      A,
      async () => A,
      async () => ({ exists: true, tenant: B.address }),
    );
    assert.equal(result.kind, "unverified", "the mismatched status is never attached to A");
  });

  it("does not trust a hosted grant response missing its tenant binding", async () => {
    const result = await readAccountForSession(A, async () => A, async () => ({ exists: true }));
    assert.equal(result.kind, "unverified");
  });

  it("detects a cookie change even when the concurrent grants request fails", async () => {
    let reads = 0;
    const result = await readAccountForSession(
      A,
      async () => ++reads === 1 ? A : B,
      async () => { throw new Error("grant store unavailable"); },
    );
    assert.deepEqual(result, { kind: "changed" });
    assert.equal(reads, 2, "failure does not skip the identity recheck");
  });

  it("requires a readable session before retaining any previous account", async () => {
    const error = new Error("session endpoint unavailable");
    const result = await readAccountForSession(A, async () => { throw error; }, async () => ({ exists: true }));
    assert.deepEqual(result, { kind: "unverified", error });
  });

  it("distinguishes a grants outage under the same verified tenant", async () => {
    const error = new Error("grant store unavailable");
    const result = await readAccountForSession(A, async () => A, async () => { throw error; });
    assert.deepEqual(result, { kind: "failed", error });
  });

  it("accepts a complete read only while the tenant stays the same", async () => {
    const status: AccountState["status"] = { exists: true, tenant: A.address };
    const result = await readAccountForSession(A, async () => A, async () => status);
    assert.deepEqual(result, { kind: "ready", account: { session: A, status } });
  });

  it("accepts a confirmed signed-out hosted read bound to null", async () => {
    const signedOut: AccountState["session"] = { hosted: true, address: null };
    const status: AccountState["status"] = { exists: false, tenant: null };
    const result = await readAccountForSession(signedOut, async () => signedOut, async () => status);
    assert.deepEqual(result, { kind: "ready", account: { session: signedOut, status } });
  });

  it("does not turn a malformed status into a no-agent result", async () => {
    const result = await readAccountForSession(
      A,
      async () => A,
      async () => ({ tenant: A.address } as AccountState["status"]),
    );
    assert.equal(result.kind, "unverified");
  });
});
