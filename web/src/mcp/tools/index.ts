/**
 * The tool catalogue. Each family lives in its own module; this list is what
 * the server registers (filtered per connection by scope).
 */
import type { ToolDef } from "../tool";
import { AGENT_TOOLS } from "./agents";

export const ALL_TOOLS: readonly ToolDef[] = [
  ...AGENT_TOOLS,
] as unknown as readonly ToolDef[];
