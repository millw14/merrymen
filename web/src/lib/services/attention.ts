/**
 * What needs the owner, across their agents, in one read.
 *
 * Built for an assistant that checks in by itself every few hours (Claude
 * Duet's periodic checks and morning brief, a scheduled task, a cron) and has
 * to decide whether to interrupt the owner. So every item carries:
 *
 *  - a SEVERITY with one fixed meaning (SEVERITY_MEANING), so two clients
 *    never disagree about what is urgent;
 *  - a stable KEY, the same on every read while the condition and its
 *    severity hold. A client that hands back the keys it already reported is
 *    told which items are new and which have resolved, so it can stay quiet
 *    about what the owner has heard and say so when something is fixed. A
 *    severity that rises (a permission three days from expiry, then one) is a
 *    new key, so it is news again. A key is built only from durable facts (an
 *    expiry, a heartbeat, a blocker rule, a proposal id), NEVER from a time
 *    read inside the lookback window: that time moves as the window slides
 *    (a run's first sighting becomes unknown, the oldest refusal ages out)
 *    and would re-announce a condition that never changed. A condition with
 *    no durable identity (a tripped breaker, a reached cap) is keyed `on`;
 *    one that clears and recurs between two checks is therefore the same
 *    key, while one reported resolved and then recurring is news again;
 *  - STARTED_AT, when the condition began or crossed into its severity, or
 *    null when no record says (a live blocker is a current fact on the
 *    agent's row, with no time). Never a guess.
 *
 * NOT A SECOND OPINION. Every condition here is one another surface already
 * reports, read the same way:
 *   status, live blocker, worker liveness ..... agent-status.ts (readAgentRow,
 *                                                blockerView, freshWithin)
 *   what a blocker means and who fixes it ..... live-blocker.ts blockerAdvice
 *   permission expiry .......................... the signed grant (OwnedAgent.expiresAt)
 *   kill switch, breaker, provider failure .... the events the risk_halt and
 *                                                provider_failure alerts read
 *                                                (notify.ts classifyAlertEvent)
 *   an arm failure ............................. the event the inactivity
 *                                                diagnosis reads (classifyEvent)
 *   a recovery hold ............................ fleet-recovery.ts
 *                                                readFleetRecoveryHold, tested
 *                                                first, as the diagnosis does
 *   spending and trade-count caps .............. rejected trades, daily-cap / ops-cap
 *
 * NO RISK LIMIT IS OFFERED AS A FIX. A tripped breaker or a reached cap is the
 * signed permission doing its job: the item says what it holds back and that
 * selling is not blocked, and has no what_to_do.
 *
 * READ-ONLY AND INDEXED. Nothing here expires a proposal, follows a trade or
 * marks an alert sent: a check every few hours must not change what it checks.
 * Events and trades are read by the exact spellings an account can be stored
 * under (notify.ts spellings), never lower(agent_id), so the (agent_id,
 * created_at) indexes serve them; the agent's row is the only status read.
 */
import type { Db } from "../../../../worker/src/db";
import { classifyAlertEvent, DELIVERY_ERROR_TEXT, PROVIDER_TEXT, spellings } from "../../../../worker/src/mcp/notify";
import { blockerAdvice } from "../live-blocker";
import { blockerView, freshWithin, readAgentRow } from "./agent-status";
import { classifyEvent } from "./inactivity";
import { SETTINGS_ARM_REFUSAL_PREFIX } from "../../../../worker/src/settings";
import { readFleetRecoveryHold } from "../../../../worker/src/fleet-recovery";
import type { SettingsView } from "./settings-view";

export type Severity = "act_now" | "today" | "fyi";
export const SEVERITIES: readonly Severity[] = ["act_now", "today", "fyi"];

export const SEVERITY_MEANING: Readonly<Record<Severity, string>> = Object.freeze({
  act_now: "Trading has stopped or stops within a day and the owner can fix it, or the drawdown breaker has tripped.",
  today: "Needs the owner within the day, or a fault they should know about that Merrymen has to fix.",
  fyi: "Explains a quiet agent. Nothing has to be done; it can wait for a daily brief.",
});

export type AttentionKind =
  | "no-permission" | "permission-expired" | "permission-expiring" | "live-blocker" | "breaker" | "worker-stale"
  | "arm-error" | "killed" | "daily-cap" | "ops-cap" | "provider-failure" | "proposal-waiting" | "alerts-failing" | "recovery-hold";

