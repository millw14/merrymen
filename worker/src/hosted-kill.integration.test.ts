/**
 * A HOSTED TELEGRAM /kill STAYS KILLED.
 *
 * What it used to do: the child deleted its own grant.json and replied "KILL
 * SWITCH — grant destroyed". The grant still sat in the tenant store, and the
 * orchestrator's next reconcile saw the missing file and wrote it back
 * ("no file — writing it is the right answer either way"). The child
 * re-armed. The owner had been told the agent was dead while it kept signing.
 *
 * Driven through the real reconcile() over a real file-backed grant store,
 * with a child counted as running (adoptChildForTest, so no worker process is
 * spawned). The child side is the real killHosted and the real
 * loadArmableGrant that syncGrant arms from.
 *
 * MERRYMEN_HOME is per process (node --test forks per file), so switching it
 * to a child's home and back never leaks into another test file.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { StoredGrant } from "../../packages/core/src/index";
import type { CommandDeps, PendingAction } from "./telegram/executor";

const FLEET = mkdtempSync(path.join(os.tmpdir(), "merrymen-hosted-kill-"));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
// The file store and the no-op lease: no Postgres in this test.
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 5).toString("base64");

const { reconcile, childHome, adoptChildForTest, honourPendingKills, setKillConfirmForTest } = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { KILL_CLOCK_SLACK_SEC, killHosted, killRequested, killRequestPath, honourKillRequest, writeKillRequest } = await import("./kill-request");
const { loadArmableGrant, loadGrantFile } = await import("./grant");
const { homePaths, merrymenHome } = await import("./home");
const { executeCommand } = await import("./telegram/executor");

after(() => {
  rmSync(FLEET, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const TENANT = "0x00000000000000000000000000000000000000a1" as const;
const ACCOUNT = "0x00000000000000000000000000000000000000c3" as const;
const SESSION = ("0x" + "cd".repeat(32)) as `0x${string}`;
const nowSec = () => Math.floor(Date.now() / 1000);

const grantAt = (grantedAt: number): StoredGrant =>
  ({
    smartAccount: ACCOUNT,
    owner: "0x00000000000000000000000000000000000000b2",
    sessionKeyAddress: "0x00000000000000000000000000000000000000d4",
    serialized: "eyJ-a-zerodev-blob",
    chainId: 4663,
    grantedAt,
    expiresAt: grantedAt + 7 * 86_400,
    caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
    grantFeatures: ["tradeable-v2"],
    grantTokens: [],
    demoSessionPrivateKey: SESSION,
  }) as unknown as StoredGrant;

const store = getGrantStore();
/** Every ✅ the orchestrator would have sent the owner, by tenant. */
const confirmed: string[] = [];
setKillConfirmForTest(async (t) => {
  confirmed.push(t);
});
const home = () => childHome(TENANT);
const grantFile = () => path.join(home(), "grant.json");

/** A running child's process, reduced to what reconcile can do to it. */
function fakeProc() {
  const signals: string[] = [];
  return { signals, kill: (s?: NodeJS.Signals | number) => (signals.push(String(s)), true) };
}

/** Run `fn` as the child: MERRYMEN_HOME is the child's own home, as childEnv sets it. */
function asChild<T>(fn: () => T): T {
  process.env.MERRYMEN_HOME = home();
  try {
    return fn();
  } finally {
    process.env.MERRYMEN_HOME = FLEET;
  }
}

/** The child's hosted kill, called exactly as index.ts calls it. */
const childKill = (at = nowSec()) => asChild(() => killHosted(merrymenHome(), homePaths.grant(), loadGrantFile()!, at));

/** What spawn + an earlier reconcile leave behind: a stored grant and the child's copy of it. */
async function armedTenant(grant: StoredGrant) {
  await store.put(TENANT, grant);
  mkdirSync(home(), { recursive: true });
  writeFileSync(grantFile(), JSON.stringify(await store.get(TENANT), null, 2));
  const proc = fakeProc();
  adoptChildForTest(TENANT, ACCOUNT, proc);
  return proc;
}

