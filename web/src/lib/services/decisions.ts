/**
 * An owner's own decisions, refusals and what became of each, read from the
 * shared ledger for a set of accounts the CALLER has already proved the owner
 * holds. Nothing here decides who may see what: it answers for the accounts it
 * is handed and for no others, so every query is `lower(agent_id) IN (…)`.
 *
 * Built on the vocabularies the product already speaks, so this surface cannot
 * drift from the feed and the chat:
 *   - `readDecisionLifecycle` (worker/src/decision-lifecycle.ts) for one decision,
 *   - `rejectRuleLabel` / `rejectRuleRemedy` / `classifyDrop` (thesis-policy.ts)
 *     for what a refusal or a drop means,
 *   - `ACCOUNT_WIDE_RULES` (owner-refusal.ts) and core's `RefuseRule` for which
 *     family a rule belongs to,
 *   - the chat tool's decisions query (telegram/chat-tools.ts) for the join to
 *     the newest trade and the exclusion of private market reviews.
 *
 * TEXT IS RETURNED RAW AND MARKED, never trusted. `reason`, `symbol`,
 * `display_name`, a dropped rule's tail and a post body were written by a model,
 * a token creator or a strategy; the MCP layer wraps them as untrusted. What is
 * NOT returned at all is text that can carry a provider's raw error — a Brain
 * run that could not reach its service, a submission that failed before the
 * chain — because that text can hold URLs, keys and internals nobody reviewed.
 * `signals_json` (the owner's whole balance sheet at decision time) is read only
 * when asked, and only its top-level scalars, capped.
 */
import { liveBlockerText, type RefuseRule } from "@merrymen/core";
import type { Db } from "../../../../worker/src/db";
import { readDecisionLifecycle, type DecisionLifecycle } from "../../../../worker/src/decision-lifecycle";
import { PRIVATE_REVIEW_SOURCE, RESEARCH_UNAVAILABLE_SOURCE, REVIEW_SOURCE } from "../../../../worker/src/market-review";
import { ACCOUNT_WIDE_RULES } from "../../../../worker/src/owner-refusal";
import { isProvenance, type Provenance } from "../../../../worker/src/provenance";
import type { RevertClass } from "../../../../worker/src/revert";
import { classifyDrop, rejectRuleLabel, rejectRuleRemedy, SHADOW_SOURCES } from "../../../../worker/src/thesis-policy";
import { readDecisionRealizedEvidence, type DecisionRealizedEvidence } from "./portfolio";

/**
 * The quiet-market review (market-review.ts quietReviewRow): a `hold` row the
 * tick writes every few minutes while its strategy has nothing to propose. It
 * is commentary on one shared oracle series, not the agent's own trading
 * choice, so it is never counted as a hold the model chose.
 */
export const REVIEW_SOURCES: readonly string[] = [REVIEW_SOURCE, PRIVATE_REVIEW_SOURCE, RESEARCH_UNAVAILABLE_SOURCE];
/** Brain runs recorded to be watched, never sent as orders (thesis-policy SHADOW_SOURCES). */
export const SHADOW_DECISION_SOURCES: readonly string[] = SHADOW_SOURCES;
/** The trade kinds that are a fill of a market position (profile-trades.ts, social.ts use the same pair). */
export const FILL_KINDS: readonly string[] = ["swap", "curve-trade"];

/** A decision id: a UUID, or `dec_<hex>` minted by the Brain. Anything else is not an id. */
export const DECISION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SLUG_RULE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Caps a query's IN list; an identity holds a handful of accounts, never hundreds. */
const MAX_ACCOUNTS = 16;

export function normAccounts(accounts: readonly string[]): string[] {
  return [...new Set(accounts.map((a) => a.toLowerCase()).filter((a) => ADDRESS_RE.test(a)))].slice(0, MAX_ACCOUNTS);
}

const holes = (n: number) => Array.from({ length: n }, () => "?").join(", ");
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
export const txHashOrNull = (v: unknown): string | null => (typeof v === "string" && TX_HASH_RE.test(v) ? v.toLowerCase() : null);
const addressOrNull = (v: unknown): string | null => (typeof v === "string" && ADDRESS_RE.test(v) ? v.toLowerCase() : null);

// ── what a refusal means ─────────────────────────────────────────────────────

/**
 * Which kind of "no" a rule is. The families are what an owner acts on
 * differently: a policy limit, the live rail, money, their own consent switch,
 * a market that could not be quoted, or an operation that failed on its way to
 * (or on) the chain.
 */
export const RULE_FAMILIES = ["policy", "preflight", "live_rail", "funding", "consent", "quote", "execution", "other"] as const;
export type RuleFamily = (typeof RULE_FAMILIES)[number];

