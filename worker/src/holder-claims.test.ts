/**
 * ONE $MERRYMEN WALLET POWERS ONE AGENT — the orchestrator's half.
 *
 * What the child is handed (childSettingsFor), how proofs from before claims
 * existed get claimed (backfillHolderClaims, earliest proof first), and the
 * orchestrator wiring that ties them to the reconcile pass.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { backfillHolderClaims, childSettingsFor, lastWrittenHolder, planHolderBackfill } from "./holder-claims";
import { FileSettingsStore } from "./settings-store";
import { effectiveHolder } from "../../packages/core/src/index";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-holder-backfill-"));
after(() => rmSync(HOME, { recursive: true, force: true }));
let n = 0;
const freshStore = () => {
  process.env.MERRYMEN_HOME = path.join(HOME, `run-${++n}`);
  return new FileSettingsStore();
};

const t = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as `0x${string}`;
/** The store's backfill surface as plain functions, so a case can override one. */
const bind = (s: InstanceType<typeof FileSettingsStore>) => ({
  listTenants: () => s.listTenants(),
  get: (x: `0x${string}`) => s.get(x),
  claimHolder: (w: string, x: string) => s.claimHolder(w, x),
  holderBackfill: () => s.holderBackfill(),
  saveHolderBackfill: (st: Parameters<typeof s.saveHolderBackfill>[0]) => s.saveHolderBackfill(st),
});
const W = "0x000000000000000000000000000000000000beef";
const W2 = "0x000000000000000000000000000000000000cafe";

describe("childSettingsFor — what the child is handed", () => {
  it("THE COUNTED WALLET IS WRITTEN; the typed-in one is never kept", () => {
    const got = childSettingsFor({ strategy: "trencher", holderAddress: W2 }, W);
    assert.deepEqual(got, { strategy: "trencher", holderAddress: W });
  });

  it("NO WALLET COUNTS → NO KEY, even when the tenant typed one in", () => {
    const got = childSettingsFor({ strategy: "trencher", holderAddress: W2 }, null);
    assert.equal("holderAddress" in got, false);
    assert.deepEqual(got, { strategy: "trencher" });
  });

  it("a tenant who saved nothing gets the wallet alone, or an empty file", () => {
    assert.deepEqual(childSettingsFor(null, t(1)), { holderAddress: t(1) });
    assert.deepEqual(childSettingsFor(null, null), {});
  });

  it("does not touch the stored object", () => {
    const stored = { holderAddress: W2 };
    childSettingsFor(stored, null);
    assert.deepEqual(stored, { holderAddress: W2 });
  });
});

