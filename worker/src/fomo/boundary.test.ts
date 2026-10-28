/**
 * THE FOMO BOUNDARIES, pinned by reading source — the same technique as
 * research-boundary.test.ts and tg-groups/boundary.test.ts.
 *
 *   1. The data key never reaches a hosted child, and only the processes that
 *      broker reads for the fleet (orchestrator, web) or own one install
 *      (settings.ts, self-hosted) ever read it.
 *   2. Only the adapter names the API host, and the adapter reads no
 *      environment: the key arrives as an argument.
 *   3. The Brain service never names the vendor; it sees a neutral lens.
 *   4. Nothing under fomo/ can reach the executor, policy, the wall, the
 *      X outbox or a signer. Research proposes; it never disposes.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const WORKER = path.join(REPO, "worker", "src");
const FOMO = path.join(WORKER, "fomo");

function walk(dir: string, keep: (f: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}

/** Source with comments removed, so a rationale that names a thing does not count as using it. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const rel = (f: string) => path.relative(REPO, f);
const isTest = (f: string) => /\.test\.ts$/.test(f);

describe("the Fomo data key", () => {
  it("is stripped from every hosted child, under both names", () => {
    const src = readFileSync(path.join(WORKER, "orchestrator.ts"), "utf8");
    const i = src.indexOf("const CHILD_SECRET_STRIP = [");
    assert.ok(i > 0, "the strip list must exist for this to mean anything");
    const block = src.slice(i, src.indexOf("] as const;", i));
    for (const key of ["MERRYMEN_FOMO_API_KEY", "FOMO_API_KEY"]) {
      assert.ok(block.includes(`"${key}"`), `${key} is not stripped from a child's environment`);
    }
  });

  it("is read only where a fleet broker or a self-hosted install resolves it", () => {
    const files = [
      ...walk(WORKER, (f) => f.endsWith(".ts") && !isTest(f)),
      ...walk(path.join(REPO, "web", "src"), (f) => /\.(ts|tsx)$/.test(f) && !isTest(f)),
    ];
    const readers = files.filter((f) => /\b(?:MERRYMEN_)?FOMO_API_KEY\b/.test(code(f))).map(rel).sort();
    const allowed = new Set([
      "worker/src/orchestrator.ts",
      "worker/src/settings.ts",
      "web/src/lib/fomo-runtime.ts",
    ]);
    for (const r of readers) assert.ok(allowed.has(r), `${r} reads the Fomo key; only the broker processes may`);
  });
});

describe("the adapter", () => {
  it("is the only code that names the API host", () => {
    const files = [
      ...walk(WORKER, (f) => f.endsWith(".ts") && !isTest(f)),
      ...walk(path.join(REPO, "web", "src"), (f) => /\.(ts|tsx)$/.test(f) && !isTest(f)),
      ...walk(path.join(REPO, "packages"), (f) => f.endsWith(".ts") && !isTest(f)),
    ];
    const naming = files.filter((f) => /api\.fomoapi\.io/.test(code(f))).map(rel);
    assert.deepEqual(naming, ["worker/src/fomo/provider.ts"]);
  });

  it("never reads the environment: the key arrives as an argument", () => {
    for (const f of ["provider.ts", "store.ts", "service.ts", "tools.ts"]) {
      const p = path.join(FOMO, f);
      let src = "";
      try {
        src = code(p);
      } catch {
        continue; // not written yet in this revision
      }
      assert.ok(!/process\.env/.test(src), `fomo/${f} must not read the environment`);
    }
  });
});

describe("the Brain service", () => {
  it("never names the data vendor", () => {
    const brain = walk(path.join(REPO, "services", "brain"), (f) => f.endsWith(".py"));
    for (const f of brain) {
      assert.ok(!/fomo/i.test(readFileSync(f, "utf8")), `${rel(f)} names the vendor; Brain sees a neutral lens`);
    }
  });
});

describe("research never disposes", () => {
  it("nothing under fomo/ imports the executor, policy, the wall, a signer or the X outbox", () => {
    const forbidden = [
      /from "\.\.\/executor"/,
      /from "\.\.\/policy"/,
      /from "\.\.\/wall"/,
      /from "\.\.\/session-account"/,
      /from "\.\.\/paymaster"/,
      /from "\.\.\/grant-store"/,
      /from "\.\.\/xpost\//,
      /from "\.\.\/index"/,
      /privateKeyToAccount|signTypedData|sendUserOperation/,
    ];
    for (const f of walk(FOMO, (x) => x.endsWith(".ts") && !isTest(x))) {
      const src = code(f);
      for (const re of forbidden) assert.ok(!re.test(src), `${rel(f)} reaches ${re}`);
    }
  });

  it("the adapter allowlists reads and refuses the provider's trading and payment routes", () => {
    let src = "";
    try {
      src = readFileSync(path.join(FOMO, "provider.ts"), "utf8");
    } catch {
      return;
    }
    assert.ok(!/method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/.test(src), "the adapter sends a non-GET request");
  });
});