export interface RuleView {
  /** A stable slug: the stored rule when it is one, else the family's own name for free text. */
  key: string;
  family: RuleFamily;
  /** Our sentence for it, or null when this build does not recognise the rule. */
  label: string | null;
  /** What the owner can do, only where there is a real action (thesis-policy's rule). */
  remedy: string | null;
  /** The author-written clause after the rule ("preflight: …"), raw. Callers mark it untrusted. */
  detail: string | null;
  /** True when the stored text carried detail that is deliberately not relayed (raw error text). */
  detail_withheld: boolean;
}

/** Wall rules written by policy.ts, beyond the account-wide set owner-refusal.ts already names. */
const POLICY_RULES: ReadonlySet<string> = new Set([
  ...ACCOUNT_WIDE_RULES,
  "target-allowlist", "order-amount", "ticker-allowlist", "asset-allowlist", "curve-provenance", "no-exit",
  "transfer-amount", "transfer-recipient", "transfer-recipient-allowlist",
]);

/** Every RefuseRule, typed so a new leg in core fails to compile here until it is placed. */
const RAIL_FAMILY: Record<RefuseRule, RuleFamily> = {
  "not-armed": "live_rail",
  "dead-policy": "live_rail",
  "grant-too-wide": "live_rail",
  "no-executor": "live_rail",
  "live-not-enabled": "consent",
  "wrong-chain": "live_rail",
  "no-gas": "funding",
  "no-cash": "funding",
};

/** Refusals written while quoting or routing, before anything was signed (index.ts quote paths, impact.ts). */
const QUOTE_RULES: ReadonlySet<string> = new Set([
  "no-route", "no-quote", "no-liquidity", "impact-cap", "impact-unknown", "no-rialto-key", "no-curve-adapter",
  "router-migrated", "class-side-ambiguous", "class-legs-unconfirmed", "class-sell-needs-vault", "class-vault-unreadable",
  "curve-graduated",
]);

/**
 * classifyRevert's classes (revert.ts), in the owner's words. Typed against
 * RevertClass so the list cannot silently fall behind the taxonomy.
 */
const REVERT_LABELS: Record<RevertClass, string> = {
  slippage: "the price moved too far between quote and fill",
  "insufficient-balance": "the account did not hold what it tried to spend",
  allowance: "the router was not approved for the amount (a wiring fault on Merrymen's side)",
  prefund: "the account could not pay the operation's gas prefund",
  "wall-refused": "the smart account's own on-chain permission refused it",
  "no-liquidity": "the route had no liquidity to fill it",
  deadline: "a deadline passed before the operation was included",
  "curve-graduated": "the launch had graduated off its bonding curve",
  "curve-unsupported": "the launchpad adapter refused the trade's shape",
  "spend-cap": "the venue's spending window for this asset was used up",
  "quote-not-approved": "the vault holds no spending ceiling for the asset it was funded in",
  unclassified: "the chain refused it for a reason Merrymen does not recognise",
};

/**
 * Owner-facing labels for rules thesis-policy's public map does not carry.
 * Public sentences come first (rejectRuleLabel); these fill the gaps for an
 * owner reading their own book, where no stranger is the audience.
 */
const OWNER_LABELS: Readonly<Record<string, string>> = {
  expiry: "the signed trading permission had expired",
  "ticker-allowlist": "that ticker is not in its signed permissions",
  "order-amount": "the order size was not a positive amount",
  "non-positive": "the trade was sized at zero",
  "scout-budget": "past the scout budget for newly discovered coins",
  "transfer-amount": "the transfer amount was not positive",
  "transfer-recipient": "the transfer recipient was not an address",
  "transfer-not-permitted": "its signed permission does not allow transfers",
  "impact-cap": "the price impact at this size was above the maximum allowed",
  "impact-unknown": "the price impact could not be computed, so it was not traded blind",
  "no-rialto-key": "the Rialto route needs a key this deployment does not have",
  "router-migrated": "the venue's router had moved, so the route was not used",
  "class-side-ambiguous": "it could not tell which side of the launch trade this was",
  "class-legs-unconfirmed": "the launch trade's legs could not be confirmed",
  "class-sell-needs-vault": "the launch position sits in a vault this sell could not use",
  "class-vault-unreadable": "the launch vault could not be read",
  "not-recorded": "it was not sent because the attempt could not first be recorded",
};

/**
 * Owner remedies for rules thesis-policy's `rejectRuleRemedy` leaves null. Only
 * rules with a real, accurate owner action (policy.ts's own detail text says
 * what it is); everything else stays null rather than an invented fix.
 */
