/**
 * THE OPS HEARTBEAT ROUTE, DRIVEN THROUGH ITS REAL HANDLER.
 *
 * A real Request into the exported GET, reading a real ledger file under a
 * temporary home through the dashboard's own read driver (self-hosted
 * sqlite, read-only). The row is written by the worker's own writer, with a
 * snapshot that carries an account and free rule text, so "aggregates only"
 * is tested against something that could have leaked.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";

import { wrapSqlite } from "../../../../../../worker/src/db";
import { foldFunnel } from "../../../../../../worker/src/autonomy-funnel";
import { heartbeatCounts, writeFleetHeartbeat } from "../../../../../../worker/src/fleet-heartbeat";
import { GET } from "./route";

const TOKEN = "ops-token-0123456789abcdef0123456789abcdef";
const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const ADDRESS = /0x[0-9a-f]{40}/i;
const ROUTE = "https://app.merrymen.dev/api/ops/heartbeat";

const saved = Object.fromEntries(["MERRYMEN_HOME", "MERRYMEN_OPS_TOKEN", "DATABASE_URL"].map((k) => [k, process.env[k]]));
let home: string;

const get = (authorization?: string) =>
  GET(new Request(ROUTE, { headers: authorization ? { authorization } : {} }));

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-ops-heartbeat-"));
  process.env.MERRYMEN_HOME = home;
  delete process.env.DATABASE_URL;
  const raw = new DatabaseSync(path.join(home, "merrymen.db"));
  try {
    const funnel = foldFunnel(
      [
        { agent_id: ACCOUNT, status: "rejected", rule: `couldn't submit: ${ACCOUNT} reverted`, n: 3 },
        { agent_id: ACCOUNT, status: "landed", rule: "", n: 2 },
        { agent_id: ACCOUNT, status: "rejected", rule: "rollout-hold", n: 9 },
      ],
      () => "live",
    );
    const counts = heartbeatCounts(
      {
        at: 1_800_000_000,
        byStatus: { armed: 3, [ACCOUNT]: 1 },
        total: 4,
        broken: 0,
        rails: { counts: { live: 1, "no worker here": 3 }, live: 1 },
        funnel,
        holds: [{ kind: "QUIET_REVIEW", n: 4 }],
        funnel6h: funnel,
      },
      { children: 1, holders: 0 },
    );
    await writeFleetHeartbeat(
      wrapSqlite(raw),
      {
        role: "orchestrator",
        commit: "0123456789abcdef0123456789abcdef01234567",
        startedAt: Math.floor(Date.now() / 1000) - 120,
        beatAt: Math.floor(Date.now() / 1000) - 30,
        halted: true,
        rollout: { scope: "none", levels: { trade: 0, "exits-only": 0, observe: 0, held: 4, absent: 0 } },
        counts,
        lastShutdown: { clean: true, finishedAt: 1_799_999_000 },
      },
      { create: true },
    );
  } finally {
    raw.close();
  }
});

beforeEach(() => {
  delete process.env.MERRYMEN_OPS_TOKEN;
  process.env.MERRYMEN_HOME = home;
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("GET /api/ops/heartbeat", () => {
  it("is a bare 404 while no token is set, even to a caller presenting one", async () => {
    for (const res of [await get(), await get(`Bearer ${TOKEN}`)]) {
      assert.equal(res.status, 404);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(await res.text(), "");
    }
  });

  it("treats a short token as unset: a guessable token is worse than none", async () => {
    process.env.MERRYMEN_OPS_TOKEN = "short-token";
    assert.equal((await get("Bearer short-token")).status, 404);
  });

  it("is 401 without the bearer token, or with the wrong one", async () => {
    process.env.MERRYMEN_OPS_TOKEN = TOKEN;
    for (const auth of [undefined, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, TOKEN, `Basic ${TOKEN}`]) {
      const res = await get(auth);
      assert.equal(res.status, 401, String(auth));
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.doesNotMatch(await res.text(), /orchestrator|armed/);
    }
  });

  it("is 200 with the token: the beat, its age and the counts, aggregates only and never cached", async () => {
    process.env.MERRYMEN_OPS_TOKEN = TOKEN;
    const res = await get(`Bearer ${TOKEN}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const text = await res.text();
    assert.doesNotMatch(text, ADDRESS, "no account, as a key or inside a rule's text");
    assert.doesNotMatch(text, /couldn't submit/);
    const body = JSON.parse(text) as { now: number; heartbeats: Record<string, any>[] };
    assert.equal(body.heartbeats.length, 1);
    const h = body.heartbeats[0]!;
    assert.equal(h.role, "orchestrator");
    assert.equal(h.commit, "0123456789abcdef0123456789abcdef01234567");
    assert.equal(h.halted, true);
    assert.ok(h.beatAgeSec >= 30 && h.beatAgeSec < 120, String(h.beatAgeSec));
    assert.deepEqual(h.rollout, { scope: "none", levels: { trade: 0, "exits-only": 0, observe: 0, held: 4, absent: 0 } });
    assert.deepEqual(h.lastShutdown, { clean: true, finishedAt: 1_799_999_000 });
    assert.deepEqual(h.counts.byStatus, { armed: 3 });
    assert.equal(h.counts.funnel1h.live.landed, 2);
    assert.equal(h.counts.funnel1h.live.proposals, 5, "the rollout's refusals are not proposals");
    assert.equal(h.counts.funnel1h.admissionHeld, 9);
    assert.deepEqual(h.counts.holds1h, { QUIET_REVIEW: 4 });
  });

  it("no ledger yet is no heartbeat yet: an empty list, not an error and not a healthy fleet", async () => {
    process.env.MERRYMEN_OPS_TOKEN = TOKEN;
    const empty = mkdtempSync(path.join(tmpdir(), "mm-ops-heartbeat-empty-"));
    try {
      process.env.MERRYMEN_HOME = empty;
      const res = await get(`Bearer ${TOKEN}`);
      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()).heartbeats, []);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
