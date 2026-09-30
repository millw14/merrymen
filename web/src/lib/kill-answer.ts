/**
 * WHAT THE SERVER SAID TO A KILL — DELETE /api/grants, read the same way by
 * every control that sends one (the kill switch, Wallet & permissions'
 * "discard & start over").
 *
 * The self-hosted DELETE can REFUSE on purpose: when the stand-down request
 * for a perps grant cannot be written, it answers 503 `{error, ownerFacing:
 * true}` and keeps grant.json armed (lib/perp-kill.ts: "a request that cannot
 * be written stops the kill"). A control that cleared this browser's copy
 * first and ignored that answer showed a discarded wallet while the server
 * grant stayed armed and the worker kept trading — opening perps included —
 * with the owner never told. So every control reads the answer BEFORE it
 * changes anything:
 *
 *   refused      the server says nothing was stopped: change nothing, say why
 *   done         the server let go of the grant; `custody` is its sentence
 *                about Lighter when it built one (self-hosted), else null
 *   unconfirmed  the server answered something else (not signed in, an
 *                error): it may still hold the grant, and the owner is told
 *   unreachable  no answer at all: the one case a local-only clear is the
 *                fallback, and it is said to be local-only
 *
 * Browser-safe.
 */

export type KillAnswer =
  | { kind: "refused"; error: string }
  | { kind: "done"; custody: string | null }
  | { kind: "unconfirmed"; status: number; error: string | null }
  | { kind: "unreachable" };

/** Read one DELETE /api/grants response. Never throws. */
export async function readKillAnswer(r: Pick<Response, "ok" | "status" | "json">): Promise<KillAnswer> {
  const body = (await r.json().catch(() => null)) as { custody?: unknown; error?: unknown; ownerFacing?: unknown } | null;
  const error = typeof body?.error === "string" && body.error ? body.error : null;
  if (!r.ok) {
    if (body?.ownerFacing === true && error !== null) return { kind: "refused", error };
    return { kind: "unconfirmed", status: r.status, error };
  }
  return { kind: "done", custody: typeof body?.custody === "string" && body.custody ? body.custody : null };
}

/** Send the kill and read its answer. `fetchImpl` is a test seam. Never throws. */
export async function sendKill(fetchImpl: typeof fetch = fetch): Promise<KillAnswer> {
  let r: Response;
  try {
    r = await fetchImpl("/api/grants", { method: "DELETE" });
  } catch {
    return { kind: "unreachable" };
  }
  return readKillAnswer(r);
}