const OWNER_REMEDIES: Readonly<Record<string, string>> = {
  "daily-cap": "Wait for the trailing 24-hour budget to roll over, or re-sign your trading permission at /grant with a higher daily limit. Exits are never blocked by it.",
  "ops-cap": "Wait for the trailing 24-hour operation count to roll over, or re-sign at /grant with a higher daily operation limit.",
  "per-trade-cap": "Re-sign at /grant with a higher per-trade limit; the cap is sealed into the signature.",
  "deposit-cap": "Re-sign at /grant with a higher limit; vault deposits are measured against a signed cap.",
  expiry: "Re-sign your trading permission at /grant — it is free and nothing moves on-chain.",
  "drawdown-breaker": "New buys stay blocked while the account is below its drawdown limit from its high-water mark; exits still run. Re-signing at /grant with a wider drawdown limit changes the threshold.",
  "scout-budget": "Raise the scout budget in Settings if you want it to buy coins it discovers (it is 0 by default).",
  "impact-cap": "Raise the maximum price impact in Settings, or let it trade a smaller size.",
  prefund: "Send a little ETH to the agent's account — every operation pays a fee before it reaches the chain.",
};

function labelFor(key: string): string | null {
  return rejectRuleLabel(key) ?? OWNER_LABELS[key] ?? null;
}
function remedyFor(key: string): string | null {
  return rejectRuleRemedy(key) ?? OWNER_REMEDIES[key] ?? null;
}

/**
 * One stored refusal, described. `reject_rule` is NOT a closed vocabulary —
 * some paths write free text into it — so a slug is looked up, a known
 * free-text prefix is split into slug + detail, and anything else is reported
 * as unrecognised with its text withheld.
 */
export function describeRule(raw: string | null | undefined, status: string | null | undefined): RuleView | null {
  const rule = typeof raw === "string" ? raw.trim() : "";
  const st = status ?? "";
  if (!rule) {
    if (st === "reverted") return { key: "unclassified", family: "execution", label: REVERT_LABELS.unclassified, remedy: null, detail: null, detail_withheld: false };
    return null;
  }
  const view = (key: string, family: RuleFamily, label: string | null, extra: Partial<RuleView> = {}): RuleView =>
    ({ key, family, label, remedy: remedyFor(key), detail: null, detail_withheld: false, ...extra });

  // The chain reverted it: the rule is a classifyRevert class (index.ts stores the class, not the message).
  if (st === "reverted") {
    if (/^reverted on-chain/i.test(rule)) return view("reverted-resolved", "execution", "it reverted on-chain (found later by reconciliation)");
    if (Object.prototype.hasOwnProperty.call(REVERT_LABELS, rule)) return view(rule, "execution", REVERT_LABELS[rule as RevertClass]);
    return view("unclassified", "execution", REVERT_LABELS.unclassified, { detail_withheld: !SLUG_RULE_RE.test(rule) });
  }
  // A failure before submission stores ~80 characters of the raw error. That is
  // provider text (RPC, bundler): classified here, never relayed.
  if (/^couldn't submit/i.test(rule)) {
    return view("couldnt-submit", "execution", "it failed before it was submitted to the chain (bundler, RPC or gas pre-flight)", { detail_withheld: true });
  }
  const prefixed = /^(preflight|paper|review):\s*(.*)$/is.exec(rule);
  if (prefixed) {
    const [, kind, tail] = prefixed;
    const detail = tail.trim() ? tail.trim() : null;
    if (kind.toLowerCase() === "preflight") return view("preflight", "preflight", "the decision was not actionable as sized (the worker's pre-flight refused it)", { detail });
    if (kind.toLowerCase() === "paper") return view("paper-fill-refused", "execution", "the paper book refused the simulated fill", { detail });
    // `review: <e.message>` (index.ts) is the broker client's raw exception
    // text — a provider error, so it is classified and never relayed.
    return view("order-review", "execution", "the broker's order review refused the terms", { detail_withheld: detail !== null });
  }
  if (Object.prototype.hasOwnProperty.call(RAIL_FAMILY, rule)) {
    const family = RAIL_FAMILY[rule as RefuseRule];
    return view(rule, family, rejectRuleLabel(rule) ?? liveBlockerText(rule as RefuseRule));
  }
  if (POLICY_RULES.has(rule)) return view(rule, "policy", labelFor(rule));
  if (QUOTE_RULES.has(rule)) return view(rule, "quote", labelFor(rule));
  if (rule.startsWith("fence-") && SLUG_RULE_RE.test(rule)) {
    return view(rule, "execution", `a final pre-signing safety check refused it (${rule.slice(6)})`);
  }
  if (/^sponsor-(refused|unreachable|absurd)$/.test(rule)) return view(rule, "execution", "the gas sponsor declined to pay for it — Merrymen's side to fix");
  if (rule.startsWith("enable-") && SLUG_RULE_RE.test(rule)) return view(rule, "execution", "the gas pre-flight for enabling the permission refused it");
  if (rule === "not-recorded") return view(rule, "execution", labelFor(rule));
  // A suppressed intent: a class that reverted before and cannot succeed until
  // something changes is refused on sight, with the revert's class as its rule.
  if (Object.prototype.hasOwnProperty.call(REVERT_LABELS, rule)) {
    return view(rule, "execution", `${REVERT_LABELS[rule as RevertClass]} — not retried after an earlier revert`);
  }
  if (SLUG_RULE_RE.test(rule)) return view(rule, "other", labelFor(rule));
  return view("unrecognised", "other", null, { detail_withheld: true });
}

