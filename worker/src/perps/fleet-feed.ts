/**
 * ONE PUBLIC MARKET-DATA PUBLISHER PER ORCHESTRATOR; hosted Perps workers only
 * read its file.
 *
 * A hosted child never opens a Lighter socket of its own (lane.ts
 * isHostedChildProcess): it reads `$MERRYMEN_FLEET_HOME/lighter-feed.json`,
 * which childEnv points at this process's home. Without a writer there, every
 * hosted paper book reads "unread" for ever — opens refused (perp-unpriced),
 * stops and fills unpriceable. This is that writer: the same feed.ts a
 * self-hosted worker runs, started here once for the whole replica, over the
 * union of what this replica's Perps workers want.
 *
 *  - WHAT IT CARRIES is decided by the caller (orchestrator.ts): only this
 *    replica's own Perps workers, from the settings it handed them and the
 *    positions their own books hold — never a Spot worker, and never a file a
 *    child could write.
 *  - IT RUNS ONLY WHILE `enabled()` (the operator's MERRYMEN_PERPS=paper) and
 *    nothing halts it. Off, it holds no socket and makes no request, whatever
 *    is held: with perps off no Perps worker runs to read the file (its
 *    positions are frozen as a kill leaves them), so a feed would serve nobody.
 *  - ONE AT A TIME: refreshes are serialised, so two at once start one feed,
 *    and a stop while a refresh awaits its targets can never start a socket.
 *  - A FAILED TARGET READ KEEPS WHAT IT HAD, each half on its own: the
 *    markets the feed was carrying stay carried, and their file timestamps
 *    stay the truth — nothing synthetic is made fresh.
 *  - PUBLIC READS ONLY (budgetKey "public"): market data never bills a
 *    tenant's L1 bucket, and nothing here signs, sends or holds a key.
 */
import path from "node:path";
import { perpMarketById, perpMarketByKey, type MerrymenSettings } from "../../../packages/core/src/index";
import { mergeSettings } from "../settings";
import { createLighterApi } from "./api";
import { startLighterFeed, type LighterFeedHandle, type LighterFeedOptions } from "./feed";
import { LIGHTER_FEED_FILE } from "./feed-reader";

/** What this replica's Perps workers want: the settings handed to each, and the markets their books hold. */
export interface FleetPerpFeedTargets {
  settings: readonly MerrymenSettings[];
  heldMarketIds: readonly number[];
}

export interface FleetPerpFeedOptions {
  /** This orchestrator's home: the file goes to `<home>/lighter-feed.json`, where childEnv's MERRYMEN_FLEET_HOME points every child. */
  home: string;
  /** True when the publisher may run at all (the operator's MERRYMEN_PERPS=paper). */
  enabled: () => boolean;
  /** FLEET_HALT, or the fleet being called home. */
  halted: () => boolean;
  readSettings: () => Promise<readonly MerrymenSettings[]>;
  readHeld: () => Promise<readonly number[]>;
  env?: () => Record<string, string | undefined>;
  log?: (line: string) => void;
  /** Offline test seams; production uses startLighterFeed and the public client. */
  start?: (options: LighterFeedOptions) => Pick<LighterFeedHandle, "stop">;
  api?: () => LighterFeedOptions["api"];
}

export interface FleetPerpFeed {
  refresh(): Promise<void>;
  /** Stop for good: shutdown or the drain. A later refresh starts nothing. */
  stop(): void;
  /** Stop for now: FLEET_HALT. The next refresh that may run starts it again. */
  pause(): void;
  readonly running: boolean;
  readonly marketIds: readonly number[];
}

export function createFleetPerpFeed(o: FleetPerpFeedOptions): FleetPerpFeed {
  let handle: Pick<LighterFeedHandle, "stop"> | null = null;
  let closed = false;
  let markets: number[] = [];
  let held: number[] = [];
  let wanted: number[] = [];
  let tail = Promise.resolve();
  let lastError: string | null = null;
  const say = (line: string) => o.log?.(`[perps feed] ${line}`);
  const stopHandle = () => {
    const active = handle;
    handle = null;
    if (active === null) return;
    try {
      active.stop();
    } catch {
      /* stopping is best effort; the file ages into staleness either way */
    }
    say("fleet publisher stopped");
  };
  const unavailable = (half: string, e: unknown) => {
    const message = `${half}: ${e instanceof Error ? e.message : String(e)}`;
    if (message !== lastError) say(`fleet publisher kept its last ${half} — ${message}`);
    lastError = message;
  };
  const refresh = async () => {
    if (closed || o.halted() || !o.enabled()) return stopHandle();
    let settings: readonly MerrymenSettings[] | null = null;
    let heldNow: readonly number[] | null = null;
    try {
      settings = await o.readSettings();
    } catch (e) {
      unavailable("markets", e);
    }
    try {
      heldNow = await o.readHeld();
    } catch (e) {
      unavailable("held markets", e);
    }
    if (closed || o.halted() || !o.enabled()) return stopHandle();
    if (heldNow !== null) {
      held = [...new Set(heldNow.filter((id) => perpMarketById(id) !== null))].sort((a, b) => a - b);
    }
    if (settings !== null) {
      const ids = new Set<number>();
      for (const s of settings) {
        const cfg = mergeSettings(s, o.env?.() ?? process.env);
        if (!cfg.perpsEnabled || cfg.perpsOperatorCeiling === "off") continue;
        for (const key of cfg.perpsMarkets) {
          const market = perpMarketByKey(key);
          if (market) ids.add(market.marketId);
        }
      }
      wanted = [...ids];
    }
    if (settings !== null && heldNow !== null) lastError = null;
    markets = [...new Set([...wanted, ...held])].sort((a, b) => a - b);
    if (markets.length === 0) return stopHandle();
    if (handle === null) {
      handle = (o.start ?? startLighterFeed)({
        home: o.home,
        outPath: path.join(o.home, LIGHTER_FEED_FILE),
        marketIds: () => markets,
        heldMarketIds: () => held,
        api: o.api?.() ?? createLighterApi({ home: o.home, budgetKey: "public" }),
        logger: say,
      });
      say(`fleet publisher started for ${markets.length} market${markets.length === 1 ? "" : "s"}`);
    }
  };
  return {
    refresh() {
      // Never rejects: the orchestrator's loop must not see a throw.
      const run = tail.then(refresh).catch((e) => unavailable("feed", e));
      tail = run;
      return run;
    },
    stop() {
      closed = true;
      stopHandle();
    },
    pause() {
      stopHandle();
    },
    get running() {
      return handle !== null;
    },
    get marketIds() {
      return markets;
    },
  };
}
