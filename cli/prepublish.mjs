/**
 * prepublishOnly gate — the counterpart to build.mjs's soft-fail install hook.
 *
 * Publishing ships web/.next verbatim, and `merrymen start` on user machines
 * serves it with `next start` (users can't rebuild — no dev tooling). A dev-mode
 * run (`next dev`) clobbers the production build (drops BUILD_ID and
 * required-server-files.json), and build.mjs deliberately exits 0 on failure so
 * installs never break — which means a broken .next can be packed SILENTLY.
 * That shipped 0.11.0 with a dashboard that could not start.
 *
 * So before every publish: throw the old .next away, build fresh, and verify
 * the files `next start` needs actually exist. Any gap FAILS the publish.
 */

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
const NEXT_DIR = path.join(WEB, ".next");

console.log("[merrymen] prepublish: clean production build of the dashboard…");
rmSync(NEXT_DIR, { recursive: true, force: true });

// Invoke next's JS entry with node directly — the .cmd shim needs shell:true on
// Windows, which breaks on spaces in the install path (unquoted). This is the
// exact bug that let 0.11.0 pack a broken dashboard.
const nextJs = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
if (!existsSync(nextJs)) {
  console.error("[merrymen] prepublish FAILED: next is not installed — run npm install first.");
  process.exit(1);
}
const res = spawnSync(process.execPath, [nextJs, "build"], { cwd: WEB, stdio: "inherit" });
if (res.status !== 0) {
  console.error("[merrymen] prepublish FAILED: next build errored — refusing to publish a broken dashboard.");
  process.exit(1);
}

// What `next start` actually requires to serve. If any is missing, the tarball
// would ship a dashboard that cannot start on user machines.
const REQUIRED = ["BUILD_ID", "required-server-files.json", "prerender-manifest.json", "routes-manifest.json"];
const missing = REQUIRED.filter((f) => !existsSync(path.join(NEXT_DIR, f)));
if (missing.length > 0) {
  console.error(`[merrymen] prepublish FAILED: build incomplete — missing ${missing.join(", ")}.`);
  process.exit(1);
}
console.log("[merrymen] prepublish OK: complete production build verified.");