export interface AttentionItem {
  /** `<kind>:<agent slug or ->:<what distinguishes this occurrence>`; stable while the condition and severity hold. */
  key: string;
  severity: Severity;
  kind: AttentionKind;
  agent: string | null;
  title: string;
  detail: string;
  owner_can_fix: boolean;
  what_to_do: string | null;
  link: string | null;
  started_at: number | null;
  ends_at: number | null;
}

/** Fixed pages on the configured issuer; null when no issuer is configured. */
export interface AttentionLinks {
  grant: string | null;
  deposit: string | null;
  settings: string | null;
}

export const KEY_RE = /^[a-z][a-z-]{1,23}:[0-9a-z-]{1,16}:[0-9a-z_.-]{1,64}$/;

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
/** Events read per agent for the kill switch, breaker and provider failures. */
export const ATTENTION_EVENTS_MAX = 2_000;
/** How far back events and refusals are read. */
export const ATTENTION_LOOKBACK_SEC = DAY;
/** An expired permission is act_now this long after it lapsed, then fyi: a stopped agent is not news for ever. */
const EXPIRED_LOUD_SEC = 3 * DAY;
/** How long a newly armed agent may go without its first heartbeat before it counts as not reporting. */
const FIRST_BEAT_GRACE_SEC = 15 * MINUTE;
/** A cap refusal newer than this means the cap is holding buys now. */
const CAP_CURRENT_SEC = 2 * HOUR;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_ACCOUNTS = 32;

const EXPIRY_TIERS: ReadonlyArray<{ within: number; severity: Severity; tag: string }> = [
  { within: DAY, severity: "act_now", tag: "24h" },
  { within: 3 * DAY, severity: "today", tag: "72h" },
  { within: 7 * DAY, severity: "fyi", tag: "7d" },
];

/** Delivery failures the owner can clear (their chat, their bot, their switches); the rest are Telegram's or Merrymen's. */
const OWNER_DELIVERY_CODES: ReadonlySet<string> = new Set(["no_linked_telegram", "owner_disabled", "bot_blocked", "chat_not_found", "bot_token_rejected"]);

const RENEW = "Re-sign the trading permission in Merrymen (Wallet & permissions). Renewal revokes the old permission on chain and costs network fees.";

const iso = (sec: number): string => new Date(sec * 1000).toISOString();

/** "40 min", "9 h", "3 days": for titles, rounded the way a person says it. */
export function inWords(sec: number): string {
  if (sec < HOUR) return `${Math.max(1, Math.round(sec / MINUTE))} min`;
  if (sec < 2 * DAY) return `${Math.round(sec / HOUR)} h`;
  return `${Math.floor(sec / DAY)} days`;
}

/**
 * When a condition the worker restates every tick began: walk back from the
 * newest sighting while sightings stay within `gap` of each other. Null when
 * the run reaches the oldest row read and an older row could still belong to
 * it (the read was cut, or stopped within `gap` of its floor).
 */
export function runStart(newestFirst: readonly number[], gap: number, floor: number, truncated: boolean): number | null {
  if (!newestFirst.length) return null;
  let start = newestFirst[0]!;
  for (let i = 1; i < newestFirst.length; i++) {
    const at = newestFirst[i]!;
    if (start - at > gap) return start;
    start = at;
  }
  return truncated || start - floor <= gap ? null : start;
}

/** Every stored spelling of every account, for `agent_id IN (…)`. */
function accountSpellings(accounts: readonly string[]): string[] {
  const list = [...new Set(accounts.filter((a) => ADDRESS.test(a)).map((a) => a.toLowerCase()))].slice(0, MAX_ACCOUNTS);
  return [...new Set(list.flatMap(spellings))];
}

/**
 * The condition a key is about, whatever its severity or scope: a permission
 * is one condition from its first expiry tier through its expiry, so a key
 * replaced by a more severe one for the same permission has not resolved; and
 * undelivered alerts are one condition whether a read covered every agent
 * (`-`) or one, so a wider read that still sees failures resolves neither.
 */
export function conditionOfKey(key: string): string {
  const [kind, agent, rest = ""] = key.split(":");
  if (kind === "permission-expiring" || kind === "permission-expired") return `permission:${agent}:${rest.split("-")[0]}`;
  if (kind === "alerts-failing") return "alerts-failing";
  return key;
}

