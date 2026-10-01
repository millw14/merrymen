const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const base = config.resolver.resolveRequest;

/**
 * Share packages/core with the rest of the repo instead of copying it.
 *
 * The grant screen needs the REAL token registry, the real Uniswap target
 * addresses and the real cap helpers. Re-typing those into the app would create a
 * second source of truth for the numbers that decide what a session key is allowed
 * to spend and touch — and the copy would drift silently, because nothing would
 * fail when it did. Aliasing means the phone and the worker are provably reading
 * the same constants.
 *
 * Safe to bundle: packages/core is plain TypeScript with no node built-ins (no
 * fs, no path, no crypto) — checked before wiring this up.
 *
 * watchFolders is required as well as the alias: Metro refuses to resolve files
 * outside the project root without it.
 */
const CORE = path.resolve(__dirname, "..", "packages", "core");
const WORKER = path.resolve(__dirname, "..", "worker");
const WEB = path.resolve(__dirname, "..", "web");
config.watchFolders = [...(config.watchFolders ?? []), CORE, WORKER, WEB];
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  "@merrymen/core": path.join(CORE, "src"),
  /**
   * Fund recovery, shared rather than reimplemented.
   *
   * worker/src/recover.ts rebuilds the smart account with the OWNER key as sudo
   * signer and sweeps it — the only path that works once a session key is gone or
   * expired. The dashboard already reaches it through this exact alias name (see
   * web/tsconfig.json), so the phone uses the same file rather than a second
   * implementation of the one operation that moves everything at once.
   *
   * It only pulls viem, @zerodev/* and packages/core, all of which bundle fine —
   * no node built-ins.
   */
  "@merrymen/recover": path.join(WORKER, "src", "recover.ts"),
};

/**
 * …and tell Metro where core's OWN dependencies live.
 *
 * Metro resolves a module's imports relative to that module's directory, walking
 * up from it. core/src/chain.ts does `import { defineChain } from "viem"`, so
 * Metro looked in ../node_modules and above — never in mobile/node_modules, where
 * viem actually is — and failed with "Unable to resolve module viem". The alias
 * alone is not enough; a shared package needs its dependencies findable too.
 *
 * mobile/node_modules is listed FIRST so the app's pinned versions win. That
 * matters: the repo root has four copies of @noble/curves and an older viem, and
 * silently bundling those instead of the app's deduped 1.9.7 would undo the
 * override and reintroduce the duplicate-curve cost.
 */
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, "node_modules"),
  path.resolve(__dirname, "..", "node_modules"),
];

/**
 * Stub merkletreejs.
 *
 * @zerodev/permissions' barrel re-exports serializeMultiChainPermissionAccounts,
 * which pulls in merkletreejs -> require('buffer') and crypto-js -> require('crypto').
 * Neither exists in React Native, so importing ANY symbol from that barrel drags
 * two unresolvable Node built-ins into the bundle — even though we never call the
 * multi-chain path.
 *
 * merrymen signs SINGLE-CHAIN grants only, so the cheaper fix is to stub the
 * module rather than ship buffer + crypto shims for code that never runs.
 *
 * CONSEQUENCE, stated plainly: serializeMultiChainPermissionAccounts will throw at
 * runtime. If merrymen ever adds multi-chain grants, DELETE this stub and add real
 * buffer/crypto polyfills instead of quietly re-enabling a broken path.
 */
config.resolver.resolveRequest = (ctx, moduleName, platform) => {
  if (moduleName === "merkletreejs") return { type: "empty" };
  return (base ?? ctx.resolveRequest)(ctx, moduleName, platform);
};

module.exports = config;
