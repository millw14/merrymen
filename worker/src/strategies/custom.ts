/**
 * User-written strategies — the plugin surface. Drop a file in strategies/
 * (repo root) exporting the Strategy contract and select it by filename in
 * /settings or `merrymen onboard`. Like every built-in, a custom strategy
 * only PROPOSES: each returned intent is shape-validated here, then faces
 * checkPolicy → quote simulation → the on-chain session-key wall. A buggy or
 * hostile strategy file can waste its own tick; it cannot exceed the caps.
 *
 * Loading is lazy and hot: the file is (re)imported when its mtime changes,
 * so editing your strategy applies on the next tick — no restarts. A load
 * failure or a thrown tick degrades to "no trades this tick" with the reason
 * in the event feed, never a crash.
 */

import { statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { TradeIntent } from "../policy";
import type { Snapshot, Strategy } from "./types";

const EXTENSIONS = [".ts", ".mts", ".mjs", ".js"];

export function customStrategiesDir(): string {
  return process.env.MERRYMEN_STRATEGIES_DIR ?? path.join(process.cwd(), "..", "strategies");
}

/** Find the strategy file for a name, or null. Names are plain tokens — no paths. */
export function resolveStrategyFile(name: string, dir: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return null; // no traversal, no weirdness
  for (const ext of EXTENSIONS) {
    const file = path.join(dir, `${name}${ext}`);
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      // keep looking
    }
  }
  return null;
}

function isHexAddress(v: unknown): v is `0x${string}` {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}

/**
 * Shape-check one intent from user code. Anything malformed is dropped with a
 * reason — never repaired. Economic limits are checkPolicy's job, not ours.
 */
export function validateIntent(raw: unknown): { intent: TradeIntent | null; reason?: string } {
  if (!raw || typeof raw !== "object") return { intent: null, reason: "not an object" };
  const i = raw as Record<string, unknown>;
  if (i.kind === "swap") {
    if (!isHexAddress(i.target)) return { intent: null, reason: "swap.target is not an address" };
    if (!isHexAddress(i.sellToken) || !isHexAddress(i.buyToken)) {
      return { intent: null, reason: "swap tokens must be addresses" };
    }
    if (typeof i.sellAmountRaw !== "bigint" || i.sellAmountRaw <= 0n) {
      return { intent: null, reason: "swap.sellAmountRaw must be a positive bigint" };
    }
    if (typeof i.notionalUsdg !== "bigint" || i.notionalUsdg <= 0n) {
      return { intent: null, reason: "swap.notionalUsdg must be a positive bigint" };
    }
    return {
      intent: {
        kind: "swap",
        target: i.target,
        sellToken: i.sellToken,
        buyToken: i.buyToken,
        sellAmountRaw: i.sellAmountRaw,
        notionalUsdg: i.notionalUsdg,
      },
    };
  }
  if (i.kind === "vault-deposit" || i.kind === "vault-withdraw") {
    if (!isHexAddress(i.target)) return { intent: null, reason: `${i.kind}.target is not an address` };
    if (typeof i.amountUsdg !== "bigint" || i.amountUsdg <= 0n) {
      return { intent: null, reason: `${i.kind}.amountUsdg must be a positive bigint` };
    }
    return { intent: { kind: i.kind, target: i.target, amountUsdg: i.amountUsdg } };
  }
  return { intent: null, reason: `unknown kind ${String(i.kind)}` };
}

interface LoadedModule {
  mtimeMs: number;
  strategy: { name?: string; tick: (snap: Snapshot) => unknown } | null;
  error?: string;
}

/**
 * Wrap a user strategy file as a Strategy. Import happens inside tick so a
 * bad file never breaks worker startup, and an edited file reloads on mtime.
 */
export function makeCustomStrategy(
  name: string,
  opts?: {
    dir?: string;
    onNote?: (level: "ok" | "warn", message: string) => void;
    /** Injectable for tests. */
    importer?: (fileUrl: string) => Promise<unknown>;
  },
): Strategy {
  const dir = opts?.dir ?? customStrategiesDir();
  const note = opts?.onNote ?? ((l, m) => console.log(`[custom:${l}] ${m}`));
  const importer = opts?.importer ?? ((url) => import(url));
  let loaded: LoadedModule | null = null;

  async function load(): Promise<LoadedModule> {
    const file = resolveStrategyFile(name, dir);
    if (!file) {
      return { mtimeMs: 0, strategy: null, error: `no strategy file "${name}" in ${dir}` };
    }
    const mtimeMs = statSync(file).mtimeMs;
    if (loaded && loaded.mtimeMs === mtimeMs && loaded.strategy) return loaded;

    try {
      // mtime in the URL busts the ESM module cache → edits apply next tick.
      const mod = (await importer(`${pathToFileURL(file).href}?v=${mtimeMs}`)) as Record<string, unknown>;
      const candidate = (mod.default ?? mod.strategy) as LoadedModule["strategy"];
      if (!candidate || typeof candidate.tick !== "function") {
        return {
          mtimeMs,
          strategy: null,
          error: `${path.basename(file)} must default-export { name, tick(snapshot) }`,
        };
      }
      if (loaded?.strategy) note("ok", `custom strategy "${name}" reloaded (file changed)`);
      return { mtimeMs, strategy: candidate };
    } catch (e) {
      return {
        mtimeMs,
        strategy: null,
        error: `failed to load ${path.basename(file)}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  let lastError: string | null = null;

  return {
    name: `custom:${name}`,
    async tick(snap: Snapshot): Promise<TradeIntent[]> {
      loaded = await load();
      if (!loaded.strategy) {
        if (loaded.error && loaded.error !== lastError) {
          note("warn", loaded.error);
          lastError = loaded.error;
        }
        return [];
      }
      lastError = null;

      let raw: unknown;
      try {
        raw = await loaded.strategy.tick(snap);
      } catch (e) {
        note("warn", `custom strategy "${name}" threw: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
      if (!Array.isArray(raw)) {
        if (raw !== undefined && raw !== null) {
          note("warn", `custom strategy "${name}" returned ${typeof raw}, expected an array of intents`);
        }
        return [];
      }

      const intents: TradeIntent[] = [];
      for (const [idx, r] of raw.entries()) {
        const { intent, reason } = validateIntent(r);
        if (intent) intents.push(intent);
        else note("warn", `custom strategy "${name}" intent #${idx} dropped: ${reason}`);
      }
      return intents;
    },
  };
}