/** Kinds read from the event scan: when a scan was cut, their absence is not established. */
export const EVENT_KINDS: ReadonlySet<AttentionKind> = new Set(["breaker", "provider-failure"]);

/**
 * The two events a worker writes when it cannot arm: the executor failing
 * (index.ts, "this agent CANNOT START and is not trading: …", which the
 * inactivity diagnosis's classifyEvent knows) and unusable settings
 * (settings.ts settingsArmRefusal). The prefixes only narrow an indexed read;
 * isArmFailure decides what a row is.
 */
const ARM_FAILURE_PREFIXES = ["this agent CANNOT START", SETTINGS_ARM_REFUSAL_PREFIX] as const;
const isArmFailure = (message: string) => classifyEvent(message) === "arm_failure" || message.startsWith(SETTINGS_ARM_REFUSAL_PREFIX);

/** Permission items: none signed, expired, or inside an expiry tier. */
export function permissionItems(slug: string, account: string | null, expiresAt: number | null, now: number, links: AttentionLinks): AttentionItem[] {
  if (!account) {
    return [{
      key: `no-permission:${slug}:none`, severity: "today", kind: "no-permission", agent: slug,
      title: "No trading permission signed yet",
      detail: "The agent cannot run until the owner signs a trading permission with their own wallet.",
      owner_can_fix: true, what_to_do: "Sign a trading permission in Merrymen to start the agent.", link: links.grant,
      started_at: null, ends_at: null,
    }];
  }
  if (expiresAt === null) return [];
  if (expiresAt <= now) {
    const loud = now - expiresAt <= EXPIRED_LOUD_SEC;
    return [{
      key: `permission-expired:${slug}:${expiresAt}${loud ? "" : "-old"}`, severity: loud ? "act_now" : "fyi", kind: "permission-expired", agent: slug,
      title: loud ? "Trading permission expired" : `Trading permission expired ${inWords(now - expiresAt)} ago`,
      detail: `The trading permission expired at ${iso(expiresAt)}, so the agent cannot trade. Funds stay in the owner's smart account.`,
      owner_can_fix: true, what_to_do: RENEW, link: links.grant,
      started_at: loud ? expiresAt : expiresAt + EXPIRED_LOUD_SEC, ends_at: null,
    }];
  }
  const left = expiresAt - now;
  const tier = EXPIRY_TIERS.find((t) => left <= t.within);
  if (!tier) return [];
  return [{
    key: `permission-expiring:${slug}:${expiresAt}-${tier.tag}`, severity: tier.severity, kind: "permission-expiring", agent: slug,
    title: `Trading permission expires in ${inWords(left)}`,
    detail: `The trading permission expires at ${iso(expiresAt)}. After that the agent stops trading until a new one is signed.`,
    owner_can_fix: true, what_to_do: `${RENEW} Do it before ${iso(expiresAt)} to keep the agent running.`, link: links.grant,
    started_at: expiresAt - tier.within, ends_at: expiresAt,
  }];
}

const FUNDING_TODO: Readonly<Record<string, string>> = {
  "no-gas": "Send a small amount of ETH to the agent's account on Robinhood Chain; the deposit page shows the address. A few dollars covers many trades.",
  "no-cash": "Send USDG to the agent's account on Robinhood Chain; the deposit page shows the address.",
};

const BLOCKER_TITLE: Readonly<Record<string, string>> = {
  "no-gas": "The agent has no ETH for network fees",
  "no-cash": "The agent has no USDG to trade with",
  "dead-policy": "The trading permission cannot reach the chain",
  "wrong-chain": "The trading permission is for another network",
  "grant-too-wide": "The trading permission is too large to install",
  "no-executor": "Nothing can be submitted to the chain",
};

const PROVIDER_TITLE: Readonly<Record<keyof typeof PROVIDER_TEXT, string>> = {
  market: "Market data could not be read",
  brain: "The decision service is unreachable",
  model: "The AI model provider is failing",
};

export interface AgentAttentionInput {
  slug: string;
  /** The owner, with the current account and the grant's chain the key of a recovery hold. */
  tenant: string;
  chainId: number | null;
  /** The current smart account; null before the first signed permission. */
  account: string | null;
  /** Every account the agent has held (older ledger rows live under these). */
  accounts: readonly string[];
  /** When the current permission was signed (the grant's own time). */
  grantedAt: number | null;
  expiresAt: number | null;
  settings: SettingsView | null;
  now: number;
  links: AttentionLinks;
}

