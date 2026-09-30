/**
 * THE SHELL'S ONE FETCH, and what it says when there is nothing to parse.
 *
 * It parsed the body before looking at the status. So a proxy's HTML 502
 * surfaced as "Unexpected token '<'", and a timeout as the DOMException's own
 * words — "signal timed out" — and App printed both verbatim in its alert. The
 * reader was shown our stack instead of what happened.
 *
 * NOW THE STATUS AND THE CONTENT TYPE ARE READ FIRST. A failure the server
 * explained keeps the server's sentence, because those are written for owners
 * ("this agent account is already linked to a different login"). Everything
 * else — no answer, an answer that is not JSON — gets one plain sentence and a
 * status, and the caller decides what to do about it.
 *
 * Out of HostedControls.tsx so the test runner can execute it; that file
 * re-exports it, so every existing import still resolves.
 */

/** A request that did not produce the JSON asked for. `status` 0 means nothing answered. */
export class RequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "RequestError";
    this.status = status;
  }
}

/** Said for a timeout, a dropped connection, or a DNS failure alike — to the reader they are one thing. */
export const UNREACHABLE = "Can't reach merrymen right now.";

/**
 * The server's own explanation, in the three shapes the routes use.
 *
 * On a 5xx only when the route marked it `ownerFacing` — see requestJson.
 */
function explained(data: unknown, status: number): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { error?: unknown; errors?: unknown; why?: unknown; ownerFacing?: unknown };
  if (status >= 500 && d.ownerFacing !== true) return null;
  if (typeof d.error === "string" && d.error) return d.error;
  if (Array.isArray(d.errors) && d.errors.length) return d.errors.join(" ");
  if (typeof d.why === "string" && d.why) return d.why;
  return null;
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(20000) });
  } catch {
    throw new RequestError(UNREACHABLE, 0);
  }
  const isJson = /\bjson\b/i.test(response.headers.get("content-type") ?? "");
  // A body that promised JSON and broke off half way is the same as no body.
  const data: unknown = isJson ? await response.json().catch(() => undefined) : undefined;
  if (!response.ok) {
    // THE SERVER'S SENTENCE FOR A 4xx, OR A 5xx THE ROUTE MARKED AS WRITTEN
    // FOR THE OWNER. A 4xx is a route telling the owner something about their
    // request. A 5xx is our own failure, and several routes fill `error` with
    // the raw exception on one — so a database driver's "connect ECONNREFUSED
    // 127.0.0.1:5432" reached the sign-in screen verbatim. An unmarked 5xx body
    // goes to the console, where the person who can act on it looks.
    const owned = explained(data, response.status);
    if (response.status >= 500 && owned === null && data !== undefined) console.warn(`[merrymen] ${url} answered ${response.status}:`, data);
    throw new RequestError(
      owned ?? `merrymen answered with an error (${response.status}). Try again in a moment.`,
      response.status,
    );
  }
  if (data === undefined) {
    throw new RequestError("merrymen sent back something that isn't data. Try again in a moment.", response.status);
  }
  return data as T;
}