describe("lastWrittenHolder — the wallet kept when the claims cannot be read", () => {
  it("READS BACK WHAT THE ORCHESTRATOR WROTE, lower-cased", () => {
    const file = path.join(HOME, "last-written.json");
    writeFileSync(file, JSON.stringify({ strategy: "trencher", holderAddress: W.toUpperCase().replace("0X", "0x") }));
    assert.equal(lastWrittenHolder(file), W);
  });

  it("NO FILE, NO KEY, OR NOT AN ADDRESS → NO WALLET (never a guess)", () => {
    assert.equal(lastWrittenHolder(path.join(HOME, "never-written.json")), null);
    const file = path.join(HOME, "no-key.json");
    writeFileSync(file, JSON.stringify({ strategy: "trencher" }));
    assert.equal(lastWrittenHolder(file), null);
    writeFileSync(file, JSON.stringify({ holderAddress: "0xnothex" }));
    assert.equal(lastWrittenHolder(file), null);
    writeFileSync(file, "{ torn");
    assert.equal(lastWrittenHolder(file), null);
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

  it("ONCE EVER: a second run reads nothing, claims nothing and moves nothing", async () => {
    const store = freshStore();
    await store.put(t(2), { holderProof: { address: W, at: 2 } });
    await store.put(t(1), { holderProof: { address: W, at: 1 } });
    const first = await backfillHolderClaims(store);
    assert.equal(first.done, true);
    assert.deepEqual(await store.holderBackfill(), { startedAt: (await store.holderBackfill())!.startedAt, pending: [] });
    let reads = 0;
    const again = await backfillHolderClaims({ ...bind(store), get: async (x) => (reads++, store.get(x)) });
    assert.deepEqual(
      { claimed: again.claimed, held: again.held, collisions: again.collisions.length, alreadyDone: again.alreadyDone, done: again.done },
      { claimed: 0, held: 0, collisions: 0, alreadyDone: true, done: true },
    );
    assert.equal(reads, 0, "no tenant's settings are even opened");
    assert.equal((await store.holderClaims()).get(W), t(1));
  });

  it("A WALLET RELEASED ON PURPOSE STAYS RELEASED: backfill → unlink → backfill never hands it to the proof that lost", async () => {
    // The review's scenario. A (at 1) and B (at 2) both linked W before claims
    // existed; W is also the login of account W. The first start gives W to A
    // and logs B as a collision — B's proof stays in its settings for good.
    const store = freshStore();
    const A = t(0xa), B = t(0xb);
    await store.put(A, { holderProof: { address: W, at: 1 } });
    await store.put(B, { holderProof: { address: W, at: 2 } });
    await backfillHolderClaims(store);
    assert.equal((await store.holderClaims()).get(W), A);
    // A unlinks (what DELETE /api/holder does): released, and A's proof dropped.
    await store.releaseHolder(W, A);
    await store.put(A, {});
    // The next deploy starts the orchestrator again.
    const next = await backfillHolderClaims(store);
    assert.equal(next.alreadyDone, true);
    const claims = await store.holderClaims();
    assert.equal(claims.has(W), false, "nobody signed anything — the wallet must stay free");
    const proofB = (await store.get(B))?.holderProof ?? null;
    assert.deepEqual(effectiveHolder(B, proofB, (w) => claims.get(w)), { address: B, source: "login" }, "B's stale proof counts nowhere — B reads its own login");
    assert.deepEqual(effectiveHolder(W, null, (w) => claims.get(w)), { address: W, source: "login" }, "W's own login counts W again");
  });

  it("RETRIED ONLY FOR THE TENANTS IT COULD NOT READ — never the ones that already lost", async () => {
    const store = freshStore();
    const A = t(0xa), B = t(0xb), C = t(0xc);
    await store.put(A, { holderProof: { address: W, at: 1 } });
    await store.put(B, { holderProof: { address: W, at: 2 } });
    await store.put(C, { holderProof: { address: W2, at: 3 } });
    let sealed = true;
    const flaky = {
      ...bind(store),
      get: async (x: `0x${string}`) => {
        if (x === C && sealed) throw new Error("unseal failed");
        return store.get(x);
      },
    };
    const first = await backfillHolderClaims(flaky, () => {}, 10_000);
    assert.equal(first.done, false);
    assert.deepEqual((await store.holderBackfill())?.pending, [C]);
    // Meanwhile A unlinks W.
    await store.releaseHolder(W, A);
    await store.put(A, {});
    // C's blob opens again; the retry reads C and nobody else.
    sealed = false;
    const opened: string[] = [];
    const retry = await backfillHolderClaims(
      { ...flaky, get: async (x) => (opened.push(x), flaky.get(x)) },
      () => {},
      20_000,
    );
    assert.deepEqual(opened, [C]);
    assert.equal(retry.done, true);
    assert.equal(retry.claimed, 1);
    const claims = await store.holderClaims();
    assert.equal(claims.get(W2), C, "the proof it could not read before is claimed now");
    assert.equal(claims.has(W), false, "and B, which lost W in the first run, does not get it back");
    assert.deepEqual(await store.holderBackfill(), { startedAt: 10_000, pending: [] }, "done for good, dated by the first run");
  });

  it("…and of a pending tenant's proofs, only one made before the first run (a later one was the route's)", async () => {
    const store = freshStore();
    const C = t(0xc);
    await store.put(C, { holderProof: { address: W, at: 1 } });
    await backfillHolderClaims({ ...bind(store), get: async () => { throw new Error("unseal failed"); } }, () => {}, 10_000);
    // C re-linked through the route after the first run, then unlinked it
    // with the put failing: a proof with no claim, released on purpose.
    await store.put(C, { holderProof: { address: W, at: 15_000 } });
    const retry = await backfillHolderClaims(store, () => {}, 20_000);
    assert.equal(retry.done, true);
    assert.equal((await store.holderClaims()).has(W), false);
  });

  it("A PENDING TENANT'S RETRY NEVER HANDS A RELEASED WALLET TO THE PROOF THAT LOST IT", async () => {
    // The review's scenario: P could not be read in the first run, so it is
    // pending — and its proof is the loser of W, which A won. A unlinks W on
    // purpose (W's own login account should count it again). The retry read
    // only P, and P's proof, made before the first run, claimed W with
    // nobody signing anything.
    const store = freshStore();
    const A = t(0xa), P = t(0xb);
    await store.put(A, { holderProof: { address: W, at: 1_000 } });
    await store.put(P, { holderProof: { address: W, at: 2_000 } });
    let sealed = true;
    const flaky = {
      ...bind(store),
      get: async (x: `0x${string}`) => {
        if (x === P && sealed) throw new Error("transient");
        return store.get(x);
      },
    };
    const first = await backfillHolderClaims(flaky, () => {}, 5_000);
    assert.equal(first.done, false);
    assert.equal((await store.holderClaims()).get(W), A, "A proved it first");
    await store.releaseHolderClaims(A); // A's unlink
    await store.put(A, {});
    sealed = false;
    const lines: string[] = [];
    const retry = await backfillHolderClaims(flaky, (l) => lines.push(l), 6_000);
    assert.equal(retry.done, true);
    assert.equal((await store.holderClaims()).has(W), false, "released on purpose, and it stays free");
    assert.deepEqual(retry.released, [{ tenant: P, wallet: W }]);
    assert.ok(lines.some((l) => l.includes(P) && /let it go/.test(l)), "and the log says why P's proof was not claimed");
    assert.equal(retry.collisions.length, 0, "not a collision: nobody holds it");
  });

  it("…nor does a re-run after a crash that came before the record", async () => {
    const store = freshStore();
    const A = t(0xa), B = t(0xb), C = t(0xc);
    await store.put(A, { holderProof: { address: W, at: 1 } });
    await store.put(B, { holderProof: { address: W, at: 2 } });
    await store.put(C, { holderProof: { address: W2, at: 3 } });
    // The first run gives W to A, then dies on W2 before writing its record.
    await assert.rejects(
      backfillHolderClaims({
        ...bind(store),
        claimHolder: async (w, x) => {
          if (w === W2) throw new Error("killed");
          return store.claimHolder(w, x);
        },
      }),
    );
    assert.equal(await store.holderBackfill(), null);
    await store.releaseHolderClaims(A); // A unlinks W before the next start
    await store.put(A, {});
    const again = await backfillHolderClaims(store);
    assert.equal(again.done, true);
    const claims = await store.holderClaims();
    assert.equal(claims.has(W), false, "B lost W to A; A let it go; B does not get it for nothing");
    assert.equal(claims.get(W2), C, "the rest of the first pass still happens");
  });

  it("AN UNREADABLE RECORD IS NOT 'NEVER RAN' — the run throws and claims nothing", async () => {
    const store = freshStore();
    await store.put(t(1), { holderProof: { address: W, at: 1 } });
    writeFileSync(path.join(process.env.MERRYMEN_HOME!, "holder-claims-backfill.json"), "{ torn");
    await assert.rejects(backfillHolderClaims(store));
    assert.equal((await store.holderClaims()).size, 0);
  });

  it("A RUN THAT FAILS PART-WAY WRITES NO RECORD, so the next start does the whole first pass again", async () => {
    const store = freshStore();
    await store.put(t(1), { holderProof: { address: W, at: 1 } });
    await store.put(t(2), { holderProof: { address: W2, at: 2 } });
    await assert.rejects(
      backfillHolderClaims({
        ...bind(store),
        claimHolder: async (w, x) => {
          if (w === W2) throw new Error("Connection terminated unexpectedly");
          return store.claimHolder(w, x);
        },
      }),
    );
    assert.equal(await store.holderBackfill(), null);
    const again = await backfillHolderClaims(store);
    assert.deepEqual([again.claimed, again.held, again.done], [1, 1, true]);
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
        ...bind(store),
        get: async (tenant) => {
          if (tenant === t(1)) throw new Error("unseal failed");
          return store.get(tenant);
        },
      },
      (l) => lines.push(l),
    );
    assert.deepEqual(out.unreadable, [t(1)]);
    assert.equal(out.claimed, 1);
    assert.equal(out.done, false, "not done while a tenant was unread");
    assert.ok(lines.some((l) => l.includes(t(1)) && /unreadable/.test(l)));
  });

  it("FILE BACKEND: A TENANT WHOSE SETTINGS WILL NOT READ IS PENDING, NOT 'NO PROOF' — and its proof is claimed once it reads", async () => {
    // The single-service hosted deploy runs on FileSettingsStore. Its get()
    // used to swallow every error and answer null, so an unreadable blob (a
    // torn write, the wrong DEK, EMFILE) looked like a tenant with nothing
    // linked: never pending, the record said done, and that holder's proof
    // was never claimed.
    const store = freshStore();
    const A = t(0xa), P = t(0xb);
    await store.put(A, { holderProof: { address: W2, at: 1 } });
    await store.put(P, { holderProof: { address: W, at: 2 } });
    const file = path.join(process.env.MERRYMEN_HOME!, "tenant-settings", `${P}.json`);
    const good = readFileSync(file, "utf8");
    writeFileSync(file, JSON.stringify({ tenant: P, sealed: "{ torn", updatedAt: 1 }));
    await assert.rejects(store.get(P), "an unreadable blob is an error, not 'no settings'");
    assert.equal(await store.get(t(0xee)), null, "no blob at all is still simply null");
    const first = await backfillHolderClaims(store, () => {}, 10_000);
    assert.deepEqual(first.unreadable, [P]);
    assert.equal(first.done, false);
    assert.deepEqual(await store.holderBackfill(), { startedAt: 10_000, pending: [P] });
    writeFileSync(file, good);
    const retry = await backfillHolderClaims(store, () => {}, 20_000);
    assert.equal(retry.done, true);
    assert.equal((await store.holderClaims()).get(W), P, "claimed once it could be read");
  });

  it("a store whose listing fails throws, so the caller tries again", async () => {
    await assert.rejects(
      backfillHolderClaims({
        listTenants: async () => {
          throw new Error("down");
        },
        get: async () => null,
        claimHolder: async () => ({ ok: true, fresh: true }),
        holderBackfill: async () => null,
        saveHolderBackfill: async () => assert.fail("nothing was learnt, so nothing is recorded"),
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

  it("…behind a lease; done for this process only once EVERY tenant was read, and a failure is retried next pass", () => {
    const run = body("async function runHolderClaimsBackfill(");
    assert.match(run, /if \(holderClaimsBackfilled \|\| Date\.now\(\) < holderBackfillRetryAt\) return;/);
    assert.match(run, /acquireTenantLease\(HOLDER_BACKFILL_LEASE\)/);
    assert.match(run, /if \(!lease\) \{/);
    const done = run.indexOf("if (out.done) holderClaimsBackfilled = true;");
    const call = run.indexOf("await backfillHolderClaims(getSettingsStore(), log);");
    assert.ok(call > 0 && done > call, "marked done only once a run read every tenant");
    assert.match(run, /else holderBackfillRetryAt = Date\.now\(\) \+ HOLDER_BACKFILL_RETRY_MS;/, "unread tenants are retried, not every pass");
    assert.ok(!/holderClaimsBackfilled = true;\n/.test(run.replace("if (out.done) holderClaimsBackfilled = true;", "")), "and never unconditionally");
    assert.match(run, /finally \{\s*await lease\.release\(\);/);
    assert.match(ORCH, /const HOLDER_BACKFILL_LEASE = "0xholder-claims-backfill" as const;/, "a key no tenant can have");
  });

  it("THE CLAIMS ARE READ ONCE PER RECONCILE PASS, not once per tenant", () => {
    const rec = body("export async function reconcile(");
    const read = rec.indexOf("const holderClaims = await readHolderClaims();");
    const loop = rec.indexOf("for (const tenant of children.keys())", read);
    assert.ok(read > 0 && loop > read);
    assert.match(rec, /writeSettingsForChild\(tenant as `0x\$\{string\}`, seenBots, holderClaims, botClaims\)/);
  });

  it("UNREADABLE CLAIMS KEEP THE WALLET WRITTEN LAST — and the rest of settings.json is still written", () => {
    // Skipping the write would spawn a fresh child on the defaults, and the
    // default is paper: a live agent off its real stop-losses.
    const fn = body("async function writeSettingsForChild(");
    const decide = fn.indexOf("const holder: `0x${string}` | null = claims");
    const kept = fn.indexOf(': lastWrittenHolder(path.join(childHome(tenant), "settings.json"));');
    const firstWrite = fn.indexOf("writeChildSettings(");
    assert.ok(decide > 0 && kept > decide && firstWrite > kept, "the holder is decided before any write");
    assert.ok(!/if \(!claims\) return/.test(fn), "an unread claims table never stops the file being written");
    const reader = body("async function readHolderClaims(");
    assert.match(reader, /return await getSettingsStore\(\)\.holderClaims\(\);/);
    assert.match(reader, /return null;/);
  });
});
