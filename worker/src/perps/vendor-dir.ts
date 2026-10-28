/**
 * WHERE THE VENDORED LIGHTER SIGNER LIVES, from whichever process asks.
 *
 * Two processes load the signer, and they disagree about where they are:
 *
 *   the worker   tsx runs worker/src/perps/signer.ts from the checkout (or the
 *                npm package); `import.meta.url` is that file, and
 *                ../../vendor/lighter beside it is right. process.cwd() is the
 *                repo root under the CLI.
 *   the web      `next start` / `next dev` run with process.cwd() = web/, and
 *                the keygen route (docs/perps.md rule 5) imports this module
 *                through webpack. webpack rewrites `import.meta.url` to the
 *                file URL the module had AT BUILD TIME — right when the build
 *                ran in the same checkout, wrong for a dashboard prebuilt on
 *                another machine and shipped in the npm package.
 *
 * So the directory is RESOLVED, not assumed: an explicit override, then the
 * module-relative path, then the two cwd-relative spellings of
 * worker/vendor/lighter, and the first that actually holds the pinned WASM
 * wins. Nothing here trusts what it finds — instantiateSigner hash-checks both
 * files before a byte runs — so a wrong candidate can only fail closed
 * (artifact-missing / hash-mismatch), never load different code.
 *
 * NO `new URL("…", import.meta.url)` WITH A LITERAL, deliberately. webpack
 * treats that exact shape as an asset reference and tries to bundle the target;
 * for a directory the build fails. Path arithmetic on the module's own file is
 * invisible to it.
 *
 * THE OVERRIDE WINS EVEN WHEN IT IS WRONG. MERRYMEN_LIGHTER_VENDOR_DIR is an
 * operator saying "the signer is HERE". Falling back past a mistyped override
 * would load a different copy than the one they pointed at, silently; failing
 * on the path they named is the honest answer.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The pinned WASM's file name — what a candidate directory must hold to be chosen. */
const WASM_FILE = "lighter-signer.wasm";

/** The operator override: an absolute (or cwd-relative) directory holding both pinned files. */
export const LIGHTER_VENDOR_DIR_ENV = "MERRYMEN_LIGHTER_VENDOR_DIR";

/** worker/vendor/lighter relative to this file, or null when the module has no file URL to go from. */
function moduleRelative(): string | null {
  try {
    const here = import.meta.url;
    if (typeof here !== "string" || !here.startsWith("file:")) return null;
    return path.resolve(path.dirname(fileURLToPath(here)), "..", "..", "vendor", "lighter");
  } catch {
    return null;
  }
}

export interface VendorDirInputs {
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** The module-relative candidate; null when there is none (tests pass it explicitly). */
  moduleDir?: string | null;
  exists?: (file: string) => boolean;
}

/**
 * Every place worth looking, in order, without the existence check — exported
 * so `doctor` and a test can say where the signer was looked for.
 */
export function lighterVendorCandidates(inputs: VendorDirInputs = {}): string[] {
  const cwd = inputs.cwd ?? process.cwd();
  const moduleDir = inputs.moduleDir === undefined ? moduleRelative() : inputs.moduleDir;
  const out: string[] = [];
  if (moduleDir) out.push(moduleDir);
  // Repo root (the CLI, tsx, the orchestrator) and web/ (next start / next dev).
  out.push(path.resolve(cwd, "worker", "vendor", "lighter"));
  out.push(path.resolve(cwd, "..", "worker", "vendor", "lighter"));
  return [...new Set(out)];
}

/**
 * The directory instantiateSigner reads the pinned files from.
 *
 * Override if set (never second-guessed); else the first candidate holding the
 * WASM; else the first candidate anyway, so the load fails as
 * `artifact-missing` naming a real path rather than succeeding somewhere
 * nobody chose.
 */
export function resolveLighterVendorDir(inputs: VendorDirInputs = {}): string {
  const env = inputs.env ?? process.env;
  const cwd = inputs.cwd ?? process.cwd();
  const override = env[LIGHTER_VENDOR_DIR_ENV]?.trim();
  if (override) return path.resolve(cwd, override);
  const exists = inputs.exists ?? existsSync;
  const candidates = lighterVendorCandidates(inputs);
  for (const dir of candidates) {
    if (exists(path.join(dir, WASM_FILE))) return dir;
  }
  return candidates[0] ?? path.resolve(cwd, "worker", "vendor", "lighter");
}
