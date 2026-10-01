/** Build a portable release tarball from the audited installed dependency tree.
 * npm does not inherit a dependency's overrides. Bundle the affected JS trees;
 * leave optional/native packages for npm to install on the consumer's platform.
 * All manifest normalization happens in a disposable staging directory. */
import { createHash } from "node:crypto";
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import Arborist from "@npmcli/arborist";
import packlist from "npm-packlist";

export const BUNDLE_ROOTS = ["next", "@privy-io/react-auth", "@zerodev/permissions"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const json = filename => JSON.parse(readFileSync(filename, "utf8"));
const writeJson = (filename, value) => writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
const isEnvironmentFile = filename => /(?:^|[\\/])\.env(?:\.[^\\/]*)?$/.test(filename);
function refuseEnvironmentFile(filename) {
  if (isEnvironmentFile(filename)) throw new Error("Refusing to package an environment file. Exclude .env and .env.* from release files.");
}

function resolveLocked(packages, from, name, required = true) {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error(`Invalid dependency name: ${name}`);
  for (let ancestor = from; ; ) {
    const candidate = `${ancestor ? `${ancestor}/` : ""}node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!ancestor) {
      if (!required) return undefined;
      throw new Error(`The lock is missing ${name} required by ${from || "the package"}.`);
    }
    const index = ancestor.lastIndexOf("/node_modules/");
    ancestor = index < 0 ? "" : ancestor.slice(0, index);
  }
}

export function runtimeBundlePlan(manifest, lock, bundleRoots = BUNDLE_ROOTS) {
  if (lock.lockfileVersion !== 3 || lock.name !== manifest.name || lock.version !== manifest.version) throw new Error("A matching version 3 package-lock.json is required.");
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    if (JSON.stringify(Object.entries(manifest[field] ?? {}).sort()) !== JSON.stringify(Object.entries(lock.packages?.[""]?.[field] ?? {}).sort())) throw new Error(`The package lock has stale ${field}; run npm install first.`);
  }
  const packages = lock.packages;
  const staged = structuredClone(manifest);
  delete staged.devDependencies;
  delete staged.overrides;
  staged.bundleDependencies = [...bundleRoots];
  staged.optionalDependencies = {};
  for (const [name] of Object.entries(staged.dependencies ?? {})) staged.dependencies[name] = packages[resolveLocked(packages, "", name)].version;
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) staged.optionalDependencies[name] = packages[resolveLocked(packages, "", name)].version;
  for (const script of ["prepack", "postpack", "prepublishOnly", "prepare", "pack:release"]) delete staged.scripts?.[script];
  staged.files = (staged.files ?? []).filter(file => file !== "npm-shrinkwrap.json");
  const bundled = new Set();
  const visit = rel => {
    if (bundled.has(rel)) return;
    const entry = packages[rel];
    if (entry.dev || entry.link || entry.os || entry.cpu || entry.libc) throw new Error(`Cannot bundle a development, linked, or platform-specific dependency: ${rel}`);
    bundled.add(rel);
    for (const name of Object.keys(entry.dependencies ?? {})) if (!entry.optionalDependencies?.[name]) visit(resolveLocked(packages, rel, name));
  };
  for (const name of bundleRoots) {
    if (!manifest.dependencies?.[name]) throw new Error(`Bundle root ${name} must be a direct production dependency.`);
    visit(resolveLocked(packages, "", name));
  }
  // Bundles suppress npm's automatic peer installation. Keep required peers
  // explicit and pinned; absent optional peers remain deliberately absent.
  for (const rel of bundled) {
    for (const name of Object.keys(packages[rel].peerDependencies ?? {})) {
      if (packages[rel].peerDependenciesMeta?.[name]?.optional) continue;
      const target = resolveLocked(packages, rel, name);
      if (bundled.has(target)) continue;
      const version = packages[target].version;
      const existing = staged.dependencies?.[name];
      if (existing && existing !== version) throw new Error(`Cannot flatten conflicting required peer ${name}: ${existing} versus ${version}.`);
      staged.dependencies[name] = version;
    }
  }
  const normalized = [];
  for (const rel of bundled) {
    const externalOptionals = [];
    const externalPeers = Object.keys(packages[rel].peerDependencies ?? {}).filter(name => {
      const target = resolveLocked(packages, rel, name, false);
      return !target || !bundled.has(target);
    });
    for (const name of Object.keys(packages[rel].optionalDependencies ?? {})) {
      const target = resolveLocked(packages, rel, name);
      if (bundled.has(target)) continue;
      const version = packages[target].version;
      const existing = staged.dependencies?.[name] ?? staged.optionalDependencies[name];
      if (existing && existing !== version) throw new Error(`Cannot flatten conflicting optional dependency ${name}: ${existing} versus ${version}.`);
      if (!staged.dependencies?.[name]) staged.optionalDependencies[name] = version;
      externalOptionals.push(name);
    }
    normalized.push({ path: rel, version: packages[rel].version, externalOptionals, externalPeers });
  }
  return { manifest: staged, packages: normalized };
}

function npmJson(args, cwd) {
  const result = spawnSync("npm", args, { cwd, encoding: "utf8", shell: process.platform === "win32", maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed: ${result.stderr || result.error || result.stdout}`);
  return JSON.parse(result.stdout);
}

function assertInside(root, filename) {
  const relative = path.relative(realpathSync(root), realpathSync(filename));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Refusing to copy a file outside the package: ${filename}`);
}

export async function packRuntime({ root, outDir, bundleRoots = BUNDLE_ROOTS, requireBuild = true }) {
  root = path.resolve(root);
  outDir = path.resolve(outDir);
  if (requireBuild) {
    for (const name of ["BUILD_ID", "required-server-files.json", "prerender-manifest.json", "routes-manifest.json"]) if (!existsSync(path.join(root, "web/.next", name))) throw new Error(`Production dashboard is incomplete (${name}); run npm run pack:release.`);
    if (!existsSync(path.join(root, "sdk/dist/browser.js"))) throw new Error("The browser SDK is missing; run npm run pack:release.");
  }
  const lockBytes = readFileSync(path.join(root, "package-lock.json"));
  const plan = runtimeBundlePlan(json(path.join(root, "package.json")), JSON.parse(lockBytes), bundleRoots);
  const stage = mkdtempSync(path.join(tmpdir(), "merrymen-release-"));
  try {
    // npm 10 still runs prepare during `pack --dry-run --ignore-scripts`.
    // Read npm's file list directly so source lifecycle scripts cannot execute.
    // This also avoids temporarily modifying the source package manifest.
    const tree = await new Arborist({ path: root }).loadActual();
    const files = await packlist(tree);
    for (const file of files) refuseEnvironmentFile(file);
    for (const rel of files) {
      if (rel === "npm-shrinkwrap.json" || rel === "package-lock.json") continue;
      const source = path.join(root, rel);
      assertInside(root, source);
      const destination = path.resolve(stage, rel);
      if (!destination.startsWith(`${stage}${path.sep}`)) throw new Error(`Invalid package file path: ${rel}`);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
    const report = { lockSha256: digest(lockBytes), bundleRoots, packages: [] };
    for (const entry of plan.packages) {
      const source = path.join(root, entry.path);
      assertInside(path.join(root, "node_modules"), source);
      const originalBytes = readFileSync(path.join(source, "package.json"));
      const installed = JSON.parse(originalBytes);
      if (installed.version !== entry.version) throw new Error(`Installed ${entry.path} is ${installed.version}; the audited lock requires ${entry.version}. Run npm ci.`);
      const destination = path.join(stage, entry.path);
      cpSync(source, destination, { recursive: true, mode: constants.COPYFILE_FICLONE, filter: filename => {
        refuseEnvironmentFile(filename);
        return filename === source || path.basename(filename) !== "node_modules";
      } });
      for (const name of entry.externalOptionals) {
        delete installed.optionalDependencies[name];
        if (installed.dependencies) delete installed.dependencies[name];
      }
      // npm otherwise marks these root-provided peers as bundled meta-deps and
      // leaves empty directories instead of installing their pinned packages.
      for (const name of entry.externalPeers) {
        delete installed.peerDependencies[name];
        if (installed.peerDependenciesMeta) delete installed.peerDependenciesMeta[name];
      }
      if (entry.externalOptionals.length || entry.externalPeers.length) writeJson(path.join(destination, "package.json"), installed);
      report.packages.push({ ...entry, originalManifestSha256: digest(originalBytes) });
    }
    writeJson(path.join(stage, "package.json"), plan.manifest);
    mkdirSync(path.join(stage, "cli"), { recursive: true });
    writeJson(path.join(stage, "cli/runtime-dependencies.json"), report);
    const [packed] = npmJson(["pack", "--ignore-scripts", "--json"], stage);
    for (const file of packed.files) refuseEnvironmentFile(file.path);
    mkdirSync(outDir, { recursive: true });
    const output = path.join(outDir, packed.filename);
    copyFileSync(path.join(stage, packed.filename), output, constants.COPYFILE_EXCL);
    return { path: output, size: packed.size, bundledPackages: plan.packages.length };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--out-dir")) throw new Error("Usage: node cli/pack-runtime.mjs [--out-dir directory]");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await packRuntime({ root, outDir: args[1] ?? path.join(root, "release") });
  console.log(JSON.stringify(result));
}
