/**
 * GET /api/grants?wallet=perps CARRIES THE PERPS WORKER'S REPORT (perps slice
 * 5b; docs/perps.md "Surfaces").
 *
 * `perps` is the worker's own report of the Perps wallet's book (core
 * PerpsReport, `agents.perps` on the Perps account's row), read through
 * lib/agent-perps.ts — read from the agents row OUTSIDE the heartbeat branch,
 * because self-hosted the heartbeat file always exists, and never with a key of
 * any kind in it: core's whitelist parser drops every field the v1 shape does
 * not name and refuses a malformed report whole. Not said, or not the v1
 * shape, is null — never an empty book.
 *
 * Paper only: the branch's stand-down, custody and kill-capability fields are
 * live, and are not in this build. The Spot answer carries no `perps` at all.
 *
 * Driven through the real route, self-hosted, against the worker's own ledger
 * schema in the Perps home ($MERRYMEN_HOME/accounts/perps/merrymen.db).
 * Adapted from the perps branch's perps-status.test.ts (112dbeb6), its three
 * report cases.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it, mock } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PerpsReport } from "@merrymen/core";

const saved = Object.fromEntries(["MERRYMEN_HOME", "MERRYMEN_HOSTED", "DATABASE_URL", "MERRYMEN_PERPS"].map((k) => [k, process.env[k]]));
const home = mkdtempSync(path.join(tmpdir(), "mm-grants-perps-status-"));
const PERPS_HOME = path.join(home, "accounts", "perps");
process.env.MERRYMEN_HOME = home;
delete process.env.MERRYMEN_HOSTED;
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_PERPS;

let GET: (req: Request) => Promise<Response>;

const SMART = "0x00000000000000000000000000000000000000a1";
const SPOT = "0x00000000000000000000000000000000000000b1";
const SESSION_KEY = generatePrivateKey();
const OWNER_KEY = generatePrivateKey();
const STRAY_80 = `0x${"9f".repeat(40)}`;

function grant(purpose: "spot" | "perps") {
  return {
    ...(purpose === "perps" ? { purpose } : {}),
    smartAccount: purpose === "perps" ? SMART : SPOT,
    owner: privateKeyToAccount(OWNER_KEY).address,
    sessionKeyAddress: privateKeyToAccount(SESSION_KEY).address,
    serialized: Buffer.from(JSON.stringify({ privateKey: SESSION_KEY })).toString("base64"),
    caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 14, maxDrawdownPct: 20, maxOpsPerDay: 100 },
    grantedAt: 1_790_000_000,
    expiresAt: 1_791_209_600,
    chainId: 4663,
    grantFeatures: purpose === "perps" ? [] : ["tradeable-v2"],
    demoSessionPrivateKey: SESSION_KEY,
    demoOwnerPrivateKey: OWNER_KEY,
  };
}

/** A paper book: one practice position, marked, with its stop. */
const REPORT: PerpsReport = {
  v: 1,
  mode: "paper",
  blocker: null,
  venueReadAt: null,
  protectAt: Date.now() - 5_000,
  accountIndex: null,
  positions: [
    {
      market: "BTC-PERP",
      side: "long",
      baseAmount: "0.00030",
      entryPrice: "83218.6",
      markPrice: "83220.1",
      leverage: 2,
      marginMicro: "12482790",
      liqPrice: "41931.3",
      unrealizedMicro: "-450000",
      stopTrigger: "79057.7",
      fundingMicro: "-12000",
    },
  ],
  openNotionalMicro: "24965580",
  collateralMicro: "100000000",
  inTransitMicro: null,
  minLiqDistanceBps: 4961,
  stopsMissing: 0,
  incident: false,
};

