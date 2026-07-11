/**
 * prepare-hook build guard. Runs `next build` so the dashboard is served as a
 * production app (`next start`) — the robust distribution model, not dev-mode.
 *
 * Skips when:
 *   - the build already exists (a published tarball ships .next prebuilt), or
 *   - MERRYMEN_SKIP_BUILD is set, or
 *   - `next` isn't resolvable (e.g. --omit=dev install without build tooling).
 * Never fails the install: a build error is reported but exits 0 so
 * `npm install` still completes; the CLI's `doctor` will flag a missing build.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
const BUILD_ID = path.join(WEB, ".next", "BUILD_ID");

function skip(reason) {
  console.log(`[merrymen] skipping web build — ${reason}`);
  process.exit(0);
}

if (process.env.MERRYMEN_SKIP_BUILD) skip("MERRYMEN_SKIP_BUILD set");
if (existsSync(BUILD_ID)) skip("already built (.next present)");

const nextBin = path.join(
  ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "next.cmd" : "next",
);
if (!existsSync(nextBin)) skip("next not installed (dev tooling absent)");

console.log("[merrymen] building the dashboard (one-time, ~15s)…");
const res = spawnSync(nextBin, ["build"], {
  cwd: WEB,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (res.status !== 0) {
  console.log("[merrymen] web build failed — the CLI still works; run `npm run build` to retry.");
}
process.exit(0);
