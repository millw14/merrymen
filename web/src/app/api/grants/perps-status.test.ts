/**
 * /api/grants AND THE AGENT'S PERPS (docs/perps.md rules 5 and 13, "Surfaces").
 *
 *   GET carries `perps`, the worker's own report, beside energy — read from
 *   the agents row on the deployment where the heartbeat file always exists,
 *   and never with a key of any kind in it.
 *
 *   The SELF-HOSTED kill (DELETE) writes a stand-down request BEFORE it
 *   archives grant.json, so the worker still holds the key and the account
 *   when it reads the request; it waits for the result and answers with the
 *   custody sentence built from it. A request that cannot be written stops the
 *   kill with the grant kept. A grant with no perps asks nothing.
 *
 * Driven through the real route, self-hosted, against the worker's own ledger
 * schema in a temporary MERRYMEN_HOME. The "worker" is this test: it watches
 * the home for the request file, records whether grant.json was still there at
 * that moment, and writes the result through the worker's own writer.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PerpsReport } from "@merrymen/core";

const saved = Object.fromEntries(
  ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "DATABASE_URL", "MERRYMEN_PERPS", "MERRYMEN_PERPS_LIVE_TENANTS"].map((k) => [k, process.env[k]]),
);
const home = mkdtempSync(path.join(tmpdir(), "mm-grants-perps-"));
process.env.MERRYMEN_HOME = home;
delete process.env.MERRYMEN_HOSTED;
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_PERPS;
delete process.env.MERRYMEN_PERPS_LIVE_TENANTS;

let GET: (req: Request) => Promise<Response>;
let DELETE: (req: Request) => Promise<Response>;
let writeStanddownResult: typeof import("../../../../../worker/src/perps/standdown-files").writeStanddownResult;

const SMART = "0x00000000000000000000000000000000000000a1";
const SESSION_KEY = generatePrivateKey();
const OWNER_KEY = generatePrivateKey();
const API_PUB = `0x${("01" + "00".repeat(7)).repeat(5)}`;
const API_SEALED = `pk1.${"A".repeat(16)}.${"B".repeat(22)}.${"C".repeat(110)}`;
const STRAY_80 = `0x${"9f".repeat(40)}`;
const GRANT_FILE = path.join(home, "grant.json");

function grant(perps: boolean) {
  return {
    smartAccount: SMART,
    owner: privateKeyToAccount(OWNER_KEY).address,
    sessionKeyAddress: privateKeyToAccount(SESSION_KEY).address,
    serialized: Buffer.from(JSON.stringify({ privateKey: SESSION_KEY })).toString("base64"),
    caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 14, maxDrawdownPct: 20, maxOpsPerDay: 100 },
    grantedAt: 1_790_000_000,
    expiresAt: 1_791_209_600,
    chainId: 4663,
    grantFeatures: perps ? ["tradeable-v2", "perp-lighter-v1"] : ["tradeable-v2"],
    ...(perps ? { perp: { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: API_PUB, apiKeySealed: API_SEALED } } : {}),
    demoSessionPrivateKey: SESSION_KEY,
    demoOwnerPrivateKey: OWNER_KEY,
  };
}

const REPORT: PerpsReport = {
  v: 1,
  mode: "live",
  blocker: null,
  venueReadAt: Date.now() - 30_000,
  protectAt: Date.now() - 5_000,
  accountIndex: 22149,
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
  collateralMicro: "17517210",
  inTransitMicro: "0",
  minLiqDistanceBps: 4961,
  stopsMissing: 0,
  incident: false,
};

async function writeLedger(perps: string | null) {
  const { wrapSqlite } = await import("../../../../../worker/src/db");
  const { applyLedgerSchema } = await import("../../../../../worker/src/store");
  const file = path.join(home, "merrymen.db");
  rmSync(file, { force: true });
  const raw = new DatabaseSync(file);
  try {
    const db = wrapSqlite(raw);
    await applyLedgerSchema(db);
    await db
      .prepare(
        `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode, epoch, perps)
         VALUES (?, 'Shogun', '0x1', '0x2', 4663, '{}', 0, 0, 'live', 2, ?)`,
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
  ({ GET, DELETE } = await import("./route"));
  ({ writeStanddownResult } = await import("../../../../../worker/src/perps/standdown-files"));
  // The heartbeat file self-hosted always has — the case where a read inside
  // the no-heartbeat branch would never reach the owner.
  writeFileSync(path.join(home, "heartbeat.json"), JSON.stringify({ at: Math.floor(Date.now() / 1000), mode: "live" }));
});
after(() => {
  mock.restoreAll();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
beforeEach(() => {
  for (const f of readdirSync(home)) if (f.startsWith("standdown-")) rmSync(path.join(home, f), { force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("GET /api/grants carries the worker's perps report", () => {
  it("THE REPORT REACHES THE ANSWER, self-hosted, beside a heartbeat file — and nothing secret with it", async () => {
    // A stray key-shaped field inside the report JSON: the whitelist parser
    // must drop it, so no key can ride the report out.
    const withStray = { ...REPORT, apiPrivateKey: STRAY_80, positions: [{ ...REPORT.positions[0], apiKey: STRAY_80 }] };
    await writeLedger(JSON.stringify(withStray));
    writeFileSync(GRANT_FILE, JSON.stringify(grant(true)));
    const res = await GET(new Request("http://localhost:3100/api/grants"));
    const text = await res.text();
    const body = JSON.parse(text) as { perps?: unknown; exists?: boolean };
    assert.equal(body.exists, true);
    assert.deepEqual(body.perps, REPORT);
    for (const secret of [SESSION_KEY, OWNER_KEY, API_SEALED, STRAY_80]) {
      const bare = secret.replace(/^0x/, "");
      assert.ok(!text.includes(bare) && !text.toLowerCase().includes(bare.toLowerCase()), `leaked ${secret.slice(0, 10)}…`);
    }
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  });

  it("SAYS WHETHER THIS SERVER'S KILL STANDS PERPS DOWN — self-hosted it does", async () => {
    await writeLedger(JSON.stringify(REPORT));
    writeFileSync(GRANT_FILE, JSON.stringify(grant(true)));
    const body = (await (await GET(new Request("http://localhost:3100/api/grants"))).json()) as { perpsStanddownOnKill?: unknown };
    assert.equal(body.perpsStanddownOnKill, true);
  });

  it("NOT SAID IS NULL — never an empty book", async () => {
    await writeLedger(null);
    writeFileSync(GRANT_FILE, JSON.stringify(grant(true)));
    const body = (await (await GET(new Request("http://localhost:3100/api/grants"))).json()) as { perps?: unknown };
    assert.equal(body.perps, null);
  });

  it("A REPORT THAT IS NOT THE v1 SHAPE IS NULL too", async () => {
    await writeLedger(JSON.stringify({ ...REPORT, positions: [{ ...REPORT.positions[0], side: "sell" }] }));
    writeFileSync(GRANT_FILE, JSON.stringify(grant(true)));
    const body = (await (await GET(new Request("http://localhost:3100/api/grants"))).json()) as { perps?: unknown };
    assert.equal(body.perps, null);
  });
});

describe("the self-hosted kill stands the perps down FIRST", () => {
  it("WRITES THE REQUEST WHILE grant.json IS STILL THERE, waits for the result, then archives — and says where the money is", async () => {
    await writeLedger(JSON.stringify(REPORT));
    writeFileSync(GRANT_FILE, JSON.stringify(grant(true)));
    const killing = DELETE(new Request("http://localhost:3100/api/grants", { method: "DELETE" }));
    // The worker: find the request, note whether the grant was still armed.
    let grantAtRequest: boolean | null = null;
    let nonce: string | null = null;
    for (let i = 0; i < 400 && nonce === null; i++) {
      const req = readdirSync(home).find((f) => f.startsWith("standdown-request-") && f.endsWith(".json"));
      if (req) {
        grantAtRequest = existsSync(GRANT_FILE);
        nonce = req.slice("standdown-request-".length, -".json".length);
        break;
      }
      await sleep(10);
    }
    assert.ok(nonce, "a stand-down request was written");
    assert.equal(grantAtRequest, true, "the request is written BEFORE grant.json is archived");
    assert.ok(existsSync(GRANT_FILE), "and the grant stays while the worker has not answered");
    const t = Date.now();
    writeStanddownResult(home, nonce, {
      reason: "kill",
      startedAt: t - 2_000,
      finishedAt: t,
      deadlineMs: t + 60_000,
      outcome: "done",
      closed: [{ market: "BTC-PERP", marketId: 1, side: "long", baseAmount: 30n, filledBase: 30n, attempts: 1, sizeDecimals: 5 }],
      residual: [],
      ordersLeft: 0,
      withdrawRequestedMicro: 17_000_000n,
      failedSteps: [],
      ingested: true,
      venue: { readAt: t, final: true, collateralMicro: 17_000_000n, isolatedMarginMicro: 0n, poolShareCount: 0, spotBalanceCount: 0 },
    });
    const res = await killing;
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean; custody?: string; standdown?: { reported?: boolean; outcome?: string; nonce?: string } };
    assert.equal(body.ok, true);
    assert.equal(body.standdown?.reported, true);
    assert.equal(body.standdown?.outcome, "done");
    assert.equal(body.standdown?.nonce, nonce);
    assert.ok(!existsSync(GRANT_FILE), "archived after the answer");
    assert.ok(existsSync(path.join(home, "grants", `${SMART}.json`)), "and kept in the archive, owner key and all");
    // The sentence is built from the RESULT, and it never sends the money home.
    assert.match(body.custody ?? "", /Closed: BTC-PERP long/);
    assert.match(body.custody ?? "", /A withdrawal of 17\.00 USDG was requested/);
    assert.doesNotMatch(body.custody ?? "", /stay in your smart account/);
    assert.ok(!JSON.stringify(body).includes(API_SEALED.slice(4, 20)));
  });

  it("A GRANT WITHOUT PERPS ASKS NOTHING and keeps today's sentence", async () => {
    await writeLedger(null);
    writeFileSync(GRANT_FILE, JSON.stringify(grant(false)));
    const res = await DELETE(new Request("http://localhost:3100/api/grants", { method: "DELETE" }));
    const body = (await res.json()) as { ok?: boolean; custody?: string; standdown?: unknown };
    assert.equal(body.ok, true);
    assert.equal(body.standdown, null);
    assert.equal(readdirSync(home).filter((f) => f.startsWith("standdown-request-")).length, 0);
    assert.match(body.custody ?? "", /Nothing is held on Lighter/);
    assert.ok(!existsSync(GRANT_FILE));
  });
});

describe("the kill controls say what THIS server's kill does, and read its answer before changing anything", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const ROUTE = strip(readFileSync(new URL("./route.ts", import.meta.url), "utf8"));

  it("HOSTED: the GET reports durable shutdown capability and DELETE only claims it is queued", () => {
    assert.match(ROUTE, /perpsStanddownOnKill: !isHostedMode\(\) \|\| hostedStanddownAvailable\(\)/);
    const del = ROUTE.slice(ROUTE.indexOf("export async function DELETE"));
    const hosted = del.slice(0, del.indexOf("let stored"));
    assert.match(hosted, /isHostedMode\(\)/);
    assert.doesNotMatch(hosted, /standDownForKill/);
    assert.match(ROUTE, /Closing and withdrawal are not confirmed/);
  });

  it("WALLET'S DISCARD sends the kill and reads it BEFORE clearing this browser's grant, and stops on a refusal", () => {
    const wallet = strip(readFileSync(new URL("../../../terminal/screens/Wallet.tsx", import.meta.url), "utf8"));
    const body = wallet.slice(wallet.indexOf("async function discard()"));
    const send = body.indexOf("await sendKill()");
    const refused = body.indexOf('answer.kind === "refused"');
    const clear = body.indexOf("clearGrant()");
    assert.ok(send > 0 && refused > send && clear > refused, "send → refused? stop → only then clear");
    assert.match(body.slice(refused, clear), /setError\(answer\.error\);\s*return;/);
    assert.doesNotMatch(body, /void fetch\("\/api\/grants", \{ method: "DELETE" \}\)/);
  });

});
