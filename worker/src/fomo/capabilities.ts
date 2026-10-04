/**
 * WHAT THE PROVIDER CAN DO FOR US, AND HOW WE KNOW IT.
 *
 * Every capability carries the evidence its status rests on, because the
 * difference between "the docs say so" and "we called it with a real key and
 * the rows were on the chain we asked for" is the whole point of the report.
 *
 *   DOCUMENTED            the vendor's documentation says it exists; nobody
 *                         has called it with a key yet
 *   AUTHENTICATED_TESTED  an authenticated call answered and the rows passed
 *                         identity checks
 *   PARTIAL               it works with a stated limitation: a filter the
 *                         vendor ignores, a capped answer, a feed that stopped
 *   ENTITLEMENT_BLOCKED   the key's plan (or its credits) does not reach it
 *   UNAVAILABLE           it did not answer usefully the last time we asked
 *   UNSUPPORTED           Merrymen will not use it, whatever the vendor offers
 *
 * TWO RULES THE MERGE HOLDS, because a report that forgets is worse than none:
 *
 *   1. Nothing silently downgrades to DOCUMENTED. A call that never reached
 *      the vendor (no key, a request we refused ourselves) is not evidence and
 *      changes nothing.
 *   2. A failure after a success is recorded as the failure, AND the time of
 *      the last success stays in the evidence, so "down since" and "worked
 *      until" are both readable from one row.
 *
 * This file cites routes, never the API host: only the adapter names it.
 */

import { sanitizeText } from "../research/news";
import { redactUrl, ROUTE_COST, type AccountInfo, type ProviderResult, type RouteName } from "./provider";
import type { CapabilityRecord, CapabilityStatus } from "./types";

/** When the vendor documentation behind the baseline was fetched. */
export const DOCS_FETCHED_AT = Date.UTC(2026, 9, 4, 16, 5);
const FETCHED = "fetched 2026-10-04T16:05Z";

/** Evidence prefixes. They are how the merge tells an observation from a citation. */
const DOCUMENTED_PREFIX = "documented: ";
const OBSERVED_PREFIX = "observed: ";
const POLICY_PREFIX = "policy: ";
const NO_CONTACT_PREFIX = "no provider contact: ";
const ENTITLED_PREFIX = "observed: entitled";

const STATUSES: ReadonlySet<CapabilityStatus> = new Set([
  "DOCUMENTED",
  "AUTHENTICATED_TESTED",
  "PARTIAL",
  "ENTITLEMENT_BLOCKED",
  "UNAVAILABLE",
  "UNSUPPORTED",
]);

/** Merrymen's capability name for each client route. */
export const CAPABILITY_FOR_ROUTE: Readonly<Record<RouteName, string>> = {
  me: "account",
  leaderboard: "leaderboard",
  traderByHandle: "trader-by-handle",
  traderById: "trader-by-id",
  positions: "positions",
  swaps: "swaps",
  balances: "balances",
  following: "following",
  spotlight: "spotlight",
  theses: "theses",
  thesesByToken: "theses-by-token",
  thesesByUser: "theses-by-user",
  thesesByUserToken: "theses-by-user-token",
  trade: "trade-detail",
  tradeComments: "trade-comments",
  tokenStats: "token-stats",
  tokenDevs: "token-devs",
  tokenHolders: "token-holders",
  tokenBoardTrending: "token-board-trending",
  tokenBoardGraduated: "token-board-graduated",
  tokenBoardMostHeld: "token-board-most-held",
  search: "search",
  tokensSearch: "tokens-search",
  alerts: "alerts-rest",
};

function doc(capability: string, route: string, status: CapabilityStatus, evidence: string): CapabilityRecord {
  const prefix = status === "UNSUPPORTED" ? POLICY_PREFIX : DOCUMENTED_PREFIX;
  return { capability, route, status, evidence: `${prefix}${evidence}; ${FETCHED}`, verifiedAt: DOCS_FETCHED_AT };
}

const T = (r: RouteName) => ROUTE_COST[r].template;

/**
 * The baseline, from the vendor's OpenAPI contract, reference page, `/v1`
 * catalogue, pricing page and guides. PARTIAL where the vendor itself states
 * the limitation.
 */