async function writeLedger(perps: string | null) {
  const { wrapSqlite } = await import("../../../../../worker/src/db");
  const { applyLedgerSchema } = await import("../../../../../worker/src/store");
  const file = path.join(PERPS_HOME, "merrymen.db");
  rmSync(file, { force: true });
  const raw = new DatabaseSync(file);
  try {
    const db = wrapSqlite(raw);
    await applyLedgerSchema(db);
    await db
      .prepare(
        `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode, epoch, perps)
         VALUES (?, 'Perps', '0x1', '0x2', 4663, '{}', 0, 0, 'paper', 2, ?)`,
      )
      .run(SMART, perps);
  } finally {
    raw.close();
  }
}

before(async () => {
  // Every chain read is refused: balances become null (unread).
  mock.method(globalThis, "fetch", async () => {
    throw new Error("no network in this test");
  });
  ({ GET } = await import("./route"));
  mkdirSync(PERPS_HOME, { recursive: true });
  writeFileSync(path.join(PERPS_HOME, "grant.json"), JSON.stringify(grant("perps")));
  writeFileSync(path.join(home, "grant.json"), JSON.stringify(grant("spot")));
  // The heartbeat file self-hosted always has — the case where a read inside
  // the no-heartbeat branch would never reach the owner.
  writeFileSync(path.join(PERPS_HOME, "heartbeat.json"), JSON.stringify({ at: Math.floor(Date.now() / 1000), mode: "paper" }));
});
after(() => {
  mock.restoreAll();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const perpsStatus = () => GET(new Request("http://localhost:3100/api/grants?wallet=perps"));

describe("GET /api/grants?wallet=perps carries the Perps worker's report", () => {
  it("THE REPORT REACHES THE ANSWER, beside a heartbeat file — and nothing secret with it", async () => {
    // Stray key-shaped fields inside the report JSON: the whitelist parser
    // must drop them, so no key can ride the report out.
    const withStray = { ...REPORT, apiPrivateKey: STRAY_80, positions: [{ ...REPORT.positions[0], apiKey: STRAY_80 }] };
    await writeLedger(JSON.stringify(withStray));
    const res = await perpsStatus();
    const text = await res.text();
    const body = JSON.parse(text) as { perps?: unknown; exists?: boolean; workerAliveAt?: unknown };
    assert.equal(body.exists, true);
    assert.ok(body.workerAliveAt, "the heartbeat file answered, and the report was read all the same");
    assert.deepEqual(body.perps, REPORT);
    for (const secret of [SESSION_KEY, OWNER_KEY, STRAY_80]) {
      const bare = secret.replace(/^0x/, "").toLowerCase();
      assert.ok(!text.toLowerCase().includes(bare), `leaked ${secret.slice(0, 10)}…`);
    }
    assert.equal(res.headers.get("cache-control"), "private, no-store");
  });

  it("NOT SAID IS NULL — never an empty book", async () => {
    await writeLedger(null);
    const body = (await (await perpsStatus()).json()) as { perps?: unknown };
    assert.equal(body.perps, null);
    // No ledger at all is not said too.
    rmSync(path.join(PERPS_HOME, "merrymen.db"), { force: true });
    assert.equal(((await (await perpsStatus()).json()) as { perps?: unknown }).perps, null);
  });

  it("A REPORT THAT IS NOT THE v1 SHAPE IS NULL too", async () => {
    await writeLedger(JSON.stringify({ ...REPORT, positions: [{ ...REPORT.positions[0], side: "sell" }] }));
    const body = (await (await perpsStatus()).json()) as { perps?: unknown };
    assert.equal(body.perps, null);
    await writeLedger("{not json");
    assert.equal(((await (await perpsStatus()).json()) as { perps?: unknown }).perps, null);
  });

  it("the Spot answer carries no perps report, and is the Spot wallet's", async () => {
    await writeLedger(JSON.stringify(REPORT));
    const body = (await (await GET(new Request("http://localhost:3100/api/grants"))).json()) as Record<string, unknown> & { grant: { smartAccount: string } };
    assert.equal("perps" in body, false);
    assert.equal(body.grant.smartAccount, SPOT);
  });
});