function killedItem(slug: string, links: AttentionLinks, at: number | null): AttentionItem {
  return {
    key: `killed:${slug}:on`, severity: "fyi", kind: "killed", agent: slug,
    title: "Kill switch is on",
    detail: "The trading key was removed, so the agent can sign nothing. Funds stay in the owner's smart account.",
    owner_can_fix: true, what_to_do: "Sign a new trading permission in Merrymen when the agent should trade again.", link: links.grant,
    started_at: at, ends_at: null,
  };
}

/**
 * Everything about one agent that needs its owner, and the agent's name as its
 * worker reports it (owner-chosen text: the caller sanitises it). THROWS when
 * the ledger cannot be read.
 */
export interface AgentAttention {
  name: string | null;
  items: AttentionItem[];
  /** The event scan filled its page: event-read conditions may be missing. */
  eventsCut: boolean;
  /** Held for recovery: nothing but the hold was judged, so no other key of this agent is known to be resolved. */
  held: boolean;
  /** The recovery report could not be read; the agent was judged as if not held. */
  holdUnread: boolean;
}

export async function readAgentAttention(db: Db, input: AgentAttentionInput): Promise<AgentAttention> {
  const { slug, account, now, links } = input;
  if (!account && input.accounts.length) {
    // The identity has held an account but holds no permission now: the owner
    // used the kill switch or discarded the permission to start over. A
    // deliberate stop, not an agent that was never signed.
    const last = await readAgentRow(db, input.accounts[0]!);
    const name = last?.name ?? input.settings?.agentName ?? null;
    if (last?.status === "killed") return { name, items: [killedItem(slug, links, null)], eventsCut: false, held: false, holdUnread: false };
    return {
      name,
      eventsCut: false,
      held: false,
      holdUnread: false,
      items: [{
        key: `no-permission:${slug}:removed`, severity: "fyi", kind: "no-permission", agent: slug,
        title: "No trading permission is active",
        detail: "The agent's trading permission was discarded, so it cannot trade until a new one is signed. Funds stay in the owner's smart account.",
        owner_can_fix: true, what_to_do: "Sign a new trading permission in Merrymen when the agent should trade again.", link: links.grant,
        started_at: null, ends_at: null,
      }],
    };
  }
  const items = permissionItems(slug, account, input.expiresAt, now, links);
  if (!account) return { name: input.settings?.agentName ?? null, items, eventsCut: false, held: false, holdUnread: false };

  const row = await readAgentRow(db, account);
  // A RECOVERY HOLD IS TESTED FIRST, keyed as the diagnosis and the grants
  // route key it (this owner, the current account, the grant's chain). A held
  // agent's supervisor runs no trading worker for it until its saved records
  // are verified, so its heartbeat, blockers and limits are the hold, and no
  // step is asked of the owner: lifting it is on Merrymen's side. An expired
  // permission is named in it and offered once the hold lifts. A report that
  // cannot be read counts as no hold, never as one, and is said.
  let hold: { checkedAt: number } | null = null;
  let holdUnread = false;
  if (input.chainId !== null) {
    try {
      hold = await readFleetRecoveryHold(db, { tenant: input.tenant, smartAccount: account, chainId: input.chainId });
    } catch {
      holdUnread = true;
    }
  }
  if (hold) {
    const exp = input.expiresAt;
    const also = exp === null ? "" : exp <= now
      ? ` Its trading permission also expired at ${iso(exp)}; renewing it is offered once the hold lifts.`
      : exp - now <= 7 * DAY ? ` Its trading permission expires at ${iso(exp)}; renewing it is offered once the hold lifts.` : "";
    return {
      name: row?.name ?? input.settings?.agentName ?? null,
      eventsCut: false,
      held: true,
      holdUnread: false,
      items: [{
        key: `recovery-hold:${slug}:on`, severity: "today", kind: "recovery-hold", agent: slug,
        title: "Trading is paused for recovery",
        detail: `Merrymen is holding this agent until its saved trading records are verified (last confirmed at ${iso(hold.checkedAt)}). A held agent does not trade, and nothing is asked of the owner: lifting the hold is on Merrymen's side.${also}`,
        owner_can_fix: false, what_to_do: null, link: null, started_at: null, ends_at: null,
      }],
    };
  }
  const status = row?.status ?? null;
  const freshWithinSec = freshWithin(input.settings?.tickSeconds);
  const beat = row?.beat_at ?? null;
  const signedAt = input.grantedAt ?? row?.granted_at ?? null;
  const live = input.expiresAt === null || input.expiresAt > now;
  // A permission the worker has not ADOPTED is PENDING: the row's status,
  // blocker and heartbeat belong to an earlier one (a first grant not yet
  // armed, or a renewal on the same account while the old worker may still be
  // beating), so none of them is the agent's state now. Adoption is read from
  // the worker's own row, as get_merryman_setup reads it (currentGrantSeen):
  // a heartbeat at or after signing, in a row that carries this permission.
  // The identity the worker writes for it is expires_at (ensureAgent updates
  // it, with the caps and session key, on every grant; granted_at is written
  // only with the account's first row), and the chain.
  const adopted = row !== null && beat !== null && signedAt !== null && beat >= signedAt
    && row.expires_at === input.expiresAt && (input.chainId === null || row.chain_id === input.chainId);
  const pending = live && signedAt !== null && !adopted;
  // A condition the worker restates every tick is current while its newest
  // sighting is younger than two heartbeat windows (never under half an hour),
  // and a run of sightings is one occurrence while they are no further apart
  // than an hour, or two heartbeat windows when that is longer.
  const currentSec = Math.max(30 * MINUTE, 2 * freshWithinSec);
  const gapSec = Math.max(HOUR, 2 * freshWithinSec);
  // Current conditions are the current permission's: events and refusals of a
  // retired account, or from before this permission was signed, are history.
  const floor = Math.max(now - ATTENTION_LOOKBACK_SEC, signedAt ?? 0);
  const ids = accountSpellings([account]);
  const inList = ids.map(() => "?").join(", ");

  const events = ids.length ? (await db.prepare(
    `SELECT message, created_at FROM events WHERE agent_id IN (${inList}) AND level IN ('warn', 'err') AND created_at >= ?
      ORDER BY created_at DESC LIMIT ${ATTENTION_EVENTS_MAX}`,
  ).all(...ids, floor)) as Array<{ message: string; created_at: number }> : [];
  const truncated = events.length >= ATTENTION_EVENTS_MAX;
  const seen: Record<"kill" | "breaker" | "market" | "brain" | "model", number[]> = { kill: [], breaker: [], market: [], brain: [], model: [] };
  for (const ev of events) {
    const kind = classifyAlertEvent(String(ev.message ?? ""));
    if (kind) seen[kind].push(Number(ev.created_at));
  }
  // 'error' is the current permission's when the worker is past it, or when it
  // failed to arm this permission; otherwise it is a renewal's predecessor and
  // the permission is still pending. The worker writes an unchanged arm
  // failure once (lastArmFailure), so the first one since signing is looked up
  // on its own, however long ago: the day's scan may have lost it.
  let armFailedAt: number | null = null;
  if (live && pending && status === "error" && ids.length) {
    const first = await db.prepare(
      `SELECT message, created_at FROM events WHERE agent_id IN (${inList}) AND level = 'err' AND created_at >= ?
        AND (${ARM_FAILURE_PREFIXES.map(() => "message LIKE ?").join(" OR ")})
        ORDER BY created_at ASC LIMIT 1`,
    ).get(...ids, signedAt, ...ARM_FAILURE_PREFIXES.map((p) => `${p}%`)) as { message: string; created_at: number } | undefined;
    if (first && isArmFailure(String(first.message))) armFailedAt = Number(first.created_at);
  }
  const armError = live && status === "error" && (!pending || armFailedAt !== null);

  if (!pending && status === "killed") items.push(killedItem(slug, links, seen.kill[0] ?? null));
  if (armError) {
    items.push({
      key: `arm-error:${slug}:on`, severity: "today", kind: "arm-error", agent: slug,
      title: "The agent could not arm its trading key",
      detail: "The worker reports that it could not arm the trading key, so nothing is signed. This is Merrymen's to fix, not the owner's.",
      owner_can_fix: false, what_to_do: null, link: null,
      started_at: armFailedAt, ends_at: null,
    });
  }
  const running = status === "active" || status === "armed";
  // A pending permission the worker has not picked up after the start-up
  // grace: the default 'armed' row with no heartbeat, a signed permission
  // whose ledger row was never written, or a renewal the worker never reached.
  const grace = Math.max(FIRST_BEAT_GRACE_SEC, 2 * freshWithinSec);
  if (pending && !armError && now - signedAt! > grace) {
    items.push({
      key: `worker-stale:${slug}:since-${signedAt}`, severity: "today", kind: "worker-stale", agent: slug,
      title: beat === null ? "The agent's worker has never reported" : "The agent's worker has not picked up the new permission",
      detail: `The trading permission was signed at ${iso(signedAt!)}, but ${beat === null ? "the agent's worker has not reported once since" : "the agent's worker has not taken it up (its reports are for the previous permission)"}, so it is not trading under it or running exits. Merrymen starts workers; the owner cannot fix this from here.`,
      owner_can_fix: false, what_to_do: null, link: null,
      started_at: signedAt! + grace, ends_at: null,
    });
  }
  // Only a live permission owes a heartbeat, as the stale_data alert rules
  // (notify.ts evalStale): after expiry the expired item is what to act on.
  if (live && !pending && running && beat !== null && now - beat > freshWithinSec) {
    items.push({
      key: `worker-stale:${slug}:${beat}`, severity: "today", kind: "worker-stale", agent: slug,
      title: "The agent's worker stopped reporting",
      detail: `The worker has not reported since ${iso(beat)}, so the agent may not be trading or running its exits. Merrymen restarts workers; the owner cannot fix this from here.`,
      owner_can_fix: false, what_to_do: null, link: null,
      started_at: beat + freshWithinSec, ends_at: null,
    });
  }

  // A blocker is about trading under a live permission: after expiry the row
  // keeps its last one (retireGrant only sets the status), and the expired
  // item is the one to act on.
  // And only a running worker's: an 'error' or 'killed' status leaves the row's
  // last blocker behind (setAgentStatus writes the status alone).
  const b = pending || !live || !running ? null : blockerView(row?.live_blocker ?? null);
  const advice = b ? blockerAdvice(b.rule) : null;
  // A deliberate state (live trading off, a key arming on the next pass) is not a fault and needs nobody.
  if (b && (advice?.fault ?? true)) {
    const funding = advice?.funding === true;
    const resign = advice?.resign === true;
    items.push({
      key: `live-blocker:${slug}:${b.rule.toLowerCase().replace(/[^0-9a-z_.-]/g, "-").slice(0, 40) || "unknown"}`,
      severity: funding || resign ? "act_now" : "today", kind: "live-blocker", agent: slug,
      title: BLOCKER_TITLE[b.rule] ?? "Live trading is blocked",
      detail: !funding && !resign && advice ? advice.say : b.text,
      owner_can_fix: funding || resign,
      what_to_do: funding ? FUNDING_TODO[b.rule] ?? advice!.say : resign ? advice!.say : null,
      link: funding ? links.deposit : resign ? links.grant : null,
      started_at: null, ends_at: null,
    });
  }

  // Breaker, provider and cap items describe what holds back trading under a
  // live permission; once it has expired, the expired item is what does.
  if (live && seen.breaker.length && now - seen.breaker[0]! <= currentSec) {
    const start = runStart(seen.breaker, gapSec, floor, truncated);
    items.push({
      key: `breaker:${slug}:on`, severity: "act_now", kind: "breaker", agent: slug,
      title: "Drawdown breaker tripped",
      detail: "The book is below the drawdown limit in the signed permission, so buys are refused until it recovers. Selling is never blocked.",
      owner_can_fix: false, what_to_do: null, link: null, started_at: start, ends_at: null,
    });
  }

  // Each provider failing now is its own open condition, newest first.
  const providers = (["market", "brain", "model"] as const)
    .filter((k) => live && seen[k].length && now - seen[k][0]! <= currentSec)
    .sort((x, y) => seen[y][0]! - seen[x][0]!);
  for (const provider of providers) {
    const start = runStart(seen[provider], gapSec, floor, truncated);
    items.push({
      key: `provider-failure:${slug}:${provider}`, severity: "fyi", kind: "provider-failure", agent: slug,
      title: PROVIDER_TITLE[provider],
      detail: `${PROVIDER_TEXT[provider]} This is Merrymen's to fix; the owner has nothing to do.`,
      owner_can_fix: false, what_to_do: null, link: null, started_at: start, ends_at: null,
    });
  }

  const caps = live && ids.length ? (await db.prepare(
    `SELECT reject_rule AS rule, MIN(created_at) AS first, MAX(created_at) AS last FROM trades
      WHERE agent_id IN (${inList}) AND status = 'rejected' AND reject_rule IN ('daily-cap', 'ops-cap') AND created_at >= ?
      GROUP BY reject_rule`,
  ).all(...ids, floor)) as Array<{ rule: string; first: number; last: number }> : [];
  for (const c of caps) {
    const first = Number(c.first), last = Number(c.last);
    if (now - last > CAP_CURRENT_SEC) continue;
    // The first refusal read is the start only when the read could not have cut an earlier one off.
    const start = first - floor > CAP_CURRENT_SEC ? first : null;
    const daily = c.rule === "daily-cap";
    items.push({
      key: `${daily ? "daily-cap" : "ops-cap"}:${slug}:on`, severity: "fyi", kind: daily ? "daily-cap" : "ops-cap", agent: slug,
      title: daily ? "Daily spending cap reached" : "Daily trade count reached",
      detail: daily
        ? "Buys past the daily spending cap sealed in the signed permission are refused until the trailing 24-hour window rolls. Selling is never blocked."
        : "Operations past the daily count sealed in the signed permission are refused until the trailing 24-hour window rolls.",
      owner_can_fix: false, what_to_do: null, link: null, started_at: start, ends_at: null,
    });
  }
  return { name: row?.name ?? input.settings?.agentName ?? null, items, eventsCut: truncated, held: false, holdUnread };
}