beforeEach(async () => {
  // With no stored grant, a reconcile stands down any child an earlier test
  // left counted as running and releases its lease. Each test starts from
  // an empty fleet.
  await store.remove(TENANT);
  await reconcile();
  rmSync(home(), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  confirmed.length = 0;
});

describe("a hosted Telegram kill, then a reconcile", () => {
  it("THE BUG: the reconcile does not hand the key back, and the child is stood down", async () => {
    const proc = await armedTenant(grantAt(nowSec() - 3600));
    assert.ok(asChild(() => loadArmableGrant()), "armed before the kill");

    const r = childKill();
    assert.equal(r.revocation, "queued");
    assert.equal(existsSync(grantFile()), false, "the child's copy is gone at once");
    assert.equal(killRequested(home()), true, "and the request the orchestrator carries out is on disk");

    await reconcile();

    assert.equal(await store.get(TENANT), null, "the STORED grant is removed, as DELETE /api/grants removes it");
    assert.ok(!(await store.listTenants()).includes(TENANT), "so the tenant is no longer wanted");
    assert.equal(existsSync(grantFile()), false, "grant.json was NOT restored");
    assert.deepEqual(proc.signals.slice(0, 1), ["SIGTERM"], "the kill-switch branch stood the child down");
    assert.deepEqual(confirmed, [TENANT], "the ✅ is sent by the process that deleted the grant");

    // And it stays that way: nothing on the next pass brings it back.
    await reconcile();
    assert.equal(existsSync(grantFile()), false);
    assert.equal(await store.get(TENANT), null);
    assert.deepEqual(confirmed, [TENANT], "and only once");
  });

  it("THE KILL REACHES THE STORE ON THE THREE-SECOND FERRY CLOCK, without waiting for a reconcile", async () => {
    // The request sits in a home a redeploy discards. A whole reconcile pass
    // is too long to leave it there.
    const proc = await armedTenant(grantAt(nowSec() - 3600));
    childKill();

    await honourPendingKills();

    assert.equal(await store.get(TENANT), null, "the stored grant is deleted before any reconcile");
    assert.deepEqual(confirmed, [TENANT], "and the owner is told");

    // The request stays in the home until reconcile wipes it, so the next
    // tick of the fast clock sees it again, and finds the grant already gone.
    await honourPendingKills();
    assert.deepEqual(confirmed, [TENANT], "one ✅, not one per tick");
    assert.deepEqual(proc.signals, [], "standing the child down is still reconcile's job");

    await reconcile();
    assert.deepEqual(proc.signals.slice(0, 1), ["SIGTERM"]);
    assert.deepEqual(confirmed, [TENANT], "the reconcile finds it already gone and does not confirm again");
  });

  it("NOTHING IS WRITTEN WHILE THE STORE CANNOT BE CHANGED: a failed removal leaves the child unarmed and retries", async () => {
    const proc = await armedTenant(grantAt(nowSec() - 3600));
    childKill();

    const real = store.removeUnlessNewer.bind(store);
    store.removeUnlessNewer = async () => {
      throw new Error("database unavailable");
    };
    try {
      await reconcile();
    } finally {
      store.removeUnlessNewer = real;
    }

    // The tenant is still wanted and the child still running, so the refresh
    // loop visited it. That is the loop that used to restore the file.
    assert.ok(await store.get(TENANT), "the grant is still stored: the removal failed");
    assert.deepEqual(proc.signals, [], "the child was not stood down this pass");
    assert.equal(existsSync(grantFile()), false, "and the refresh did NOT write grant.json back");
    assert.equal(killRequested(home()), true, "the request survives for the next pass");
    assert.deepEqual(confirmed, [], "no ✅ while the grant is still stored");

    await reconcile();
    assert.equal(await store.get(TENANT), null, "the next pass carries it out");
    assert.deepEqual(proc.signals.slice(0, 1), ["SIGTERM"]);
    assert.deepEqual(confirmed, [TENANT]);
  });

  it("A CRASHED CHILD IS NOT RESPAWNED with its key while a kill is pending", async () => {
    // No adopted child: the tenant is wanted but not running, which is
    // what a crash leaves. The spawn path writes grant.json.
    await store.put(TENANT, grantAt(nowSec() - 3600));
    mkdirSync(home(), { recursive: true });
    writeFileSync(grantFile(), JSON.stringify(await store.get(TENANT), null, 2));
    childKill();

    const real = store.removeUnlessNewer.bind(store);
    store.removeUnlessNewer = async () => {
      throw new Error("database unavailable");
    };
    try {
      await reconcile();
    } finally {
      store.removeUnlessNewer = real;
    }
    assert.equal(existsSync(grantFile()), false, "spawn did not hand the home a key");

    // The fast clock finds the request on disk, not through the running set,
    // so a crashed child's kill is carried out too.
    await honourPendingKills();
    assert.equal(await store.get(TENANT), null, "a crashed child's request still reaches the store");
    assert.deepEqual(confirmed, [TENANT]);
  });
});

describe("the child does not re-arm", () => {
  it("A COPY RACED BACK INTO THE HOME IS NOT ARMED while the request stands", async () => {
    // The race that the child-side latch closes: the orchestrator reads the
    // store, the child writes the request and deletes its copy, and the
    // orchestrator writes the copy back from its earlier read.
    await armedTenant(grantAt(nowSec() - 3600));
    const grant = asChild(() => loadGrantFile())!;
    childKill();
    writeFileSync(grantFile(), JSON.stringify(grant, null, 2));

    assert.ok(asChild(() => loadGrantFile()), "the copy is on disk");
    assert.equal(asChild(() => loadArmableGrant()), null, "but syncGrant arms nothing");
  });

  it("syncGrant arms through loadArmableGrant, and the hosted kill goes through killHosted", () => {
    // The two call sites the behaviour above depends on. They live inside
    // main()'s closure, where a test cannot reach them, so they are pinned
    // in the source.
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const sync = src.slice(src.indexOf("async function syncGrant()"), src.indexOf("if (!grant) {", src.indexOf("async function syncGrant()")));
    assert.match(sync, /const grant = loadArmableGrant\(\);/);
    assert.doesNotMatch(sync, /loadGrantFile\(\)/, "syncGrant must not read the raw file");
    const kill = src.slice(src.indexOf("    kill: () => {"), src.indexOf("// ARCHIVE FIRST.", src.indexOf("    kill: () => {")));
    assert.match(kill, /if \(isHostedMode\(\)\) \{[\s\S]*killHosted\(merrymenHome\(\), homePaths\.grant\(\)/);
  });
});

describe("a grant signed after the kill is a redeploy, and arms", () => {
  it("the newer stored grant survives, the request is cleared, and the child is handed it", async () => {
    const proc = await armedTenant(grantAt(nowSec() - 3600));
    // Killed a minute ago...
    childKill(nowSec() - 60);
    // ...and the owner has signed again since. The store stamps updatedAt now.
    const fresh = grantAt(nowSec() - 5);
    await store.put(TENANT, fresh);

    await reconcile();

    assert.ok(await store.get(TENANT), "the new grant is kept");
    assert.equal(killRequested(home()), false, "the request is cleared");
    assert.deepEqual(proc.signals, [], "the child is not stood down");
    const handed = JSON.parse(readFileSync(grantFile(), "utf8")) as StoredGrant;
    assert.equal(handed.grantedAt, fresh.grantedAt, "the refresh handed the child the NEW grant");
    assert.equal(asChild(() => loadArmableGrant())?.grantedAt, fresh.grantedAt, "and it arms");
  });

  it("a grant stored in the SAME second as the kill counts as killed", async () => {
    await store.put(TENANT, grantAt(nowSec() - 3600));
    const record = JSON.parse(readFileSync(path.join(FLEET, "tenants", `${TENANT}.json`), "utf8")) as { updatedAt: number };
    assert.equal(await store.removeUnlessNewer(TENANT, record.updatedAt - 1), "newer");
    assert.equal(await store.removeUnlessNewer(TENANT, record.updatedAt), "removed", "a tie is covered");
    assert.equal(await store.removeUnlessNewer(TENANT, record.updatedAt), "absent");
  });

  it("CLOCK SLACK: a grant stamped a few seconds after the kill is still covered", async () => {
    // The stamp comes from the web service's clock and the kill time from
    // this one. A web clock running ahead must not turn the grant that was
    // killed into a "redeploy".
    await store.put(TENANT, grantAt(nowSec() - 3600));
    const record = JSON.parse(readFileSync(path.join(FLEET, "tenants", `${TENANT}.json`), "utf8")) as { updatedAt: number };
    mkdirSync(home(), { recursive: true });
    writeKillRequest(home(), { smartAccount: ACCOUNT }, record.updatedAt - (KILL_CLOCK_SLACK_SEC - 1));
    assert.equal((await honourKillRequest(store, TENANT, home(), nowSec())).outcome, "revoked");
    assert.equal(await store.get(TENANT), null);
  });

  it("an unreadable request covers everything stored so far", async () => {
    await store.put(TENANT, grantAt(nowSec() - 3600));
    mkdirSync(home(), { recursive: true });
    writeFileSync(killRequestPath(home()), "{ not json");
    const k = await honourKillRequest(store, TENANT, home(), nowSec() + 1);
    assert.equal(k.outcome, "revoked");
    assert.equal(await store.get(TENANT), null);
  });
});

describe("the Telegram reply stays truthful", () => {
  /** Only what /kill and /confirm touch. */
  function killDeps(kill: CommandDeps["kill"]): CommandDeps {
    let pending: PendingAction | null = null;
    return {
      controlEnabled: true,
      hosted: true,
      kill,
      getPending: () => pending,
      setPending: (p: PendingAction) => {
        pending = p;
      },
      clearPending: () => {
        pending = null;
      },
      now: () => 1_000_000,
    } as unknown as CommandDeps;
  }

  it("what the reply says happened is what the next reconcile does", async () => {
    await armedTenant(grantAt(nowSec() - 3600));
    const d = killDeps(() => childKill());

    const asked = await executeCommand({ kind: "kill" }, d);
    assert.doesNotMatch(asked, /merrymen recover|~\/\.merrymen\/grants/, "no owner key is archived hosted, so none is promised");
    const done = await executeCommand({ kind: "confirm" }, d);

    assert.match(done, /KILL SWITCH/);
    // The reply claims only what the child did; the grant is still stored now.
    assert.ok(await store.get(TENANT), "the stored grant is not gone yet when the reply is sent");
    assert.match(done, /deleting your stored grant now; you'll get a ✅/);
    assert.doesNotMatch(done, /archived|merrymen recover|revoked/, "hosted archives nothing, and claims nothing it has not done");
    assert.deepEqual(confirmed, [], "no ✅ before the server has deleted it");

    await honourPendingKills();
    assert.equal(await store.get(TENANT), null, "the server deleted the stored grant, as the reply said it would");
    assert.deepEqual(confirmed, [TENANT], "and sent the ✅ the reply promised");
    await reconcile();
    assert.equal(existsSync(grantFile()), false, "and did not hand it back");
  });

  it("when the request cannot be written, the reply says the key may come back", async () => {
    await armedTenant(grantAt(nowSec() - 3600));
    // A home the request cannot be written into: its path is taken by a directory.
    mkdirSync(killRequestPath(home()) + ".tmp", { recursive: true });
    const d = killDeps(() => childKill());

    await executeCommand({ kind: "kill" }, d);
    const done = await executeCommand({ kind: "confirm" }, d);

    assert.match(done, /only half done/);
    assert.match(done, /may hand the key back/);
    assert.match(done, /discard &amp; start over/, "and it names the web control that does stick");
    assert.equal(killRequested(home()), false, "no request was left");
  });
});
