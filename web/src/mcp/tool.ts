/**
 * How an MCP tool is defined and what runs around it.
 *
 * A tool is a thin adapter: validate input (zod, strict), check the policy,
 * call a shared service, shape the output. The wrapper applies the same
 * controls to every tool, so none can forget one:
 *
 *   capability check → per-tool rate limit + any daily budget → timeout →
 *   handler → output (structured + text) → audit + metrics.
 *
 * Errors come back as `isError` results with a stable code
 * (errors.ts), never as an empty success. Nothing thrown by a service is
 * echoed to the client except an McpError's own message.
 */
import type * as z from "zod";
import type { Db } from "../../../worker/src/db";
import { withReadDb } from "@/lib/ledger";
import { agentDirectory, type AgentDirectory, type OwnedAgent } from "./agents";
import { mcpDb, type McpDb } from "./db";
import { McpError, asMcpError, errorBody, type ErrorBody } from "./errors";
import { auditDetail, logEvent, pseudonym, rateHit, recordToolCall, writeAudit } from "./observe";
import { hasCapability, reachableAgents, requireCapability, resolveOwnedAgent } from "./policy";
import type { Capability } from "./scopes";
import type { Principal } from "./oauth/server";

export interface ToolAnnotations {
  /** True only when the tool changes nothing anywhere. */
  readOnlyHint: boolean;
  /** True when the tool can delete or overwrite something the owner cares about. */
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  /** True when the tool reaches data sources outside Merrymen (market providers, the chain). */
  openWorldHint: boolean;
}

export interface Budget {
  /** Bucket name; defaults to the tool name. Tools sharing a costly backend share a bucket. */
  bucket?: string;
  perMinute?: number;
  perHour?: number;
  perDay?: number;
}

export interface ToolContext {
  principal: Principal;
  traceId: string;
  signal: AbortSignal;
  now(): number;
  mcp(): Promise<McpDb>;
  /** Run against the shared ledger (read side). A missing ledger is an outage, not an empty answer. */
  ledger<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** The agent this call is about, after the ownership check. */
  agent(ref?: string): Promise<OwnedAgent>;
  /** Every agent this connection may see. */
  agents(): Promise<OwnedAgent[]>;
  directory: AgentDirectory;
}

export interface ToolResult<O> {
  data: O;
  /** A short human-readable summary shown before the JSON in the text fallback. */
  summary?: string;
}

export interface ToolDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  capability: Capability;
  /**
   * When set, holding ANY of these is enough (e.g. reading a proposal: the
   * scope that created its kind). The handler must still check the object's
   * own kind against the connection's capabilities.
   */
  anyOf?: readonly Capability[];
  input: I;
  output: O;
  annotations: ToolAnnotations;
  budget?: Budget;
  /** Protocol `_meta` for the tool definition (e.g. an MCP Apps UI resource). Never authority. */
  meta?: Record<string, unknown>;
  /** Default 15 s. Long work returns a job id instead of holding the connection. */
  timeoutMs?: number;
  handler(args: z.infer<I>, ctx: ToolContext): Promise<ToolResult<z.infer<O>>>;
}

/** Keeps the generic types attached when tools are collected into arrays. */
export function defineTool<I extends z.ZodType, O extends z.ZodType>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def;
}

export const DEFAULT_PER_MINUTE = 60;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface CallToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface RunDeps {
  now?: () => number;
  mcp?: () => Promise<McpDb>;
  ledger?: <T>(fn: (db: Db | null) => Promise<T>) => Promise<T>;
  directory?: AgentDirectory;
}

let ledgerOverride: Db | null = null;
/** Test seam: the ledger every tool reads when no per-call override is given. */
export function setLedgerForTest(db: Db | null): void {
  ledgerOverride = db;
}

/** The shared ledger for MCP code outside a tool call (the approval route), honouring the test seam. */
export function readLedger<T>(fn: (db: Db | null) => Promise<T>): Promise<T> {
  const override = ledgerOverride;
  return override ? fn(override) : withReadDb(fn);
}

export function makeContext(principal: Principal, traceId: string, signal: AbortSignal, deps: RunDeps = {}): ToolContext {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const directory = deps.directory ?? agentDirectory();
  const override = ledgerOverride;
  const readLedger = deps.ledger ?? (override ? <T>(fn: (db: Db | null) => Promise<T>) => fn(override) : withReadDb);
  return {
    principal,
    traceId,
    signal,
    now,
    mcp: deps.mcp ?? mcpDb,
    directory,
    ledger: (fn) => readLedger(async (db) => {
      if (!db) throw new McpError("upstream_unavailable", "The shared ledger is not reachable right now.", { retryAfterSec: 30 });
      return fn(db);
    }),
    agent: (ref) => resolveOwnedAgent(principal, ref, directory),
    agents: () => reachableAgents(principal, directory),
  };
}