// ── holds, drops and outcomes ────────────────────────────────────────────────

export const HOLD_KINDS = ["MODEL_HOLD", "GATE_FORCED_HOLD", "STALE_MARK_HOLD", "QUIET_REVIEW", "UNKNOWN"] as const;
export type HoldKind = (typeof HOLD_KINDS)[number];

export const HOLD_KIND_TEXT: Readonly<Record<HoldKind, string>> = {
  MODEL_HOLD: "The model itself chose to hold.",
  GATE_FORCED_HOLD: "A gate in the Brain overruled the model's answer and forced a hold (for example a risk or data-quality gate that was shut). The model's own view may have been different.",
  STALE_MARK_HOLD: "It held while its price mark was stale, so the hold says nothing about the market.",
  QUIET_REVIEW: "A periodic market review written while its strategy had nothing to propose. It is commentary on one market's public price series, not a trading choice.",
  UNKNOWN: "Not recorded: the row predates hold kinds, or its producer does not report one.",
};

export function holdView(action: string | null, holdKind: string | null, source: string | null = null): { kind: HoldKind; explained: string } | null {
  if (action !== "hold") return null;
  const kind: HoldKind = holdKind === "MODEL_HOLD" || holdKind === "GATE_FORCED_HOLD" || holdKind === "STALE_MARK_HOLD" ? holdKind
    : source !== null && REVIEW_SOURCES.includes(source) ? "QUIET_REVIEW" : "UNKNOWN";
  return { kind, explained: HOLD_KIND_TEXT[kind] };
}

export const DROP_KINDS = ["brain-refused", "brain-unreachable", "brain-malformed", "proposal-dropped"] as const;
export type DropKind = (typeof DROP_KINDS)[number];

export function dropView(dropped: string | null): { kind: DropKind; label: string; rule_text: string | null } | null {
  if (!dropped) return null;
  if (dropped === "brain-refused") return { kind: dropped, label: "The Brain declined to make a decision on this run. A refusal is a result, not a failure.", rule_text: null };
  if (dropped === "brain-unreachable") return { kind: dropped, label: "The Brain service could not be reached, so no decision was made.", rule_text: null };
  if (dropped === "brain-malformed") return { kind: dropped, label: "The Brain answered with something unusable, so no decision was made.", rule_text: null };
  // `dropped_rule` embeds a model-supplied symbol; the label is ours (classifyDrop), the text goes back marked.
  return { kind: "proposal-dropped", label: `Dropped before it reached the wall: ${classifyDrop(dropped)}.`, rule_text: dropped };
}

/**
 * The stored explanation, or why it is withheld. A Brain run that could not
 * reach or parse its service stored the raw error as its reason, which is
 * provider text and stays in the agent's own log.
 */
export function explanationOf(reason: string | null, dropped: string | null): { text: string | null; withheld: string | null } {
  if (dropped === "brain-unreachable" || dropped === "brain-malformed") {
    return { text: null, withheld: "The stored text is a raw service error and is not relayed here; the agent's activity log in Merrymen shows it." };
  }
  return { text: reason, withheld: null };
}

export const OUTCOME_CATEGORIES = [
  "confirmed", "landed_without_tx_hash", "paper_fill", "submitted_unconfirmed", "reverted", "rejected",
  "dropped", "hold", "view", "shadow_only", "no_trade_recorded",
] as const;
export type OutcomeCategory = (typeof OUTCOME_CATEGORIES)[number];

export const OUTCOME_TEXT: Readonly<Record<OutcomeCategory, string>> = {
  confirmed: "Landed on chain with a transaction hash.",
  landed_without_tx_hash: "Recorded as landed, but no transaction hash is on record, so it is not shown as confirmed.",
  paper_fill: "A simulated fill on the paper book. No real funds moved.",
  submitted_unconfirmed: "Sent, and not yet confirmed or settled in the shared records.",
  reverted: "Reached the chain and reverted. No trade happened.",
  rejected: "Refused before anything was sent.",
  dropped: "Dropped before it reached the wall; no trade was attempted.",
  hold: "A hold: no trade was intended.",
  view: "A view with no action (the agent explaining why it is not acting).",
  shadow_only: "A Brain decision made in shadow: recorded so it can be watched and graded, never sent as an order.",
  no_trade_recorded: "No trade row is linked to it: it never reached the wall, or the record has not arrived yet.",
};