const PROPOSAL_TITLE: Readonly<Record<string, string>> = {
  trade: "A trade proposal is waiting for approval",
  settings: "A settings change is waiting for approval",
  agent_draft: "An agent setup is waiting for review",
  post: "A post is waiting for approval",
};

/** One item per proposal still waiting for the owner. The caller filters to what the connection may see. */
export function proposalItems(rows: ReadonlyArray<{ id: string; kind: string; agent_slug: string | null; created_at: number; expires_at: number; approval_url: string | null }>): AttentionItem[] {
  return rows.map((r) => ({
    key: `proposal-waiting:${r.agent_slug ?? "-"}:${r.kind}.${r.id.toLowerCase()}`, severity: "today" as const, kind: "proposal-waiting" as const, agent: r.agent_slug,
    title: PROPOSAL_TITLE[r.kind] ?? "A proposal is waiting for approval",
    detail: `Nothing happens unless the owner approves it in Merrymen. It expires at ${iso(r.expires_at)}.`,
    owner_can_fix: true, what_to_do: "Open the approval page to review it, then approve or decline.", link: r.approval_url,
    started_at: r.created_at, ends_at: r.expires_at,
  }));
}

/**
 * One item when alert messages to the owner's Telegram died in the lookback,
 * keyed by the agent a read was limited to, or `-` for a read of them all.
 * The newest failure's code says whose it is: the owner's chat, bot or
 * switches, or a Telegram or Merrymen failure no setting can clear.
 */