export const DOCUMENTED_CAPABILITIES: readonly CapabilityRecord[] = [
  doc("account", T("me"), "DOCUMENTED", "/v1 catalogue GET /v2/me: plan, credits{monthly,usedThisMonth,prepaid,remaining}, streams{appFeed,onChain}; zero credits"),
  doc("leaderboard", T("leaderboard"), "DOCUMENTED", "openapi.json GET /v2/leaderboard/{window}: window 24h|7d|30d|all, limit 1-150 (100 on all), 250 credits per call; rows carry userId; no chain filter"),
  doc("trader-by-handle", T("traderByHandle"), "DOCUMENTED", "openapi.json GET /v2/users/{handle}: 2,500 credits on a hit, 250 on an unresolvable handle, refunded while wallets are resolving"),
  doc("trader-by-id", T("traderById"), "DOCUMENTED", "openapi.json GET /v2/users/id/{userId}: same identity payload as the handle route, 2,500 credits; 404 does not consume the allowance"),
  doc("positions", T("positions"), "DOCUMENTED", "openapi.json GET /v2/users/{handle}/positions (userId accepted): 25 closed per cursor page, 250 credits per page; the vendor states a full history is not obtainable at any setting"),
  doc("swaps", T("swaps"), "DOCUMENTED", "openapi.json GET /v2/users/{handle}/swaps: 100 fills per cursor page, 250 credits per page; tradeIdIn/tradeIdOut join to positions"),
  doc("swaps-relay", `${T("swaps")}?source=relay`, "PARTIAL", "listed only in the /v1 catalogue, absent from openapi.json; covers Relay-routed flow only (vendor measured 96% in-window); 409 retryable while a wallet resolves"),
  doc("balances", T("balances"), "DOCUMENTED", "openapi.json GET /v2/users/{handle}/balances: upstream cap of ~100 holdings with no way past it, so totalValueUsd is a floor when truncated; ?chain= narrows rows"),
  doc("following", T("following"), "DOCUMENTED", "openapi.json GET /v2/users/{handle}/following: at most 200 names upstream, flat 250 credits; 503 retryable never means not-found"),
  doc("spotlight", T("spotlight"), "DOCUMENTED", "openapi.json GET /v2/users/{handle}/spotlight: the vendor's own pick of best trades and theses, 250 credits"),
  doc("theses", T("theses"), "DOCUMENTED", "openapi.json GET /v2/thesis: recent theses across coins with networkId and equity (no likes); ?chain= filter; 1,250 credits per page"),
  doc("theses-by-token", T("thesesByToken"), "PARTIAL", "openapi.json GET /v2/thesis/token/{mint}: the network enum is sol|bnb|base|eth|arc with no robinhood value, so a Robinhood token is queried without one and every row's networkId must be checked; 1,250 credits per page"),
  doc("theses-by-user", T("thesesByUser"), "DOCUMENTED", "openapi.json GET /v2/thesis/user/{id}: every thesis by one trader, sort likes|recent, ?chain="),
  doc("theses-by-user-token", T("thesesByUserToken"), "DOCUMENTED", "openapi.json GET /v2/thesis/user/{id}/token/{address}: one trader's theses on one token"),
  doc("trade-detail", T("trade"), "DOCUMENTED", "openapi.json GET /v2/trades/{tradeId}: swaps, transfers, entry/exit, realized PnL, isDev"),
  doc("trade-comments", T("tradeComments"), "DOCUMENTED", "openapi.json GET /v2/trades/{tradeId}/comments: thread with parentId, limit 1-200, 250 credits"),
  doc("token-stats", T("tokenStats"), "DOCUMENTED", "openapi.json GET /v2/token/{address}/stats: windows 5m|1h|4h|24h, volumes sent as strings, buySellRatio null with no sells; networkId needed outside the vendor directory"),
  doc("token-devs", T("tokenDevs"), "DOCUMENTED", "openapi.json GET /v2/token/{address}/devs: deployer and insider positions with their theses; an empty list is not a clean bill of health"),
  doc("token-holders", T("tokenHolders"), "PARTIAL", "openapi.json GET /token/{address}/holders is populated from captured balances, and GET /health and GET /v1 report a captured dataset of 8 traders, so the holder set is tiny and an absence proves nothing"),
  doc("token-board-trending", T("tokenBoardTrending"), "DOCUMENTED", "openapi.json GET /v2/leaderboard/tokens/trending: live with a 5-minute cache; source captured means a fallback board"),
  doc("token-board-graduated", T("tokenBoardGraduated"), "DOCUMENTED", "openapi.json GET /v2/leaderboard/tokens/graduated: same shape as trending; small caps by nature"),
  doc("token-board-most-held", T("tokenBoardMostHeld"), "DOCUMENTED", "openapi.json GET /v2/leaderboard/tokens/most-held: holders is null on this board upstream"),
  doc("token-activity", "/v2/tokens/activity", "PARTIAL", "openapi.json GET /v2/tokens/activity: the vendor states its upstream stopped publishing this board on 2026-08-23; answers carry stale:true; not wired into the client"),
  doc("token-candles", "/v2/token/{address}/candles", "PARTIAL", "listed in the /v1 catalogue and the pricing page (Growth and Scale only) but absent from openapi.json; not wired into the client"),
  doc("search", T("search"), "DOCUMENTED", "openapi.json GET /v2/search: traders and tokens, each with a type; trader rows carry userId"),
  doc("tokens-search", T("tokensSearch"), "DOCUMENTED", "openapi.json GET /v2/tokens/search: symbol/name to address, networkId, market cap"),
  doc("alerts-rest", T("alerts"), "DOCUMENTED", "openapi.json GET /v2/alerts: the app feed's LARGE events only (floor near $3,000 of position value), opaque cursor checkpointing, 125 credits"),
  doc("ws-alerts", "/ws/alerts", "DOCUMENTED", "openapi.json WSS /ws/alerts: app feed on every plan, zero credits; paid keys realtime, a free key delayed 15 s after 7 days"),
  doc("ws-trades", "/ws/trades", "DOCUMENTED", "openapi.json WSS /ws/trades: on-chain stream for Growth or Scale keys only; a lower plan is refused (403 or close 1008) and is ENTITLEMENT_BLOCKED once probed"),
  doc("trading-account", "/v2/trading/*", "UNSUPPORTED", "the vendor's order-placing account product; Merrymen keeps its own execution system and the client refuses the path"),
  doc("credit-top-up", "/pay/create", "UNSUPPORTED", "a payment flow; Merrymen never pays through a research adapter and the client refuses the path"),
];

