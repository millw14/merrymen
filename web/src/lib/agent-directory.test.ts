import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { applyLedgerSchema } from "../../../worker/src/store";
import { readAgentDirectory } from "./agent-directory";
import { readLeaderboard } from "./read-leaderboard";
import type { DiscoveryTiming, DiscoveryStage } from "./discovery-timing";

const NOW = 2_000_000_000;
async function fixture(active = 34, retired = 130) {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  // Match the observed public fleet size; ledger history exists but a directory
  // must never read it. Distinct identifiers keep alias/retirement behavior real.
  const ids: { tenant: `0x${string}`; slug: string; accounts: `0x${string}`[]; createdAt: number; updatedAt: number }[] = [];
  const insert = raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps,
    granted_at, expires_at, status, created_at, name, mode, beat_at) VALUES (?, 'owner', 'key', 4663, '{}', ?, ?, ?, ?, ?, 'paper', ?)`);
  for (let i = 0; i < active + retired; i++) {
    const account = `0x${i.toString(16).padStart(40, "0")}` as const;
    insert.run(account, NOW - 1000, NOW + 1000, i < active ? "armed" : "killed", NOW - i, `Agent ${i}`, NOW - 60);
    ids.push({ tenant: account, slug: `public-${i}`, accounts: [account], createdAt: NOW - i, updatedAt: NOW });
  }
  return { raw, db, identities: async () => ids };
}

function observed(db: Db) {
  const queries: string[] = [];
  const reader: Db = {
    prepare(sql) { queries.push(sql); return db.prepare(sql); },
    exec: sql => db.exec(sql),
    tx: fn => db.tx(fn),
  };
  return { reader, queries };
}

test("164-account directory has the ranking's lifecycle selection without financial/history reads", async (t) => {
  const f = await fixture();
  try {
    const fast = observed(f.db);
    const start = performance.now();
    const directory = await readAgentDirectory(fn => fn(fast.reader), f.identities, () => NOW);
    const duration = performance.now() - start;
    assert.equal(directory.agents.length, 34);
    assert.equal(directory.retired, 130);
    assert.equal(directory.fetchedAt, NOW * 1000);
    assert.ok(directory.agents.every(r => r.landed === null && r.pnlBps === null && r.unrankedWhy === "not-read"));
    assert.ok(fast.queries.every(sql => !/\b(?:trades|equity|flows|tenant_settings)\b/i.test(sql)), "no financial query can delay identity discovery");
    // Six: the four selection reads, and the catalogue's answer that no Perps
    // wallets record exists yet (perps-wallets.ts; two statements on sqlite,
    // one on Postgres), so the record itself is never read.
    assert.equal(fast.queries.length, 6, "selection cost stays fixed as the fleet grows");
    assert.doesNotMatch(JSON.stringify(directory), /smart_account|owner_address|session_key|caps|equityUsdg|pnlUsdg|performance/);

    const slow = observed(f.db);
    let settingsReads = 0;
    const fullStart = performance.now();
    const ranking = await readLeaderboard(fn => fn(slow.reader), f.identities, () => NOW, async () => { settingsReads++; return null; });
    const fullDuration = performance.now() - fullStart;
    assert.deepEqual(new Set(directory.agents.map(r => r.slug)), new Set(ranking.agents.map(r => r.slug)));
    assert.equal(directory.retired, ranking.retired);
    assert.ok(slow.queries.length > fast.queries.length);
    assert.equal(settingsReads, 164);
    t.diagnostic(`164-account fixture: directory ${duration.toFixed(2)}ms / ${fast.queries.length} ledger queries; full board ${fullDuration.toFixed(2)}ms / ${slow.queries.length} ledger queries + ${settingsReads} settings reads. Local SQLite timings are not production latency.`);
  } finally { f.raw.close(); }
});

test("unknown identities keep rows visible and never invent a retired count", async () => {
  const f = await fixture(2, 2);
  try {
    const r = await readAgentDirectory(fn => fn(f.db), async () => { throw new Error("unread"); }, () => NOW);
    assert.equal(r.agents.length, 4);
    assert.equal(r.retired, null);
    assert.ok(r.agents.every(a => a.slug === null));
  } finally { f.raw.close(); }
});

test("no database or unread selection is not a successful empty directory", async () => {
  const none = await readAgentDirectory(fn => fn(null), async () => [], () => NOW);
  assert.equal(none.source, "none");
  const raw = new DatabaseSync(":memory:");
  try {
    const result = await readAgentDirectory(fn => fn(wrapSqlite(raw)), async () => [], () => NOW);
    assert.equal(result.source, "none");
  } finally { raw.close(); }
});

test("directory diagnostics stop acquisition at callback entry and wrap only the five public reads", async () => {
  const f = await fixture(1, 0);
  const events: string[] = [];
  const timing: DiscoveryTiming = {
    start(stage) {
      events.push(`start:${stage}`);
      return outcome => { events.push(`${outcome}:${stage}`); };
    },
    async measure(stage: DiscoveryStage, read) {
      events.push(`start:${stage}`);
      try {
        const result = await read();
        events.push(`ok:${stage}`);
        return result;
      } catch (error) {
        events.push(`error:${stage}`);
        throw error;
      }
    },
  };
  try {
    const directory = await readAgentDirectory(async fn => {
      assert.deepEqual(events, ["start:read-db"], "opening is measured before the driver is available");
      return fn(f.db);
    }, async () => {
      assert.deepEqual(events, ["start:read-db", "ok:read-db", "start:identities"]);
      return f.identities();
    }, () => NOW, timing);
    assert.equal(directory.agents.length, 1);
    assert.equal(directory.source, "sqlite");
    assert.equal(directory.retired, 0);
    // This ledger fixture lacks the optional recovery table. Its read still
    // gets an error outcome, while the existing no-hold fallback keeps rows.
    assert.deepEqual(events, [
      // perps-wallets: the Perps wallets the board leaves out (rule 17), read with the board.
      ...["read-db", "identities", "heartbeat", "registrations", "perps-wallets", "lifecycle"]
        .flatMap(stage => [`start:${stage}`, `ok:${stage}`]),
      "start:holds", "error:holds",
    ]);
  } finally { f.raw.close(); }
});

test("A PERPS WALLET'S AGENT IS NEVER ON THE BOARD OR IN THE DIRECTORY (docs/perps.md rule 17)", async () => {
  const f = await fixture(3, 0);
  try {
    const { recordPerpsWallet } = await import("../../../worker/src/perps-wallets");
    // A login's Perps worker wrote its own agents row (no public id), as a
    // hosted one does; the orchestrator recorded the wallet before it ran.
    const perps = `0x${"9".repeat(40)}` as const;
    f.raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps,
      granted_at, expires_at, status, created_at, name, mode, beat_at) VALUES (?, 'owner', 'key', 4663, '{}', ?, ?, 'armed', ?, 'Robin', 'paper', ?)`)
      .run(perps, NOW - 1000, NOW + 1000, NOW, NOW - 60);
    const before = await readAgentDirectory(fn => fn(f.db), f.identities, () => NOW);
    assert.equal(before.agents.length, 4, "unrecorded, it would be listed — which is why the record comes first");
    await recordPerpsWallet(f.db, { smartAccount: perps, owner: `0x${"8".repeat(40)}`, chainId: 4663, nowSec: NOW });
    const directory = await readAgentDirectory(fn => fn(f.db), f.identities, () => NOW);
    assert.equal(directory.agents.length, 3);
    assert.ok(!directory.agents.some((a) => a.name === "Robin"), "the Perps wallet's agent is left out");
    const board = await readLeaderboard(fn => fn(f.db), f.identities, () => NOW);
    assert.ok(!JSON.stringify(board).includes("Robin"), "and off the leaderboard");
    // A record that is there but cannot be read leaves the board unread, never both wallets listed.
    const refusing: Db = {
      prepare(sql) {
        if (/FROM perps_wallets/.test(sql)) throw new Error("permission denied for table perps_wallets");
        return f.db.prepare(sql);
      },
      exec: sql => f.db.exec(sql),
      tx: fn => f.db.tx(fn),
    };
    const unread = await readAgentDirectory(fn => fn(refusing), f.identities, () => NOW).catch((e) => e);
    assert.ok(unread instanceof Error || unread.source === "none", "unread, not published");
    assert.ok(unread instanceof Error || !JSON.stringify(unread).includes("Robin"));
  } finally { f.raw.close(); }
});
