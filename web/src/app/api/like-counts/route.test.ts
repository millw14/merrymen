import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NextResponse } from "next/server";
import ts from "typescript";
import type { ReadThesesOptions } from "@/lib/read-theses";

/** Execute the saved route; replace only its public feed/store dependencies. */
function handler(
  readTheses: (options?: ReadThesesOptions) => Promise<unknown>,
  counts: (ids: readonly string[]) => Promise<Record<string, number>>,
) {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Partial<typeof import("./route")> = {};
  const require = (name: string) => {
    if (name === "next/server") return { NextResponse };
    if (name === "@/lib/read-theses") return { readTheses };
    if (name === "@/lib/like-store") return { getLikeStore: () => ({ counts }) };
    throw new Error(`Unexpected route dependency: ${name}`);
  };
  new Function("require", "module", "exports", javascript)(require, { exports }, exports);
  assert.equal(exports.dynamic, "force-dynamic");
  assert.ok(exports.GET);
  return exports.GET;
}

test("counts use the activity post IDs without reading return enrichment and keep zero counts", async () => {
  const options: (ReadThesesOptions | undefined)[] = [];
  let asks = 0;
  const GET = handler(async opts => {
    options.push(opts);
    return { source: "sqlite", theses: [{ postId: "new-post" }, { postId: null }, { postId: "zero-likes" }] };
  }, async ids => {
    asks++;
    assert.deepEqual(ids, ["new-post", "zero-likes"], "only IDs supplied by the publication-gated feed");
    return { "new-post": 3, "zero-likes": 0 };
  });
  const response = await GET();
  assert.deepEqual(options, [{ figures: false }]);
  assert.equal(asks, 1);
  assert.deepEqual(await response.json(), { counts: { "new-post": 3, "zero-likes": 0 }, read: true });
  assert.equal(response.headers.get("cache-control"), "public, max-age=10, s-maxage=20, stale-while-revalidate=60");
});

test("feed and count failures remain unread and uncacheable", async () => {
  for (const failedStage of ["feed", "counts"]) {
    let asks = 0;
    const GET = handler(async () => {
      if (failedStage === "feed") throw new Error("private database error");
      return { source: "sqlite", theses: [{ postId: "published" }] };
    }, async () => { asks++; throw new Error("private database error"); });
    const response = await GET();
    assert.equal(asks, failedStage === "feed" ? 0 : 1);
    assert.deepEqual(await response.json(), { counts: {}, read: false });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
