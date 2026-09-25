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

export const ALL_TOOLS: readonly ToolDef[] = [
  ...AGENT_TOOLS,
  ...PORTFOLIO_TOOLS,
  ...DECISIONS_TOOLS,
  ...MARKET_TOOLS,
  ...CHAT_TOOLS,
  ...REPORTS_TOOLS,
  ...PUBLIC_TOOLS,
  ...PROPOSAL_TOOLS,
  ...STAFF_TOOLS,
] as unknown as readonly ToolDef[];
