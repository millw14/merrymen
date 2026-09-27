/**
 * Orchestrator env curation — the security-critical part a unit test can pin.
 *
 * A child worker holds one tenant's SESSION key. It must inherit the platform's
 * HOUSE keys (bundler/LLM) — that is hosted-mode's whole design — but never the
 * material that would let it decrypt OTHER tenants' stored keys (the store DEK),
 * forge any session (the signing secret), or reach the shared grant database
 * (the URL). This proves the strip keeps the first and drops the second.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";

process.env.MERRYMEN_HOME = path.join(process.cwd(), ".test-orch-home");
process.env.MERRYMEN_HOSTED = "1";
process.env.MERRYMEN_BUNDLER_API_KEY = "house-bundler-key";
process.env.GROQ_API_KEY = "house-groq-key";
process.env.MERRYMEN_STORE_DEK = "SECRET-dek-never-to-a-child";
process.env.MERRYMEN_SESSION_SECRET = "SECRET-session-never-to-a-child";
process.env.DATABASE_URL = "postgres://SECRET-never-to-a-child";
process.env.MERRYMEN_HOLDER_ADDRESS = "0x00000000000000000000000000000000000Wha1e";

const { childHome, childEnv, fleetHaltFile, dedupeBotToken } = await import("./orchestrator");

const T = "0xABCDef0000000000000000000000000000000001" as const;

describe("orchestrator env curation", () => {
  it("childHome is per-tenant, lowercased, under children/", () => {
    assert.equal(childHome(T), path.join(process.env.MERRYMEN_HOME!, "children", T.toLowerCase()));
  });

  it("childEnv injects the house keys but STRIPS the orchestrator-only secrets", () => {
    const env = childEnv(T);
    // house keys — injected on purpose (house-keys-server-only)
    assert.equal(env.MERRYMEN_BUNDLER_API_KEY, "house-bundler-key");
    assert.equal(env.GROQ_API_KEY, "house-groq-key");
    // per-child steering
    assert.equal(env.MERRYMEN_HOSTED, "1");
    assert.equal(env.MERRYMEN_HOME, childHome(T));
    // the three a child must NEVER see
    assert.equal(env.MERRYMEN_STORE_DEK, undefined, "the DEK decrypts every tenant's key");
    assert.equal(env.MERRYMEN_SESSION_SECRET, undefined, "the secret forges any session");
    assert.equal(env.DATABASE_URL, undefined, "the url reaches every tenant's grant");
    /**
     * And the one that is not a secret at all.
     *
     * settings.ts reads `str(file.holderAddress, env.MERRYMEN_HOLDER_ADDRESS)`,
     * so the orchestrator's per-tenant overwrite only holds for a child that
     * actually got a settings file. `writeChildSettings` returns early on
     * unreadable settings and again from its catch — and that child would then
     * inherit the OPERATOR'S holder wallet and resolve the operator's balance
     * as its own: Circle strategies unlocked and the fee discounted for a
     * tenant who may hold nothing. Every other holder path fails closed; this
     * was the one that failed open, on the pass where something else had
     * already broken.
     */
    assert.equal(
      env.MERRYMEN_HOLDER_ADDRESS,
      undefined,
      "a child with no settings file must inherit NO holder wallet, not the operator's",
    );
  });

  it("fleetHaltFile sits under the orchestrator home", () => {
    assert.equal(fleetHaltFile(), path.join(process.env.MERRYMEN_HOME!, "FLEET_HALT"));
  });
});

