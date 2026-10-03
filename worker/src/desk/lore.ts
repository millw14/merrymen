/**
 * What a coin says it is, alongside the desk's measured chart evidence.
 *
 * Reads only the exact Robinhood contract: GeckoTerminal token info plus the
 * existing Pons metadata getter. Published descriptions are attributed claims,
 * not verified origin stories, official affiliations, or trading authority.
 * No website/social URL is visited and no additional paid provider is used.
 */
import type { PublicClient } from "viem";
import { readTokenMeta, type TokenMeta } from "../venues/pons-meta";
import type { FeedResult } from "../venues/fleet-feed-cache";
import { geckoSource } from "../venues/geckoterminal";
import { cleanProjectText, projectLink, readTokenInfo, type TokenInfoRead } from "./gecko";
import { DESK_LOOKUP_MS, type DeskReadOptions } from "./deadline";

export const LORE_READ_MS = 3000;
export const LORE_CHAIN_ID = 4663;

export interface CoinProfile {
  token: `0x${string}`;
  chainId: typeof LORE_CHAIN_ID;
  /** Publisher's bounded prose. Empty means links were published without a description. */
  description: string;
  name?: string;
  source: "GeckoTerminal token info" | "token-published metadata";
  /** Fixed, contract-bound attribution page; never a launcher-chosen destination. */
  url: string;
  observedAtMs: number;
  /** Launcher/index-published links, not verified official identities. */
  website?: string;
  twitter?: string;
}

export interface LoreRead extends FeedResult {
  profile?: CoinProfile;
}

export interface LoreReaderDeps {
  /** Only a mainnet client can supply Pons metadata. A testnet client is ignored. */
  client?: PublicClient;
  indexed?: (address: string, timeoutMs: number, signal: AbortSignal) => Promise<TokenInfoRead>;
  metadata?: typeof readTokenMeta;
  now?: () => number;
}

function publishedProfile(meta: TokenMeta | undefined, token: `0x${string}`, observedAtMs: number): CoinProfile | undefined {
  if (!meta || meta.token.toLowerCase() !== token) return undefined;
  const description = cleanProjectText(meta.description);
  const website = projectLink(meta.website);
  const rawTwitter = typeof meta.twitter === "string" ? meta.twitter.trim() : "";
  const handle = /^@?[a-z0-9_]{1,15}$/i.test(rawTwitter) ? rawTwitter.replace(/^@/, "") : undefined;
  const socialUrl = projectLink(rawTwitter);
  const twitter = handle ? `https://x.com/${handle}` : socialUrl && /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[a-z0-9_]{1,15}\/?$/i.test(socialUrl) ? socialUrl : undefined;
  if (!description && !website && !twitter) return undefined;
  return {
    token, chainId: LORE_CHAIN_ID, description,
    source: "token-published metadata",
    url: `https://explorer.robinhood.com/address/${token}`,
    observedAtMs,
    ...(website ? { website } : {}), ...(twitter ? { twitter } : {}),
  };
}

function indexedProfile(read: TokenInfoRead | undefined, token: `0x${string}`, observedAtMs: number): CoinProfile | undefined {
  const info = read?.failed === false ? read.info : undefined;
  if (!info || info.token !== token || (!info.description && !info.website && !info.twitter)) return undefined;
  return {
    token, chainId: LORE_CHAIN_ID, description: info.description,
    ...(info.name ? { name: info.name } : {}),
    source: "GeckoTerminal token info",
    url: `https://www.geckoterminal.com/robinhood/tokens/${token}`,
    observedAtMs: read?.observedAt ?? observedAtMs,
    ...(info.website ? { website: info.website } : {}), ...(info.twitter ? { twitter: info.twitter } : {}),
  };
}

function readLimit(options?: DeskReadOptions): number {
  // A cold fleet read may wait for the next spacing slot before it starts its
  // three-second network timeout. The owning lookup supplies the total slice;
  // it can never exceed that lookup's existing ten-second budget.
  return options?.timeoutMs === undefined ? LORE_READ_MS : Number.isFinite(options.timeoutMs) ? Math.max(0, Math.min(DESK_LOOKUP_MS, Math.floor(options.timeoutMs))) : 0;
}

