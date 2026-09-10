/**
 * Stage the merrymen package for bundling — as real files, not a symlink.
 *
 * Run `node stage-bundle.mjs` before electron-builder, `--restore` after.
 *
 * THE BUG THIS EXISTS TO KILL. desktop/package.json depends on `merrymen` as
 * `file:..`, which npm resolves to a SYMLINK back at the repo root.
 * electron-builder follows it and copies that entire tree — .gitignore included,
 * because it has no reason to read one. Worse, `!node_modules/merrymen/**`
 * negations DO NOT apply inside a symlinked package: I added seven of them and
 * the rebuilt bundle still contained every directory they named. They fail
 * silently, which is how this survived six releases. Two things shipped:
 *
 *   THE INSTALLER ATE ITSELF. desktop/dist holds previously built installers,
 *   so every release packaged the last one. 0.1.6 shipped at 260MB carrying
 *   0.1.5 inside it; 0.1.7 first built at 520MB. It doubles per release.
 *
 *   PRIVATE STATE WAS IN THE BUNDLE. .data/ is gitignored precisely because it
 *   holds local worker state — settings.json with API keys, the trade database.
 *   It was empty on this machine, so nothing leaked. On a machine that had ever
 *   run with MERRYMEN_HOME pointing at the repo, a public installer would have
 *   carried that owner's keys to everyone who downloaded it.
 *
 * THE FIX REUSES THE ALLOWLIST WE ALREADY MAINTAIN. `npm pack` honours the root
 * package.json `files` field — the same list that decides what goes to npm,
 * already reviewed, covering cli/web/worker/packages/strategies and nothing
 * else. Extracting that tarball over the symlink gives electron-builder plain
 * files it cannot over-collect. No second exclusion list to drift out of sync,
 * and a new top-level directory can't sneak in: to reach an installer it must
 * first be something we deliberately publish.
 *
 * The one thing the tarball lacks is merrymen's own node_modules (next, tsx,
 * viem) — npm never packs dependencies. Those come back as a junction to the
 * repo's node_modules, which electron-builder dereferences exactly as it did
 * the original symlink. Same bytes as before for the parts that matter.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const STAGED = path.join(HERE, "node_modules", "merrymen");
const INNER_NM = path.join(STAGED, "node_modules");
const ROOT_NM = path.join(ROOT, "node_modules");

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
const die = (msg) => {
  console.error(`[stage] FAILED: ${msg}`);
  process.exit(1);
};

/**
 * Run npm without going through npm.cmd.
 *
 * Node 22 refuses to spawn .cmd files unless `shell: true`, and shell:true is
 * not an option here — it re-parses the arguments, which is what broke the
 * scheduled-task install on "C:\Program Files\nodejs\node.exe". This repo's own
 * path has a space in it. So call npm's JS entry point with the node binary
 * already running us, and no shell is involved at any point.
 */
const NPM_CLI = [
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
].find((p) => existsSync(p));

const npmRun = (args, cwd) => {
  if (!NPM_CLI) die("could not locate npm-cli.js next to the node binary");
  return execFileSync(process.execPath, [NPM_CLI, ...args], { cwd, encoding: "utf8" }).trim();
};

/**
 * Remove a path that MIGHT be a symlink/junction pointing at the repo.
 *
 * This is the dangerous line in the file. `rmSync(recursive)` on a junction to
 * ROOT/node_modules would delete the repo's dependencies, and on the `merrymen`
 * symlink it would delete the repo. Node unlinks links rather than following
 * them, but the cost of being wrong is high enough to check explicitly rather
 * than trust that: links are unlinked, and only a verified real directory is
 * ever recursed into.
 */
