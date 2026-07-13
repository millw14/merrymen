import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * The worker must use RELATIVE imports only. The "@merrymen/core" (or any
 * "@merrymen/*") alias lives in dev tsconfigs that tsx resolves from the repo
 * root — inside the INSTALLED package the worker is launched with the package
 * root as cwd, the alias doesn't resolve, and the worker dies at startup.
 * That failure is silent from the user's point of view (the dashboard still
 * runs; Telegram just never answers), so guard it here where `npm test` runs.
 */

const WORKER_SRC = join(import.meta.dirname, ".");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}

describe("worker imports are install-safe", () => {
  it("no file under worker/src alias-imports @merrymen/*", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(WORKER_SRC)) {
      const src = readFileSync(file, "utf8");
      if (/from\s+["']@merrymen\//.test(src)) offenders.push(file);
    }
    assert.deepEqual(
      offenders,
      [],
      `alias imports break the installed worker — use relative paths to packages/core: ${offenders.join(", ")}`,
    );
  });
});