export function outcomeCategory(action: string | null, dropped: string | null, trade: { status: string; tx_hash: string | null } | null, source: string | null = null): OutcomeCategory {
  if (trade) {
    switch (trade.status) {
      case "landed": return txHashOrNull(trade.tx_hash) ? "confirmed" : "landed_without_tx_hash";
      case "paper": return "paper_fill";
      case "submitted": return "submitted_unconfirmed";
      case "reverted": return "reverted";
      case "rejected": return "rejected";
    }
  }
  if (dropped) return "dropped";
  if (action === "hold") return "hold";
  if (action === null) return "view";
  if (source !== null && SHADOW_DECISION_SOURCES.includes(source)) return "shadow_only";
  return "no_trade_recorded";
}

/** Which book a trade status belongs to. A refusal carries no book in the ledger. */
export function bookOfStatus(status: string | null | undefined): "paper" | "live" | null {
  if (status === "paper") return "paper";
  if (status === "landed" || status === "submitted" || status === "reverted") return "live";
  return null;
}

// ── bounded JSON views ───────────────────────────────────────────────────────

export type Scalar = string | number | boolean | null;
export interface KeyValue { key: string; value: Scalar }

/**
 * A nested JSON value flattened to dotted keys, bounded in bytes, depth,
 * entries and array length. Strings are returned raw for the caller to mark.
 */
export function flattenJson(raw: string | null, o: { maxBytes: number; maxEntries: number; maxDepth: number; maxArray: number; topLevelScalarsOnly?: boolean; skipKey?: (k: string) => boolean }): { entries: KeyValue[]; truncated: boolean; state: "ok" | "absent" | "too_large" | "unreadable" } {
  if (raw === null || raw === "") return { entries: [], truncated: false, state: "absent" };
  if (raw.length > o.maxBytes) return { entries: [], truncated: true, state: "too_large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], truncated: false, state: "unreadable" };
  }
  const entries: KeyValue[] = [];
  let truncated = false;
  const walk = (v: unknown, key: string, depth: number) => {
    if (entries.length >= o.maxEntries) { truncated = true; return; }
    if (v === null || typeof v === "string" || typeof v === "boolean") { entries.push({ key, value: v as Scalar }); return; }
    if (typeof v === "number") { entries.push({ key, value: Number.isFinite(v) ? v : null }); return; }
    if (o.topLevelScalarsOnly || depth >= o.maxDepth || typeof v !== "object") { truncated = truncated || typeof v === "object"; return; }
    if (Array.isArray(v)) {
      if (v.length > o.maxArray) truncated = true;
      v.slice(0, o.maxArray).forEach((x, i) => walk(x, `${key}.${i}`, depth + 1));
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, o.maxEntries)) {
      const safe = k.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
      if (!safe || o.skipKey?.(safe)) continue;
      walk(x, key ? `${key}.${safe}` : safe, depth + 1);
    }
  };
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { entries: [], truncated: false, state: "unreadable" };
  for (const [k, x] of Object.entries(parsed as Record<string, unknown>)) {
    if (entries.length >= o.maxEntries) { truncated = true; break; }
    const safe = k.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    if (!safe || o.skipKey?.(safe)) continue;
    walk(x, safe, 1);
  }
  return { entries, truncated, state: "ok" };
}

/**
 * Read at most one byte past these in SQL (substr), so an oversized column is
 * reported as too_large without ever being transferred whole.
 */
const EVIDENCE_MAX_BYTES = 32_768;
const SIGNALS_MAX_BYTES = 131_072;

/** evidence_json: the banded fact layer behind a post, written to be read. */
export const evidenceOf = (raw: string | null) => flattenJson(raw, { maxBytes: EVIDENCE_MAX_BYTES, maxEntries: 40, maxDepth: 3, maxArray: 6 });

/**
 * signals_json: the inputs the decision was made on — the owner's own figures,
 * so an owner may see them, but only its top-level observed values (prices,
 * confidence, sizes, thresholds), never nested books, and never ids.
 */
export const signalsSubsetOf = (raw: string | null) =>
  flattenJson(raw, { maxBytes: SIGNALS_MAX_BYTES, maxEntries: 24, maxDepth: 1, maxArray: 0, topLevelScalarsOnly: true, skipKey: (k) => /(^|_)id$/i.test(k) });

// ── the owner's decision list ────────────────────────────────────────────────

