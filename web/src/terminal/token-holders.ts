/**
 * WHAT THE TOKEN PAGE MAY SAY ABOUT WHO HOLDS IT, given where that read stands.
 *
 * The page kept an error string and a list, and nothing for "not answered yet"
 * — so for the whole of the fetch it printed "Agents holding 0" and "No public
 * agent holdings reported yet". Zero and empty are answers; a read in flight
 * has not given one. Out of Token.tsx so the decision can be executed: the
 * screen imports a chart library the test runner cannot load.
 */
export type HoldersRead = "loading" | "failed" | "ok";

/**
 * How many agents hold it, and how many of those publish their book.
 *
 * `total` counts both. The strip printed the PUBLIC holders with a profile,
 * so a token held by three agents that keep their books private read "Agents
 * holding 0" over a line saying "0 of 3 agents publish their positions".
 */
export function coverageOf(ledger: { holders: readonly unknown[]; privateHolders: number }): { published: number; total: number } {
  const published = ledger.holders.length;
  const hidden = Number.isFinite(ledger.privateHolders) && ledger.privateHolders > 0 ? ledger.privateHolders : 0;
  return { published, total: published + hidden };
}

/** The strip's "Agents holding" figure: every holding agent, and only once the read answered. */
export function holdersFigure(read: HoldersRead, coverage: { published: number; total: number } | null): string {
  return read === "ok" && coverage ? String(coverage.total) : "—";
}

/** How long the holders read may take before the page says it failed. */
export const HOLDERS_TIMEOUT_MS = 20_000;

/**
 * THE TOKEN PAGE'S LEDGER READ, BOUNDED.
 *
 * It was a raw fetch with no time limit, behind a route that reads the token,
 * its market, its candles and its pool evidence one after another. So the
 * skeleton that replaced a false "0" lasted as long as the slowest scan, or for
 * ever on a request that hung. Every other read on this screen gives up after
 * twenty seconds; this one does too, and a failure is `{ ok: false }` for the
 * page to say so and offer to try again — never the error's own words.
 */
export async function readTokenPage<T = unknown>(
  id: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ ok: true; data: T } | { ok: false }> {
  const get = opts.fetch ?? fetch;
  try {
    const r = await get(`/api/tokens/${encodeURIComponent(id)}?activity=1`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? HOLDERS_TIMEOUT_MS),
    });
    if (!r.ok) return { ok: false };
    return { ok: true, data: (await r.json()) as T };
  } catch {
    return { ok: false };
  }
}

/**
 * Which holders block to draw. A list that already has rows keeps them (the
 * read that produced them succeeded); otherwise emptiness is claimed only by a
 * read that answered, and a failure is its own state, said by the page.
 */
export function holdersList(read: HoldersRead, count: number): "loading" | "failed" | "empty" | "table" {
  if (count > 0) return "table";
  return read === "loading" ? "loading" : read === "failed" ? "failed" : "empty";
}
