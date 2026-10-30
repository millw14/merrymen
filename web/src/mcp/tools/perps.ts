/** Authenticated paper Perps reads. No keys, venue calls, orders or Spot totals. */
import * as z from "zod";
import { readAgentPerpsFrom } from "@/lib/agent-perps";
import { perpsOffered } from "@/lib/perps-enabled";
import { perpsAttention } from "../../../../worker/src/telegram/perps";
import { McpError } from "../errors";
import { defineTool, type ToolContext } from "../tool";
import { AGENT_ARG } from "./shared";

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const POSITION = z.object({market: z.string(), side: z.enum(["long", "short"]), base_amount: z.string(), entry_price: z.string(), mark_price: z.string().nullable(), stop_trigger: z.string().nullable(), unrealized_micro: z.string().nullable(), funding_micro: z.string().nullable()});
const OUTPUT = z.object({agent: z.string(), wallet: z.literal("perps"), book: z.literal("paper"), money: z.literal("simulated"), account: z.string().nullable(), permission_expires_at: z.number().nullable(), state: z.enum(["no-current-permission", "not-said", "unreadable", "ok"]), fresh: z.boolean(), reported_at_ms: z.number().nullable(), positions: z.array(POSITION).nullable(), collateral_micro: z.string().nullable(), open_notional_micro: z.string().nullable(), entries_halted: z.boolean().nullable(), attention: z.array(z.string()), note: z.string()});
const NOTE = "Separate Perps practice book, never added to Spot. Amounts ending in micro are integer millionths of simulated USDG. Missing or stale evidence is unknown, never an empty book. No live perpetual orders or signing are available through MCP.";

async function read(args: {agent?: string}, ctx: ToolContext) {
  if (!perpsOffered()) throw new McpError("unsupported", "Perps is not offered by this server.");
  // The caller must hold this agent's portfolio capability. A public slug or
  // supplied account address can never select the Perps wallet to read.
  const agent = await ctx.agent(args.agent);
  const {db} = await ctx.mcp();
  const row = await db.prepare(`SELECT grant_json->>'smartAccount' AS account, grant_json->>'owner' AS owner,
    grant_json->>'purpose' AS purpose, grant_json->>'expiresAt' AS expires_at
    FROM perps_grants WHERE tenant = ?`).get(ctx.principal.tenant.toLowerCase()) as {account: unknown; owner: unknown; purpose: unknown; expires_at: unknown} | undefined;
  const empty = {agent: agent.slug, wallet: "perps" as const, book: "paper" as const, money: "simulated" as const, account: null, permission_expires_at: null, state: "no-current-permission" as const, fresh: false, reported_at_ms: null, positions: null, collateral_micro: null, open_notional_micro: null, entries_halted: null, attention: [] as string[], note: NOTE};
  if (!row) return {data: {...empty, attention: ["There is no current Perps permission. This does not establish that an older practice book is empty."]}};
  const expiry = typeof row.expires_at === "number" ? row.expires_at : typeof row.expires_at === "string" && /^\d+$/.test(row.expires_at) ? Number(row.expires_at) : NaN;
  if (row.purpose !== "perps" || typeof row.account !== "string" || !ADDRESS.test(row.account) || typeof row.owner !== "string" || row.owner.toLowerCase() !== ctx.principal.tenant.toLowerCase() || !Number.isSafeInteger(expiry) || expiry < 0) {
    throw new McpError("upstream_unavailable", "The stored Perps wallet could not be verified.");
  }
  const account = row.account.toLowerCase() as `0x${string}`;
  if (agent.accounts.some(a => a.toLowerCase() === account)) throw new McpError("upstream_unavailable", "The Perps wallet is not separate from Spot.");
  const book = await ctx.perpsLedger(db => readAgentPerpsFrom(db, account));
  const report = book.state === "ok" && book.report.mode !== "live" && book.report.accountIndex === null && book.accountMode === "paper" ? book.report : null;
  const state = report ? "ok" as const : book.state === "not-said" ? "not-said" as const : "unreadable" as const;
  const fresh = report?.venueReadAt !== null && report?.venueReadAt !== undefined && report.venueReadAt <= ctx.now() * 1000 && ctx.now() * 1000 - report.venueReadAt <= 120_000;
  return {data: {...empty, account, permission_expires_at: expiry, state, fresh,
    reported_at_ms: report?.venueReadAt ?? null,
    positions: report ? report.positions.map(p => ({market:p.market, side:p.side, base_amount:p.baseAmount, entry_price:p.entryPrice, mark_price:p.markPrice, stop_trigger:p.stopTrigger, unrealized_micro:p.unrealizedMicro, funding_micro:p.fundingMicro})) : null,
    collateral_micro: report?.collateralMicro ?? null, open_notional_micro: report?.openNotionalMicro ?? null, entries_halted: report ? report.entriesHalted ?? false : null,
    attention: perpsAttention({state:"ready", account, grantExpiresAt:expiry, report}, ctx.now()),
  }};
}

export const PERPS_TOOLS = [defineTool({name: "get_perps", title: "Read paper perpetuals", description: "Read the authenticated owner's separate Perps practice positions, paper collateral, unrealized P&L, funding and attention items from the worker's last report. Does not execute orders, sign, open positions or read Spot balances.", capability: "portfolio.read", input: z.object({agent: AGENT_ARG}).strict(), output: OUTPUT, annotations: {readOnlyHint:true, openWorldHint:false}, handler:read})];