function removeLinkOrDir(target, { allowRealDir = false } = {}) {
  if (!existsSync(target) && !isLink(target)) return;
  if (isLink(target)) {
    try {
      unlinkSync(target);
    } catch {
      rmSync(target, { recursive: false, force: true }); // Windows dir junction
    }
    return;
  }
  if (!allowRealDir) die(`${target} is a real directory and I won't delete it blind`);
  rmSync(target, { recursive: true, force: true });
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Clear whatever is currently at node_modules/merrymen — the file:.. symlink on
 * a fresh checkout, or a previous staging on a re-run.
 *
 * ORDER IS LOAD-BEARING. A staged tree contains node_modules as a JUNCTION to
 * the repo's real node_modules. Recursing into it before unlinking it would
 * delete the repo's dependencies. Drop the junction first, prove it's gone,
 * then recurse.
 */
function clearStaged() {
  // While `merrymen` is still the file:.. symlink, INNER_NM is not ours at all:
  // the path resolves THROUGH the symlink into the repo's own node_modules.
  // Touching it here would delete the repo's dependencies. Unlink the symlink
  // itself and stop — there is no inner junction yet to worry about.
  if (isLink(STAGED)) {
    removeLinkOrDir(STAGED);
    return;
  }
  removeLinkOrDir(INNER_NM);
  if (existsSync(INNER_NM) || isLink(INNER_NM)) die("inner node_modules link survived; refusing to recurse");
  removeLinkOrDir(STAGED, { allowRealDir: true });
}

function restore() {
  clearStaged();
  npmRun(["install", "--silent"], HERE);
  console.log("[stage] restored the file:.. symlink for development");
}

if (process.argv.includes("--restore")) {
  restore();
  process.exit(0);
}

// Old installers are what used to get bundled. Clear them rather than trusting
// an exclusion — that trust is the mistake this whole file documents.
const dist = path.join(HERE, "dist");
if (existsSync(dist)) {
  rmSync(dist, { recursive: true, force: true });
  console.log("[stage] cleared desktop/dist");
}

const tmp = mkdtempSync(path.join(tmpdir(), "merrymen-stage-"));
console.log("[stage] packing merrymen from the root `files` allowlist…");

/**
 * Run the publish gate by hand, because `npm pack` will not.
 *
 * `prepublishOnly` fires only on `npm publish`. What pack runs is `prepare`
 * (cli/build.mjs), and that hook deliberately SKIPS when .next already exists
 * and exits 0 even when the build errors, so `npm install` never breaks. Net
 * effect: pack alone will happily bundle a stale dashboard, or one clobbered by
 * a `next dev` run — which is how 0.11.0 shipped a UI that could not start.
 *
 * The installer deserves the same guarantee the npm tarball gets, so invoke the
 * real gate: it wipes .next, rebuilds clean, and exits non-zero on any gap.
 */
console.log("[stage] running the publish gate against the dashboard…");
execFileSync(process.execPath, [path.join(ROOT, "cli", "prepublish.mjs")], { cwd: ROOT, stdio: "inherit" });

const packed = npmRun(["pack", "--pack-destination", tmp], ROOT).split("\n").pop().trim();
const tarball = path.join(tmp, packed);
if (!existsSync(tarball)) die(`npm pack produced no tarball (got "${packed}")`);
console.log(`[stage] packed ${packed}`);

// `tar` on PATH here is Git's GNU tar, which reads "C:\..." as a remote host
// spec and fails with "Cannot connect to C". Windows ships bsdtar in System32,
// which handles drive letters natively; fall back to telling GNU tar the path
// is local.
const SYSTEM_TAR = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
if (process.platform === "win32" && existsSync(SYSTEM_TAR)) {
  run(SYSTEM_TAR, ["-xf", tarball, "-C", tmp]);
} else {
  run("tar", [...(process.platform === "win32" ? ["--force-local"] : []), "-xf", tarball, "-C", tmp]);
}
const extracted = path.join(tmp, "package");
if (!existsSync(extracted)) die("tarball did not contain package/");

clearStaged(); // the file:.. symlink, or a previous staging
try {
  renameSync(extracted, STAGED);
} catch (e) {
  // Cross-device move (/tmp on tmpfs is the classic): rename can't cross
  // filesystems, so copy + remove instead. Same result, no new dependency.
  if (!e || e.code !== "EXDEV") throw e;
  cpSync(extracted, STAGED, { recursive: true });
  rmSync(extracted, { recursive: true, force: true });
}

// npm never packs dependencies; point the staged copy back at the repo's, the
// same resolution the symlink gave us. Junction on Windows, symlink elsewhere.
if (process.platform === "win32") {
  execFileSync("cmd", ["/c", "mklink", "/J", INNER_NM, ROOT_NM], { encoding: "utf8" });
} else {
  symlinkSync(ROOT_NM, INNER_NM, "dir");
}

const banned = ["desktop", ".data", "site", "gateway", "contracts", "scripts", ".claude", ".git", ".env"];
const leaked = banned.filter((d) => existsSync(path.join(STAGED, d)));
if (leaked.length) die(`these must never ship and are in the bundle: ${leaked.join(", ")}`);

for (const need of ["web", "worker", "packages", "cli", "node_modules"]) {
  if (!existsSync(path.join(STAGED, need))) die(`the app runs from ${need}/ and it isn't in the bundle`);
}
// The same four files cli/prepublish.mjs checks. BUILD_ID alone is not enough:
// a dev-mode run leaves some of these behind and drops others, so a bundle can
// look built and still fail to serve.
const NEXT_REQUIRED = ["BUILD_ID", "required-server-files.json", "prerender-manifest.json", "routes-manifest.json"];
const missingNext = NEXT_REQUIRED.filter((f) => !existsSync(path.join(STAGED, "web", ".next", f)));
if (missingNext.length) die(`bundled dashboard is incomplete — missing ${missingNext.join(", ")}`);
if (!existsSync(path.join(STAGED, "worker", "src", "index.ts"))) die("bundled worker has no entry point");

rmSync(tmp, { recursive: true, force: true });
console.log(`[stage] OK — ${readdirSync(STAGED).length} entries staged, none of them private`);