export interface OwnerDecisionRow {
  id: string;
  agent_id: string;
  at: number;
  source: string;
  strategy: string | null;
  provider: string | null;
  model: string | null;
  provenance: Provenance | null;
  action: string | null;
  symbol: string | null;
  display_name: string | null;
  size_usdg: number | null;
  reason: string | null;
  dropped_rule: string | null;
  hold_kind: string | null;
  mark_usd: number | null;
  mcap_usd: number | null;
  evidence_json: string | null;
  signals_json: string | null;
  trade: {
    id: number;
    status: string;
    tx_hash: string | null;
    user_op_hash: string | null;
    reject_rule: string | null;
    token: string | null;
    created_at: number;
  } | null;
}

export interface DecisionQuery {
  since: number | null;
  action: "buy" | "sell" | "hold" | null;
  /** A ticker or coin name, matched case-insensitively against the symbol and display name. */
  symbol: string | null;
  /** A token address: its Trencher id, or a linked trade on either leg. */
  address: string | null;
  /** Keyset position: rows strictly older than this (at DESC, id DESC). */
  before: { at: number; id: string } | null;
  limit: number;
  withEvidence: boolean;
}

/** The token a linked trade moved: what a buy bought, what a sell sold. */
function tradeToken(action: string | null, buy: unknown, sell: unknown): string | null {
  if (action === "sell") return addressOrNull(sell) ?? addressOrNull(buy);
  return addressOrNull(buy) ?? addressOrNull(sell);
}

/**
 * The decision columns plus the NEWEST trade carrying its id (the chat tool's
 * join), so the list and the single read describe an outcome identically.
 * `signals_json` is selected only when asked for.
 */
function decisionSelect(o: { evidence: boolean; signals: boolean }): string {
  return `SELECT d.id, d.agent_id, d.at, d.source, d.strategy, d.provider, d.model, d.provenance, d.action, d.symbol,
        d.display_name, d.size_usdg, d.reason, d.dropped_rule, d.hold_kind, d.mark_usd, d.mcap_usd,
        ${o.evidence ? `substr(d.evidence_json, 1, ${EVIDENCE_MAX_BYTES + 1}) AS evidence_json` : "NULL AS evidence_json"},
        ${o.signals ? `substr(d.signals_json, 1, ${SIGNALS_MAX_BYTES + 1}) AS signals_json` : "NULL AS signals_json"},
        t.id AS t_id, t.status AS t_status, t.tx_hash AS t_tx_hash, t.user_op_hash AS t_user_op_hash, t.reject_rule AS t_reject_rule,
        t.buy_token AS t_buy_token, t.sell_token AS t_sell_token, t.created_at AS t_created_at
      FROM decisions d
      LEFT JOIN trades t ON t.id = (SELECT MAX(x.id) FROM trades x WHERE x.decision_id = d.id AND lower(x.agent_id) = lower(d.agent_id))`;
}

function decisionRow(r: Record<string, unknown>): OwnerDecisionRow {
  const action = str(r.action);
  return {
    id: String(r.id),
    agent_id: String(r.agent_id).toLowerCase(),
    at: Number(r.at),
    source: String(r.source),
    strategy: str(r.strategy),
    provider: str(r.provider),
    model: str(r.model),
    provenance: isProvenance(r.provenance) ? r.provenance : null,
    action,
    symbol: str(r.symbol),
    display_name: str(r.display_name),
    size_usdg: num(r.size_usdg),
    reason: str(r.reason),
    dropped_rule: str(r.dropped_rule),
    hold_kind: str(r.hold_kind),
    mark_usd: num(r.mark_usd),
    mcap_usd: num(r.mcap_usd),
    evidence_json: str(r.evidence_json),
    signals_json: str(r.signals_json),
    trade: r.t_id === null || r.t_id === undefined ? null : {
      id: Number(r.t_id),
      status: String(r.t_status),
      tx_hash: txHashOrNull(r.t_tx_hash),
      user_op_hash: txHashOrNull(r.t_user_op_hash),
      reject_rule: str(r.t_reject_rule),
      token: tradeToken(action, r.t_buy_token, r.t_sell_token),
      created_at: Number(r.t_created_at),
    },
  };
}

/**
 * Newest first, keyset-paginated. Returns up to `limit + 1` rows so the caller
 * can tell whether another page exists.
 */
