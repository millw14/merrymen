import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { NextResponse } from "next/server";
import type { LeaderboardRead, LeaderRow } from "@/lib/read-leaderboard";

const PRIVATE_DIRECTORY_CACHE = "public, s-maxage=60, stale-while-revalidate=120";

/** Execute the saved GET handler; only the database read is replaced. */
function handler(readLeaderboard: () => Promise<LeaderboardRead>) {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Partial<typeof import("./route")> = {};
  const require = (name: string) => {
    if (name === "next/server") return { NextResponse };
    if (name === "@/lib/read-leaderboard") return { readLeaderboard };
    throw new Error(`Unexpected route dependency: ${name}`);
  };
  new Function("require", "module", "exports", javascript)(require, { exports }, exports);
  assert.equal(exports.dynamic, "force-dynamic");
  assert.ok(exports.GET);
  return exports.GET;
}

function row(publicBook: boolean, equityUsdg: number | null = 1000.25, pnlUsdg: number | null = 12.5): LeaderRow {
  return {
    slug: "desk", name: "Desk", handle: null, handleVerified: false, unrankedWhy: null,
    pnlBps: 125, mode: "live", filledPaper: 0, landed: 3, refused: 0, paperFills: 0, liveFills: 3, maxDdBps: 0, curve: [1, 1.0125],
    performance: { book: "live", equityUsdg: publicBook ? equityUsdg : null,
      equityAt: 100, pnlUsdg: publicBook ? pnlUsdg : null, pnlBps: 125, pnlAt: 100,
      publicBook, gasComplete: true, held: false, fills: 3, fillsAtMark: 3, lastFillAt: 90, funded: true,
      valuation: "current", gasOps: { sponsored: 3, priced: 0, unpriced: 0, unrecorded: 0 }, underReview: false },
  };
}
const board = (agents: LeaderRow[]): LeaderboardRead => ({ source: "sqlite", retired: 0, agents });

/** Small shared-cache model honoring the response's actual Cache-Control. */
function cdn(origin: () => Promise<Response>) {
  let stored: Response | null = null;
  return async () => {
    if (stored) return stored.clone();
    const response = await origin();
    const control = response.headers.get("cache-control") ?? "";
    if (!/(?:^|,)\s*no-store\s*(?:,|$)/i.test(control) && /\bpublic\b/i.test(control) && /\bs-maxage=60\b/.test(control)) {
      stored = response.clone();
    }
    return response;
  };
}

test("a compliant shared cache cannot replay published leaderboard dollars after publication is disabled", async () => {
  let published = true;
  let reads = 0;
  const GET = handler(async () => { reads++; return board([row(published)]); });
  const cachedGet = cdn(GET);
  const first = await cachedGet();
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal((await first.json()).agents[0].performance.equityUsdg, 1000.25);
  published = false;
  const second = await cachedGet();
  assert.equal(reads, 2, "the opt-in response was never stored by the shared cache");
  assert.equal(second.headers.get("cache-control"), PRIVATE_DIRECTORY_CACHE);
  const body = await second.json();
  assert.equal(body.agents[0].performance.equityUsdg, null);
  assert.equal(body.agents[0].performance.pnlUsdg, null);
  assert.equal(body.agents[0].performance.publicBook, false);
  assert.doesNotMatch(JSON.stringify(body), /1000\.25|12\.5/);
});

test("any public-book row disables storage even when its current dollars are zero or unavailable", async () => {
  for (const amount of [0, null]) {
    const GET = handler(async () => board([row(false), row(true, amount, amount)]));
    const response = await GET();
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.agents[1].performance.equityUsdg, amount);
    assert.equal(body.agents[1].performance.pnlUsdg, amount);
  }
});

test("fully private, legacy and empty percentage-only directories retain shared caching", async () => {
  const legacy = row(false);
  delete legacy.performance;
  for (const agents of [[row(false)], [legacy], []]) {
    let reads = 0;
    const cachedGet = cdn(handler(async () => { reads++; return board(agents); }));
    const first = await cachedGet();
    assert.equal(first.headers.get("cache-control"), PRIVATE_DIRECTORY_CACHE);
    assert.deepEqual(await first.json(), board(agents));
    const second = await cachedGet();
    assert.deepEqual(await second.json(), board(agents));
    assert.equal(reads, 1, "the percentage-only response is still shared-cacheable");
  }
});
