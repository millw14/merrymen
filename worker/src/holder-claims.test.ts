/**
 * ONE $MERRYMEN WALLET POWERS ONE AGENT — the orchestrator's half.
 *
 * What the child is handed (childSettingsFor), how proofs from before claims
 * existed get claimed (backfillHolderClaims, earliest proof first), and the
 * orchestrator wiring that ties them to the reconcile pass.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { backfillHolderClaims, childSettingsFor, planHolderBackfill } from "./holder-claims";
import { FileSettingsStore } from "./settings-store";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-holder-backfill-"));
after(() => rmSync(HOME, { recursive: true, force: true }));
let n = 0;
const freshStore = () => {
  process.env.MERRYMEN_HOME = path.join(HOME, `run-${++n}`);
  return new FileSettingsStore();
};

const t = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as `0x${string}`;
const W = "0x000000000000000000000000000000000000beef";
const W2 = "0x000000000000000000000000000000000000cafe";

describe("childSettingsFor — what the child is handed", () => {
  it("THE COUNTED WALLET IS WRITTEN; the typed-in one is never kept", () => {
    const got = childSettingsFor({ strategy: "trencher", holderAddress: W2 }, { address: W, source: "linked" });
    assert.deepEqual(got, { strategy: "trencher", holderAddress: W });
  });

  it("NO WALLET COUNTS → NO KEY, even when the tenant typed one in", () => {
    const got = childSettingsFor({ strategy: "trencher", holderAddress: W2 }, null);
    assert.equal("holderAddress" in got, false);
    assert.deepEqual(got, { strategy: "trencher" });
  });

  it("a tenant who saved nothing gets the wallet alone, or an empty file", () => {
    assert.deepEqual(childSettingsFor(null, { address: t(1), source: "login" }), { holderAddress: t(1) });
    assert.deepEqual(childSettingsFor(null, null), {});
  });

  it("does not touch the stored object", () => {
    const stored = { holderAddress: W2 };
    childSettingsFor(stored, null);
    assert.deepEqual(stored, { holderAddress: W2 });
  });
});

describe("planHolderBackfill — earliest proof first", () => {
  it("SORTED BY proof.at, ties by account, malformed proofs dropped", () => {
    const plan = planHolderBackfill([
      { tenant: t(3), proof: { address: W, at: 300 } },
      { tenant: t(2), proof: { address: W, at: 100 } },
      { tenant: t(1), proof: { address: W2, at: 100 } },
      { tenant: t(4), proof: { address: "0xnothex", at: 1 } },
    ]);
    assert.deepEqual(
      plan.map((r) => [r.tenant, r.proof.at]),
      [
        [t(1), 100],
        [t(2), 100],
        [t(3), 300],
      ],
    );
  });
});

describe("backfillHolderClaims — against a real store", () => {
  it("THE EARLIEST PROOF OF A SHARED WALLET KEEPS IT; the rest are logged as collisions", async () => {
    const store = freshStore();
    // Written out of order on purpose: the listing order must not decide it.
    await store.put(t(3), { holderProof: { address: W, at: 3_000 } });
    await store.put(t(1), { holderProof: { address: W, at: 1_000 } });
    await store.put(t(2), { holderProof: { address: W, at: 2_000 } });
    await store.put(t(4), { holderProof: { address: W2, at: 5_000 } });
    await store.put(t(5), { strategy: "trencher" }); // nothing linked
    const lines: string[] = [];
    const out = await backfillHolderClaims(store, (l) => lines.push(l));
    assert.equal(out.claimed, 2);
    assert.equal(out.held, 0);
    assert.deepEqual(
      out.collisions.map((c) => [c.tenant, c.wallet, c.heldBy]),
      [
        [t(2), W, t(1)],
        [t(3), W, t(1)],
      ],
    );
    const claims = await store.holderClaims();
    assert.equal(claims.get(W), t(1), "proven first, kept");
    assert.equal(claims.get(W2), t(4));
    assert.equal(lines.filter((l) => /COLLISION/.test(l)).length, 2, "every collision is named in the log");
  });

  it("IDEMPOTENT: a second run claims nothing new and moves nothing", async () => {
    const store = freshStore();
    await store.put(t(2), { holderProof: { address: W, at: 2 } });
    await store.put(t(1), { holderProof: { address: W, at: 1 } });
    await backfillHolderClaims(store);
    const again = await backfillHolderClaims(store);
    assert.equal(again.claimed, 0);
    assert.equal(again.held, 1);
    assert.equal(again.collisions.length, 1);
    assert.equal((await store.holderClaims()).get(W), t(1));
  });

  it("TWO REPLICAS AT ONCE STILL AGREE: the earliest proof wins", async () => {
    const store = freshStore();
    for (let i = 1; i <= 6; i++) await store.put(t(i), { holderProof: { address: W, at: 100 - i } });
    await Promise.all([backfillHolderClaims(store), backfillHolderClaims(store)]);
    assert.equal((await store.holderClaims()).get(W), t(6), "at: 94, the earliest");
  });

  it("A CLAIM MADE SINCE (a live link) IS NOT OVERTURNED — the older proof is the collision", async () => {
    const store = freshStore();
    await store.put(t(1), { holderProof: { address: W, at: 1 } });
    await store.claimHolder(W, t(9));
    const out = await backfillHolderClaims(store);
    assert.deepEqual(out.collisions.map((c) => c.heldBy), [t(9)]);
    assert.equal((await store.holderClaims()).get(W), t(9));
  });

  it("AN UNREADABLE TENANT IS SKIPPED AND NAMED, and never blocks the others", async () => {
    const store = freshStore();
    await store.put(t(1), { holderProof: { address: W, at: 1 } });
    await store.put(t(2), { holderProof: { address: W2, at: 2 } });
    const lines: string[] = [];
    const out = await backfillHolderClaims(
      {
        listTenants: () => store.listTenants(),
        get: async (tenant) => {
          if (tenant === t(1)) throw new Error("unseal failed");
          return store.get(tenant);
        },
        claimHolder: (w, tenant) => store.claimHolder(w, tenant),
      },
      (l) => lines.push(l),
    );
    assert.deepEqual(out.unreadable, [t(1)]);
    assert.equal(out.claimed, 1);
    assert.ok(lines.some((l) => l.includes(t(1)) && /unreadable/.test(l)));
  });

  it("a store whose listing fails throws, so the caller tries again", async () => {
    await assert.rejects(
      backfillHolderClaims({
        listTenants: async () => {
          throw new Error("down");
        },
        get: async () => null,
        claimHolder: async () => ({ ok: true, fresh: true }),
      }),
    );
  });
});

describe("the orchestrator wiring", () => {
  const ORCH = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
  const body = (sig: string) => {
    const at = ORCH.indexOf(sig);
    assert.ok(at > 0, sig);
    return ORCH.slice(at, ORCH.indexOf("\n}\n", at));
  };

  it("THE BACKFILL RUNS BEFORE reconcile(), so the first settings.json already counts the claimed wallet", () => {
    const loop = body("export async function runOrchestrator(");
    const backfill = loop.indexOf("await runHolderClaimsBackfill();");
    const reconcile = loop.indexOf("await reconcile();");
    assert.ok(backfill > 0 && reconcile > backfill);
  });

  it("…behind a lease, once per process, and a failure is retried next pass", () => {
    const run = body("async function runHolderClaimsBackfill(");
    assert.match(run, /if \(holderClaimsBackfilled\) return;/);
    assert.match(run, /acquireTenantLease\(HOLDER_BACKFILL_LEASE\)/);
    assert.match(run, /if \(!lease\) \{/);
    const done = run.indexOf("holderClaimsBackfilled = true;");
    const call = run.indexOf("await backfillHolderClaims(getSettingsStore(), log);");
    assert.ok(call > 0 && done > call, "marked done only once the run succeeded");
    assert.match(run, /finally \{\s*await lease\.release\(\);/);
    assert.match(ORCH, /const HOLDER_BACKFILL_LEASE = "0xholder-claims-backfill" as const;/, "a key no tenant can have");
  });

  it("THE CLAIMS ARE READ ONCE PER RECONCILE PASS, not once per tenant", () => {
    const rec = body("export async function reconcile(");
    const read = rec.indexOf("const holderClaims = await readHolderClaims();");
    const loop = rec.indexOf("for (const tenant of children.keys())", read);
    assert.ok(read > 0 && loop > read);
    assert.match(rec, /writeSettingsForChild\(tenant as `0x\$\{string\}`, seenBotTokens, holderClaims\)/);
  });

  it("UNREADABLE CLAIMS WRITE NOTHING — the child keeps the file written from claims we could read", () => {
    const fn = body("async function writeSettingsForChild(");
    const unread = fn.indexOf("if (!claims) return settings;");
    const firstWrite = fn.indexOf("writeChildSettings(");
    assert.ok(unread > 0 && firstWrite > unread, "no write of any kind before the claims are known");
    const reader = body("async function readHolderClaims(");
    assert.match(reader, /return await getSettingsStore\(\)\.holderClaims\(\);/);
    assert.match(reader, /return null;/);
  });
});
