/**
 * THE TWO CREDENTIAL SYSTEMS STAY APART, AND THIS IS THE FENCE.
 *
 * `partner-cross.test.mjs` proves they reject each other's keys today. This
 * proves they cannot quietly grow a shared code path tomorrow — the change that
 * would make that test start passing for the wrong reason.
 *
 * A source-scanning test in the style of worker/src/imports.test.ts: cheap,
 * mechanical, and it fails on the diff that introduces the problem rather than
 * on the incident that reveals it.
 *
 * `node --test imports.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, rel), "utf8");
/** Comments explain the rule; they must not be able to satisfy or break it. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

test("partners.mjs does not import the holder core", () => {
  const src = code(read("lib/partners.mjs"));
  assert.ok(!/from\s+["'][^"']*core\.mjs["']/.test(src), "partners.mjs imported core.mjs");
  // Nor the holder vocabulary by any other route.
  for (const banned of ["isHolder", "issueToken", "verifyToken", "minTokens"]) {
    assert.ok(!src.includes(banned), `partners.mjs referenced ${banned}`);
  }
});

test("partner-api.mjs never reaches for the holder gate", () => {
  const src = code(read("lib/partner-api.mjs"));
  for (const banned of ["isHolder", "verifyToken", "issueToken", "mmk_", "balanceOf"]) {
    assert.ok(!src.includes(banned), `partner-api.mjs referenced ${banned}`);
  }
});

test("the holder core knows nothing about partners", () => {
  // The dependency must point one way. If core.mjs ever imports partners.mjs,
  // a bug in the partner registry becomes a bug in the LLM gate.
  const src = code(read("lib/core.mjs"));
  assert.ok(!/from\s+["'][^"']*partners?\.mjs["']/.test(src), "core.mjs imported a partner module");
  assert.ok(!src.includes("mmp_"), "core.mjs referenced the partner key prefix");
});

test("the partner surface carries no CORS", () => {
  // A partner key is a server-side secret. Any CORS header on /partner/* turns
  // a browser into a place where that secret has to live.
  const src = code(read("lib/partner-api.mjs"));
  assert.ok(!/access-control-allow/i.test(src), "partner-api.mjs set a CORS header");
  assert.ok(!src.includes("cors"), "partner-api.mjs mentioned cors");
});

test("the server wires the partner API before its catch-all 404", () => {
  const src = code(read("server.mjs"));
  const wired = src.indexOf("partnerApi.owns(");
  const catchAll = src.indexOf('status: 404, json: { error: "not found" }');
  assert.ok(wired > 0, "server.mjs does not route the partner API");
  assert.ok(catchAll > 0, "server.mjs lost its catch-all");
  // Otherwise partner routes fall through to the holder-shaped 404 and a partner
  // gets an error envelope their client cannot parse.
  assert.ok(wired < catchAll, "the partner API must be matched before the catch-all");
});

test("HTTP plumbing cannot mint keys; issuance stays in the authenticated developer service", () => {
  const src = code(read("server.mjs"));
  assert.ok(!src.includes("makeKey"), "server.mjs can mint a partner key");
  assert.ok(!src.includes("writeRecord"), "server.mjs can write the partner registry");
});
