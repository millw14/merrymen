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
  /** Merrymen's own database. Refuses new statements once `signal` is aborted (see abortableDb). */
  mcp(): Promise<McpDb>;
  /**
   * Run against the shared ledger (read side). A missing ledger is an outage,
   * not an empty answer. Refuses new statements once `signal` is aborted; a
   * statement already in flight is not cancelled.
   */
  ledger<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** The agent this call is about, after the ownership check. */
  agent(ref?: string): Promise<OwnedAgent>;
  /** Every agent this connection may see. */
  agents(): Promise<OwnedAgent[]>;
  /**
   * Only for tools with settlesAfterTimeout: an unguarded handle for the ONE
   * write that stores a paid call's result after the call may have timed out.
   */
  settleMcp?: () => Promise<McpDb>;
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
  /**
   * The description served on the directory profile (/mcp/directory), when it
   * differs: `description` with its pointers to other tools cut. Build it with
   * withToolRefs, never by hand, so it can only ever be a cut of `description`.
   */
  directoryDescription?: string;
  /** The pointers withToolRefs cut to make directoryDescription (a test re-derives the cut from these). */
  directoryCuts?: readonly string[];
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
  /**
   * The handler stores what a paid external call produced (send_message: the
   * model's reply). ctx.settleMcp() then hands out a database that still
   * accepts THAT write after the call timed out: the client is told to read the
   * reply later, and that promise only holds if the reply is stored. Everything
   * else (ctx.mcp(), the ledger, agent lookups) still stops at the timeout, so
   * nothing new — no state read, no claim, no paid call — starts after it.
   */
  settlesAfterTimeout?: boolean;
  handler(args: z.infer<I>, ctx: ToolContext): Promise<ToolResult<z.infer<O>>>;
}

/** Keeps the generic types attached when tools are collected into arrays. */
export function defineTool<I extends z.ZodType, O extends z.ZodType>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def;
}

/**
 * A description that points at other tools ("open one with get_decision"),
 * and its copy for the directory profile with those pointers cut: Anthropic's
 * connector directory asks that tool descriptions carry no instructions about
 * other tools. The full server keeps them, because they tell a client which
 * tool comes next. Each ref is cut verbatim and must occur exactly once, so a
 * description edited without its refs throws when the module loads (and every
 * test fails) instead of serving a stale or half-cut copy.
 */
export function withToolRefs(description: string, ...refs: string[]): { description: string; directoryDescription: string; directoryCuts: readonly string[] } {
  let cut = description;
  for (const ref of refs) {
    const at = cut.indexOf(ref);
    if (!ref || at < 0 || cut.indexOf(ref, at + 1) >= 0) {
      throw new Error(`withToolRefs: ${JSON.stringify(ref)} must occur exactly once in ${JSON.stringify(description.slice(0, 60))}…`);
    }
    cut = cut.slice(0, at) + cut.slice(at + ref.length);
  }
  return { description, directoryDescription: cut, directoryCuts: refs };
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

/** Why an aborted call stops: the abort reason when it is ours (the timeout), else a timeout. */
function abortError(signal: AbortSignal): McpError {
  return signal.reason instanceof McpError ? signal.reason : new McpError("timeout");
}

/**
 * The database as a tool handler sees it: every statement, and every new
 * transaction, first checks the call's signal and refuses to START once the
 * call was abandoned (runTool answered `timeout`, and the client may already
 * be retrying). Without this a timed-out handler keeps issuing its remaining
 * queries one by one, and each retry starts another such orphan, until they
 * hold every connection of the shared pool.
 *
 * A statement that is already running is NOT cancelled: it runs to its end
 * (bounded only by the database's own limits), and the handler stops at its
 * next statement. A transaction interrupted this way throws, so it rolls back
 * rather than committing half of its work after the client was told the call
 * timed out. Each call wraps anew, so nothing may key a cache on this Db's
 * identity (none does: services use only prepare/exec/tx).
 */
function abortableDb(db: Db, signal: AbortSignal): Db {
  const guard = <T>(start: () => Promise<T>): Promise<T> => (signal.aborted ? Promise.reject(abortError(signal)) : start());
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run: (...params) => guard(() => stmt.run(...params)),
        get: (...params) => guard(() => stmt.get(...params)),
        all: (...params) => guard(() => stmt.all(...params)),
      };
    },
    exec: (sql) => guard(() => db.exec(sql)),
    tx: (fn) => guard(() => db.tx((scoped) => fn(abortableDb(scoped, signal)))),
  };
}

export function makeContext(principal: Principal, traceId: string, signal: AbortSignal, deps: RunDeps = {}, o: { settlesAfterTimeout?: boolean } = {}): ToolContext {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const directory = deps.directory ?? agentDirectory();
  const override = ledgerOverride;
  const readLedger = deps.ledger ?? (override ? <T>(fn: (db: Db | null) => Promise<T>) => fn(override) : withReadDb);
  const openMcp = deps.mcp ?? mcpDb;
  return {
    principal,
    traceId,
    signal,
    now,
    // Both database seams refuse new work once the call is abandoned (abortableDb).
    mcp: async () => {
      if (signal.aborted) throw abortError(signal);
      const d = await openMcp();
      return { ...d, db: abortableDb(d.db, signal) };
    },
    directory,
    ledger: (fn) => {
      if (signal.aborted) return Promise.reject(abortError(signal));
      return readLedger(async (db) => {
        if (!db) throw new McpError("upstream_unavailable", "The shared ledger is not reachable right now.", { retryAfterSec: 30 });
        if (signal.aborted) throw abortError(signal);
        return fn(abortableDb(db, signal));
      });
    },
    ...(o.settlesAfterTimeout ? { settleMcp: openMcp } : {}),
    // The directory reads the identity store and the grants: no new lookups after the call is abandoned either.
    agent: (ref) => (signal.aborted ? Promise.reject(abortError(signal)) : resolveOwnedAgent(principal, ref, directory)),
    agents: () => (signal.aborted ? Promise.reject(abortError(signal)) : reachableAgents(principal, directory)),
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
    const ctx = makeContext(principal, traceId, controller.signal, deps, { settlesAfterTimeout: def.settlesAfterTimeout === true });
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
