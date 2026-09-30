/**
 * THE PUBLIC FEED, READ AT MOST ONCE EVERY FEW SECONDS PER PROCESS.
 *
 * The terminal asked for /api/theses once a minute. It asks every ten seconds
 * now, from every open tab, so the feed can show a trade within seconds of it
 * landing — and the route is `force-dynamic`, so every one of those requests
 * would run the grouped ledger read plus the identity and settings reads. Tabs
 * multiplied by six is not a load the ledger should carry for an answer that
 * is byte-identical for every visitor.
 *
 * So one read is shared by every caller for a few seconds, and callers that
 * arrive while it runs wait for that read rather than starting another — the
 * same single-flight the discoveries memo has, for the same reason.
 *
 * SHARING IS SAFE ONLY BECAUSE THE READ HAS NO CALLER IN IT. `read-theses.ts`
 * states that as its security property: no tenant, no session, no per-caller
 * branch. The memo keys on nothing, which is the same claim made a second time;
 * if a session read ever appears in that module, this becomes a leak exactly as
 * every HTTP cache above it would.
 *
 * AN UNREADABLE ANSWER IS NOT KEPT. `source: "none"` means the ledger could not
 * be opened, and a memo that held it would publish an outage for its whole life
 * after the ledger came back.
 */
export const THESES_FRESH_MS = 5_000;

/**
 * What any cache in front of the route may do with it.
 *
 * `max-age` is the BROWSER's cache, and it was 15s with a 60s
 * stale-while-revalidate — which browsers honour too. Polled every ten seconds,
 * each poll would have been answered from the cache of the one before, so the
 * feed would have run a poll behind while looking as though it refreshed.
 * Five seconds and no stale arm: a poll ten seconds after the last one always
 * reaches the server, and the server's memo keeps that cheap.
 */
export const THESES_CACHE_CONTROL = "public, max-age=5, s-maxage=5";

export function thesesMemo<R extends { source: string }>(
  read: () => Promise<R>,
  now: () => number = () => Date.now(),
): { get(): Promise<R> } {
  let last: { value: R; at: number } | null = null;
  let inFlight: Promise<R> | null = null;
  return {
    get() {
      if (last && now() - last.at < THESES_FRESH_MS) return Promise.resolve(last.value);
      if (inFlight) return inFlight;
      inFlight = read()
        .then((r) => {
          last = r.source === "none" ? null : { value: r, at: now() };
          return r;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
