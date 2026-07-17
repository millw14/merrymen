/**
 * Virtuals Terminal API client — publish an agent's activity to its page on
 * app.virtuals.io. Zero deps (bare fetch), injectable for tests.
 *
 * Two-step flow (per the Virtuals developer docs):
 *   1. exchange your API key for a short-lived bearer token
 *      POST https://api.virtuals.io/api/accesses/tokens   (header X-API-KEY)
 *   2. submit an activity log
 *      POST https://api-terminal.virtuals.io/logs          (Bearer token)
 *      body: { framework_name, category_name, title(≤255), body(markdown) }
 *
 * OUTBOUND + PUBLIC: everything sent here appears on the agent's public Virtuals
 * page. It is strictly opt-in (settings.virtualsEnabled) and read-only w.r.t. the
 * agent — it can post logs, never trade or move funds. The exact token-response
 * shape isn't fully pinned in the docs, so the parser is defensive and any
 * failure is non-fatal (streaming just no-ops until it's fixed).
 */

const TOKEN_URL = "https://api.virtuals.io/api/accesses/tokens";
const LOGS_URL = "https://api-terminal.virtuals.io/logs";

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface TerminalLog {
  /** The agent framework name. merrymen uses "merrymen". */
  framework_name: string;
  /** Virtuals log lane. "general" for our trade/report posts. */
  category_name: "general" | "planner_module" | "reaction_module";
  /** ≤255 chars — enforced by the caller/formatter. */
  title: string;
  /** Markdown body. */
  body: string;
}

/** Pull a bearer token out of whatever shape the exchange endpoint returns. */
function extractToken(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const data = (b.data as Record<string, unknown> | undefined) ?? {};
  const candidate =
    b.token ?? b.accessToken ?? b.access_token ?? data.token ?? data.accessToken ?? data.access_token;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

/** Exchange an API key for a bearer token. null on any failure (non-fatal). */
export async function exchangeToken(apiKey: string, fetchFn?: FetchLike): Promise<string | null> {
  const f = fetchFn ?? (fetch as unknown as FetchLike);
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await f(TOKEN_URL, {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: "{}",
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    return extractToken(await res.json());
  } catch {
    return null;
  }
}

/** Submit one activity log with a bearer token. Returns the HTTP status. */
export async function postLog(
  bearer: string,
  log: TerminalLog,
  fetchFn?: FetchLike,
): Promise<{ ok: boolean; status: number }> {
  const f = fetchFn ?? (fetch as unknown as FetchLike);
  try {
    const res = await f(LOGS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(log),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Title is hard-capped at 255 by the API — clamp defensively. */
export const clampTitle = (s: string): string => (s.length > 255 ? `${s.slice(0, 252)}…` : s);
