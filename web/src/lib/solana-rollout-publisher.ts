/**
 * THE WEB PUBLISHES ITS LIVE ROLLOUT SETTINGS AS IT STARTS, AND EVERY 30 SECONDS AFTER.
 *
 * The Solana worker lets its live buys through only while the web's latest digest of MERRYMEN_SOLANA_LIVE_TENANTS and
 * MERRYMEN_SOLANA_LIVE_MAX_* equals its own (SETTINGS THAT MUST MATCH, CHECKED, in worker/src/solana-app-runtime.ts). A web
 * that published only when it served a Solana request left the digest of its previous settings in place after a redeploy
 * until someone opened the Solana page: a worker redeployed meanwhile with a tenant re-added, or caps raised, matched that
 * old digest and bought under settings the running web no longer ran. So the web's server (web/src/instrumentation.ts)
 * publishes once as it starts, and again every SOLANA_LIVE_ROLLOUT_PUBLISH_MS, which also replaces, within that interval,
 * a digest an old web container still draining during a deploy wrote after the new one's.
 *
 * Only while this deployment offers Solana (MERRYMEN_SOLANA=1): otherwise nothing is loaded or written. Best effort: a
 * publish that fails never stops the web from starting or serving. Each failure says an [alert] (solana-live-rollout
 * unpublished), at most once a minute per process, naming no value: until a publish succeeds the worker judges the last
 * digest written as the web's, which may be out of date. One publish at a time; a tick that finds one still running skips.
 */
import { SOLANA_LIVE_ROLLOUT_PUBLISH_MS } from "../../../worker/src/solana-live-rollout";
import { solanaEnabled } from "./solana-enabled";

/** At most one [alert] a minute per process, as every other Solana [alert]. */
const ALERT_REPEAT_MS = 60_000;
export const SOLANA_ROLLOUT_UNPUBLISHED_ALERT = "[alert] solana-live-rollout unpublished: the web could not publish its MERRYMEN_SOLANA_LIVE_TENANTS and "
  + "MERRYMEN_SOLANA_LIVE_MAX_* digest (solana_runtime_live_rollout_seen); until it can, the Solana worker judges the last one published as the web's, "
  + "which may be out of date, so it may hold its live buys or let them through under settings this web no longer runs. Retried every 30 s and "
  + "at every Solana request; check the web's DATABASE_URL (exits, revoke and withdraw continue)";

export interface SolanaRolloutPublisherOptions {
  /** Whether this deployment offers Solana. Default solanaEnabled(). */
  enabled?: () => boolean;
  /** Writes the web's digest. Default: the web's app runtime's publishLiveRollout(), loaded only when enabled. */
  publish?: () => Promise<void>;
  /** Operator lines. Default: stderr. */
  log?: (line: string) => void;
  now?: () => number;
  /** The timer, for tests. Default: setInterval, unref'd so it never keeps a process alive. */
  every?: (run: () => void, ms: number) => { stop(): void };
}
export interface SolanaRolloutPublisher {
  /** The publish made as it started; it never rejects. */
  readonly started: Promise<void>;
  stop(): void;
}

function defaultEvery(run: () => void, ms: number): { stop(): void } {
  const timer = setInterval(run, ms);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
async function defaultPublish(): Promise<void> {
  const { getSolanaAppRuntime } = await import("../../../worker/src/solana-app-runtime");
  await getSolanaAppRuntime().publishLiveRollout();
}

/** Starts publishing: once now, then every SOLANA_LIVE_ROLLOUT_PUBLISH_MS. Null, doing nothing, while Solana is off. */
export function startSolanaRolloutPublisher(options: SolanaRolloutPublisherOptions = {}): SolanaRolloutPublisher | null {
  if (!(options.enabled ?? solanaEnabled)()) return null;
  const publish = options.publish ?? defaultPublish, now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  let running: Promise<void> | null = null, alertAtMs: number | undefined;
  const once = (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      try { await publish(); } catch {
        const at = now();
        if (alertAtMs === undefined || at < alertAtMs || at - alertAtMs >= ALERT_REPEAT_MS) {
          alertAtMs = at;
          try { log(SOLANA_ROLLOUT_UNPUBLISHED_ALERT); } catch { /* Logging never changes an outcome. */ }
        }
      } finally { running = null; }
    })();
    return running;
  };
  const started = once();
  const timer = (options.every ?? defaultEvery)(() => { void once(); }, SOLANA_LIVE_ROLLOUT_PUBLISH_MS);
  return { started, stop: () => timer.stop() };
}

const STARTED = Symbol.for("merrymen.solana-rollout-publisher");
/** The web server's publisher once started (startSolanaWebRolloutPublisher), else undefined. */
export function solanaWebRolloutPublisher(): SolanaRolloutPublisher | undefined {
  return (globalThis as { [STARTED]?: SolanaRolloutPublisher })[STARTED];
}
/**
 * The web server's publisher (web/src/instrumentation.ts), started at most once per process: a second call (a dev server
 * registering again) returns the first.
 */
export function startSolanaWebRolloutPublisher(): SolanaRolloutPublisher | null {
  const holder = globalThis as { [STARTED]?: SolanaRolloutPublisher };
  const running = holder[STARTED] ?? startSolanaRolloutPublisher();
  if (running) holder[STARTED] = running;
  return running;
}
