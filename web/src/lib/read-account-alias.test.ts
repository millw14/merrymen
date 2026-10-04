import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { applyLedgerSchema } from "../../../worker/src/store";
import { profileOf } from "./read-agent";
import { readLeaderboard } from "./read-leaderboard";
import type { PublicIdentity } from "@merrymen/identity-store";

const ACCOUNT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALIAS = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const REGRANT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TENANT = "0xcccccccccccccccccccccccccccccccccccccccc";
const NOW = 2_000_000_000;

async function registration(db: Db, account: string, name: string, epoch: number, beat: number,
  created: number, mode: string, quality: number) {
  await db.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps,
    granted_at, expires_at, status, mode, epoch, beat_at, contributions_known, created_at, x_handle, x_verified)
    VALUES (?, ?, ?, 'PRIVATE-KEY', 4663, 'PRIVATE-CAPS', 0, ?, 'armed', ?, ?, ?, ?, ?, ?, ?)`)
    .run(account, name, TENANT, NOW + 86_400, mode, epoch, beat, quality, created,
      name === "Current desk" ? "current_desk" : "stale_desk", name === "Current desk" ? 1 : 0);
}

async function mark(db: Db, account: string, epoch: number, equity: number, mode: string, at: number) {
  await db.prepare(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg,
    equity_usdg, epoch, mode, at) VALUES (?, 'PRIVATE-ETH', ?, 0, 0, ?, ?, ?, ?)`)
    .run(account, equity, equity, epoch, mode, at);
}

test("profile and board choose the current alias before reading its run and publication setting", async () => {
  // The epoch wins first; if aliases are already in the same epoch, the newer
  // heartbeat wins. A tied registration timestamp cannot choose stale metadata.
  for (const staleEpoch of [1, 2]) {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    try {
      await applyLedgerSchema(db);
      await registration(db, ALIAS, "Stale desk", staleEpoch, staleEpoch === 1 ? NOW : NOW - 100, 100, "live", 0);
      await registration(db, ACCOUNT, "Current desk", 2, NOW - 1, 100, "paper", 1);
      await mark(db, ALIAS, 1, 250, "live", NOW - 200);
      await mark(db, ACCOUNT, 2, 333, "paper", NOW - 60);
      await mark(db, ACCOUNT, 2, 332, "paper", NOW - 10);
      const identity: PublicIdentity = { tenant: TENANT, slug: "current-desk", accounts: [ALIAS], createdAt: 100, updatedAt: 100 };
      for (const publicBook of [false, true]) {
        const board = await readLeaderboard(fn => fn(db), async () => [identity], () => NOW,
          async tenant => {
            assert.equal(tenant, TENANT);
            return { publicBook };
          });
        const profile = await profileOf(db, identity, publicBook);
        assert.ok(profile);
        assert.equal(board.retired, 0);
        assert.equal(board.agents.length, 1);
        const row = board.agents[0]!;
        for (const result of [row, profile]) {
          assert.equal(result.name, "Current desk");
          assert.equal(result.mode, "paper");
          assert.equal(result.handle, "current_desk");
          assert.equal(result.handleVerified, true);
          assert.equal(result.unrankedWhy, "paper");
          assert.equal(result.performance?.book, "paper");
          assert.equal(result.performance?.equityUsdg, publicBook ? 332 : null);
          assert.equal(result.performance?.pnlUsdg, publicBook ? -1 : null);
          assert.equal(result.performance?.equityAt, NOW - 10);
          assert.ok(Math.abs(result.performance!.pnlBps! - (-10_000 / 333)) < 1e-9);
          const serialized = JSON.stringify(result);
          for (const privateField of [ACCOUNT, ALIAS, TENANT, "PRIVATE-KEY", "PRIVATE-CAPS", "PRIVATE-ETH"]) {
            assert.ok(!serialized.includes(privateField), `public projection exposed ${privateField}`);
          }
        }
        assert.equal(profile.beatAt, NOW - 1);
        assert.equal(profile.contributionsEvidenced, true, "quality must come from the selected alias");
        assert.deepEqual(row.performance, profile.performance);
      }
    } finally { raw.close(); }
  }
});

test("a distinct account re-grant still wins by registration time after alias canonicalization", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await applyLedgerSchema(db);
    await registration(db, ALIAS, "Stale desk", 9, NOW, 100, "live", 0);
    await registration(db, ACCOUNT, "Older account", 10, NOW, 100, "paper", 1);
    await registration(db, REGRANT, "Current desk", 1, NOW - 1, 200, "paper", 1);
    await mark(db, ACCOUNT, 10, 999, "paper", NOW - 5);
    await mark(db, REGRANT, 1, 500, "paper", NOW - 20);
    await mark(db, REGRANT, 1, 501, "paper", NOW - 10);
    const identity: PublicIdentity = { tenant: TENANT, slug: "current-desk", accounts: [ALIAS, REGRANT], createdAt: 100, updatedAt: 200 };
    const board = await readLeaderboard(fn => fn(db), async () => [identity], () => NOW, async () => ({ publicBook: true }));
    const profile = await profileOf(db, identity, true);
    assert.ok(profile);
    assert.equal(board.agents.length, 1);
    assert.equal(board.retired, 0);
    assert.equal(board.agents[0]!.name, "Current desk");
    assert.equal(profile.name, "Current desk");
    assert.equal(profile.performance?.equityUsdg, 501);
    assert.equal(profile.performance?.pnlUsdg, 1);
    assert.deepEqual(board.agents[0]!.performance, profile.performance);
  } finally { raw.close(); }
});
