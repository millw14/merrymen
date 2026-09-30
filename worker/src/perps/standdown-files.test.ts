/**
 * THE STAND-DOWN FILE PROTOCOL. A request and its result round-trip exactly;
 * nothing half-written is ever readable (proved with a reader on another
 * thread racing the writer); a file this writer could not have made is
 * ignored, not half-believed; a nonce is used once and never becomes a path
 * outside the home; and no key-shaped string survives the trip either way.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Worker } from "node:worker_threads";

import type { StanddownResult } from "./standdown";
import {
  STANDDOWN_REQUEST_PREFIX,
  clearStanddownFiles,
  isStanddownNonce,
  newStanddownNonce,
  parseStanddownResult,
  readPendingStanddownRequests,
  readStanddownProgress,
  readStanddownResult,
  redactKeyMaterial,
  serializeStanddownResult,
  standdownRequestFile,
  standdownResultFile,
  waitForStanddownResult,
  writeStanddownProgress,
  writeStanddownRequest,
  writeStanddownResult,
} from "./standdown-files";

const ROOT = mkdtempSync(path.join(os.tmpdir(), "merrymen-standdown-files-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let homes = 0;
function home(): string {
  const h = path.join(ROOT, `home-${++homes}`);
  mkdirSync(h);
  return h;
}

const T = 1_800_000_000_000;
const u = (usdg: number) => BigInt(Math.round(usdg * 1e6));

function result(o: Partial<StanddownResult> = {}): StanddownResult {
  return {
    reason: "kill",
    startedAt: T,
    finishedAt: T + 21_500,
    deadlineMs: T + 110_000,
    outcome: "residual",
    closed: [
      { market: "ETH-PERP", marketId: 0, side: "short", baseAmount: 100n, filledBase: 100n, realizedMicro: u(-1.25), attempts: 1, sizeDecimals: 4 },
      { market: "SOL-PERP", marketId: 3, side: "long", baseAmount: 500n, filledBase: null, attempts: 2, sizeDecimals: null },
    ],
    residual: [{ market: "BTC-PERP", marketId: 1, side: "long", baseAmount: 30n, stopResting: true, attempts: 3, sizeDecimals: 5 }],
    ordersLeft: 1,
    withdrawRequestedMicro: u(20),
    failedSteps: ["BTC-PERP: still open after 3 close attempts within 150 bps of mark; its stop stays resting."],
    ingested: true,
    venue: { readAt: T + 21_400, final: true, collateralMicro: u(20), isolatedMarginMicro: u(5), poolShareCount: 0, spotBalanceCount: 0 },
    ...o,
  };
}

const KEY80 = "ab".repeat(40);
const KEY64 = "cd".repeat(32);

// ── round trip ──────────────────────────────────────────────────────────────

describe("stand-down files: the round trip", () => {
  it("a request is pending until its result is written, and the result reads back exactly", () => {
    const h = home();
    const nonce = newStanddownNonce();
    assert.ok(isStanddownNonce(nonce));
    writeStanddownRequest(h, { reason: "kill", requestedAt: T, nonce });
    assert.deepEqual(readPendingStanddownRequests(h), [{ reason: "kill", requestedAt: T, nonce }]);
    assert.equal(readStanddownResult(h, nonce), null);

    const r = result();
    writeStanddownResult(h, nonce, r);
    assert.deepEqual(readPendingStanddownRequests(h), [], "the result is the claim");
    assert.deepEqual(readStanddownResult(h, nonce), r);
  });

  it("round-trips an unreachable result: no venue, orders unknown, nothing closed", () => {
    const h = home();
    const nonce = newStanddownNonce();
    const r = result({ outcome: "unreachable", closed: [], residual: [], ordersLeft: null, withdrawRequestedMicro: null, ingested: false, venue: null });
    writeStanddownResult(h, nonce, r);
    assert.deepEqual(readStanddownResult(h, nonce), r);
  });

  it("lists pending requests oldest first, and only those without a result", () => {
    const h = home();
    const [a, b, c] = ["req-aaaaaaaa", "req-bbbbbbbb", "req-cccccccc"];
    writeStanddownRequest(h, { reason: "expiry", requestedAt: T + 2, nonce: a });
    writeStanddownRequest(h, { reason: "kill", requestedAt: T + 1, nonce: b });
    writeStanddownRequest(h, { reason: "incident", requestedAt: T + 3, nonce: c });
    writeStanddownResult(h, c, result());
    assert.deepEqual(
      readPendingStanddownRequests(h).map((r) => [r.nonce, r.reason]),
      [
        [b, "kill"],
        [a, "expiry"],
      ],
    );
  });

  it("clears a finished stand-down's files, request first, and a home without them is quiet", () => {
    const h = home();
    const nonce = newStanddownNonce();
    writeStanddownRequest(h, { reason: "kill", requestedAt: T, nonce });
    writeStanddownProgress(h, nonce, ["ok begin: kill"]);
    writeStanddownResult(h, nonce, result());
    clearStanddownFiles(h, nonce);
    assert.deepEqual(readdirSync(h), []);
    clearStanddownFiles(h, nonce); // already gone: not an error
    assert.deepEqual(readPendingStanddownRequests(path.join(h, "missing")), []);
  });
});

// ── atomicity ───────────────────────────────────────────────────────────────

describe("stand-down files: nothing half-written is ever read", () => {
  it("leaves no temporary file behind, writes 0600, and never reuses a nonce", () => {
    const h = home();
    const nonce = newStanddownNonce();
    writeStanddownRequest(h, { reason: "kill", requestedAt: T, nonce });
    writeStanddownResult(h, nonce, result());
    writeStanddownProgress(h, nonce, ["one"]);
    const names = readdirSync(h).sort();
    assert.equal(names.length, 3);
    assert.ok(names.every((n) => !n.startsWith(".") && n.endsWith(".json")));
    for (const n of names) assert.equal(statSync(path.join(h, n)).mode & 0o777, 0o600, n);

    const before = readFileSync(standdownRequestFile(h, nonce), "utf8");
    assert.throws(() => writeStanddownRequest(h, { reason: "flatten", requestedAt: T + 1, nonce }), /used once/);
    assert.equal(readFileSync(standdownRequestFile(h, nonce), "utf8"), before, "the first request is untouched");
    assert.equal(readdirSync(h).length, 3, "and the refused write left nothing behind");
  });

  it("ignores a writer's leftover temporary file and a half-written file under the real name", () => {
    const h = home();
    const nonce = "half-written-1";
    const whole = serializeStanddownResult(nonce, result());
    // What a crash mid-write leaves: the temporary name, which no reader lists…
    writeFileSync(path.join(h, `.${STANDDOWN_REQUEST_PREFIX}${nonce}.json.1234.tmp`), '{"v":1,"kind":"standdown-request"');
    // …and what a NON-atomic writer would leave under the real name.
    writeFileSync(standdownResultFile(h, nonce), whole.slice(0, Math.floor(whole.length / 2)));
    assert.deepEqual(readPendingStanddownRequests(h), []);
    assert.equal(readStanddownResult(h, nonce), null);
  });

  it("a reader racing the writer on another thread only ever sees whole results", async () => {
    const h = home();
    const nonce = "race-nonce-1";
    const file = standdownResultFile(h, nonce);
    // Large enough that a non-atomic write would be caught half-way.
    const big = result({ failedSteps: Array.from({ length: 120 }, (_, i) => `step ${i}: ${"x".repeat(500)}`) });
    writeStanddownResult(h, nonce, big);
    const reader = new Worker(
      `
      const { workerData, parentPort } = require("node:worker_threads");
      const fs = require("node:fs");
      let whole = 0, torn = 0;
      parentPort.postMessage("ready");
      const end = Date.now() + workerData.ms;
      while (Date.now() < end) {
        let t;
        try { t = fs.readFileSync(workerData.file, "utf8"); } catch { continue; }
        try { JSON.parse(t); whole++; } catch { torn++; }
      }
      parentPort.postMessage({ whole, torn });
      `,
      { eval: true, workerData: { file, ms: 400 } },
    );
    const done = new Promise<{ whole: number; torn: number }>((resolve, reject) => {
      reader.on("message", (m) => {
        if (m !== "ready") resolve(m as { whole: number; torn: number });
      });
      reader.on("error", reject);
    });
    await new Promise<void>((resolve) => reader.once("message", () => resolve()));
    const end = Date.now() + 300;
    let writes = 0;
    while (Date.now() < end) {
      writeStanddownResult(h, nonce, { ...big, ordersLeft: writes++ });
    }
    const seen = await done;
    await reader.terminate();
    assert.ok(writes > 5, `wrote ${writes} times`);
    assert.ok(seen.whole > 0, "the reader read");
    assert.equal(seen.torn, 0, `a reader saw ${seen.torn} torn result(s)`);
    assert.ok(readdirSync(h).every((n) => !n.endsWith(".tmp")), "no temporary file survives");
  });
});

// ── garbage ─────────────────────────────────────────────────────────────────

describe("stand-down files: garbage is ignored, never half-believed", () => {
  it("skips requests that are not whole, valid and named for their own nonce", () => {
    const h = home();
    const good = "good-request";
    writeStanddownRequest(h, { reason: "kill", requestedAt: T, nonce: good });
    const put = (nonce: string, body: string) => writeFileSync(path.join(h, `${STANDDOWN_REQUEST_PREFIX}${nonce}.json`), body);
    put("not-json-1", "{not json");
    put("bad-reason", JSON.stringify({ v: 1, kind: "standdown-request", nonce: "bad-reason", reason: "pause", requestedAt: T }));
    put("wrong-nonce", JSON.stringify({ v: 1, kind: "standdown-request", nonce: "another-one", reason: "kill", requestedAt: T }));
    put("extra-field", JSON.stringify({ v: 1, kind: "standdown-request", nonce: "extra-field", reason: "kill", requestedAt: T, key: KEY80 }));
    put("old-version", JSON.stringify({ v: 2, kind: "standdown-request", nonce: "old-version", reason: "kill", requestedAt: T }));
    put("float-time", JSON.stringify({ v: 1, kind: "standdown-request", nonce: "float-time", reason: "kill", requestedAt: 1.5 }));
    put("a.b", JSON.stringify({ v: 1, kind: "standdown-request", nonce: "a.b", reason: "kill", requestedAt: T }));
    put("results-kind", serializeStanddownResult("results-kind", result()));
    mkdirSync(path.join(h, `${STANDDOWN_REQUEST_PREFIX}a-directory.json`));
    // A symlink under a request's name, pointing at a valid request elsewhere.
    const elsewhere = home();
    writeStanddownRequest(elsewhere, { reason: "kill", requestedAt: T, nonce: "linked-one" });
    symlinkSync(standdownRequestFile(elsewhere, "linked-one"), path.join(h, `${STANDDOWN_REQUEST_PREFIX}linked-one.json`));
    const ignored: string[] = [];
    const pending = readPendingStanddownRequests(h, {
      onIgnored: (f) => {
        ignored.push(f);
        throw new Error("a logger that throws must not hide the rest");
      },
    });
    assert.deepEqual(pending, [{ reason: "kill", requestedAt: T, nonce: good }]);
    assert.equal(ignored.length, 10);
  });

  it("refuses a result that is not whole, strict and consistent", () => {
    const nonce = "strict-result";
    const whole = JSON.parse(serializeStanddownResult(nonce, result())) as { result: Record<string, unknown> } & Record<string, unknown>;
    assert.ok(parseStanddownResult(whole, nonce) !== null);
    const bad = (mut: (r: Record<string, unknown>) => void) => {
      const c = JSON.parse(JSON.stringify(whole)) as { result: Record<string, unknown> };
      mut(c.result);
      return parseStanddownResult(c, nonce);
    };
    assert.equal(parseStanddownResult(whole, "another-nonce"), null);
    assert.equal(bad((r) => (r.outcome = "fine")), null);
    assert.equal(bad((r) => (r.venue = null)), null, "a residual outcome with no final read behind it");
    assert.equal(bad((r) => ((r.venue as Record<string, unknown>).final = false)), null);
    assert.equal(bad((r) => (r.ordersLeft = null)), null);
    assert.equal(bad((r) => (r.ordersLeft = -1)), null);
    assert.equal(bad((r) => (r.withdrawRequestedMicro = 20)), null, "money is a decimal string, never a float");
    assert.equal(bad((r) => (r.withdrawRequestedMicro = "0")), null);
    assert.equal(bad((r) => (r.finishedAt = T - 1)), null);
    assert.equal(bad((r) => (r.extra = true)), null);
    assert.equal(bad((r) => ((r.closed as Record<string, unknown>[])[0]!.market = "DOGE-PERP-X")), null);
    assert.equal(bad((r) => ((r.closed as Record<string, unknown>[])[0]!.marketId = 1)), null, "a key paired with another market's id");
    assert.equal(bad((r) => ((r.residual as Record<string, unknown>[])[0]!.market = "../../etc")), null);
    assert.equal(bad((r) => ((r.residual as Record<string, unknown>[])[0]!.stopResting = "yes")), null);
    assert.equal(bad((r) => ((r.residual as Record<string, unknown>[])[0]!.baseAmount = "0")), null);
    assert.equal(bad((r) => (r.failedSteps = ["x".repeat(601)])), null);

    const h = home();
    writeFileSync(standdownResultFile(h, nonce), "garbage");
    writeStanddownRequest(h, { reason: "kill", requestedAt: T, nonce });
    assert.equal(readStanddownResult(h, nonce), null);
    assert.deepEqual(readPendingStanddownRequests(h), [], "a mangled result still ends the request: no stand-down loop");
  });

  it("never turns a nonce into a path outside the home", () => {
    const h = home();
    for (const nonce of ["../escape-1", "a/b/c/d/e", ".hidden-nonce", "-leading-dash", "short", "x".repeat(65), "has space 12"]) {
      assert.equal(isStanddownNonce(nonce), false, nonce);
      assert.throws(() => writeStanddownRequest(h, { reason: "kill", requestedAt: T, nonce }), TypeError, nonce);
      assert.throws(() => standdownResultFile(h, nonce), TypeError, nonce);
    }
    assert.throws(() => writeStanddownRequest(h, { reason: "pause" as never, requestedAt: T, nonce: "fine-nonce" }), TypeError);
    assert.throws(() => writeStanddownRequest(h, { reason: "kill", requestedAt: 0, nonce: "fine-nonce" }), TypeError);
    assert.deepEqual(readdirSync(h), []);
    assert.deepEqual(readdirSync(ROOT).filter((n) => !n.startsWith("home-")), [], "nothing escaped the home");
  });

  it("will not create a home that is not there", () => {
    assert.throws(() => writeStanddownRequest(path.join(ROOT, "no-such-home"), { reason: "kill", requestedAt: T, nonce: "fine-nonce" }));
  });
});

// ── key material ────────────────────────────────────────────────────────────

describe("stand-down files: no key material", () => {
  it("redacts every key-shaped string on the way out and on the way back in", () => {
    const h = home();
    const nonce = "keys-nonce-1";
    const r = result({
      failedSteps: [`signer said 0x${KEY80} was wrong`, `bare ${KEY80.toUpperCase()} too`, `session 0x${KEY64}`],
      residual: [{ market: `M${KEY80}`, marketId: 99, side: "short", baseAmount: 5n, stopResting: false, attempts: 0, sizeDecimals: null }],
    });
    writeStanddownResult(h, nonce, r);
    writeStanddownProgress(h, nonce, [`!! close BTC-PERP #1: tx_info carried ${KEY80}`]);
    for (const n of readdirSync(h)) {
      const body = readFileSync(path.join(h, n), "utf8");
      assert.doesNotMatch(body, /[0-9a-fA-F]{64}/, n);
    }
    const back = readStanddownResult(h, nonce);
    assert.deepEqual(back?.failedSteps, ["signer said [redacted] was wrong", "bare [redacted] too", "session [redacted]"]);
    assert.equal(back?.residual[0]?.market, "M?redacted?");
    assert.deepEqual(readStanddownProgress(h, nonce)?.lines, ["!! close BTC-PERP #1: tx_info carried [redacted]"]);

    // A hand-planted file carrying a key is redacted on read, too.
    const planted = JSON.parse(serializeStanddownResult(nonce, result())) as { result: { failedSteps: string[] } };
    planted.result.failedSteps = [`leak ${KEY80}`];
    assert.deepEqual(parseStanddownResult(planted, nonce)?.failedSteps, ["leak [redacted]"]);
    assert.equal(redactKeyMaterial(`a\nb\u0000c 0x${KEY64}`), "a b c [redacted]");
    // A request has no field that could carry one.
    writeStanddownRequest(h, { reason: "kill", requestedAt: T, nonce: "keys-nonce-2" });
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(standdownRequestFile(h, "keys-nonce-2"), "utf8")) as object).sort(), ["kind", "nonce", "reason", "requestedAt", "v"]);
  });
});

// ── the CLI's wait ──────────────────────────────────────────────────────────

describe("stand-down files: waiting for the result", () => {
  it("reports each progress line once, in order, and returns the result when it lands", async () => {
    const h = home();
    const nonce = newStanddownNonce();
    let t = 0;
    let polls = 0;
    const lines: string[] = [];
    const all = Array.from({ length: 205 }, (_, i) => `line ${i}`);
    const r = await waitForStanddownResult(h, nonce, 120_000, (p) => lines.push(...p.lines), {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        polls += 1;
        if (polls === 1) writeStanddownProgress(h, nonce, all.slice(0, 3));
        if (polls === 2) writeStanddownProgress(h, nonce, all.slice(0, 3)); // no news
        if (polls === 3) writeStanddownProgress(h, nonce, all); // the oldest are cut from the file
        if (polls === 4) writeStanddownResult(h, nonce, result());
      },
    });
    assert.deepEqual(r, result());
    // Lines 3 and 4 were cut before the reader saw them: skipped, never repeated or invented.
    assert.deepEqual(lines, [...all.slice(0, 3), ...all.slice(5)]);
  });

  it("gives up at its timeout with null — never a result it did not read", async () => {
    const h = home();
    let t = 0;
    let calls = 0;
    const r = await waitForStanddownResult(h, "never-comes", 2_000, () => calls++, {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      pollMs: 500,
    });
    assert.equal(r, null);
    assert.equal(t, 2_000);
    assert.equal(calls, 5);
  });

  it("works on the real clock", async () => {
    const h = home();
    const nonce = newStanddownNonce();
    setTimeout(() => writeStanddownResult(h, nonce, result()), 40);
    const r = await waitForStanddownResult(h, nonce, 5_000, undefined, { pollMs: 10 });
    assert.deepEqual(r, result());
  });
});
