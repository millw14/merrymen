/**
 * The OAuth scopes an MCP connection can hold, and the capabilities each one
 * unlocks.
 *
 * Scopes are what the owner consents to; capabilities are what code checks.
 * Every tool declares ONE capability, and the policy (policy.ts) maps it back
 * to a scope — so the security boundary is this explicit table, never a
 * pattern on a tool's name. Tool annotations (read-only, destructive) are
 * metadata for the client's UI and are not consulted here.
 *
 * None of these scopes can move funds. The strongest ones (trade:propose,
 * drafts:write, social:write) only create proposals that the owner must
 * approve on a Merrymen page with their own sign-in, where the worker's own
 * gates and the on-chain permission wall still apply.
 */

export type Capability =
  | "market.read"
  | "agents.read"
  | "portfolio.read"
  | "decisions.read"
  | "chat.send"
  | "research.submit"
  | "watchlist.manage"
  | "notifications.manage"
  | "drafts.write"
  | "trade.propose"
  | "jobs.run"
  | "social.write"
  | "reports.read"
  | "staff.diagnostics";

export type ScopeLevel = "read" | "write" | "sensitive" | "staff";

export interface ScopeInfo {
  id: string;
  title: string;
  /** Plain-language consent text: what the connected app can do. */
  detail: string;
  level: ScopeLevel;
  capabilities: readonly Capability[];
  /** Only meaningful with access to at least one of the owner's agents. */
  needsAgent: boolean;
  /** Ticked on the consent screen when requested. Sensitive scopes start unticked. */
  defaultOn: boolean;
}

export const SCOPES: readonly ScopeInfo[] = [
  {
    id: "market:read", level: "read", needsAgent: false, defaultOn: true,
    title: "Research markets and public agents",
    detail: "Search tokens, read prices, candles, liquidity and public agent profiles, theses and leaderboards. Nothing private.",
    capabilities: ["market.read"],
  },
  {
    id: "agents:read", level: "read", needsAgent: true, defaultOn: true,
    title: "See your agent’s status and settings",
    detail: "Its mode (paper or live), strategy, limits, permission expiry and whether it is running.",
    capabilities: ["agents.read"],
  },
  {
    id: "portfolio:read", level: "read", needsAgent: true, defaultOn: true,
    title: "See your portfolio and trades",
    detail: "Cash, savings, positions, profit and loss, fees and your trade history with receipts.",
    capabilities: ["portfolio.read"],
  },
  {
    id: "decisions:read", level: "read", needsAgent: true, defaultOn: true,
    title: "See your agent’s decisions",
    detail: "What it decided and why, what it refused, and why it has not traded.",
    capabilities: ["decisions.read"],
  },
  {
    id: "reports:read", level: "read", needsAgent: true, defaultOn: true,
    title: "Create reports and exports",
    detail: "Daily and weekly summaries and downloadable portfolio or trade exports that expire after a day.",
    capabilities: ["reports.read"],
  },
  {
    id: "chat:write", level: "write", needsAgent: true, defaultOn: true,
    title: "Talk with your agent",
    detail: "Send it messages and research notes and read the replies. Messages cannot change settings or place trades.",
    capabilities: ["chat.send", "research.submit"],
  },
  {
    id: "watchlist:manage", level: "write", needsAgent: false, defaultOn: true,
    title: "Manage your watchlist",
    detail: "Add and remove tokens you are watching. Watching a token never buys it.",
    capabilities: ["watchlist.manage"],
  },
  {
    id: "notifications:manage", level: "write", needsAgent: true, defaultOn: true,
    title: "Manage your alerts",
    detail: "Choose which alerts your agent sends to your linked Telegram, and see whether they were delivered.",
    capabilities: ["notifications.manage"],
  },
  {
    id: "jobs:run", level: "write", needsAgent: false, defaultOn: true,
    title: "Run backtests",
    detail: "Run historical strategy tests. Results are simulations, never promises of live returns.",
    capabilities: ["jobs.run"],
  },
  {
    id: "drafts:write", level: "sensitive", needsAgent: false, defaultOn: false,
    title: "Suggest setting changes for you to approve",
    detail: "Prepare agent drafts and setting changes. Nothing changes until you approve it in Merrymen.",
    capabilities: ["drafts.write"],
  },
  {
    id: "trade:propose", level: "sensitive", needsAgent: true, defaultOn: false,
    title: "Suggest trades for you to approve",
    detail: "Get quotes and prepare exact trade proposals. Nothing is bought or sold until you approve it in Merrymen, and your agent’s limits still apply.",
    capabilities: ["trade.propose"],
  },
  {
    id: "social:write", level: "sensitive", needsAgent: true, defaultOn: false,
    title: "Follow agents and draft posts",
    detail: "Follow or unfollow public agents for research and draft posts. A post is published only after you approve it in Merrymen. Following never copies trades.",
    capabilities: ["social.write"],
  },
  {
    id: "staff:diagnostics", level: "staff", needsAgent: false, defaultOn: false,
    title: "Merrymen staff diagnostics",
    detail: "Fleet health, provider errors and execution failures, with owners’ private data redacted. Staff only.",
    capabilities: ["staff.diagnostics"],
  },
  {
    id: "offline_access", level: "read", needsAgent: false, defaultOn: true,
    title: "Stay connected",
    detail: "Keep this connection working without signing in again, until you disconnect it or it expires.",
    capabilities: [],
  },
];

const BY_ID = new Map(SCOPES.map((s) => [s.id, s]));

export function scopeInfo(id: string): ScopeInfo | undefined {
  return BY_ID.get(id);
}

/** Scopes advertised to clients (the staff scope is never advertised). */
export const ADVERTISED_SCOPES: readonly string[] = SCOPES.filter((s) => s.level !== "staff").map((s) => s.id);

/** What a client gets asked for when it requests no scope at all: read access plus chat. */
export const DEFAULT_REQUEST_SCOPES: readonly string[] = [
  "market:read", "agents:read", "portfolio:read", "decisions:read", "reports:read", "chat:write", "offline_access",
];

/** The scope that grants a capability. Exactly one scope per capability, checked by a test. */
export function scopeFor(capability: Capability): string {
  for (const s of SCOPES) if (s.capabilities.includes(capability)) return s.id;
  throw new Error(`no scope grants ${capability}`);
}

/**
 * Parse an OAuth `scope` parameter. Unknown scopes are dropped (RFC 6749 lets the
 * server issue fewer), duplicates collapse, and the result is sorted so it can
 * be compared and stored canonically.
 */
export function parseScopeParam(raw: string | null | undefined, opts: { staff: boolean }): string[] {
  const requested = (raw ?? "").split(/\s+/).filter(Boolean);
  const list = requested.length ? requested : [...DEFAULT_REQUEST_SCOPES];
  const out = new Set<string>();
  for (const s of list) {
    const info = BY_ID.get(s);
    if (!info) continue;
    if (info.level === "staff" && !opts.staff) continue;
    out.add(s);
  }
  return [...out].sort();
}

export function normalizeScopes(list: readonly string[]): string[] {
  return [...new Set(list.filter((s) => BY_ID.has(s)))].sort();
}

export function scopeString(list: readonly string[]): string {
  return normalizeScopes(list).join(" ");
}
