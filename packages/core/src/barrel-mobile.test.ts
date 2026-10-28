import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as core from "./index";
import * as solana from "./solana";
import * as solanaLive from "./solana-live";

/**
 * THE PHONE BUNDLES THIS BARREL.
 *
 * mobile/metro.config.js aliases @merrymen/core to packages/core/src, and
 * Metro bundles every file index.ts reaches, used or not. An EAS build installs
 * mobile/ only, so a package the barrel reaches that mobile/package.json lacks
 * fails the release build, and @solana/kit would ship to every phone even if it
 * resolved. Solana stays out: the worker and web import solana.ts and
 * solana-live.ts by path.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/g;

/** Every file index.ts reaches by runtime (not type-only) relative imports, and the packages they name. */
function reach(): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(IMPORT)) {
      if (!spec!.startsWith(".")) {
        packages.add(spec!);
        continue;
      }
      const base = resolve(dirname(file), spec!);
      const hit = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((p) => statSync(p, { throwIfNoEntry: false })?.isFile());
      assert.ok(hit, `${relative(SRC, file)} imports ${spec}, which does not resolve`);
      if (!hit.endsWith(".json")) visit(hit);
    }
  };
  visit(join(SRC, "index.ts"));
  return { files, packages };
}

describe("the core barrel the phone bundles", () => {
  const { files, packages } = reach();

  it("reaches neither Solana module nor any @solana package", () => {
    const names = [...files].map((f) => relative(SRC, f));
    assert.ok(names.includes("ids.ts"), "the walk follows the barrel");
    assert.ok(!names.includes("solana.ts") && !names.includes("solana-live.ts"), names.join(", "));
    assert.deepEqual([...packages].filter((p) => p.startsWith("@solana/")), []);
  });

  it("exports nothing from either Solana module", () => {
    assert.deepEqual(Object.keys(core).filter((k) => k in solana || k in solanaLive), []);
  });

  it("reaches only packages a mobile/ install installs, and no Node built-in", () => {
    // An EAS build installs mobile/ only: a package the barrel reaches that mobile/ does not install fails the
    // release build, and nothing in CI bundles mobile/ to notice (it was proved by hand once). Installed means a
    // dependency in mobile/package.json, or a production package mobile/package-lock.json puts at the top of
    // node_modules: @noble/hashes (ids.ts, robinhood-oauth.ts) comes that way, with viem and @noble/curves.
    const mobile = JSON.parse(readFileSync(join(SRC, "../../../mobile/package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const lock = JSON.parse(readFileSync(join(SRC, "../../../mobile/package-lock.json"), "utf8")) as { packages?: Record<string, { dev?: boolean; version?: string }> };
    const installed = (name: string) => Object.hasOwn(mobile.dependencies ?? {}, name)
      || (lock.packages?.[`node_modules/${name}`] !== undefined && lock.packages[`node_modules/${name}`]!.dev !== true);
    // The walk reads text, so a comment quoting `"…" from "…"` can look like an import: only a bare package
    // specifier counts. "@scope/name/sub" and "name/sub" are the packages "@scope/name" and "name".
    const BARE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/\S*)?$/;
    const packageOf = (spec: string) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
    const reached = [...new Set([...packages].filter((spec) => BARE.test(spec)).map(packageOf))].sort();
    assert.ok(reached.includes("viem") && reached.includes("@noble/curves"), `the walk sees the barrel's packages: ${reached.join(", ")}`);
    assert.deepEqual(reached.filter((name) => !installed(name)), [], "not installed by mobile/ (package.json dependencies or its lock's top level)");
    assert.deepEqual([...packages].filter((spec) => spec.startsWith("node:")), [], "Metro bundles no Node built-in");
  });
});
