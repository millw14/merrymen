/** Remove obsolete hosted key copies without erasing the original book or memory. */
import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, unlinkSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { carriesOwnerKey, isHostedMode } from "../../packages/core/src/hosted";

export const HOSTED_GRANT_CACHE_MAX_BYTES = 1024 * 1024;
const MAX_RETIRED_KEYS = 256;
const refuse = () => new Error("Hosted grant cache cleanup refused; retain the home and retry after verifying authority and file ownership.");

/** Fresh authoritative state, not the cached grant or an inferred roster omission. */
export interface HostedGrantCacheAuthority {
  readonly expiresAt: number;
  readonly replacementStop?: {
    readonly sessionKeyHash: string;
    readonly sessionKeyAddress: string;
  };
  readonly retiredSessionKeyHashes?: readonly string[];
}

export interface HostedGrantCacheOptions {
  nowSec: number;
  /** The caller excludes workers, holders, exiting processes and preparing spawns. */
  writerAbsent: boolean;
  /** Orchestrators may explicitly attest hosted mode; self-hosted defaults refuse. */
  hosted?: boolean;
  /** Synchronous race/failure injection only; production callers omit these hooks. */
  beforeFinalCheckForTest?: () => void;
  unlinkForTest?: (file: string) => void;
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}

function plainAncestors(home: string): void {
  if (!path.isAbsolute(home) || path.resolve(home) !== home) throw refuse();
  for (let dir = home; ; dir = path.dirname(dir)) {
    if (!lstatSync(dir).isDirectory()) throw refuse();
    if (dir === path.dirname(dir)) return;
  }
}

function fences(current: HostedGrantCacheAuthority): { retired: readonly string[]; stop?: HostedGrantCacheAuthority["replacementStop"] } {
  const retired = current.retiredSessionKeyHashes ?? [];
  if (!Array.isArray(retired) || retired.length > MAX_RETIRED_KEYS
      || retired.some((h) => typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h))) throw refuse();
  const stop = current.replacementStop;
  if (stop !== undefined && (!stop || typeof stop.sessionKeyHash !== "string"
      || !/^[0-9a-f]{64}$/.test(stop.sessionKeyHash) || typeof stop.sessionKeyAddress !== "string"
      || !/^0x[0-9a-f]{40}$/i.test(stop.sessionKeyAddress))) throw refuse();
  return { retired, stop };
}

/**
 * Invoke immediately after fetching current authority, with no intervening await.
 * null means a successful authoritative read found no armable grant (removed or
 * replacement-stopped), never that the store failed. An active current grant is
 * always preserved. This function has no awaits between that read and unlink.
 * Returns true only after deleting this cache and syncing its directory.
 */
export function scrubHostedGrantCache(
  home: string, current: HostedGrantCacheAuthority | null, o: HostedGrantCacheOptions,
): boolean {
  if (!(o.hosted ?? isHostedMode()) || !o.writerAbsent) return false;
  let fileFd: number | null = null;
  let homeFd: number | null = null;
  try {
    if (!Number.isSafeInteger(o.nowSec) || o.nowSec < 0) throw refuse();
    if (current !== null) {
      if (!Number.isSafeInteger(current.expiresAt) || current.expiresAt < 0) throw refuse();
      if (current.expiresAt > o.nowSec) return false;
    }
    const authorityFences = current === null ? null : fences(current);
    let homeStat: BigIntStats;
    try { homeStat = lstatSync(home, { bigint: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
    if (!homeStat.isDirectory()) throw refuse();
    plainAncestors(home);
    homeFd = openSync(home, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0));
    const openedHome = fstatSync(homeFd, { bigint: true });
    if (!openedHome.isDirectory() || openedHome.dev !== homeStat.dev || openedHome.ino !== homeStat.ino) throw refuse();

    const file = path.join(home, "grant.json");
    let before: BigIntStats;
    try { before = lstatSync(file, { bigint: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
    if (!before.isFile() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(HOSTED_GRANT_CACHE_MAX_BYTES)) throw refuse();
    fileFd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!sameFile(before, fstatSync(fileFd, { bigint: true }))) throw refuse();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const got = readSync(fileFd, bytes, count, bytes.length - count, count);
      if (got === 0) break;
      count += got;
    }
    if (count !== Number(before.size) || !sameFile(before, fstatSync(fileFd, { bigint: true }))) throw refuse();
    const cached: unknown = JSON.parse(bytes.subarray(0, count).toString("utf8"));
    if (!cached || typeof cached !== "object" || Array.isArray(cached) || carriesOwnerKey(cached)) throw refuse();
    const grant = cached as Record<string, unknown>;
    if (typeof grant.smartAccount !== "string" || !/^0x[0-9a-f]{40}$/i.test(grant.smartAccount)
        || typeof grant.serialized !== "string" || grant.serialized.length === 0
        || typeof grant.expiresAt !== "number" || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt < 0
        || typeof grant.demoSessionPrivateKey !== "string" || !/^0x[0-9a-f]{64}$/i.test(grant.demoSessionPrivateKey)) throw refuse();
    // Derive from the actual key; never let a claimed public address establish a stop.
    const session = privateKeyToAccount(grant.demoSessionPrivateKey as `0x${string}`).address;
    const digest = createHash("sha256").update(Buffer.from(grant.demoSessionPrivateKey.slice(2), "hex")).digest("hex");
    const stopped = authorityFences !== null && (authorityFences.retired.includes(digest)
      || (authorityFences.stop?.sessionKeyHash === digest && authorityFences.stop.sessionKeyAddress.toLowerCase() === session.toLowerCase()));
    if (current !== null && grant.expiresAt > o.nowSec && !stopped) return false;

    o.beforeFinalCheckForTest?.();
    plainAncestors(home);
    const finalHome = lstatSync(home, { bigint: true });
    if (!finalHome.isDirectory() || finalHome.dev !== openedHome.dev || finalHome.ino !== openedHome.ino
        || !sameFile(before, fstatSync(fileFd, { bigint: true })) || !sameFile(before, lstatSync(file, { bigint: true }))) throw refuse();
    (o.unlinkForTest ?? unlinkSync)(file);
    if (process.platform !== "win32") fsyncSync(homeFd);
    return true;
  } catch {
    // Never pass through parser, filesystem or key errors: they can contain secrets or paths.
    throw refuse();
  } finally {
    let closeFailed = false;
    try { if (fileFd !== null) closeSync(fileFd); } catch { closeFailed = true; }
    try { if (homeFd !== null) closeSync(homeFd); } catch { closeFailed = true; }
    if (closeFailed) throw refuse();
  }
}
