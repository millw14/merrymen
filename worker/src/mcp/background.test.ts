import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { makeMcpBackground, mcpBackgroundEnabled } from "./background";

test("the background work runs only with shared Postgres and MCP switched on", () => {
  assert.equal(mcpBackgroundEnabled({}), false);
  assert.equal(mcpBackgroundEnabled({ DATABASE_URL: "postgres://x" }), true);
  assert.equal(mcpBackgroundEnabled({ DATABASE_URL: "postgres://x", MERRYMEN_MCP_ENABLED: "0" }), false);
});

test("a tick never throws and never blocks: a database outage is logged, and the next tick retries", async () => {
  const lines: string[] = [];
  let calls = 0;
  const tick = makeMcpBackground({
    shared: async () => { calls += 1; throw new Error("connect ECONNREFUSED"); },
    log: (l) => lines.push(l),
    env: { DATABASE_URL: "postgres://x" },
  });
  const started = Date.now();
  tick();
  assert.ok(Date.now() - started < 50, "the tick returns immediately");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 3, "jobs, notify and retention each tried");
  assert.ok(lines.every((l) => /^mcp: (jobs|notify|maintenance) pass failed/.test(l)), lines.join("\n"));
  tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 6, "retried on the next tick");
});

test("a disabled tick does nothing at all", async () => {
  let calls = 0;
  const tick = makeMcpBackground({ shared: async () => { calls += 1; throw new Error("x"); }, log: () => {}, env: {} });
  tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 0);
});

test("the orchestrator starts the MCP background after the mirror and never awaits it", () => {
  // The chat-room boundary test forbids naming that room here, so the mirror is the only anchor.
  const src = readFileSync(path.join(process.cwd(), "worker", "src", "orchestrator.ts"), "utf8");
  const mirror = src.indexOf("await mirrorLedgers();");
  const mcp = src.indexOf("(mcpBackground ??= makeMcpBackground(");
  assert.ok(mirror > 0 && mcp > mirror, "called after the mirror");
  assert.doesNotMatch(src, /await\s+\(?mcpBackground/, "never awaited");
});