describe("telegram bot-token collision guard", () => {
  it("the first tenant keeps a token; a second tenant sharing it is stripped", () => {
    const seen = new Set<string>();
    const a: any = { telegramBotToken: "111:AAA", strategy: "trencher" };
    const b: any = { telegramBotToken: "111:AAA", strategy: "even-keel" };
    assert.equal(dedupeBotToken(a, seen), false, "first claim keeps it");
    assert.equal(a.telegramBotToken, "111:AAA");
    assert.equal(dedupeBotToken(b, seen), true, "the duplicate is stripped");
    assert.equal(b.telegramBotToken, undefined, "…so this child won't poll the same bot");
    assert.equal(b.strategy, "even-keel", "the rest of its config is untouched");
  });

  it("distinct tokens both survive; no token is a no-op", () => {
    const seen = new Set<string>();
    const a: any = { telegramBotToken: "111:AAA" };
    const b: any = { telegramBotToken: "222:BBB" };
    const c: any = { strategy: "steady-basket" };
    assert.equal(dedupeBotToken(a, seen), false);
    assert.equal(dedupeBotToken(b, seen), false);
    assert.equal(dedupeBotToken(c, seen), false);
    assert.equal(a.telegramBotToken, "111:AAA");
    assert.equal(b.telegramBotToken, "222:BBB");
  });
});

/**
 * THE MIRROR MUST NOT SPEAK FOR A CHILD IT DOES NOT RUN.
 *
 * `children` keeps its entry after the tenant lease moves to another replica:
 * the child was spawned here, a later reconcile handed the lease elsewhere, and
 * the sqlite left behind in this container froze at whatever this replica last
 * wrote. The mirror then copied THAT up — and `positions` and `cost_basis` are
 * snapshots, delete-then-insert, because a closed position must not linger. So a
 * stale local child with neither DELETED the live rows the owning replica had
 * just written.
 *
 * Observed on a real book: positions emptying and refilling, entry prices
 * recovered from their receipts and gone again minutes later, and a permanent
 * "CURSOR REWOUND" on a tenant whose child was healthy throughout — the rewind
 * detector correctly reporting that THIS replica's copy had been rebuilt
 * beneath it, which it had, in another container.
 */
describe("the ledger mirror follows the lease", () => {
  it("SKIPS A TENANT THIS REPLICA DOES NOT HOLD", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
    assert.match(src, /const lease = leases\.get\(tenant\.toLowerCase\(\)\);\s*\n\s*if \(!lease \|\| !lease\.healthy\(\)\) continue;/);
  });

  it("and it decides BEFORE opening the child's database", async () => {
    // Not merely an optimisation: everything destructive is downstream of the
    // handle, so the guard has to sit above it rather than beside the copy.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
    const guard = src.indexOf("if (!lease || !lease.healthy()) continue;");
    // THE MIRROR'S open, specifically. `openChildLedger` has more than one call
    // site now — `seedBasisForChild` opens the same database before spawn — so
    // taking the first occurrence in the file would silently start measuring a
    // different guard than this test is about.
    const open = src.indexOf("const handle = openChildLedger(childHome(tenant));", guard);
    assert.ok(guard > 0 && open > guard, "the lease check must precede the open");
  });

  it("and an unhealthy lease counts as not held", async () => {
    // A lease whose connection dropped has been released by Postgres, so
    // another replica may already own this child. Holding the object is not the
    // same as holding the lock — the arm path draws exactly this distinction.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
    assert.match(src, /!lease\.healthy\(\)/);
  });
});

/**
 * THE OTHER CALL SITE THAT OPENS A CHILD'S DATABASE.
 *
 * `seedBasisForChild` gives a rebuilt child back the cost basis the redeploy
 * destroyed, and it opens the child's sqlite to do it. Everything the lease
 * protects applies to it exactly as it applies to the mirror: only the replica
 * that owns a child may write into its ledger.
 */
describe("the basis seed is inside the lease too", () => {
  it("runs from spawnChild, which has already checked the lease", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
    const guard = src.indexOf("log(`${tenant}: no healthy lease — not spawning");
    const seed = src.indexOf("await seedBasisForChild(tenant, smartAccount);");
    assert.ok(guard > 0, "spawnChild must still refuse without a healthy lease");
    assert.ok(seed > guard, "the seed must sit below that refusal");
  });

  it("and BEFORE spawn, like the grant and the anchor", async () => {
    // The child reads its book while arming. A basis that landed a moment later
    // would be read as absent — which is the defect, not the fix.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
    const seed = src.indexOf("await seedBasisForChild(tenant, smartAccount);");
    const spawned = src.indexOf("const proc = startWorker(tenant);", seed);
    assert.ok(seed > 0 && spawned > seed, "seed then spawn, never the other way round");
  });
});