export async function readOwnerDecisions(db: Db, accounts: readonly string[], q: DecisionQuery): Promise<OwnerDecisionRow[]> {
  const acc = normAccounts(accounts);
  if (!acc.length) return [];
  const where: string[] = [`lower(d.agent_id) IN (${holes(acc.length)})`, "d.source <> ?"];
  const params: unknown[] = [...acc, PRIVATE_REVIEW_SOURCE];
  if (q.since !== null) { where.push("d.at >= ?"); params.push(q.since); }
  if (q.action) { where.push("d.action = ?"); params.push(q.action); }
  if (q.symbol) {
    where.push("(UPPER(d.symbol) = ? OR UPPER(d.display_name) = ?)");
    params.push(q.symbol.toUpperCase(), q.symbol.toUpperCase());
  }
  if (q.address) {
    const a = q.address.toLowerCase();
    where.push(`(UPPER(d.symbol) = ? OR EXISTS (SELECT 1 FROM trades tt WHERE tt.decision_id = d.id AND lower(tt.agent_id) = lower(d.agent_id)
      AND (lower(tt.buy_token) = ? OR lower(tt.sell_token) = ?)))`);
    params.push(`T${a.slice(-11).toUpperCase()}`, a, a);
  }
  if (q.before) {
    where.push("(d.at < ? OR (d.at = ? AND d.id < ?))");
    params.push(q.before.at, q.before.at, q.before.id);
  }
  params.push(q.limit + 1);
  const rows = (await db.prepare(`${decisionSelect({ evidence: q.withEvidence, signals: q.withEvidence })}
      WHERE ${where.join(" AND ")}
      ORDER BY d.at DESC, d.id DESC LIMIT ?`).all(...params)) as Record<string, unknown>[];
  return rows.map(decisionRow);
}

// ── one decision ─────────────────────────────────────────────────────────────

export interface OwnerDecision {
  row: OwnerDecisionRow;
  lifecycle: DecisionLifecycle;
  /**
   * One entry per lifecycle trade, in the same order: whether its realized
   * figure is a MEASUREMENT by get_trade's rule (portfolio.ts
   * readDecisionRealizedEvidence). Null when it has no realized figure, when
   * the cost could not be replayed, or when the evidence read and the
   * lifecycle read do not describe the same row.
   */
  realized_measured: Array<boolean | null>;
}

/**
 * Pair the evidence rows with the lifecycle's, row by row, only where both
 * reads describe the same row (time, status and operation). Anything that does
 * not line up — a row written between the two reads — is left unjudged (null),
 * never assumed measured.
 */
export function pairRealizedEvidence(
  trades: DecisionLifecycle["trades"],
  evidence: readonly DecisionRealizedEvidence[] | null,
): Array<boolean | null> {
  return trades.map((t, i) => {
    if (t.realized_pnl_usdg === null) return null;
    const e = evidence?.[i];
    const op = t.user_op_hash ? t.user_op_hash.toLowerCase() : null;
    return e && e.created_at === t.created_at && e.status === t.status && e.user_op_hash === op ? e.measured : null;
  });
}

/**
 * One decision and its whole life, ONLY if it belongs to one of `accounts`.
 *
 * readDecisionLifecycle trusts the id it is handed (it has no owner check), so
 * ownership is settled first, on the row's own agent_id. A missing id and a
 * foreign one both return null: the caller answers not_found to both, so the
 * surface cannot be used to learn which ids exist.
 */
export async function readOwnerDecision(db: Db, accounts: readonly string[], decisionId: string, withEvidence: boolean): Promise<OwnerDecision | null> {
  if (!DECISION_ID_RE.test(decisionId)) return null;
  const acc = normAccounts(accounts);
  if (!acc.length) return null;
  const r = (await db.prepare(`${decisionSelect({ evidence: true, signals: withEvidence })} WHERE d.id = ? LIMIT 1`).get(decisionId)) as Record<string, unknown> | undefined;
  if (!r || !acc.includes(String(r.agent_id).toLowerCase())) return null;
  const lifecycle = await readDecisionLifecycle(db, decisionId);
  if (!lifecycle || !acc.includes(lifecycle.decision.agent_id.toLowerCase())) return null;
  // Only a decision with a realized figure needs its costs replayed.
  const evidence = lifecycle.trades.some((t) => t.realized_pnl_usdg !== null)
    ? await readDecisionRealizedEvidence(db, lifecycle.decision.agent_id, decisionId).catch(() => null)
    : null;
  return { row: decisionRow(r), lifecycle, realized_measured: pairRealizedEvidence(lifecycle.trades, evidence) };
}

// ── refusals over a window ───────────────────────────────────────────────────

export interface WindowTrade {
  id: number;
  agent_id: string;
  kind: string;
  status: string;
  reject_rule: string | null;
  decision_id: string | null;
  tx_hash: string | null;
  user_op_hash: string | null;
  created_at: number;
}

/** A hard ceiling on rows scanned per window: a week of a 15 s tick refusing every time is ~40k. */
export const WINDOW_TRADE_CAP = 5000;

