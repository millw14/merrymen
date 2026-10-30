import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { NextResponse } from "next/server";
import { thesesMemo, THESES_CACHE_CONTROL } from "@/lib/theses-memo";
import type { ReadThesesOptions } from "@/lib/read-theses";
import { walletNotSupported } from "@/lib/route-guard";

function handler(readTheses: (options?: ReadThesesOptions) => Promise<unknown>) {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Partial<typeof import("./route")> = {};
  const require = (name: string) => {
    if (name === "next/server") return { NextResponse };
    if (name === "@/lib/route-guard") return { walletNotSupported };
    if (name === "@/lib/read-theses") return { readTheses };
    if (name === "@/lib/theses-memo") return { thesesMemo, THESES_CACHE_CONTROL };
    throw new Error(`Unexpected route dependency: ${name}`);
  };
  new Function("require", "module", "exports", javascript)(require, { exports }, exports);
  assert.ok(exports.GET);
  return exports.GET;
}

test("activity and enriched feed keep separate single-flight memos and the same freshness contract", async () => {
  const calls: (ReadThesesOptions | undefined)[] = [];
  const GET = handler(async (opts) => {
    calls.push(opts);
    return { source: "sqlite", theses: [{ postId: "same", realizedPct: opts?.figures === false ? null : 25 }], tradesComplete: true };
  });
  const request = new Request("https://example.test/api/theses?view=activity");
  const [full, activity] = await Promise.all([GET(new Request("https://app.merrymen.dev/api/theses")), GET(request)]);
  assert.equal(full.headers.get("cache-control"), THESES_CACHE_CONTROL);
  assert.equal(activity.headers.get("cache-control"), THESES_CACHE_CONTROL);
  assert.equal((await full.json()).theses[0].realizedPct, 25);
  const body = await activity.json();
  assert.equal(body.figuresIncluded, false);
  assert.equal(body.theses[0].realizedPct, null);
  assert.equal(body.theses[0].postId, "same");
  assert.deepEqual(calls, [undefined, { figures: false }]);
  await Promise.all([GET(new Request("https://app.merrymen.dev/api/theses")), GET(request)]);
  assert.equal(calls.length, 2, "one memo per response shape, no cross-contamination");
});
