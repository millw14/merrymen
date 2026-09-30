/**
 * THE CLI'S PERPS SURFACES — `merrymen kill`, `status`, and the rotation
 * journal `recover` writes (docs/perps.md rule 13, "Surfaces → CLI").
 *
 * The kill tests spawn the real cli/bin.mjs against a temporary
 * MERRYMEN_HOME, answer its prompt, and play the worker's part with the real
 * stand-down file protocol (standdown-files.ts): find the request, write
 * progress and a result. What must hold:
 *   - the request is written BEFORE grant.json is archived and deleted. The
 *     helper that writes it reads grant.json to decide and refuses without
 *     it, so a request on disk is proof the grant still existed; the output
 *     order proves the CLI asked first;
 *   - the custody text is built from the RESULT (custodySentence), never a
 *     fixed "your funds are safe";
 *   - with no worker running, the CLI says so and names recover, without a
 *     two-minute wait.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { GRANT_PERP_LIGHTER, LIGHTER_ROUTE_V1 } from "../../packages/core/src/index";
import {
  killCustodyText,
  markOwnerRotationSeen,
  perpsReportLines,
  readLedgerPerpsReport,
  readOwnerRotations,
  recordOwnerRotation,
  retiredKeysFor,
  retiredKeysOf,
  type OwnerRotation,
} from "./perps-local";
import type { StanddownResult } from "./perps/standdown";
import {
  STANDDOWN_REQUEST_PREFIX,
  readPendingStanddownRequests,
  writeStanddownProgress,
  writeStanddownResult,
} from "./perps/standdown-files";
import type { RecoverVenue } from "./recover";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BIN = path.join(ROOT, "cli", "bin.mjs");
const homes: string[] = [];
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});
function tempHome(): string {
  const h = mkdtempSync(path.join(os.tmpdir(), "merrymen-perps-cli-"));
  homes.push(h);
  return h;
}

const ACCOUNT = "0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487";
const PUBKEY = `0x${"0100000000000000".repeat(5)}`;

function residualResult(): StanddownResult {
  const now = Date.now();
  return {
    reason: "kill",
    startedAt: now - 5_000,
    finishedAt: now,
    deadlineMs: now + 60_000,
    outcome: "residual",
    closed: [{ market: "BTC-PERP", marketId: 1, side: "long", baseAmount: 20n, filledBase: 20n, attempts: 1, sizeDecimals: 5 }],
    residual: [{ market: "ETH-PERP", marketId: 0, side: "short", baseAmount: 1000n, stopResting: true, attempts: 3, sizeDecimals: 4 }],
    ordersLeft: 1,
    withdrawRequestedMicro: 5_000_000n,
    failedSteps: ["close ETH-PERP: the fill stayed outside the slippage bound"],
    ingested: true,
    venue: { readAt: now, final: true, collateralMicro: 1_000_000n, isolatedMarginMicro: 2_000_000n, poolShareCount: 0, spotBalanceCount: 0 },
  };
}

describe("the owner-rotation journal", () => {
  const entry = (over: Partial<OwnerRotation> = {}): OwnerRotation => ({
    smartAccount: ACCOUNT,
    accountIndex: 22149,
    apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex,
    ownerRotatedPubKey: `0x${"0200000000000000".repeat(5)}`,
    retiredPubKey: PUBKEY as `0x${string}`,
    userOpHash: `0x${"ab".repeat(32)}`,
    txHash: `0x${"cd".repeat(32)}`,
    at: 1_790_000_000_000,
    seenAtVenue: true,
    ...over,
  });

  it("appends, owner-only, public keys only", () => {
    const home = tempHome();
    assert.deepEqual(readOwnerRotations(home), [], "no journal is an empty journal");
    recordOwnerRotation(home, entry());
    recordOwnerRotation(home, entry({ ownerRotatedPubKey: `0x${"0300000000000000".repeat(5)}`, retiredPubKey: `0x${"0200000000000000".repeat(5)}` }));
    const r = readOwnerRotations(home)!;
    assert.equal(r.length, 2);
    assert.equal(r[1]!.retiredPubKey, `0x${"0200000000000000".repeat(5)}`);
    if (process.platform !== "win32") assert.equal(statSync(path.join(home, "perp-owner-rotations.json")).mode & 0o777, 0o600);
  });

  it("a journal that cannot be read is NOT empty, and is never overwritten", () => {
    const home = tempHome();
    writeFileSync(path.join(home, "perp-owner-rotations.json"), "{not json");
    assert.equal(readOwnerRotations(home), null);
    assert.throws(() => recordOwnerRotation(home, entry()), /refusing to overwrite/);
    assert.equal(readFileSync(path.join(home, "perp-owner-rotations.json"), "utf8"), "{not json");
  });

  it("EVERY RETIRED KEY IS RECORDED — the grant's sealed key even when the slot could not be read", () => {
    const home = tempHome();
    const THROWAWAY = `0x${"0300000000000000".repeat(5)}` as const;
    // The slot read failed: replacedPubKey null. The sealed key is still retired.
    recordOwnerRotation(home, entry({ ownerRotatedPubKey: THROWAWAY, retiredPubKey: null, retiredPubKeys: retiredKeysFor(null, PUBKEY), seenAtVenue: null }));
    const r = readOwnerRotations(home)!;
    assert.deepEqual(retiredKeysOf(r[0]!), [PUBKEY]);
    assert.deepEqual(retiredKeysFor(PUBKEY, PUBKEY), [PUBKEY], "one key, once");
    assert.deepEqual(retiredKeysFor(`0x${"0200000000000000".repeat(5)}`, PUBKEY), [`0x${"0200000000000000".repeat(5)}`, PUBKEY]);
    assert.deepEqual(retiredKeysFor("0xnot-a-key", null), []);
    // A journal from before the field reads its one retired key.
    assert.deepEqual(retiredKeysOf({ ...entry(), retiredPubKeys: undefined }), [PUBKEY]);
  });

  it("the entry is written first and only its seenAtVenue is filled in after the poll", () => {
    const home = tempHome();
    recordOwnerRotation(home, entry({ seenAtVenue: null }));
    recordOwnerRotation(home, entry({ userOpHash: `0x${"ef".repeat(32)}`, seenAtVenue: null }));
    markOwnerRotationSeen(home, `0x${"ab".repeat(32)}`, true);
    const r = readOwnerRotations(home)!;
    assert.deepEqual(r.map((x) => x.seenAtVenue), [true, null]);
    assert.equal(r[0]!.ownerRotatedPubKey, entry().ownerRotatedPubKey, "nothing else changes");
    assert.throws(() => markOwnerRotationSeen(home, `0x${"99".repeat(32)}`, true), /has no rotation/);
  });

  it("recover-cli journals the rotation BEFORE it polls the venue, with every retired key", () => {
    const src = readFileSync(path.join(ROOT, "worker", "src", "recover-cli.ts"), "utf8");
    const record = src.indexOf("recordOwnerRotation(home, {");
    const poll = src.indexOf("await readVenueKeySlot(res.accountIndex)");
    const mark = src.indexOf("markOwnerRotationSeen(home, res.userOpHash, seenAtVenue)");
    assert.ok(record > 0 && poll > record && mark > poll, "record → poll → mark seen");
    assert.match(src, /retiredPubKeys: retiredKeysFor\(res\.replacedPubKey, agentPerpPubKey\)/);
  });

  it("refuses an entry that is not a canonical public key", () => {
    const home = tempHome();
    assert.throws(() => recordOwnerRotation(home, entry({ ownerRotatedPubKey: `0x${"ff".repeat(40)}` })), /not a valid rotation/);
  });
});

describe("status: the worker's report, read, never invented", () => {
  it("paper is labelled paper, and a position with no stop is flagged", () => {
    const lines = perpsReportLines({
      state: "read",
      report: {
        v: 1,
        mode: "paper",
        blocker: null,
        venueReadAt: Date.now() - 5_000,
        protectAt: null,
        accountIndex: null,
        positions: [
          {
            market: "BTC-PERP",
            side: "long",
            baseAmount: "0.00020",
            entryPrice: "100000.0",
            markPrice: "101000.0",
            leverage: 2,
            marginMicro: "10000000",
            liqPrice: "52000.0",
            unrealizedMicro: "200000",
            stopTrigger: null,
            fundingMicro: null,
          },
        ],
        openNotionalMicro: "20000000",
        collateralMicro: "30000000",
        inTransitMicro: null,
        minLiqDistanceBps: 4800,
        stopsMissing: 1,
        incident: false,
      },
    });
    const text = lines.map((l) => l.text).join("\n");
    assert.match(text, /paper \(practice — no real money\)/);
    assert.match(text, /📜 BTC-PERP long/);
    assert.match(text, /NO STOP SEEN/);
    assert.ok(lines.some((l) => l.level === "warn" && /without a resting stop/.test(l.text)));
  });

  const unreadBase = {
    v: 1 as const,
    blocker: null,
    protectAt: null,
    positions: [],
    openNotionalMicro: null,
    collateralMicro: null,
    inTransitMicro: null,
    minLiqDistanceBps: null,
    incident: false,
  };

  it("A PAPER BOOK THAT COULD NOT BE READ is never 'no open paper positions' (lane.ts's catch branch)", () => {
    const text = perpsReportLines({ state: "read", report: { ...unreadBase, mode: "paper", venueReadAt: null, accountIndex: null, stopsMissing: 0 } })
      .map((l) => l.text)
      .join("\n");
    assert.doesNotMatch(text, /no open/);
    assert.match(text, /the practice book could not be read — unknown, not none/);
    assert.match(text, /collateral unread/);
  });

  it("A LIVE READ THAT FAILED keeps the last good venueReadAt — it is never called the current read, and never 'no positions'", () => {
    const text = perpsReportLines(
      { state: "read", report: { ...unreadBase, mode: "live", venueReadAt: 1_000, accountIndex: 22149, stopsMissing: 2 } },
      2_000,
    )
      .map((l) => l.text)
      .join("\n");
    assert.doesNotMatch(text, /no open positions/);
    assert.doesNotMatch(text, /venue read 1s ago/);
    assert.match(text, /Lighter could not be read at the last check \(last good read 1s ago\)/);
    assert.match(text, /Lighter could not be read — unknown, not none \(2 positions held at the last record, 0 listed below\)/);
    assert.match(text, /2 position\(s\) with no stop SEEN — Lighter could not be read/);
  });

  it("PRACTICE HELD WHILE PERPS ARE OFF is printed as paper — the account's book, not the rail; an unplaced book is never called real", () => {
    const held = {
      v: 1 as const,
      mode: "off" as const,
      blocker: "perps-off" as const,
      venueReadAt: Date.now(),
      protectAt: null,
      accountIndex: null,
      positions: [
        { market: "BTC-PERP" as const, side: "long" as const, baseAmount: "0.00010", entryPrice: "60000", markPrice: "60100", leverage: 2, marginMicro: "3000000", liqPrice: "30500", unrealizedMicro: "10000", stopTrigger: "57000", fundingMicro: "0" },
      ],
      openNotionalMicro: "6000000",
      collateralMicro: "6000000",
      inTransitMicro: "0",
      minLiqDistanceBps: 4900,
      stopsMissing: 0,
      incident: false,
    };
    const paper = perpsReportLines({ state: "read", report: held, accountMode: "paper" }).map((l) => l.text).join("\n");
    assert.match(paper, /📜 paper \(practice — no real money\) · perps off/);
    assert.match(paper, /📜 BTC-PERP long/);
    assert.doesNotMatch(paper, /real money on Lighter/);
    const unplaced = perpsReportLines({ state: "read", report: held, accountMode: null }).map((l) => l.text).join("\n");
    assert.match(unplaced, /whether what it lists is practice or real money is not stated/);
    assert.doesNotMatch(unplaced, /real money on Lighter/);
  });

  it("an unread or absent report is never 'no positions'", () => {
    for (const r of [{ state: "unread" as const, why: "the report does not parse" }, { state: "absent" as const }]) {
      const text = perpsReportLines(r).map((l) => l.text).join(" ");
      assert.doesNotMatch(text, /no open position/);
      assert.match(text, /not the same as nothing|unknown, not zero/);
    }
  });

  it("reads agents.perps from a real ledger, read-only; a bad report is unread", async () => {
    const home = tempHome();
    const db = path.join(home, "merrymen.db");
    const { DatabaseSync } = await import("node:sqlite");
    const w = new DatabaseSync(db);
    w.exec("CREATE TABLE agents (smart_account TEXT PRIMARY KEY, perps TEXT, mode TEXT)");
    w.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(ACCOUNT, JSON.stringify({ v: 1, mode: "live", positions: [], stopsMissing: 0, incident: false, venueReadAt: 1 }), "paper");
    w.prepare("INSERT INTO agents VALUES (?, ?, ?)").run("0x1111111111111111111111111111111111111111", "{broken", null);
    w.close();
    const good = await readLedgerPerpsReport(db, ACCOUNT.toUpperCase().replace("0X", "0x"));
    assert.equal(good.state, "read");
    assert.equal(good.state === "read" ? good.accountMode : undefined, "paper", "the account's own book rides with the report");
    const bad = await readLedgerPerpsReport(db, "0x1111111111111111111111111111111111111111");
    assert.equal(bad.state, "unread");
    const none = await readLedgerPerpsReport(db, "0x2222222222222222222222222222222222222222");
    assert.equal(none.state, "absent");
    assert.equal((await readLedgerPerpsReport(path.join(home, "nope.db"), ACCOUNT)).state, "unread");
  });
});

describe("kill: the custody text comes from the stand-down's result", () => {
  it("something left: named, stops still resting, recover pointed to — never 'funds stay in your smart account'", () => {
    const text = killCustodyText(residualResult(), null);
    assert.match(text, /Still on Lighter/);
    assert.match(text, /Closed: BTC-PERP long 0\.00020/);
    assert.match(text, /ETH-PERP short 0\.1000 \(its stop is still resting\)/);
    assert.match(text, /merrymen recover/);
    assert.match(text, /to be claimed is unknown/, "what the fresh read could not see is said");
    assert.doesNotMatch(text, /funds stay in your smart account/);
  });

  it("an unreachable stand-down says Lighter could not be read", () => {
    const r = { ...residualResult(), outcome: "unreachable" as const, venue: null, ordersLeft: null };
    assert.match(killCustodyText(r, { kind: "unreadable", why: "rpc down" } as RecoverVenue), /could not be read/);
  });
});

// ── the real CLI, end to end ────────────────────────────────────────────────

function perpGrant() {
  return {
    smartAccount: ACCOUNT,
    owner: "0x8e93bad5a60a266b4283855ceffa0979720aed72",
    chainId: LIGHTER_ROUTE_V1.chainId,
    demoOwnerPrivateKey: `0x${"31".repeat(32)}`,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    caps: { perTradeUsdg: 25, dailyUsdg: 100, maxOpsPerDay: 10, maxDrawdownPct: 20 },
    grantFeatures: [GRANT_PERP_LIGHTER],
    perp: { route: GRANT_PERP_LIGHTER, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PUBKEY },
  };
}

function setupHome(opts: { perps: boolean; workerAlive: boolean }): string {
  const home = tempHome();
  mkdirSync(path.join(home, "strategies"), { recursive: true });
  writeFileSync(path.join(home, ".welcomed"), "test");
  // An RPC that refuses at once: the post-result venue read must fail fast and be SAID, not hang or be zero.
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ rpcMainnet: "http://127.0.0.1:9", rpcTestnet: "http://127.0.0.1:9" }));
  const g = perpGrant();
  if (!opts.perps) {
    delete (g as Partial<typeof g>).perp;
    g.grantFeatures = [];
  }
  writeFileSync(path.join(home, "grant.json"), JSON.stringify(g));
  if (opts.workerAlive) writeFileSync(path.join(home, "heartbeat.json"), JSON.stringify({ at: Math.floor(Date.now() / 1000), block: 1 }));
  return home;
}

function runKill(home: string, onStart?: () => void): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "kill"], {
      cwd: ROOT,
      env: { ...process.env, MERRYMEN_HOME: home, NO_COLOR: "1", MERRYMEN_NO_ANIM: "1", MERRYMEN_RPC_MAINNET: "http://127.0.0.1:9" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    child.stdin.write("y\n");
    child.stdin.end();
    onStart?.();
    child.on("exit", (code) => resolve({ code, out }));
  });
}

const requestsIn = (home: string) => readdirSync(home).filter((f) => f.startsWith(STANDDOWN_REQUEST_PREFIX));

describe("merrymen kill with perps", { timeout: 150_000 }, () => {
  it("writes the stand-down request BEFORE the grant goes, waits, and prints the custody text from the result", async () => {
    const home = setupHome({ perps: true, workerAlive: true });
    let stop = false;
    let answered: string | null = null;
    // THE FAKE WORKER: the real file protocol, nothing mocked in the CLI.
    const worker = (async () => {
      const deadline = Date.now() + 60_000;
      while (!stop && Date.now() < deadline) {
        const pending = readPendingStanddownRequests(home);
        if (pending.length > 0) {
          const req = pending[0]!;
          assert.equal(req.reason, "kill");
          writeStanddownProgress(home, req.nonce, ["ok close BTC-PERP #1: filled 0.00020"]);
          await new Promise((r) => setTimeout(r, 700));
          writeStanddownResult(home, req.nonce, residualResult());
          answered = req.nonce;
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    const { code, out } = await runKill(home);
    stop = true;
    await worker;

    assert.equal(code, 0, out);
    assert.ok(answered, `the worker must have found a valid request:\n${out}`);
    assert.ok(requestsIn(home).length === 1, "the request is on disk");
    // ORDER. The request helper reads grant.json and refuses without it, so a
    // request on disk proves the grant still existed when it was written; the
    // output proves the CLI asked before it destroyed the grant.
    const asked = out.indexOf("stand-down requested");
    const destroyed = out.indexOf("grant destroyed");
    assert.ok(asked >= 0, out);
    assert.ok(destroyed > asked, "the stand-down is requested BEFORE the grant is archived and deleted");
    assert.equal(existsSync(path.join(home, "grant.json")), false, "the grant is gone");
    assert.ok(existsSync(path.join(home, "grants", `${ACCOUNT}.json`)), "and archived with its owner key");

    assert.match(out, /ok close BTC-PERP #1: filled 0\.00020/, "progress is printed as it comes");
    assert.match(out, /stand-down finished with something still on Lighter/);
    assert.match(out, /Still on Lighter/);
    assert.match(out, /its stop is still resting/);
    assert.match(out, /merrymen recover/);
    assert.doesNotMatch(out, /funds stay in your smart account/);
  });

  it("no worker running: the request is still written first, and the owner is sent to recover — no two-minute wait", async () => {
    const home = setupHome({ perps: true, workerAlive: false });
    const t0 = Date.now();
    const { code, out } = await runKill(home);
    assert.equal(code, 0, out);
    assert.ok(Date.now() - t0 < 60_000, "no waiting on a worker that is not there");
    assert.equal(requestsIn(home).length, 1, "every kill path leaves the request (rule 13)");
    assert.ok(out.indexOf("stand-down requested") < out.indexOf("grant destroyed"));
    assert.match(out, /no worker is running/);
    assert.match(out, /merrymen recover/);
    assert.equal(existsSync(path.join(home, "grant.json")), false);
  });

  it("THE HELPER CANNOT ASK (core refuses the perp block): the CLI writes the request itself, BEFORE the grant goes", async () => {
    const home = setupHome({ perps: true, workerAlive: false });
    const g = JSON.parse(readFileSync(path.join(home, "grant.json"), "utf8"));
    g.perp.apiPublicKey = "0x01"; // mentions perps; core's grantPerp refuses it, so the helper answers "no-perps"
    writeFileSync(path.join(home, "grant.json"), JSON.stringify(g));
    const { code, out } = await runKill(home);
    assert.equal(code, 0, out);
    assert.equal(requestsIn(home).length, 1, "the request is on disk, written by the CLI");
    assert.equal(readPendingStanddownRequests(home).length, 1, "and the worker's own strict reader accepts it");
    assert.match(out, /written by the CLI/);
    assert.ok(out.indexOf("stand-down requested") < out.indexOf("grant destroyed"));
    assert.equal(existsSync(path.join(home, "grant.json")), false);
  });

  it("NO REQUEST CAN BE WRITTEN: the kill STOPS with the grant kept, unless the owner types 'kill anyway'", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
    const home = setupHome({ perps: true, workerAlive: false });
    chmodSync(home, 0o555); // nothing can be created in the home: neither the helper nor the CLI can ask
    try {
      const { code, out } = await runKill(home);
      assert.equal(code, 1, out);
      assert.match(out, /could not ask the worker to stand the perps down/);
      assert.match(out, /Nothing has been stopped\. The grant is kept/);
      assert.match(out, /kill anyway/);
      assert.doesNotMatch(out, /grant destroyed/);
      assert.equal(existsSync(path.join(home, "grant.json")), true, "the agent keeps running, protecting what it holds");
    } finally {
      chmodSync(home, 0o755);
    }
  });

  it("a grant without perps: no request, the kill exactly as before", async () => {
    const home = setupHome({ perps: false, workerAlive: true });
    const { code, out } = await runKill(home);
    assert.equal(code, 0, out);
    assert.equal(requestsIn(home).length, 0);
    assert.doesNotMatch(out, /stand-down/);
    assert.match(out, /grant destroyed/);
  });
});

describe("the CLI's own stand-down request writer (cli/standdown-request.mjs)", () => {
  it("writes exactly what the worker's strict reader accepts, once per nonce, and nothing else", async () => {
    const { writeKillStanddownRequest } = (await import(path.join(ROOT, "cli", "standdown-request.mjs"))) as {
      writeKillStanddownRequest: (home: string, now?: number) => string;
    };
    const home = tempHome();
    const a = writeKillStanddownRequest(home, 1_790_000_000_000);
    const b = writeKillStanddownRequest(home, 1_790_000_000_001);
    assert.notEqual(a, b);
    const pending = readPendingStanddownRequests(home);
    assert.deepEqual(
      pending.map((r) => ({ nonce: r.nonce, reason: r.reason })).sort((x, y) => x.nonce.localeCompare(y.nonce)),
      [a, b].sort().map((nonce) => ({ nonce, reason: "kill" })),
    );
    assert.deepEqual(readdirSync(home).filter((f) => f.startsWith(".")), [], "no temporary file is left behind");
    if (process.platform !== "win32") {
      for (const f of requestsIn(home)) assert.equal(statSync(path.join(home, f)).mode & 0o777, 0o600);
    }
    assert.throws(() => writeKillStanddownRequest(path.join(home, "no-such-dir")), /ENOENT/);
  });
});