const BASELINE: ReadonlyMap<string, CapabilityRecord> = new Map(DOCUMENTED_CAPABILITIES.map((r) => [r.capability, r]));

/** The documented baseline for one capability, or null for a name the baseline does not know. */
export function documentedCapability(capability: string): CapabilityRecord | null {
  const r = BASELINE.get(capability);
  return r ? { ...r } : null;
}

function iso(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "unknown";
}

function shortIso(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/:\d{2}\.\d{3}Z$/, "Z") : "unknown";
}

function clean(s: string, max = 600): string {
  return sanitizeText(redactUrl(s), max);
}

function record(capability: string, route: string, status: CapabilityStatus, evidence: string, verifiedAt: number): CapabilityRecord {
  return { capability, route, status, evidence: clean(evidence), verifiedAt };
}

export interface CapabilityCallExtra {
  chainFilterHonoured?: boolean | null;
  truncated?: boolean;
  /** Rows kept / dropped by the normaliser. Read from the result's data when omitted. */
  rowsKept?: number;
  dropped?: number;
  /**
   * The subject may simply not exist (a handle someone typed). A 404 then
   * proves the route answered, not that it is gone.
   */
  notFoundIsSubject?: boolean;
}

/** What a result's data says about filters, truncation and identity, without knowing its type. */
function factsOf(data: unknown, extra: CapabilityCallExtra) {
  const d = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return {
    chainFilterHonoured:
      extra.chainFilterHonoured !== undefined ? extra.chainFilterHonoured : typeof d.chainFilterHonoured === "boolean" ? d.chainFilterHonoured : null,
    truncated: extra.truncated ?? d.truncated === true,
    rowsKept: extra.rowsKept ?? (Array.isArray(d.rows) ? d.rows.length : null),
    dropped: extra.dropped ?? (typeof d.dropped === "number" && Number.isFinite(d.dropped) ? d.dropped : 0),
  };
}

/**
 * One call's evidence about one capability.
 *
 * A call that never reached the vendor returns DOCUMENTED — not as a verdict
 * but as "no evidence", which `mergeCapability` ignores. An UNSUPPORTED
 * capability stays UNSUPPORTED whatever a call says: that status is policy.
 */
