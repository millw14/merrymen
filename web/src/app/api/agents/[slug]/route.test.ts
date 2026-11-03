import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { NextResponse } from "next/server";
import { walletNotSupported } from "@/lib/route-guard";

function handler(reads: { readAgent: (slug: string) => Promise<unknown>; readAgentSummary: (slug: string) => Promise<unknown>; readTheses: (opts: unknown) => Promise<unknown> }) {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Partial<typeof import("./route")> = {};
  const require = (name: string) => {
    if (name === "next/server") return { NextResponse };
    if (name === "@/lib/route-guard") return { walletNotSupported };
    if (name === "@/lib/read-agent") return reads;
    if (name === "@/lib/read-theses") return reads;
    throw new Error(`Unexpected route dependency: ${name}`);
  };
  new Function("require", "module", "exports", javascript)(require, { exports }, exports);
  assert.ok(exports.GET);
  return exports.GET;
}
const request = (view: string) => new Request(`https://example.test/api/agents/desk?view=${view}`);
const params = { params: Promise.resolve({ slug: "desk" }) };

test("summary and activity answer independently of historical profile performance", async () => {
  let full = 0;
  let activity = 0;
  const GET = handler({
    readAgent: async () => { full++; return new Promise(() => {}); },
    readAgentSummary: async () => ({ summary: true, slug: "desk", name: "Desk" }),
    readTheses: async (opts) => { activity++; assert.deepEqual(opts, { agentSlug: "desk", limit: 40, figures: false }); return { source: "sqlite", theses: [{ postId: "stable" }], tradesComplete: true }; },
  });
  const summary = await GET(request("summary"), params);
  assert.equal((await summary.json()).summary, true);
  assert.equal(full, 0);
  assert.equal(activity, 0);
  const result = await GET(request("activity"), params);
  assert.equal((await result.json()).theses[0].postId, "stable");
  assert.equal(full, 0);
  assert.equal(activity, 1);
});

test("explicit details do not repeat the activity read", async () => {
  const GET = handler({
    readAgent: async () => ({ slug: "desk", name: "Desk", pnlBps: null }),
    readAgentSummary: async () => { throw new Error("not needed"); },
    readTheses: async () => { throw new Error("not needed"); },
  });
  assert.equal((await (await GET(request("details"), params)).json()).name, "Desk");
});

test("a failed summary is unavailable, an unknown agent is missing, and invalid slugs trigger no read", async () => {
  let calls = 0;
  let missing = false;
  const GET = handler({
    readAgent: async () => { throw new Error("not needed"); },
    readAgentSummary: async () => { calls++; if (missing) return null; throw new Error("database unavailable"); },
    readTheses: async () => { throw new Error("not needed"); },
  });
  assert.equal((await GET(request("summary"), params)).status, 503);
  missing = true;
  assert.equal((await GET(request("summary"), params)).status, 404);
  assert.equal((await GET(request("summary"), { params: Promise.resolve({ slug: "../feed" }) })).status, 400);
  assert.equal(calls, 2);
});