/** Per-caller cancellation cannot extend a shared read or refresh cached provenance. */
async function waitFor<T>(job: Promise<T>, ms: number, signal: AbortSignal | undefined, timeout: T): Promise<T> {
  if (ms < 1 || signal?.aborted) return timeout;
  let timer: ReturnType<typeof setTimeout>;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(timeout), ms);
    if (signal) {
      onAbort = () => resolve(timeout);
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try { return await Promise.race([job, stop]); }
  finally {
    clearTimeout(timer!);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Pons metadata and index metadata run together within the lookup's slice.
 * Index network work remains capped at three seconds, after fleet pacing.
 * A slow quota slot or RPC does not erase a description already obtained from
 * the other source. Concurrent asks share one public read per source/address.
 */
export function createLoreReader(d: LoreReaderDeps = {}): (address: string, options?: DeskReadOptions) => Promise<LoreRead> {
  const indexed = d.indexed ?? readTokenInfo;
  const metadata = d.metadata ?? readTokenMeta;
  const now = d.now ?? Date.now;
  const memo = new Map<string, { until: number; value: LoreRead }>();
  const pending = new Map<string, Promise<LoreRead>>();
  return async (address, options) => {
    const token = typeof address === "string" ? address.toLowerCase() : "";
    if (!/^0x[\da-f]{40}$/.test(token)) return { failed: true, failure: "invalid-token" };
    const timeout: LoreRead = { failed: true, failure: "timeout" };
    const ms = readLimit(options);
    if (ms < 1 || options?.signal?.aborted) return timeout;
    const useMeta = d.client?.chain?.id === LORE_CHAIN_ID;
    const key = `${geckoSource().id}:${LORE_CHAIN_ID}:${useMeta ? "with-published" : "index-only"}:${token}`;
    const hit = memo.get(key);
    if (hit && hit.until > now()) return hit.value;
    const joined = pending.get(key);
    if (joined) return waitFor(joined, ms, options?.signal, timeout);
    const at = now();
    const ctl = new AbortController();
    let indexedRead: TokenInfoRead | undefined;
    let published: CoinProfile | undefined;
    let job: Promise<LoreRead>;
    let publishReady: (result: LoreRead) => void;
    const preferred = new Promise<LoreRead>((resolve) => { publishReady = resolve; });
    const select = (): LoreRead => {
      const info = indexedProfile(indexedRead, token as `0x${string}`, at);
      // A real description wins over a source carrying just a social handle.
      const profile = published?.description ? published : info?.description ? info : published ?? info;
      return profile ? { failed: false, observedAt: profile.observedAtMs, profile }
        : indexedRead && !indexedRead.failed ? { failed: false, observedAt: indexedRead.observedAt ?? at }
          : { failed: true, failure: indexedRead?.failure ?? "unavailable" };
    };
    // Start the index read now, rather than deferring it to another microtask:
    // measureCoin deliberately admits lore before hourly candles, and a defer
    // here would hand the fleet's next quota slot to the lower-priority chart.
    const start = <T>(read: () => Promise<T>): Promise<T> => {
      try { return Promise.resolve(read()); } catch (error) { return Promise.reject(error); }
    };
    const work = Promise.allSettled([
      start(() => indexed(token, Math.min(LORE_READ_MS, ms), ctl.signal)).then((r) => { if (!ctl.signal.aborted) indexedRead = r; }),
      ...(useMeta ? [waitFor(start(() => metadata(d.client!, [token as `0x${string}`])), Math.min(LORE_READ_MS, ms), ctl.signal, new Map<string, TokenMeta>())
        .then((r) => {
          if (ctl.signal.aborted) return;
          published = publishedProfile(r.get(token), token as `0x${string}`, at);
          if (published?.description) publishReady(select());
        })] : []),
    ]).then(select);
    // Timeout uses the completed source rather than throwing away partial lore.
    job = waitFor(Promise.race([work, preferred]), ms, options?.signal, timeout)
      .then((r) => r === timeout ? select() : r)
      .then((value) => {
        if (memo.size >= 256) memo.delete(memo.keys().next().value!);
        memo.set(key, { until: value.failed ? now() + 5000 : (value.observedAt ?? at) + 60_000, value });
        return value;
      })
      .finally(() => { ctl.abort(); if (pending.get(key) === job) pending.delete(key); });
    pending.set(key, job);
    return job;
  };
}

/** Gecko-only default. Production can add its existing mainnet public client. */
export const readCoinLore = createLoreReader();
