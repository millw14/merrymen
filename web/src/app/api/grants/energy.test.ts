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
 * run against a stub ledger.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
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

describe("what the route hands back from a stub ledger", () => {
  const stub = (row: unknown) => <T>(fn: (db: Db | null) => Promise<T>) =>
    fn({ prepare: () => ({ get: async () => row, all: async () => [], run: async () => ({ changes: 0 }) }) } as unknown as Db);

  it("a report is returned as the worker wrote it", async () => {
    const report = {
      v: 1, gated: true, mode: "enforce", level: "unread", agentTokens: null, holderTokens: null,
      needTokens: 100_000, day: "2026-09-27", resetsAt: 1_790_553_600, reviews: null, entries: { used: 0, allowed: 2 },
      spent: false, buy: "resign", estimateUsdg: null, at: 1_790_500_000,
    };
    const got = await readAgentEnergy("0xabc", stub({ energy: JSON.stringify(report) }));
    assert.equal(got?.level, "unread");
    assert.equal(got?.agentTokens, null, "unread stays unread");
  });

  it("and nothing is null, never a default report", async () => {
    assert.equal(await readAgentEnergy("0xabc", stub(undefined)), null);
    assert.equal(await readAgentEnergy("0xabc", stub({ energy: null })), null);
  });
});
