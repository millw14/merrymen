/**
 * THE SHARED SERVER HELPERS NAME A WALLET, AND "perps" NEVER REACHES SPOT'S.
 *
 * hostedAgentFor and diskAgent (agent-for.ts), withReadDb (ledger.ts),
 * archiveCurrentGrant and removeSelfHostedGrant (grant-archive.ts) and
 * queuePaperReset (start-over.ts) each take the wallet with no default, as the
 * stores and `purposeHome` do. Every existing caller passes "spot" and gets
 * exactly what it always got; "perps" resolves the Perps wallet where main
 * already keeps it (getGrantStore("perps") hosted, `purposeHome("perps")`,
 * accounts/perps, self-hosted) and answers empty, never with the Spot wallet,
 * when there is none. A wallet that names neither throws before anything is
 * read or written.
 *
 * Driven over real file-backed stores (the single-service hosted deploy) and a
 * real self-hosted home.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "@merrymen/core";
import type { Db } from "../../../worker/src/db";

const ORIGIN = "https://app.merrymen.dev";
const ENV = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_GRANT_FILE", "MERRYMEN_SESSION_SECRET", "MERRYMEN_STORE_DEK", "DATABASE_URL"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let home = "";
let agentFor: typeof import("./agent-for");
let ledger: typeof import("./ledger");
let archive: typeof import("./grant-archive");
let startOver: typeof import("./start-over");
let auth: typeof import("@/lib/auth");
let stores: typeof import("../../../worker/src/grant-store");

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-wallet-helpers-"));
  process.env.MERRYMEN_HOME = home;
  for (const k of ["MERRYMEN_HOSTED", "MERRYMEN_GRANT_FILE", "DATABASE_URL"] as const) delete process.env[k];
  process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
  agentFor = await import("./agent-for");
  ledger = await import("./ledger");
  archive = await import("./grant-archive");
  startOver = await import("./start-over");
  auth = await import("@/lib/auth");
  // Through require, as kill-perps.test.ts does: the instance agent-for.ts reaches.
  stores = createRequire(import.meta.url)("../../../worker/src/grant-store.ts") as typeof import("../../../worker/src/grant-store");
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const key = (byte: string) => `0x${byte.repeat(32)}` as `0x${string}`;
const grant = (tenant: `0x${string}`, account: `0x${string}`, sessionKey: `0x${string}`, extra: Partial<StoredGrant> = {}): StoredGrant => ({
  owner: tenant, smartAccount: account, chainId: 4663, demoSessionPrivateKey: sessionKey,
  sessionKeyAddress: privateKeyToAccount(sessionKey).address, serialized: `permission-${account}`,
  grantedAt: 1, expiresAt: 9_999_999_999, grantFeatures: ["tradeable-v2"],
  caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 4 },
  ...extra,
});
const NOT_A_WALLET = ["Perps", "", "solana", undefined] as const;
const perpsHome = () => path.join(home, "accounts", "perps");
const T = addr(0x11), SPOT = addr(0x22), PERPS = addr(0x33);

describe("hostedAgentFor", () => {
  const req = (tenant: `0x${string}` | null) =>
    new Request(`${ORIGIN}/api/pnl`, tenant ? { headers: { cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(tenant)}` } } : {});
  const reset = async () => {
    await stores.getGrantStore("spot").remove(T);
    await stores.getGrantStore("perps").remove(T);
  };
  beforeEach(async () => {
    process.env.MERRYMEN_HOSTED = "1";
    await reset();
  });
  after(() => { delete process.env.MERRYMEN_HOSTED; });

  it("a Spot-only owner: Spot is their account, and Perps is nobody — never the Spot account", async () => {
    await stores.getGrantStore("spot").put(T, grant(T, SPOT, key("ab")));
    assert.equal(await agentFor.hostedAgentFor(req(T), "spot"), SPOT);
    assert.equal(await agentFor.hostedAgentFor(req(T), "perps"), null);
  });

  it("a two-wallet owner: each wallet answers with its own account", async () => {
    await stores.getGrantStore("spot").put(T, grant(T, SPOT, key("ab")));
    await stores.getGrantStore("perps").put(T, grant(T, PERPS, key("cd"), { purpose: "perps" }));
    assert.equal(await agentFor.hostedAgentFor(req(T), "spot"), SPOT);
    assert.equal(await agentFor.hostedAgentFor(req(T), "perps"), PERPS);
  });

  it("a Perps-only owner has no Spot account", async () => {
    await stores.getGrantStore("perps").put(T, grant(T, PERPS, key("cd"), { purpose: "perps" }));
    assert.equal(await agentFor.hostedAgentFor(req(T), "spot"), null);
    assert.equal(await agentFor.hostedAgentFor(req(T), "perps"), PERPS);
  });

  it("signed out is nobody in either wallet, and an unnamed wallet throws", async () => {
    await stores.getGrantStore("spot").put(T, grant(T, SPOT, key("ab")));
    assert.equal(await agentFor.hostedAgentFor(req(null), "spot"), null);
    assert.equal(await agentFor.hostedAgentFor(req(null), "perps"), null);
    for (const w of NOT_A_WALLET) await assert.rejects(agentFor.hostedAgentFor(req(T), w as never), /wallet purpose/, String(w));
  });
});

describe("diskAgent", () => {
  beforeEach(() => {
    rmSync(path.join(home, "grant.json"), { force: true });
    rmSync(perpsHome(), { recursive: true, force: true });
  });

  it("Spot's grant.json is Spot's; Perps reads its own home, and is nobody without one", async () => {
    writeFileSync(path.join(home, "grant.json"), JSON.stringify({ smartAccount: SPOT }));
    assert.equal(await agentFor.diskAgent("spot"), SPOT);
    assert.equal(await agentFor.diskAgent("perps"), null, "never the Spot grant.json");
    mkdirSync(perpsHome(), { recursive: true });
    writeFileSync(path.join(perpsHome(), "grant.json"), JSON.stringify({ smartAccount: PERPS, purpose: "perps" }));
    assert.equal(await agentFor.diskAgent("perps"), PERPS);
    assert.equal(await agentFor.diskAgent("spot"), SPOT);
  });

  it("a grant that names the other wallet answers null, in either home", async () => {
    mkdirSync(perpsHome(), { recursive: true });
    // A Spot grant (no purpose) copied into the Perps home is not a Perps wallet.
    writeFileSync(path.join(perpsHome(), "grant.json"), JSON.stringify({ smartAccount: SPOT }));
    assert.equal(await agentFor.diskAgent("perps"), null);
    writeFileSync(path.join(home, "grant.json"), JSON.stringify({ smartAccount: PERPS, purpose: "perps" }));
    assert.equal(await agentFor.diskAgent("spot"), null);
  });

  it("an unnamed wallet throws rather than reading Spot's file", async () => {
    writeFileSync(path.join(home, "grant.json"), JSON.stringify({ smartAccount: SPOT }));
    for (const w of NOT_A_WALLET) await assert.rejects(agentFor.diskAgent(w as never), /wallet purpose/, String(w));
  });
});

describe("withReadDb", () => {
  const seed = (file: string, who: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE IF NOT EXISTS whose (who TEXT)");
    db.exec("DELETE FROM whose");
    db.prepare("INSERT INTO whose (who) VALUES (?)").run(who);
    db.close();
  };
  const whose = (wallet: "spot" | "perps") =>
    ledger.withReadDb(async (db) => (db ? ((await db.prepare("SELECT who FROM whose").get()) as { who: string }).who : null), wallet);
  beforeEach(() => {
    rmSync(path.join(home, "merrymen.db"), { force: true });
    rmSync(perpsHome(), { recursive: true, force: true });
  });

  it("self-hosted, each wallet reads its own home's ledger, and Perps without one reads nothing", async () => {
    seed(path.join(home, "merrymen.db"), "spot");
    assert.equal(await whose("spot"), "spot");
    assert.equal(await whose("perps"), null, "never the Spot ledger");
    assert.equal(existsSync(path.join(perpsHome(), "merrymen.db")), false, "and nothing is created by reading");
    seed(path.join(perpsHome(), "merrymen.db"), "perps");
    assert.equal(await whose("perps"), "perps");
    assert.equal(await whose("spot"), "spot");
  });

  it("hosted, both wallets share the one pooled driver: rows are told apart by the account each query names", async () => {
    const fake = { prepare: () => ({ get: async () => undefined, all: async () => [], run: async () => undefined }) } as unknown as Db;
    let opens = 0;
    const read = ledger.createReadDb(async () => { opens++; return fake; });
    process.env.DATABASE_URL = "postgres://fixture.invalid/ledger";
    try {
      assert.equal(await read(async (db) => db, "spot"), fake);
      assert.equal(await read(async (db) => db, "perps"), fake);
      assert.equal(opens, 1);
    } finally {
      delete process.env.DATABASE_URL;
    }
  });

  it("an unnamed wallet throws before anything is opened", async () => {
    seed(path.join(home, "merrymen.db"), "spot");
    let ran = false;
    for (const w of NOT_A_WALLET) {
      await assert.rejects(ledger.withReadDb(async () => { ran = true; }, w as never), /wallet purpose/, String(w));
    }
    assert.equal(ran, false);
  });
});

describe("archiveCurrentGrant and removeSelfHostedGrant", () => {
  const SPOT_GRANT = JSON.stringify({ smartAccount: SPOT, demoOwnerPrivateKey: key("01") });
  const PERPS_GRANT = JSON.stringify({ smartAccount: PERPS, purpose: "perps", demoOwnerPrivateKey: key("01") });
  beforeEach(() => {
    for (const p of ["grant.json", "grants", "paused", "accounts"]) rmSync(path.join(home, p), { recursive: true, force: true });
    writeFileSync(path.join(home, "grant.json"), SPOT_GRANT);
  });

  it("Perps with no grant of its own archives nothing, and leaves Spot's alone", async () => {
    assert.deepEqual(await archive.archiveCurrentGrant("perps"), { kind: "nothing" });
    await archive.removeSelfHostedGrant("perps");
    assert.equal(readFileSync(path.join(home, "grant.json"), "utf8"), SPOT_GRANT);
    assert.equal(existsSync(path.join(home, "grants")), false);
  });

  it("Perps's grant is archived into its own home and removed; Spot's file and archive are untouched", async () => {
    mkdirSync(perpsHome(), { recursive: true });
    writeFileSync(path.join(perpsHome(), "grant.json"), PERPS_GRANT);
    await archive.removeSelfHostedGrant("perps");
    assert.equal(existsSync(path.join(perpsHome(), "grant.json")), false);
    assert.equal(readFileSync(path.join(perpsHome(), "grants", `${PERPS}.json`), "utf8"), PERPS_GRANT);
    assert.equal(readFileSync(path.join(home, "grant.json"), "utf8"), SPOT_GRANT);
    assert.equal(existsSync(path.join(home, "grants")), false);
  });

  it("Spot is the kill switch it always was, and leaves the Perps home alone", async () => {
    mkdirSync(perpsHome(), { recursive: true });
    writeFileSync(path.join(perpsHome(), "grant.json"), PERPS_GRANT);
    await archive.removeSelfHostedGrant("spot");
    assert.equal(existsSync(path.join(home, "grant.json")), false);
    assert.equal(readFileSync(path.join(home, "grants", `${SPOT}.json`), "utf8"), SPOT_GRANT);
    assert.equal(readFileSync(path.join(perpsHome(), "grant.json"), "utf8"), PERPS_GRANT);
  });

  it("a Perps archive that cannot be written keeps the grant and pauses the PERPS home, naming its archive", async () => {
    mkdirSync(perpsHome(), { recursive: true });
    writeFileSync(path.join(perpsHome(), "grant.json"), PERPS_GRANT);
    writeFileSync(path.join(perpsHome(), "grants"), "not a directory");
    await assert.rejects(archive.removeSelfHostedGrant("perps"), (e: unknown) => {
      assert.ok(e instanceof archive.GrantArchiveError);
      assert.equal(e.paused, true);
      assert.match(e.message, /accounts\/perps\/grants\//);
      return true;
    });
    assert.equal(readFileSync(path.join(perpsHome(), "grant.json"), "utf8"), PERPS_GRANT, "kept");
    assert.equal(existsSync(path.join(perpsHome(), "paused")), true);
    assert.equal(existsSync(path.join(home, "paused")), false, "the Spot wallet is not paused for it");
  });

  it("an unnamed wallet throws before any file is touched", async () => {
    for (const w of NOT_A_WALLET) {
      await assert.rejects(archive.archiveCurrentGrant(w as never), /wallet purpose/, String(w));
      await assert.rejects(archive.removeSelfHostedGrant(w as never), /wallet purpose/, String(w));
    }
    assert.equal(readFileSync(path.join(home, "grant.json"), "utf8"), SPOT_GRANT);
  });
});

describe("queuePaperReset", () => {
  const commands = (dir: string) => (existsSync(path.join(dir, "commands")) ? readdirSync(path.join(dir, "commands")).filter((n) => n.endsWith(".json")) : []);
  beforeEach(() => {
    rmSync(path.join(home, "commands"), { recursive: true, force: true });
    rmSync(perpsHome(), { recursive: true, force: true });
  });

  it("self-hosted, a Perps reset lands in the Perps home and never in the Spot worker's", async () => {
    const queued = await startOver.queuePaperReset(false, PERPS, "perps");
    assert.equal(queued.ok, true);
    assert.equal(commands(perpsHome()).length, 1);
    assert.deepEqual(commands(home), []);
  });

  it("and a Spot reset lands where it always did", async () => {
    const queued = await startOver.queuePaperReset(false, SPOT, "spot");
    assert.equal(queued.ok, true);
    assert.equal(commands(home).length, 1);
    assert.equal(existsSync(perpsHome()), false);
  });

  it("an unnamed wallet throws before anything is written", async () => {
    for (const w of NOT_A_WALLET) await assert.rejects(startOver.queuePaperReset(false, SPOT, w as never), /wallet purpose/, String(w));
    assert.deepEqual(commands(home), []);
  });
});
