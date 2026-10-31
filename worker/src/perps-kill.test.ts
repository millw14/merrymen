/**
 * THE KILL MATRIX, SELF-HOSTED: the Telegram /kill and `merrymen kill`
 * against a Spot-only, a Perps-only and a two-wallet owner. The web rows are
 * in web/src/app/api/grants/kill-perps.test.ts, the hosted Telegram rows in
 * perps-kill-hosted.integration.test.ts.
 *
 * Self-hosted, the Perps wallet is the grant.json in its own home
 * (`accounts/perps`). Its kill archives that grant, owner key and all, into
 * that home's archive, then removes it; an archive it cannot write keeps the
 * grant, pauses that home and says the kill is incomplete. It runs before the
 * Spot grant is touched, like Solana's half, and a Spot-only install's kill
 * records a disabled Perps revision, with no grant or worker.
 *
 * The Telegram row runs the Perps half and the answer it renders, and reads
 * index.ts for the order, as solana-kill.test.ts does for Solana: the kill
 * dependency lives inside the worker's start-up. `merrymen kill` is spawned
 * for real.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { PerpsKillIncomplete, PerpsPaperNotStopped, selfHostedPerpsKill, stopLocalPerpsForKill, stopPerpsForKill } from "./perps-kill";
import { selfHostedSolanaKill } from "./solana-kill";
import { killDoneText } from "./telegram/kill-confirm";

type Owner = "spot-only" | "perps-only" | "two-wallet";
const OWNERS: Owner[] = ["spot-only", "perps-only", "two-wallet"];
const hasSpot = (o: Owner) => o !== "perps-only";
const hasPerps = (o: Owner) => o !== "spot-only";
const SPOT = "0x1111111111111111111111111111111111111111";
const PERPS = "0x2222222222222222222222222222222222222222";
const local = (account: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ smartAccount: account, serialized: "0xserialized", chainId: 4663, demoOwnerPrivateKey: `0x${"77".repeat(32)}`, ...extra });

/** A self-hosted home holding the wallets `owner` has. */
function install(t: TestContext, owner: Owner): { dir: string; perpsHome: string } {
  const saved = { home: process.env.MERRYMEN_HOME, hosted: process.env.MERRYMEN_HOSTED, db: process.env.DATABASE_URL };
  const dir = mkdtempSync(path.join(tmpdir(), "perps-kill-home-"));
  process.env.MERRYMEN_HOME = dir; delete process.env.MERRYMEN_HOSTED; delete process.env.DATABASE_URL;
  t.after(() => {
    for (const [k, v] of [["MERRYMEN_HOME", saved.home], ["MERRYMEN_HOSTED", saved.hosted], ["DATABASE_URL", saved.db]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const perpsHome = path.join(dir, "accounts", "perps");
  if (hasSpot(owner)) writeFileSync(path.join(dir, "grant.json"), local(SPOT));
  if (hasPerps(owner)) {
    mkdirSync(perpsHome, { recursive: true });
    writeFileSync(path.join(perpsHome, "grant.json"), local(PERPS, { purpose: "perps" }));
  }
  return { dir, perpsHome };
}

for (const owner of OWNERS) {
  test(`self-hosted Telegram /kill, ${owner}: the Perps half revokes exactly the local Perps wallet, and says so`, async (t) => {
    const { dir, perpsHome } = install(t, owner);
    assert.equal(await selfHostedPerpsKill(), hasPerps(owner) ? "stopped" : null);
    assert.equal(existsSync(path.join(perpsHome, "grant.json")), false);
    if (hasPerps(owner)) assert.equal(readFileSync(path.join(perpsHome, "grants", `${PERPS}.json`), "utf8"), local(PERPS, { purpose: "perps" }), "its owner key is kept");
    else assert.equal(JSON.parse(readFileSync(path.join(perpsHome, "settings.json"), "utf8")).perpsEnabled, false, "a Spot-only kill records an off revision against delayed enables");
    if (hasSpot(owner)) assert.equal(readFileSync(path.join(dir, "grant.json"), "utf8"), local(SPOT), "the Spot grant is the Spot half's to remove");
    assert.equal(await selfHostedPerpsKill(), null, "a retry finds nothing left");
  });
}

test("self-hosted: a Perps owner key that cannot be archived keeps that grant, pauses its home, and answers not-stopped", async (t) => {
  const { perpsHome } = install(t, "perps-only");
  writeFileSync(path.join(perpsHome, "grants"), "not a directory");
  await assert.rejects(stopLocalPerpsForKill(), (e: unknown) => e instanceof PerpsKillIncomplete && e.paused && /archive could not be written/.test(e.message));
  assert.equal(await selfHostedPerpsKill(), "not-stopped");
  assert.ok(existsSync(path.join(perpsHome, "grant.json")), "the owner key is not lost");
  assert.ok(existsSync(path.join(perpsHome, "paused")));
});

test("the Telegram answer has a Perps line after the Solana one, and none for an owner without a Perps wallet", () => {
  assert.match(killDoneText({ ok: true, archived: "0xabc", perps: "stopped" }), /grant destroyed[\s\S]*Your Perps wallet's grant is revoked too: it can no longer sign anything\.$/);
  assert.match(killDoneText({ ok: true, archived: null, solana: "stopped", perps: "stopped" }), /Your Solana strategy is stopped too\.\nYour Perps wallet's grant is revoked too/);
  assert.match(killDoneText({ ok: false, reason: "no grant", perps: "stopped" }), /^nothing to kill: no grant\nYour Perps wallet's grant is revoked too/);
  assert.match(killDoneText({ ok: true, archived: null, perps: "not-stopped" }), /Kill incomplete: your Perps wallet's grant could not be revoked and it may still sign\. \/kill again\.$/);
  // The grant went, the paper strategy could not be switched off: incomplete, and never said to be a live grant.
  const paper = killDoneText({ ok: true, archived: null, perps: "paper-not-stopped" });
  assert.match(paper, /Kill incomplete: your Perps wallet has no grant left, so nothing trades on it, but its practice perpetuals could not be switched off\./);
  assert.doesNotMatch(paper, /may still sign/);
  assert.doesNotMatch(killDoneText({ ok: true, archived: null, solana: "stopped" }), /Perps/);
});

test("the worker's self-hosted Telegram kill runs the Perps half beside Solana's, before it touches the grant", () => {
  const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  const start = source.indexOf("    kill: async () => {");
  assert.ok(start > 0, "the Telegram kill dependency");
  const body = source.slice(start, source.indexOf("function robinhoodKill(): KillResult", start));
  assert.match(body, /const perps = isHostedMode\(\) \? null : await selfHostedPerpsKill\(\);[\s\S]*const result = robinhoodKill\(\);/);
  assert.match(body, /\.\.\.\(perps \? \{ perps \} : \{\}\)/, "and its answer carries the Perps line");
});

test("the hosted half answers from the store, and refuses to guess", async () => {
  const T = "0x00000000000000000000000000000000000000a1" as const;
  const store = (r: "removed" | "absent" | "newer") => ({ revokeForKill: async () => r });
  // The paper strategy is turned off on every kill that finds no newer grant (slice 3).
  const asked: string[] = [];
  const paper = (r: "disabled" | "none") => async (t: `0x${string}`) => {
    asked.push(t);
    return r;
  };
  assert.equal(await stopPerpsForKill(T, { store: store("removed"), paper: paper("disabled") }), "stopped");
  assert.equal(await stopPerpsForKill(T, { store: store("absent"), paper: paper("none") }), "none");
  // No grant, but perps were on: turned off, and the answer names no grant it did not revoke.
  assert.equal(await stopPerpsForKill(T, { store: store("absent"), paper: paper("disabled") }), "none");
  assert.deepEqual(asked, [T, T, T]);
  // A grant signed after the kill is the owner's later decision, and so are its settings.
  assert.equal(await stopPerpsForKill(T, { store: store("newer"), coveredSec: 1, paper: paper("disabled") }), "newer");
  assert.equal(asked.length, 3, "the settings of a later decision are not touched");
  await assert.rejects(stopPerpsForKill(T, { store: { revokeForKill: async () => { throw new Error("database unavailable"); } }, paper: paper("none") }), /database unavailable/);
  // A settings store that cannot say makes the kill incomplete — after the grant was revoked.
  let revoked = false;
  await assert.rejects(
    stopPerpsForKill(T, {
      store: { revokeForKill: async () => { revoked = true; return "removed"; } },
      paper: async () => { throw new Error("settings unavailable"); },
    }),
    /practice perpetuals could NOT be switched off/,
  );
  assert.equal(revoked, true, "the grant first");
  // The store's own words (a driver's host and port) are the operator's, never the owner's.
  await assert.rejects(
    stopPerpsForKill(T, { store: store("removed"), paper: async () => { throw new Error("connect ECONNREFUSED 10.0.0.7:5432"); } }),
    (e: unknown) => e instanceof PerpsPaperNotStopped && e.perpsRemoved && !/ECONNREFUSED|10\.0\.0\.7/.test(e.message) && /its settings could not be read or written just now/.test(e.message),
  );
  const saved = process.env.MERRYMEN_HOSTED;
  process.env.MERRYMEN_HOSTED = "1";
  try { await assert.rejects(stopLocalPerpsForKill(), /hosted kill names its tenant/); }
  finally { if (saved === undefined) delete process.env.MERRYMEN_HOSTED; else process.env.MERRYMEN_HOSTED = saved; }
});

const bin = fileURLToPath(new URL("../../cli/bin.mjs", import.meta.url));
const cli = (dir: string, input: string) => spawnSync(process.execPath, [bin, "kill"], { input, encoding: "utf8", timeout: 100_000,
  env: { ...process.env, MERRYMEN_HOME: dir, MERRYMEN_HOSTED: "", DATABASE_URL: "" } });

for (const owner of OWNERS) {
  test(`\`merrymen kill\`, ${owner}: every local wallet's grant is archived and removed`, { timeout: 120_000 }, (t) => {
    const { dir, perpsHome } = install(t, owner);
    const run = cli(dir, "y\n");
    const said = run.stdout + run.stderr;
    assert.equal(run.status, 0, said);
    if (owner === "two-wallet") assert.match(said, /destroy the grants of both wallets \(Spot and Perps\)\?/);
    if (owner === "spot-only") assert.match(said, /destroy the grant\? The worker halts/);
    if (owner === "perps-only") assert.match(said, /revoke your Perps wallet's grant\?/);
    if (hasPerps(owner)) {
      assert.match(said, /Perps wallet's grant revoked/);
      assert.ok(existsSync(path.join(perpsHome, "grants", `${PERPS}.json`)));
    } else {
      assert.doesNotMatch(said, /Perps/);
      assert.equal(JSON.parse(readFileSync(path.join(perpsHome, "settings.json"), "utf8")).perpsEnabled, false, "a Spot-only kill records an off revision against delayed enables");
    }
    if (hasSpot(owner)) assert.match(said, /grant destroyed — the band stands down on the next tick/);
    assert.equal(existsSync(path.join(dir, "grant.json")), false);
    assert.equal(existsSync(path.join(perpsHome, "grant.json")), false);
  });
}

test("`merrymen kill` with a Perps grant it cannot archive removes Spot's, keeps the Perps one, and is incomplete", { timeout: 120_000 }, (t) => {
  const { dir, perpsHome } = install(t, "two-wallet");
  writeFileSync(path.join(perpsHome, "grants"), "not a directory");
  const run = cli(dir, "y\n");
  const said = run.stdout + run.stderr;
  assert.equal(run.status, 1, said);
  assert.match(said, /Kill incomplete: your Perps wallet's grant could not be revoked and it may still sign\. Your Perps wallet's grant was NOT revoked: the archive could not be written/);
  assert.match(said, /grant destroyed and the Robinhood band stands down, but the kill is incomplete: the Perps wallet's grant was not revoked/);
  assert.doesNotMatch(said, /the band stands down on the next tick/);
  assert.equal(existsSync(path.join(dir, "grant.json")), false, "the Spot grant is still torn down");
  assert.ok(existsSync(path.join(perpsHome, "grant.json")), "the Perps owner key is not lost");
});

/**
 * A home this process cannot read is not an empty one. Made unreadable with
 * mode 000 for the test (root reads through any mode, so it is skipped there),
 * and given its mode back by the test itself, before the temp home is removed.
 */
const asRoot = process.getuid?.() === 0;
function unreadable(dir: string): () => void {
  chmodSync(dir, 0o000);
  return () => chmodSync(dir, 0o700);
}

test("self-hosted Telegram /kill on a home it cannot read: Solana and Perps both answer not-stopped, never none", { skip: asRoot }, async (t) => {
  const { dir } = install(t, "two-wallet");
  const restore = unreadable(dir);
  try {
    assert.equal(await selfHostedPerpsKill(), "not-stopped");
    assert.equal(await selfHostedSolanaKill(), "not-stopped", "an accounts file that cannot be looked for may be a strategy that is on");
  } finally {
    restore();
  }
});

for (const owner of ["two-wallet", "perps-only"] as const) {
  test(`\`merrymen kill\`, ${owner}, with a Perps home it cannot read: incomplete and exit 1, never done, and the grant is not lost`, { skip: asRoot, timeout: 120_000 }, (t) => {
    const { dir, perpsHome } = install(t, owner);
    const restore = unreadable(perpsHome);
    let said: string;
    let status: number | null;
    try {
      const run = cli(dir, "y\n");
      said = run.stdout + run.stderr;
      status = run.status;
    } finally {
      restore();
    }
    assert.equal(status, 1, said);
    assert.doesNotMatch(said, /already home|the band stands down on the next tick/);
    assert.match(said, /Kill incomplete: your Perps wallet's grant could not be revoked and it may still sign\. The local Perps wallet's grant could not be read or revoked \(EACCES\)/);
    if (owner === "two-wallet") assert.match(said, /grant destroyed and the Robinhood band stands down, but the kill is incomplete: the Perps wallet's grant was not revoked/);
    assert.ok(existsSync(path.join(perpsHome, "grant.json")), "the Perps grant is still there, and the kill said so");
  });
}

test("`merrymen kill` on a home it cannot read says nothing is done: Solana, Perps and the grant all incomplete", { skip: asRoot, timeout: 120_000 }, (t) => {
  const { dir } = install(t, "two-wallet");
  const restore = unreadable(dir);
  let said: string;
  let status: number | null;
  try {
    const run = cli(dir, "y\n");
    said = run.stdout + run.stderr;
    status = run.status;
  } finally {
    restore();
  }
  assert.equal(status, 1, said);
  assert.doesNotMatch(said, /already home|the band stands down on the next tick/);
  assert.match(said, /Kill incomplete: your Solana strategy could not be stopped/);
  assert.match(said, /Kill incomplete: your Perps wallet's grant could not be revoked/);
  assert.match(said, /grant NOT destroyed — grant\.json could not be read \(EACCES\)/);
});

test("`merrymen kill` answered no touches neither wallet", { timeout: 120_000 }, (t) => {
  for (const owner of ["two-wallet", "perps-only"] as const) {
    const { dir, perpsHome } = install(t, owner);
    const run = cli(dir, "n\n");
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /stayed the hand — nothing touched/);
    assert.ok(existsSync(path.join(perpsHome, "grant.json")));
    if (hasSpot(owner)) assert.ok(existsSync(path.join(dir, "grant.json")));
  }
});
