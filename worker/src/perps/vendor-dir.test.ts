/**
 * THE SIGNER IS FOUND FROM THE WORKER AND FROM THE WEB.
 *
 * The keygen route (docs/perps.md rule 5) loads the same pinned WASM the
 * worker does, from a Next.js server whose cwd is web/ and whose
 * import.meta.url webpack rewrote at build time. These tests pin the order of
 * the search and the one rule that must never bend: an operator override is
 * obeyed even when it is wrong, so a load fails on the path they named instead
 * of quietly running a copy from somewhere else.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LIGHTER_SIGNER_ARTIFACT, LIGHTER_VENDOR_DIR } from "./signer";
import { LIGHTER_VENDOR_DIR_ENV, lighterVendorCandidates, resolveLighterVendorDir } from "./vendor-dir";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const VENDOR = path.join(REPO, "worker", "vendor", "lighter");

test("the worker's own resolution finds the vendored WASM", () => {
  assert.equal(path.resolve(LIGHTER_VENDOR_DIR), VENDOR);
  assert.ok(existsSync(path.join(LIGHTER_VENDOR_DIR, LIGHTER_SIGNER_ARTIFACT.wasmFile)));
});

test("from web/ with no usable module path (a prebuilt dashboard), cwd/../worker/vendor/lighter is found", () => {
  const dir = resolveLighterVendorDir({ env: {}, cwd: path.join(REPO, "web"), moduleDir: "/build-machine/that/is/gone/worker/vendor/lighter" });
  assert.equal(dir, VENDOR);
});

test("from the repo root (the CLI), cwd/worker/vendor/lighter is found", () => {
  assert.equal(resolveLighterVendorDir({ env: {}, cwd: REPO, moduleDir: null }), VENDOR);
});

test("the module-relative path wins when it holds the WASM", () => {
  const seen: string[] = [];
  const dir = resolveLighterVendorDir({
    env: {},
    cwd: "/somewhere",
    moduleDir: "/pkg/worker/vendor/lighter",
    exists: (f) => {
      seen.push(f);
      return f === path.join("/pkg/worker/vendor/lighter", "lighter-signer.wasm") || f.startsWith("/somewhere");
    },
  });
  assert.equal(dir, "/pkg/worker/vendor/lighter");
  assert.equal(seen.length, 1, "the first candidate that holds the WASM ends the search");
});

test("MERRYMEN_LIGHTER_VENDOR_DIR wins, even over a candidate that exists — and even when it is wrong", () => {
  assert.equal(resolveLighterVendorDir({ env: { [LIGHTER_VENDOR_DIR_ENV]: "/opt/lighter" }, cwd: REPO }), "/opt/lighter");
  assert.equal(resolveLighterVendorDir({ env: { [LIGHTER_VENDOR_DIR_ENV]: "vendor-here" }, cwd: "/srv/app" }), path.resolve("/srv/app", "vendor-here"));
  // Blank is not an override.
  assert.equal(resolveLighterVendorDir({ env: { [LIGHTER_VENDOR_DIR_ENV]: "  " }, cwd: REPO, moduleDir: null }), VENDOR);
});

test("nothing found: the first candidate, so the load fails naming a real path", () => {
  const dir = resolveLighterVendorDir({ env: {}, cwd: "/nowhere", moduleDir: "/mod/vendor/lighter", exists: () => false });
  assert.equal(dir, "/mod/vendor/lighter");
  assert.deepEqual(lighterVendorCandidates({ cwd: "/a/web", moduleDir: null }), [path.resolve("/a/web/worker/vendor/lighter"), path.resolve("/a/worker/vendor/lighter")]);
});
