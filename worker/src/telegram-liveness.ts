/**
 * IS ANYTHING HEARING THIS TENANT'S BOT? The orchestrator's question, asked
 * every pass for each tenant whose worker or hold process it runs
 * (orchestrator.ts telegramLiveness), and answered from the poll record that
 * process keeps in telegram.json (telegram/state.ts PollHealth).
 *
 * Nothing asked it before. In the incident this came from, an owner's bot was
 * not polled by anything for days: its worker was held back by a practice
 * book that would not restore, and the worker was the only thing that polled
 * it. The fleet's log had a restore failure every 17 seconds and not one line
 * saying that a bot had gone deaf, so nobody knew to look.
 *
 * ALERT ONLY, NEVER A KILL. The watchdog kills a worker whose trading tick has
 * stopped; this must never join it. A bot can be deaf for reasons no restart
 * fixes (a revoked token, another program reading its updates, Telegram
 * down), and a worker killed for them stops trading as well, a second outage
 * on top of the first. telegram-liveness.test.ts pins that the watchdog does
 * not read the poll record and that the liveness pass kills nothing.
 *
 * Pure: imports only the poll-rules parse of an error's kind.
 */
import { pollErrKind } from "./telegram/poll-rules";

/** A bot not heard for this long, while a process should be polling it, is alerted. */
export const LIVENESS_STALE_SEC = 600;

/**
 * - `off`: nothing should be polling (Telegram switched off, or no token).
 * - `live`: heard within LIVENESS_STALE_SEC of now, or of when this watch began.
 * - `revoked`: the last poll was refused (401 or 404): the token is revoked or
 *   wrong, and only the owner can fix it. Said at once, not after ten minutes:
 *   waiting cannot change it.
 * - `conflict`: not heard for too long, and the last poll failed with a 409:
 *   another program is reading the bot's updates, or a webhook is set.
 * - `stale`: not heard for too long, for any other reason, or none recorded.
 */
export type LivenessVerdict = "live" | "stale" | "revoked" | "conflict" | "off";

/** Is the recorded failure the latest outcome, rather than one a later success has overtaken? */
export function pollFailingNow(okAt: number | null, err: string | null, errAt: number | null): boolean {
  return err !== null && (okAt === null || errAt === null || errAt >= okAt);
}

/**
 * THE VERDICT. `since` is when this replica began watching the tenant's bot
 * (orchestrator.ts livenessWatch): a watch that has only just begun, after a
 * redeploy or a lease taken over, is not stale for a record it cannot vouch
 * for or for having none yet. The later of the two is the clock. It is not
 * restarted with each new process, so a bot whose processes keep dying is
 * still said.
 */
export function telegramLivenessVerdict(p: {
  enabled: boolean;
  okAt: number | null;
  err: string | null;
  errAt?: number | null;
  since?: number | null;
  now: number;
}): LivenessVerdict {
  if (!p.enabled) return "off";
  const failing = pollFailingNow(p.okAt, p.err, p.errAt ?? null);
  const kind = pollErrKind(p.err);
  if (failing && kind === "refused") return "revoked";
  const heard = Math.max(p.okAt ?? 0, p.since ?? 0);
  if (p.now - heard <= LIVENESS_STALE_SEC) return "live";
  return failing && kind === "conflict" ? "conflict" : "stale";
}

const iso = (sec: number): string => new Date(sec * 1000).toISOString();

/**
 * The [alert] line for a verdict worth one, or null. A revoked token gets a
 * line of its own because its remedy is the owner's, not the operator's; a
 * conflict is a bot not polling like any other, and its error says why.
 * Never the token, and never the link code, and one line only: the error is
 * as state.ts parsePollHealth read it, cleaned of anything shaped like a
 * token and of line breaks, whatever wrote the file.
 */
export function livenessAlertLine(
  tenant: string,
  verdict: LivenessVerdict,
  p: { okAt: number | null; err: string | null; since: number },
): string | null {
  if (verdict === "revoked") {
    return `[alert] telegram bot token refused: ${tenant} — its owner has to paste a new token from @BotFather (${p.err ?? "no reason recorded"})`;
  }
  if (verdict !== "stale" && verdict !== "conflict") return null;
  const when = p.okAt !== null ? iso(p.okAt) : `the watch began at ${iso(p.since)}, with no poll that worked`;
  return `[alert] telegram not polling: ${tenant} since ${when} (${p.err ?? "no failure recorded"})`;
}
