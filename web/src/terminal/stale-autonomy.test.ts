/**
 * NOT RUNNING, SAID TRUTHFULLY — AND WITHOUT COSTING ANYTHING ELSE ITS PLACE.
 *
 * An agent whose worker had stopped wore the chip it stopped with — LIVE or
 * PAPER — because `mode` is the last thing a worker said and a stopped worker
 * goes on saying it. This pins the three halves of saying so instead:
 *
 *   - the server decides "stopped" by its own clock and the watchdog's rule,
 *     never the browser's clock and never a second rule (worker-stale.ts);
 *   - the route carries that answer and the page reads it back unchanged;
 *   - the desk keeps every remedy it had: a silent agent short of ETH is still
 *     told to send ETH, an expired one is still offered the renewal, and a held
 *     one is offered nothing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { freshWithin } from "@/lib/services/agent-status";
import { WORKER_STALE_MARGIN_SEC, beatSeconds, workerSilentSince, workerStale } from "./worker-stale";

const raw = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
/** Comments stripped — block, JSX and line — so prose about a rule never satisfies it. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const ROUTE = code(raw("../app/api/grants/route.ts"));
const NOW = Date.parse("2026-10-05T12:00:00Z") / 1000;

describe("the server decides when a worker has stopped, by one rule", () => {
  it("IS THE WATCHDOG'S WINDOW PLUS A MARGIN FOR THE MIRROR — not a number of its own", () => {
    for (const tick of [null, 15, 60, 240, 300, 3_600]) {
      const edge = freshWithin(tick) + WORKER_STALE_MARGIN_SEC;
      assert.equal(workerStale(NOW - edge, NOW, tick), false, `exactly at the edge is still fresh (tick ${tick})`);
      assert.equal(workerStale(NOW - edge - 1, NOW, tick), true, `one second past it is stopped (tick ${tick})`);
    }
  });

  it("a longer tick earns a longer window, as the watchdog grants it", () => {
    const silence = 15 * 60;
    assert.equal(workerStale(NOW - silence, NOW, 60), true, "fifteen quiet minutes on a one-minute tick");
    assert.equal(workerStale(NOW - silence, NOW, 600), false, "is under one window on a ten-minute tick");
  });

  it("NEVER HEARD FROM IS NOT STOPPED", () => {
    // A new agent waiting for its first tick has not stopped; null leaves the
    // idle arm to say what is true of it.
    for (const beat of [null, undefined, 0, -5, Number.NaN, Infinity]) {
      assert.equal(workerStale(beat, NOW, 240), null, String(beat));
    }
  });

  it("reads a beat written in milliseconds as the same moment", () => {
    // Read as seconds, a millisecond beat is far in the future and forever
    // fresh — the exact lie this exists to remove.
    const old = NOW - 3_600;
    assert.equal(beatSeconds(old * 1000), old);
    assert.equal(workerStale(old * 1000, NOW, 240), true);
    assert.equal(workerStale(old, NOW, 240), true);
    assert.equal(workerStale((NOW - 30) * 1000, NOW, 240), false);
  });

  it("a beat ahead of this server's clock is fresh, not an error", () => {
    assert.equal(workerStale(NOW + 30, NOW, 240), false);
  });
});

describe("the page reads the server's answer back, and nothing else", () => {
  it("the last beat when the server said stale; null otherwise", () => {
    assert.equal(workerSilentSince({ workerStale: true, workerAliveAt: NOW - 900 }), NOW - 900);
    assert.equal(workerSilentSince({ workerStale: true, workerAliveAt: (NOW - 900) * 1000 }), NOW - 900);
    for (const status of [
      { workerStale: false, workerAliveAt: NOW - 900 },
      { workerStale: null, workerAliveAt: NOW - 900 },
      // An older server sends no verdict at all: described as before.
      { workerAliveAt: NOW - 900 },
      { workerStale: true, workerAliveAt: null },
      null,
      undefined,
    ]) {
      assert.equal(workerSilentSince(status), null, JSON.stringify(status));
    }
  });

  it("THE ROUTE DECLARES IT, nullable", () => {
    assert.match(ROUTE, /workerStale\?: boolean \| null;/);
  });

  it("the route judges it with its own clock, after both heartbeat sources", () => {
    const get = ROUTE.indexOf("export async function GET");
    assert.ok(get > 0, "the GET handler must exist");
    const call = ROUTE.indexOf("workerStaleOf(workerAliveAt, Math.floor(Date.now() / 1000), await tickSecondsFor(hostedTenant))", get);
    assert.ok(call > get, "GET must judge the heartbeat it read, by the server's clock and the owner's tick");
    // After the ledger branch, so the hosted heartbeat (the mirrored row) is
    // the one judged, not only the self-hosted file.
    const branch = ROUTE.indexOf("if (workerAliveAt === null)", get);
    assert.ok(branch > get && call > branch, "after the hosted heartbeat read, not before it");
    const status = ROUTE.slice(ROUTE.indexOf("const status: AgentStatus = {"));
    assert.match(status.slice(0, status.indexOf("};")), /\bworkerStale,/, "and it reaches the response");
  });

  it("the tick is read for the caller, and a failed read is the default, never the house's", () => {
    const fn = ROUTE.slice(ROUTE.indexOf("async function tickSecondsFor"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    assert.match(body, /getSettingsStore\(\)\.get\(hostedTenant\)/, "hosted: this tenant's own settings");
    assert.match(body, /catch \{\s*return null;/, "a failed read falls back to freshWithin's default");
  });
});
