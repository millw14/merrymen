/**
 * HOW MUCH OF A STRANGER'S ANSWER ARE WE WILLING TO HOLD?
 *
 * Nothing in `worker/src` or `packages/core/src` has ever asked. Every venue
 * read is `await res.json()` or `await res.text()`, which buffers whatever
 * arrives — so a hostile or merely broken feed decides this worker's memory
 * ceiling, and the worker is a long-lived process holding an armed session key.
 *
 * The reads are not obscure. GeckoTerminal's trending feed, Bitquery's GraphQL
 * endpoint, the research reader (which fetches pages an ATTACKER chose, via
 * `read_link`), Rialto's quote API, and the MCP transport. Four of the five are
 * third parties and one of them serves arbitrary web pages.
 *
 * THE CAP IS ENFORCED WHILE READING, NOT MEASURED AFTERWARDS. Checking
 * `text.length` once the body is in hand answers the question after the damage
 * is done; the only useful version stops pulling. So this streams, counts, and
 * abandons the response the moment the count exceeds the limit — the property
 * the test pins by feeding it exactly `maxBytes + 1`.
 *
 * `content-length` is consulted as a cheap early exit and TRUSTED FOR NOTHING.
 * It is absent on chunked responses and is attacker-supplied on the one lane
 * that matters, so it can save work but must never be the thing that decides.
 *
 * Reimplemented from Vex's bounded reader, with its author's permission.
 */

/**
 * 2 MB. Chosen against what these endpoints legitimately return — a
 * GeckoTerminal page is tens of kilobytes, a Rialto quote is smaller, a research
 * page read is capped in characters downstream — with two orders of magnitude of
 * slack so a bound is never the reason a real read fails.
 *
 * Vex measured a live token name of 34,090 characters. The interesting failures
 * on this surface are three orders of magnitude below this line; this exists for
 * the response that never ends.
 */
export const MAX_READ_BYTES = 2_000_000;

export type BoundedRead =
  | { ok: true; text: string; bytes: number }
  | { ok: false; rule: "too-large"; bytes: number; limit: number; detail: string };

/**
 * Read a response body, refusing rather than buffering past `maxBytes`.
 *
 * A refusal is returned, not thrown, so every caller books it the way it books
 * an unreadable feed — this must never become the reason a tick dies, and an
 * over-long answer is a fact about the answer rather than an error in us.
 */
export async function readBounded(
  res: { headers: { get(name: string): string | null }; body?: unknown; text(): Promise<string> },
  maxBytes: number = MAX_READ_BYTES,
): Promise<BoundedRead> {
  const tooLarge = (bytes: number): BoundedRead => ({
    ok: false,
    rule: "too-large",
    bytes,
    limit: maxBytes,
    detail:
      `the response was at least ${bytes} bytes, past the ${maxBytes}-byte limit — abandoned unread. ` +
      `Nothing about the content is known, which is not the same as it being empty.`,
  });

  // Cheap exit when the server volunteers a number and the number is damning.
  // A missing or lying header changes nothing: the stream below is the check.
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge(declared);

  const body = res.body as
    | { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } }
    | null
    | undefined;
  // No stream to read — some fetch implementations and every test double. Fall
  // back to the buffered read and bound what we were handed. Weaker, and it is
  // the weaker case for a reason: there is nothing to stop pulling.
  if (!body || typeof body.getReader !== "function") {
    const text = await res.text();
    const bytes = Buffer.byteLength(text, "utf8");
    return bytes > maxBytes ? tooLarge(bytes) : { ok: true, text, bytes };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    // STOP PULLING. Not "note that it was too big afterwards" — by then the
    // memory is already spent, which is the entire failure being prevented.
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      return tooLarge(bytes);
    }
    chunks.push(value);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8"), bytes };
}

/**
 * The same read, parsed. Returns `null` on a refusal OR on malformed JSON,
 * because both mean the same thing to a caller: this feed said nothing usable.
 * Callers that need to tell them apart should use `readBounded` directly.
 */
export async function readBoundedJson<T>(
  res: Parameters<typeof readBounded>[0],
  maxBytes: number = MAX_READ_BYTES,
): Promise<{ ok: true; value: T } | { ok: false; detail: string }> {
  const r = await readBounded(res, maxBytes);
  if (!r.ok) return { ok: false, detail: r.detail };
  try {
    return { ok: true, value: JSON.parse(r.text) as T };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "unparseable JSON" };
  }
}
