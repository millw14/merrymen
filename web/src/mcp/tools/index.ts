/**
 * The tool catalogue. Each family lives in its own module; this list is what
 * the server registers (filtered per connection by scope, re-checked on every
 * call by the policy).
 */
import type { ToolDef } from "../tool";
import { AGENT_TOOLS } from "./agents";
import { PORTFOLIO_TOOLS } from "./portfolio";
import { DECISIONS_TOOLS } from "./decisions";
import { MARKET_TOOLS } from "./market";
import { CHAT_TOOLS } from "./chat";
import { REPORTS_TOOLS } from "./reports";
import { PUBLIC_TOOLS } from "./public";
import { PROPOSAL_TOOLS } from "./proposals";
import { STAFF_TOOLS } from "./staff";
import { JOBS_TOOLS } from "./jobs";
import { NOTIFICATIONS_TOOLS } from "./notifications";
import { SOCIAL_TOOLS } from "./social";
import { withAppMeta } from "../apps";

// withAppMeta attaches the MCP Apps view (ui:// resource) to the tools that have one.
export const ALL_TOOLS: readonly ToolDef[] = withAppMeta([
  ...AGENT_TOOLS,
  ...PORTFOLIO_TOOLS,
  ...DECISIONS_TOOLS,
  ...MARKET_TOOLS,
  ...CHAT_TOOLS,
  ...REPORTS_TOOLS,
  ...PUBLIC_TOOLS,
  ...PROPOSAL_TOOLS,
  ...JOBS_TOOLS,
  ...NOTIFICATIONS_TOOLS,
  ...SOCIAL_TOOLS,
  ...STAFF_TOOLS,
] as unknown as readonly ToolDef[]);
