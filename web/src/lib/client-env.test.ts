/**
 * Server env vars do not exist in the browser bundle.
 *
 * This pins the defect that made hosted onboarding fail for every tester, in a
 * way that cannot come back. `isHostedMode()` reads `process.env.MERRYMEN_HOSTED`
 * (packages/core/src/hosted.ts). Next inlines only `NEXT_PUBLIC_*` into the
 * client bundle, and web/next.config.mjs declares no `env` block — so in any
 * `"use client"` module that call evaluates to `false` no matter how the server
 * is configured.
 *
 * It did exactly that in web/src/lib/session.ts, which used it to decide whether
 * to strip the owner key before POSTing a grant. It never stripped it, the
 * server refused every hosted grant with a 422, and nothing surfaced the
 * refusal. The bug is invisible by construction: no type error, no runtime
 * throw, just a constant that is quietly always false.
 *
 * The client's only trustworthy signal is GET /api/auth/session, which returns
 * {hosted, address} at runtime.
 *
 * Route handlers under app/api are server-side (node runtime) and may use it
 * freely — that is where it belongs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "web", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/**
 * Source with comments removed.
 *
 * Load-bearing: the files that explain this bug NAME it, and a naive scan would
 * flag the very comments warning people off it. Only real code counts.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no client module imports isHostedMode — it is always false in the browser", () => {
  const apiDir = path.join(SRC, "app", "api");
  // These services run behind the signed partner route. Their Node-only
  // dependencies (session crypto / SQLite and Postgres) cannot run in a client
  // bundle; unlike session.ts they are never wallet/browser helpers.
  const partnerServerModules = new Set([
    path.join(SRC, "lib", "partner-runtime.ts"),
    path.join(SRC, "lib", "partner-store.ts"),
    // The MCP server's config: read only by route handlers (/mcp, /oauth/*,
    // /.well-known/*, /api/mcp/*). It imports node:crypto-backed modules and is
    // never part of a client bundle.
    path.join(SRC, "mcp", "config.ts"),
  ]);
  const offenders = walk(SRC)
    .filter((f) => !f.startsWith(apiDir)) // route handlers are server-side
    .filter((f) => !partnerServerModules.has(f))
    .filter((f) => /\bisHostedMode\b/.test(code(f)))
    .map((f) => path.relative(process.cwd(), f));

  assert.deepEqual(
    offenders,
    [],
    `These files reference isHostedMode() outside app/api. It reads process.env, which Next does ` +
      `not inline into the browser bundle, so it is ALWAYS false there — the exact bug that made ` +
      `every hosted grant get refused with nobody able to see why. Use GET /api/auth/session ` +
      `({hosted,address}) instead.\n  ${offenders.join("\n  ")}`,
  );
});