/** Every trade row in the window, newest first, capped. `truncated` means counts are lower bounds. */
export async function readWindowTrades(db: Db, accounts: readonly string[], since: number): Promise<{ rows: WindowTrade[]; truncated: boolean }> {
  const acc = normAccounts(accounts);
  if (!acc.length) return { rows: [], truncated: false };
  const rows = (await db.prepare(`SELECT id, agent_id, kind, status, reject_rule, decision_id, tx_hash, user_op_hash, created_at FROM trades
      WHERE lower(agent_id) IN (${holes(acc.length)}) AND created_at >= ? ORDER BY id DESC LIMIT ?`)
    .all(...acc, since, WINDOW_TRADE_CAP + 1)) as Record<string, unknown>[];
  const truncated = rows.length > WINDOW_TRADE_CAP;
  return {
    rows: rows.slice(0, WINDOW_TRADE_CAP).map((r) => ({
      id: Number(r.id),
      agent_id: String(r.agent_id).toLowerCase(),
      kind: String(r.kind),
      status: String(r.status),
      reject_rule: str(r.reject_rule),
      decision_id: str(r.decision_id),
      tx_hash: str(r.tx_hash),
      user_op_hash: str(r.user_op_hash),
      created_at: Number(r.created_at),
    })),
    truncated,
  };
}

/**
 * Market fills in the window, one per OPERATION (distinct-trades.ts): a
 * redeploy's reconciler re-wrote successful operations as bare 'swap' copies
 * under the same user-op hash, and a count of rows would read each twice.
 * Transfers, vault deposits and pre-flight refusals are not fills.
 */
export function countFills(rows: readonly WindowTrade[]): { live_landed: number; live_confirmed: number; paper: number; submitted_unresolved: number } {
  const ops = new Map<string, WindowTrade>();
  const rank = (t: WindowTrade) => (t.status === "submitted" ? 0 : 1) + (txHashOrNull(t.tx_hash) ? 2 : 0);
  for (const t of rows) {
    if (!FILL_KINDS.includes(t.kind)) continue;
    if (t.status !== "landed" && t.status !== "paper" && t.status !== "submitted") continue;
    const op = t.user_op_hash ? t.user_op_hash.toLowerCase() : "";
    const key = op ? `${t.agent_id}|${op}` : `row:${t.id}`;
    const prev = ops.get(key);
    if (!prev || rank(t) > rank(prev)) ops.set(key, t);
  }
  const all = [...ops.values()];
  const landed = all.filter((t) => t.status === "landed");
  return {
    live_landed: landed.length,
    live_confirmed: landed.filter((t) => txHashOrNull(t.tx_hash) !== null).length,
    paper: all.filter((t) => t.status === "paper").length,
    submitted_unresolved: all.filter((t) => t.status === "submitted").length,
  };
}

export interface RefusalBucket {
  key: string;
  family: RuleFamily;
  status: "rejected" | "reverted";
  label: string | null;
  remedy: string | null;
  count: number;
  first_at: number;
  last_at: number;
  /** Up to three of the newest, as (trade id, decision id) — the decision id opens get_decision. */
  examples: Array<{ trade_id: number; decision_id: string | null; at: number }>;
  /** The newest author-written detail for a free-text rule (preflight/paper/review), raw. */
  latest_detail: string | null;
  detail_withheld: boolean;
}

/** Group refused and reverted rows by their described rule, most frequent first. */
export function tallyRefusals(rows: readonly WindowTrade[]): RefusalBucket[] {
  const by = new Map<string, RefusalBucket>();
  for (const t of rows) {
    if (t.status !== "rejected" && t.status !== "reverted") continue;
    const v = describeRule(t.reject_rule, t.status) ?? { key: "unrecorded", family: "other" as const, label: "no rule was recorded", remedy: null, detail: null, detail_withheld: false };
    const id = `${t.status}|${v.key}`;
    let b = by.get(id);
    if (!b) {
      b = { key: v.key, family: v.family, status: t.status, label: v.label, remedy: v.remedy, count: 0, first_at: t.created_at, last_at: t.created_at, examples: [], latest_detail: null, detail_withheld: false };
      by.set(id, b);
    }
    b.count += 1;
    b.first_at = Math.min(b.first_at, t.created_at);
    if (t.created_at >= b.last_at) {
      b.last_at = t.created_at;
    }
    // Rows arrive newest first, so the first examples seen are the newest.
    if (b.examples.length < 3) b.examples.push({ trade_id: t.id, decision_id: t.decision_id && DECISION_ID_RE.test(t.decision_id) ? t.decision_id : null, at: t.created_at });
    if (b.latest_detail === null && v.detail) b.latest_detail = v.detail;
    b.detail_withheld = b.detail_withheld || v.detail_withheld;
  }
  return [...by.values()].sort((a, b) => b.count - a.count || b.last_at - a.last_at);
}
