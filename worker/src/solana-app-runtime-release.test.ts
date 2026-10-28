/**
 * The live runtime holds its configured vault to the release pin: once
 * SOLANA_VAULT_RELEASES lists a release, MERRYMEN_SOLANA_VAULT_PROGRAM and
 * MERRYMEN_SOLANA_VAULT_SHA256 must be one listed pair, the program the owner
 * recovery tool trusts. config() refuses anything else as configuration,
 * before any RPC read, for status and for every owner action. Status still
 * names such a program and the owner's vault on it, so the recovery card can
 * show the read-only plan for the vault the owner may have funded.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getBase58Decoder } from "@solana/kit";
import { deriveSolanaVaultAddress, SOLANA_VAULT_LOCAL_TEST_PROGRAM } from "../../packages/core/src/solana-live";
import { SqlSolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { wrapSqlite } from "./db";
import { createSolanaAppRuntime } from "./solana-app-runtime";
import type { SolanaLiveRpc } from "./solana-live-rpc";

const TENANT = "0x2222222222222222222222222222222222222222";
const key = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
const OWNER = key(23), PROGRAM = key(77), OTHER_PROGRAM = key(78);
const HASH = "a".repeat(64), OTHER_HASH = "b".repeat(64);
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 10, maxDrawdownBps: 2000, expiresAtMs: 4_600_000,
  perTradeWsol: "100000000", dailyWsol: "500000000" };
const NOT_RELEASED = /not a released Merrymen vault program/;
const NOT_RELEASED_HASH = /binary hash is not the released hash of that program/;

async function fixture() {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw), now = () => 1_000_000;
  const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", now);
  await bindings.bind(TENANT, "did:privy:owner", OWNER);
  await bindings.settings(TENANT, OWNER, 0, "paper", limits);
  // Every RPC use is recorded and refused: a refusal by configuration must come first.
  const calls: string[] = [];
  const refuse = (what: string) => { calls.push(what); throw new Error(`unexpected RPC ${what}`); };
  const rpc: SolanaLiveRpc = { read: async () => refuse("read"), readEach: async () => refuse("readEach"), send: async () => refuse("send") };
  const runtime = (env: Record<string, string>, extra: Partial<Parameters<typeof createSolanaAppRuntime>[0]> = {}) =>
    createSolanaAppRuntime({ db, rpc, env, now, localTestDeployment: false, ...extra });
  return { raw, calls, runtime, scope: { tenant: TENANT, owner: OWNER } };
}
const configured = (programId: string, hash: string) => ({ MERRYMEN_SOLANA_VAULT_PROGRAM: programId, MERRYMEN_SOLANA_VAULT_SHA256: hash });
const releases = [{ programId: PROGRAM, sha256: HASH }];

test("with a release pinned, a configured program or binary hash that is not a listed pair is refused before any RPC", async () => {
  const f = await fixture();
  try {
    for (const [env, refusal] of [[configured(OTHER_PROGRAM, HASH), NOT_RELEASED], [configured(PROGRAM, OTHER_HASH), NOT_RELEASED_HASH],
      [configured(OTHER_PROGRAM, OTHER_HASH), NOT_RELEASED]] as const) {
      const app = f.runtime(env, { vaultReleases: releases });
      const status = await app.status(f.scope);
      assert.equal(status.live.ready, false);
      assert.equal(status.live.canExit, false, "the release refusal stops exits too");
      assert.match(status.live.blockers.join(" "), refusal);
      // Shown, never used: the program and the owner's vault on it, for the recovery card;
      // nothing was read from it (no balances, no token account).
      const programId = env.MERRYMEN_SOLANA_VAULT_PROGRAM;
      assert.deepEqual([status.live.programId, status.live.vault], [programId, await deriveSolanaVaultAddress(programId, OWNER)]);
      assert.deepEqual([status.live.balances, status.live.cashTokenAccount, status.live.feePayer, status.live.ownerWallet, status.live.recoverable],
        [null, null, null, null, null]);
      await assert.rejects(app.prepareOwnerAction(f.scope, { action: "revoke" }), refusal);
      await assert.rejects(app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "1" }), refusal);
    }
    assert.deepEqual(f.calls, [], "refused as configuration before any RPC read");
  } finally { f.raw.close(); }
});

test("a listed program with its released hash passes the release check, and an empty pin checks nothing", async () => {
  const f = await fixture();
  try {
    const listed = await f.runtime(configured(PROGRAM, HASH), { vaultReleases: releases }).status(f.scope);
    assert.equal(listed.live.programId, PROGRAM);
    assert.doesNotMatch(listed.live.blockers.join(" "), /released/);
    // A second release keeps the first one trusted (vaults on an older release stay usable).
    const both = await f.runtime(configured(PROGRAM, HASH), { vaultReleases: [{ programId: OTHER_PROGRAM, sha256: OTHER_HASH }, ...releases] }).status(f.scope);
    assert.doesNotMatch(both.live.blockers.join(" "), /released/);
    // Nothing is released yet (the shipped pin): the deployment checks alone decide.
    for (const app of [f.runtime(configured(OTHER_PROGRAM, OTHER_HASH), { vaultReleases: [] }), f.runtime(configured(OTHER_PROGRAM, OTHER_HASH))]) {
      const status = await app.status(f.scope);
      assert.equal(status.live.programId, OTHER_PROGRAM);
      assert.doesNotMatch(status.live.blockers.join(" "), /released/);
    }
    // The listed pair still goes on to the deployment check (RPC) for an owner action.
    await assert.rejects(f.runtime(configured(PROGRAM, HASH), { vaultReleases: releases }).prepareOwnerAction(f.scope, { action: "revoke" }), /unexpected RPC/);
  } finally { f.raw.close(); }
});

test("only a local test harness skips the release check, and the local test id is never a release", async () => {
  const f = await fixture();
  try {
    const harness = f.runtime(configured(OTHER_PROGRAM, OTHER_HASH), { vaultReleases: releases, localTestDeployment: true });
    assert.doesNotMatch((await harness.status(f.scope)).live.blockers.join(" "), /released/);
    // Production never runs as a harness: the local test id is refused whatever the pin says.
    const local = await f.runtime(configured(SOLANA_VAULT_LOCAL_TEST_PROGRAM, HASH), { vaultReleases: [{ programId: SOLANA_VAULT_LOCAL_TEST_PROGRAM, sha256: HASH }] })
      .status(f.scope);
    assert.match(local.live.blockers.join(" "), /local test id/);
    // Only the release refusal shows the program: the local test id, an invalid id or a missing
    // hash shows none, and derives no vault.
    assert.deepEqual([local.live.programId, local.live.vault], [null, null]);
    for (const env of [configured("not-a-key", HASH), { MERRYMEN_SOLANA_VAULT_PROGRAM: PROGRAM }, configured(PROGRAM, "A".repeat(64))]) {
      const status = await f.runtime(env, { vaultReleases: releases }).status(f.scope);
      assert.match(status.live.blockers.join(" "), /must be configured|invalid/);
      assert.deepEqual([status.live.programId, status.live.vault], [null, null]);
    }
    assert.deepEqual(f.calls, []);
  } finally { f.raw.close(); }
});