export function capabilityFromCall(
  capability: string,
  route: string,
  result: ProviderResult<unknown>,
  extra: CapabilityCallExtra = {},
): CapabilityRecord {
  const base = BASELINE.get(capability);
  if (base?.status === "UNSUPPORTED") return { ...base };
  const at = result.meta.retrievedAt;
  const status = result.meta.status;

  if (result.ok) {
    const f = factsOf(result.data, extra);
    const limits: string[] = [];
    if (f.chainFilterHonoured === false) limits.push("chain filter ignored: rows on other networks");
    if (f.truncated) limits.push("answer truncated by the provider");
    if (f.rowsKept === 0 && f.dropped > 0) limits.push(`every row (${f.dropped}) failed identity checks`);
    const cost = result.meta.creditsCost !== null ? `, ${result.meta.creditsCost} credits` : "";
    const dropped = f.dropped > 0 && !(f.rowsKept === 0) ? `; ${f.dropped} rows dropped` : "";
    return record(
      capability,
      route,
      limits.length ? "PARTIAL" : "AUTHENTICATED_TESTED",
      `${OBSERVED_PREFIX}HTTP ${status ?? "?"} on ${route} at ${iso(at)}${cost}${limits.length ? "; " + limits.join("; ") : ""}${dropped}`,
      at,
    );
  }

  const failure = result.failure;
  if (result.meta.attempts === 0 || failure === "no-key" || failure === "refused-path") {
    return record(capability, route, "DOCUMENTED", `${NO_CONTACT_PREFIX}${failure}`, at);
  }
  const what = `${OBSERVED_PREFIX}${failure}${status !== null ? ` (HTTP ${status})` : ""} on ${route} at ${iso(at)}`;
  if (failure === "entitlement" || failure === "credits-exhausted" || failure === "unauthorized") {
    return record(capability, route, "ENTITLEMENT_BLOCKED", what, at);
  }
  if (failure === "not-found" && extra.notFoundIsSubject) {
    return record(capability, route, "DOCUMENTED", `${NO_CONTACT_PREFIX}404 for an unknown subject; the route answered but no payload was verified`, at);
  }
  return record(capability, route, "UNAVAILABLE", what, at);
}

/**
 * What `/v2/me` says about the two streams. Only a plan that EXCLUDES a stream
 * is a verdict (ENTITLEMENT_BLOCKED); an included stream is still untested, so
 * it is reported as an entitlement observation that lifts an earlier block and
 * otherwise changes nothing.
 */
export function capabilityFromAccount(account: AccountInfo, at: number): CapabilityRecord[] {
  const plan = account.plan ?? "unknown";
  const one = (capability: string, route: string, flag: boolean | null, field: string, need: string): CapabilityRecord =>
    flag === false
      ? record(capability, route, "ENTITLEMENT_BLOCKED", `${OBSERVED_PREFIX}/v2/me streams.${field}=false on plan ${plan}; ${need}`, at)
      : flag === true
        ? record(capability, route, "DOCUMENTED", `${ENTITLED_PREFIX} per /v2/me streams.${field}=true on plan ${plan}; stream not yet probed`, at)
        : record(capability, route, "DOCUMENTED", `${NO_CONTACT_PREFIX}/v2/me did not state streams.${field}`, at);
  return [
    one("ws-alerts", "/ws/alerts", account.streams.appFeed, "appFeed", "the app feed is on every plan, so this is unexpected"),
    one("ws-trades", "/ws/trades", account.streams.onChain, "onChain", "the on-chain stream needs a Growth or Scale key"),
  ];
}

/** How a websocket probe ended, as the stream module saw it. */
export interface StreamProbe {
  /** A `welcome` frame arrived: the application protocol works. */
  welcome: boolean;
  /** Delivery delay the welcome frame announced (a free key goes to 15 s after 7 days). */
  delaySeconds?: number | null;
  closeCode?: number | null;
  /** HTTP status of a refused upgrade, when the socket library exposes one. */
  httpStatus?: number | null;
}

