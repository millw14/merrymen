/**
 * /api/grants CARRIES THE WORKER'S ENERGY REPORT, ON BOTH DEPLOYMENTS.
 *
 * The agents row is read inside `if (workerAliveAt === null)` — the branch for
 * "no heartbeat file on this disk". Self-hosted there always IS one (the worker
 * writes it beside this service), so anything read only inside that branch
 * never reaches a self-hosted owner at all. `liveBlocker` gets away with it
 * because the heartbeat file is its self-hosted source; energy has no such
 * file. It lives on the agents row and nowhere else, so its read must sit on
 * its own, after the branch.
 *
 * The route itself cannot run here (it needs the grant store, a session and a
 * chain), so its wiring is pinned in the source, and the reader it calls is
 * run against a stub that answers only the right question for the right
 * account, and against the real ledger schema with two tenants on it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { before, describe, it } from "node:test";
import type { Db } from "../../../../../worker/src/db";
import { readAgentEnergy } from "../../../lib/agent-energy";

const ROUTE = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const CODE = ROUTE.replace(/\/\*[\s\S]*?\*\//g, " ")
  .split(/\r?\n/)
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n");

/** The index just past the brace that closes the block opened at `from`. */
function blockEnd(src: string, from: number): number {
  const open = src.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

describe("the status carries energy", () => {
  it("AgentStatus DECLARES IT, nullable — not said yet is not zero", () => {
    assert.match(CODE, /energy\?: EnergyStatus \| null;/);
    // The doc comment is the contract for every client that reads it.
    assert.match(ROUTE, /REPORTED BY THE WORKER, never computed here/);
  });

  it("THE READ SITS OUTSIDE `if (workerAliveAt === null)`, so self-hosted gets it too", () => {
    const get = CODE.indexOf("export async function GET");
    assert.ok(get > 0, "the GET handler must exist");
    const branch = CODE.indexOf("if (workerAliveAt === null)", get);
    assert.ok(branch > get, "the heartbeat branch must still exist, or this test is guarding nothing");
    const end = blockEnd(CODE, branch);
    assert.ok(end > branch, "the branch must close");
    const read = CODE.indexOf("readAgentEnergy(grant.smartAccount)", get);
    assert.ok(read > 0, "GET must read the agent's energy for ITS OWN account");
    assert.ok(read > end, "and not inside the branch that only runs without a heartbeat file");
    assert.equal(
      [...CODE.matchAll(/readAgentEnergy\(/g)].length,
      1,
      "one read, in one place",
    );
  });

  it("AND IT REACHES THE RESPONSE", () => {
    const status = CODE.slice(CODE.indexOf("const status: AgentStatus = {"));
    assert.match(status.slice(0, status.indexOf("};")), /\benergy,/);
  });

  it("it is a column read, not a chain read or a guess", () => {
    // Nothing in the route may work energy out for itself: no balanceOf of
    // $MERRYMEN, no allowance arithmetic. The child's report is the answer.
    assert.ok(!/MERRYMEN_TOKEN/.test(CODE), "the route must not read $MERRYMEN balances itself");
    assert.ok(!/parseEnergyStatus/.test(CODE), "parsing lives in the one reader, lib/agent-energy.ts");
  });
});

/**
 * THE READER ASKS FOR THIS AGENT'S ENERGY AND NOTHING ELSE.
 *
 * The stub used to be `get: async () => row` — it discarded the SQL and the
 * bound account, so it would have passed a reader that read another column or
 * another tenant's row. Now the stub answers ONLY the one query shape, and only
 * for the account bound to it; and the ledger case runs the real schema with
 * two tenants on it, so reading one can never return the other's report.
 */
const ENERGY_READ = /^\s*SELECT\s+energy\s+FROM\s+agents\s+WHERE\s+smart_account\s*=\s*\?\s*$/i;
const report = (level: string, at: number) => ({
  v: 1, gated: true, mode: "enforce", level, agentTokens: null, holderTokens: null,
  needTokens: 100_000, day: "2026-09-27", resetsAt: 1_790_553_600, reviews: null, entries: { used: 0, allowed: 2 },
  spent: false, buy: "resign", estimateUsdg: null, at,
});

describe("what the route hands back from a stub ledger", () => {
  const ACCOUNT = "0x00000000000000000000000000000000000a11ce";
  type Asked = { sql: string; params: unknown[] }[];
  /**
   * A ledger holding `row` for ACCOUNT alone. It RECORDS what it was asked and
   * never asserts inside a call: readAgentEnergy wraps the read in try/catch
   * and turns any throw into null, so an assert.fail in here would be
   * swallowed and every test beside it would pass whatever the reader did.
   */
  const stub = (row: unknown, asked: Asked, calls = { list: 0, write: 0 }) => <T>(fn: (db: Db | null) => Promise<T>) =>
    fn({
      prepare: (sql: string) => ({
        get: async (...params: unknown[]) => {
          asked.push({ sql, params });
          return params[0] === ACCOUNT ? row : undefined;
        },
        all: async () => {
          calls.list++;
          return [];
        },
        run: async () => {
          calls.write++;
          return { changes: 0 };
        },
      }),
    } as unknown as Db);
  /** The one read, asked exactly once: the energy column of the agents row, bound to ACCOUNT as a parameter. */
  const askedOnce = (asked: Asked) => {
    assert.equal(asked.length, 1, "one read");
    assert.match(asked[0]!.sql, ENERGY_READ, "the one read: the energy column of the agents row");
    assert.deepEqual(asked[0]!.params, [ACCOUNT], "bound to the account asked about, as a parameter");
    assert.ok(!asked[0]!.sql.toLowerCase().includes(ACCOUNT), "the account is bound, never spliced into the SQL");
  };

  it("a report is returned as the worker wrote it — asked for by the bound account", async () => {
    const asked: Asked = [];
    const calls = { list: 0, write: 0 };
    const got = await readAgentEnergy(ACCOUNT, stub({ energy: JSON.stringify(report("unread", 1_790_500_000)) }, asked, calls));
    askedOnce(asked);
    assert.deepEqual(calls, { list: 0, write: 0 }, "no list read, and a reader never writes");
    assert.equal(got?.level, "unread");
    assert.equal(got?.agentTokens, null, "unread stays unread");
  });

  it("and nothing is null, never a default report — after the same one read", async () => {
    for (const row of [undefined, { energy: null }]) {
      const asked: Asked = [];
      assert.equal(await readAgentEnergy(ACCOUNT, stub(row, asked)), null);
      askedOnce(asked);
    }
  });

  it("no account asks nothing at all", async () => {
    for (const none of [null, undefined, ""]) {
      let calls = 0;
      const got = await readAgentEnergy(none, async () => {
        calls++;
        return undefined as never;
      });
      assert.equal(got, null);
      assert.equal(calls, 0, `no read without an account (${JSON.stringify(none)})`);
    }
  });
});

describe("what the route hands back from the real ledger, with two tenants on it", () => {
  const A = "0x00000000000000000000000000000000000000a1";
  const B = "0x00000000000000000000000000000000000000b2";
  const NONE = "0x00000000000000000000000000000000000000c3";
  let readDb: <T>(fn: (db: Db | null) => Promise<T>) => Promise<T>;

  before(async () => {
    const { wrapSqlite } = await import("../../../../../worker/src/db");
    const { applyLedgerSchema } = await import("../../../../../worker/src/store");
    const db = wrapSqlite(new DatabaseSync(":memory:"));
    await applyLedgerSchema(db);
    const add = db.prepare(
      `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode, epoch)
       VALUES (?, ?, '0x1', '0x2', 4663, '{}', 0, 0, 'live', 1)`,
    );
    await add.run(A, "Alder");
    await add.run(B, "Birch");
    // The worker's own write (store.ts setAgentEnergy), for each tenant.
    const write = db.prepare("UPDATE agents SET energy = ? WHERE smart_account = ?");
    await write.run(JSON.stringify(report("full", 1)), A);
    await write.run(JSON.stringify(report("low", 2)), B);
    readDb = (fn) => fn(db);
  });

  it("each tenant reads its own report, and only its own", async () => {
    assert.equal((await readAgentEnergy(A, readDb))?.level, "full");
    assert.equal((await readAgentEnergy(A, readDb))?.at, 1);
    assert.equal((await readAgentEnergy(B, readDb))?.level, "low");
    assert.equal((await readAgentEnergy(B, readDb))?.at, 2);
  });

  it("an account with no row is null, not somebody else's report", async () => {
    assert.equal(await readAgentEnergy(NONE, readDb), null);
  });
});