function textOf(summary: string | undefined, data: unknown): string {
  const json = JSON.stringify(data);
  return summary ? `${summary}\n\n${json}` : json;
}

/** Where an error result carries its machine-readable envelope ({code, message, retryable, retry_after_s, trace_id}). */
export const ERROR_META_KEY = "dev.merrymen/error";

/**
 * An error result carries NO structuredContent: every tool declares an
 * outputSchema for its success shape, and clients (the v1 TypeScript SDK's
 * callTool among them) validate structuredContent against it even when
 * isError is set — an error envelope there fails validation and the model
 * would see a schema mismatch instead of the code. The envelope rides in the
 * text (after a blank line, as JSON) and in _meta.
 */
function errorResult(e: McpError, traceId: string): CallToolResult {
  const body: ErrorBody = errorBody(e, traceId);
  const retry = e.retryAfterSec ? ` Retry after ${e.retryAfterSec}s.` : "";
  return {
    content: [{ type: "text", text: `Error ${e.code}: ${e.message}${retry}\n\n${JSON.stringify(body)}` }],
    _meta: { [ERROR_META_KEY]: body.error },
    isError: true,
  };
}

async function enforceBudget(d: McpDb, def: ToolDef, p: Principal, now: number): Promise<void> {
  const bucket = def.budget?.bucket ?? def.name;
  const checks: Array<[string, number, number]> = [
    [`tool:${p.connectionId}:${bucket}:m`, 60, def.budget?.perMinute ?? DEFAULT_PER_MINUTE],
  ];
  if (def.budget?.perHour) checks.push([`tool:${p.tenant}:${bucket}:h`, 3600, def.budget.perHour]);
  if (def.budget?.perDay) checks.push([`tool:${p.tenant}:${bucket}:d`, 86_400, def.budget.perDay]);
  for (const [key, window, limit] of checks) {
    const v = await rateHit(d, key, window, limit, now);
    if (!v.ok) {
      throw new McpError(window >= 3600 ? "quota_exceeded" : "rate_limited",
        window >= 3600 ? `The ${window === 86_400 ? "daily" : "hourly"} budget for ${def.name} is used up.` : `Too many ${def.name} calls; slow down.`,
        { retryAfterSec: v.retryAfterSec });
    }
  }
}

/**
 * Run one tool call with every control applied. Exported for tests; the MCP
 * server calls it from the registered callback.
 */
export async function runTool(def: ToolDef, rawArgs: unknown, principal: Principal, traceId: string, deps: RunDeps = {}): Promise<CallToolResult> {
  const started = Date.now();
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const controller = new AbortController();
  const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new McpError("timeout")), timeoutMs);
  let outcome = "ok";
  let d: McpDb | null = null;
  try {
    // The database first, so a refused call is audited like any other.
    d = await (deps.mcp ?? mcpDb)().catch(() => {
      throw new McpError("upstream_unavailable", "Merrymen's database is not reachable right now.", { retryAfterSec: 15 });
    });
    if (def.anyOf?.length) {
      if (!def.anyOf.some((c) => hasCapability(principal, c))) requireCapability(principal, def.anyOf[0]!);
    } else {
      requireCapability(principal, def.capability);
    }
    await enforceBudget(d, def, principal, now());
    const parsed = def.input.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      throw new McpError("invalid_input", parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
    }
    const ctx = makeContext(principal, traceId, controller.signal, deps);
    const work = def.handler(parsed.data, ctx);
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? new McpError("timeout")), { once: true });
    });
    const result = await Promise.race([work, aborted]);
    const checked = def.output.safeParse(result.data);
    if (!checked.success) {
      // The service produced something the declared schema does not allow:
      // a server bug. Never ship an unvalidated shape to the client.
      logEvent("output_schema_violation", { tool: def.name, trace: traceId, issues: checked.error.issues.slice(0, 3).map((i) => i.path.join(".")) });
      throw new McpError("internal");
    }
    return {
      content: [{ type: "text", text: textOf(result.summary, checked.data) }],
      structuredContent: checked.data as Record<string, unknown>,
    };
  } catch (error) {
    const e = asMcpError(error);
    outcome = e.code;
    if (e.code === "internal") {
      logEvent("tool_internal_error", { tool: def.name, trace: traceId, error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unknown" });
    }
    return errorResult(e, traceId);
  } finally {
    clearTimeout(timer);
    const ms = Date.now() - started;
    recordToolCall(def.name, outcome, ms);
    logEvent("tool", { tool: def.name, outcome, ms, trace: traceId, tenant: pseudonym(principal.tenant), connection: pseudonym(principal.connectionId) });
    if (d) {
      await writeAudit(d, {
        action: `tool:${def.name}`, outcome, tenant: principal.tenant, connectionId: principal.connectionId, clientId: principal.clientId,
        capability: def.capability, latencyMs: ms, traceId, detail: auditDetail(rawArgs),
      }, now());
    }
  }
}