export function capabilityFromStream(capability: string, route: string, probe: StreamProbe, at: number): CapabilityRecord {
  const base = BASELINE.get(capability);
  if (base?.status === "UNSUPPORTED") return { ...base };
  if (probe.welcome) {
    const delay = typeof probe.delaySeconds === "number" && Number.isFinite(probe.delaySeconds) ? probe.delaySeconds : null;
    return delay !== null && delay > 0
      ? record(capability, route, "PARTIAL", `${OBSERVED_PREFIX}welcome on ${route} at ${iso(at)}; delivery delayed ${delay} s`, at)
      : record(capability, route, "AUTHENTICATED_TESTED", `${OBSERVED_PREFIX}welcome on ${route} at ${iso(at)}; realtime`, at);
  }
  // 1008 is the vendor's documented close for a key whose plan lacks the stream.
  if (probe.closeCode === 1008 || probe.httpStatus === 401 || probe.httpStatus === 403) {
    const how = probe.closeCode === 1008 ? "close 1008" : `HTTP ${probe.httpStatus}`;
    return record(capability, route, "ENTITLEMENT_BLOCKED", `${OBSERVED_PREFIX}${how} on ${route} at ${iso(at)}`, at);
  }
  const how = probe.closeCode != null ? `close ${probe.closeCode}` : probe.httpStatus != null ? `HTTP ${probe.httpStatus}` : "no welcome";
  return record(capability, route, "UNAVAILABLE", `${OBSERVED_PREFIX}${how} on ${route} at ${iso(at)}`, at);
}

const LAST_SUCCESS = /last success (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/;

/** When this record last proved the capability worked, if it ever did. */
function lastSuccessOf(r: CapabilityRecord): number | null {
  if (r.status === "AUTHENTICATED_TESTED") return r.verifiedAt;
  if (r.status === "PARTIAL" && r.evidence.startsWith(OBSERVED_PREFIX)) return r.verifiedAt;
  const m = LAST_SUCCESS.exec(r.evidence);
  if (!m?.[1]) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

/** Fold newer evidence into the stored record. See the module comment for the two rules. */
export function mergeCapability(prior: CapabilityRecord | null | undefined, next: CapabilityRecord): CapabilityRecord {
  if (!prior) return next;
  if (prior.status === "UNSUPPORTED") return prior;
  if (next.status === "UNSUPPORTED") return next;
  if (next.status === "DOCUMENTED") {
    // No evidence never downgrades. The one exception is an observed
    // entitlement lifting an observed block (the plan was upgraded).
    return prior.status === "ENTITLEMENT_BLOCKED" && next.evidence.startsWith(ENTITLED_PREFIX) && next.verifiedAt >= prior.verifiedAt
      ? next
      : prior;
  }
  // Evidence that arrives late is older than what we already hold.
  if (next.verifiedAt < prior.verifiedAt) return prior;
  if (next.status === "UNAVAILABLE" || next.status === "ENTITLEMENT_BLOCKED") {
    const last = lastSuccessOf(prior);
    if (last !== null && !LAST_SUCCESS.test(next.evidence)) {
      return { ...next, evidence: clean(`${next.evidence}; last success ${iso(last)}`, 700) };
    }
  }
  return next;
}

/** Merge a batch by capability name. Order follows `prior`, then new names in arrival order. */
export function mergeCapabilities(prior: readonly CapabilityRecord[], next: readonly CapabilityRecord[]): CapabilityRecord[] {
  const out = new Map<string, CapabilityRecord>();
  for (const r of prior) out.set(r.capability, r);
  for (const r of next) out.set(r.capability, mergeCapability(out.get(r.capability), r));
  return [...out.values()];
}

function cell(s: string, max: number): string {
  return sanitizeText(s, max).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** A markdown table for operators and the integration doc. Every cell is sanitised and key-redacted. */
export function capabilityReport(records: readonly CapabilityRecord[]): string {
  const lines = ["| Capability | Route | Status | Evidence | As of |", "|---|---|---|---|---|"];
  for (const r of records) {
    const status = STATUSES.has(r.status) ? r.status : cell(String(r.status), 24);
    const route = cell(redactUrl(r.route), 120).replace(/`/g, "");
    lines.push(`| ${cell(r.capability, 64)} | \`${route}\` | ${status} | ${cell(redactUrl(r.evidence), 700)} | ${shortIso(r.verifiedAt)} |`);
  }
  return lines.join("\n") + "\n";
}
