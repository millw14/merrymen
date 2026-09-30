/**
 * The resource catalogue: documentation every connection can read, plus
 * per-family resources (agent snapshots, decisions, exports) registered by
 * their modules.
 */
import type { ResourceDef } from "./resources";
import { SCOPES, scopeAllowedIn, type McpProfile } from "./scopes";
import { ERROR_CODES } from "./errors";
import { PORTFOLIO_RESOURCES } from "./tools/portfolio";
import { DECISIONS_RESOURCES } from "./tools/decisions";
import { MARKET_RESOURCES } from "./tools/market";
import { REPORTS_RESOURCES } from "./tools/reports";
import { PUBLIC_RESOURCES } from "./tools/public";
import { APP_RESOURCES } from "./apps";

/** On the directory profile only the scopes it can hold are described: the rest cannot exist there. */
function capabilitiesDoc(profile: McpProfile = "full"): string {
  const scopes = SCOPES.filter((s) => s.level !== "staff" && scopeAllowedIn(profile, s.id)).map((s) => `- \`${s.id}\` (${s.level}): ${s.title}. ${s.detail}`).join("\n");
  const errors = Object.entries(ERROR_CODES).map(([code, e]) => `- \`${code}\` (HTTP-like ${e.http}${e.retryable ? ", retryable" : ""}): ${e.what}`).join("\n");
  return `# Merrymen MCP: scopes and errors

## Scopes
${scopes}

A connection only ever sees the agents its owner chose on the consent screen. No scope can move funds: trade and setting proposals take effect only after the owner approves them in Merrymen.

## Error codes
${errors}
`;
}

const METRICS_DOC = `# Merrymen metrics

- **Book**: "paper" (simulated funds) or "live" (real funds on chain). Figures are never combined across books.
- **Equity**: cash + savings (Morpho vault, valued at its share price) + positions at their last price + tokens carried at cost when they cannot be priced. Gas ETH is excluded.
- **Realised P&L**: proceeds minus weighted-average cost of the quantity sold. A sell whose cost basis is unknown has no realised figure (null), never zero.
- **Unrealised P&L**: last value minus cost basis of the open quantity. Null when the price is missing or stale.
- **Return (leaderboard)**: (latest equity − net contributions − gas) ÷ net contributions over the current run. Published only when contributions are known and at least one live trade landed.
- **Max drawdown**: largest peak-to-trough fall of equity over the window.
- **Confirmed trade**: an operation with a successful on-chain receipt and a reconciled fill. "Submitted" is not confirmed; "paper" is a simulated fill.
- **Valuation time**: when the worker last wrote a complete mark (equity row). Positions carry their own update time and a stale-price flag.
- **Worker fresh**: heartbeat younger than max(180 s, 2 × tick + 90 s).
`;

export const DOC_RESOURCES: ResourceDef[] = [
  {
    name: "capabilities",
    title: "Scopes, permissions and error codes",
    description: "What each scope allows, and the stable error codes tools return.",
    mimeType: "text/markdown",
    capability: null,
    uri: "merrymen://docs/capabilities",
    async read(_uri, _vars, ctx) {
      return { mimeType: "text/markdown", text: capabilitiesDoc(ctx?.principal?.profile) };
    },
  },
  {
    name: "metrics",
    title: "How Merrymen measures performance",
    description: "Definitions of equity, P&L, returns, drawdown, confirmed trades and freshness.",
    mimeType: "text/markdown",
    capability: null,
    uri: "merrymen://docs/metrics",
    async read() {
      return { mimeType: "text/markdown", text: METRICS_DOC };
    },
  },
];

export const ALL_RESOURCES: readonly ResourceDef[] = [
  ...DOC_RESOURCES,
  ...PORTFOLIO_RESOURCES,
  ...DECISIONS_RESOURCES,
  ...MARKET_RESOURCES,
  ...REPORTS_RESOURCES,
  ...PUBLIC_RESOURCES,
  ...APP_RESOURCES,
];