export function deliveryItems(dead: { count: number; first: number; lastErrorCode: string | null } | null, links: AttentionLinks, agent: string | null = null): AttentionItem[] {
  if (!dead || dead.count <= 0) return [];
  const why = dead.lastErrorCode ? DELIVERY_ERROR_TEXT[dead.lastErrorCode] ?? null : null;
  const owners = dead.lastErrorCode !== null && OWNER_DELIVERY_CODES.has(dead.lastErrorCode);
  return [{
    key: `alerts-failing:${agent ?? "-"}:on`, severity: "fyi", kind: "alerts-failing", agent,
    title: "Telegram alerts are not being delivered",
    detail: `${dead.count} alert message(s) in the last 24 hours could not be delivered${why ? `: ${why}` : "."}${owners ? "" : " This is not something a setting can fix."}`,
    owner_can_fix: owners, what_to_do: owners ? "Check the Telegram link and bot in Merrymen Settings." : null, link: owners ? links.settings : null,
    started_at: dead.first, ends_at: null,
  }];
}

/** Most severe first; within a severity, new before already reported, then the most recent start first. */
export function rankItems<T extends AttentionItem & { new: boolean }>(items: readonly T[]): T[] {
  const order = (s: Severity) => SEVERITIES.indexOf(s);
  return [...items].sort((a, b) =>
    order(a.severity) - order(b.severity)
    || Number(b.new) - Number(a.new)
    || (b.started_at ?? 0) - (a.started_at ?? 0)
    || a.key.localeCompare(b.key));
}
