import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MAX_READ_BYTES, readBounded, readBoundedJson } from "./bounded-read";

/**
 * The property worth testing is not "it reports the size". It is that it STOPS.
 * A check that buffers the whole body and then measures it answers the question
 * after the memory is already spent, which is the failure being prevented.
 */

/** A response whose body arrives in chunks and counts how many were pulled. */
function streaming(chunks: readonly string[], headers: Record<string, string> = {}) {
  let i = 0;
  let cancelled = false;
  const enc = new TextEncoder();
  return {
    pulled: () => i,
    wasCancelled: () => cancelled,
    res: {
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      body: {
        getReader: () => ({
          read: async () =>
            i < chunks.length ? { done: false, value: enc.encode(chunks[i++]!) } : { done: true },
          cancel: async () => {
            cancelled = true;
          },
        }),
      },
      text: async () => chunks.join(""),
    },
  };
}

/** A response with no stream at all — the fallback path. */
const buffered = (text: string, headers: Record<string, string> = {}) => ({
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  text: async () => text,
});

test("an ordinary answer comes back whole", async () => {
  const s = streaming(["{\"a\":", "1}"]);
  const r = await readBounded(s.res, 1000);
  assert.equal(r.ok, true);
  assert.equal(r.ok === true ? r.text : null, '{"a":1}');
  assert.equal(r.ok === true ? r.bytes : null, 7);
  assert.equal(s.wasCancelled(), false);
});

test("EXACTLY AT THE LIMIT IS FINE; ONE BYTE PAST IT IS NOT", async () => {
  // The boundary is the whole specification, so it is asserted from both sides.
  const at = await readBounded(streaming(["a".repeat(64)]).res, 64);
  assert.equal(at.ok, true);

  const over = await readBounded(streaming(["a".repeat(65)]).res, 64);
  assert.equal(over.ok, false);
  assert.equal(over.ok === false ? over.rule : null, "too-large");
  assert.equal(over.ok === false ? over.limit : null, 64);
});

test("IT STOPS PULLING — the point of the whole module", async () => {
  // Ten chunks of ten bytes against a limit of 25. A reader that buffered first
  // and measured after would pull all ten and report 100. This must stop on the
  // third, having seen 30, and abandon the rest.
  const s = streaming(Array.from({ length: 10 }, () => "0123456789"));
  const r = await readBounded(s.res, 25);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false ? r.bytes : null, 30, "stopped as soon as the count crossed");
  assert.equal(s.pulled(), 3, "three chunks read, not ten");
  assert.equal(s.wasCancelled(), true, "and the rest of the response was abandoned");
});

test("a declared content-length can save the work but is never trusted to allow it", async () => {
  // Cheap exit when the server volunteers a damning number.
  const declared = streaming(["small"], { "content-length": "999999999" });
  const r = await readBounded(declared.res, 1000);
  assert.equal(r.ok, false);
  assert.equal(declared.pulled(), 0, "refused without reading a byte");

  // AND A LYING HEADER CHANGES NOTHING. This is the case that matters: the one
  // lane serving attacker-chosen pages is also the one that can set this.
  const liar = streaming(["a".repeat(500)], { "content-length": "1" });
  const w = await readBounded(liar.res, 100);
  assert.equal(w.ok, false, "the stream is the check, not the header");
  assert.equal(w.ok === false ? w.bytes : null, 500);

  // An absent header is the ordinary case for a chunked response.
  assert.equal((await readBounded(streaming(["ok"]).res, 100)).ok, true);
});

test("a response with no stream still gets bounded", async () => {
  // Some fetch implementations, and every test double. Weaker by nature — there
  // is nothing to stop pulling — but it must not silently become unbounded.
  assert.equal((await readBounded(buffered("a".repeat(50)), 100)).ok, true);
  const over = await readBounded(buffered("a".repeat(500)), 100);
  assert.equal(over.ok, false);
  assert.equal(over.ok === false ? over.bytes : null, 500);
});

test("bytes are counted as BYTES, not as characters", async () => {
  // A multi-byte character counts for what it costs. Measuring `text.length`
  // would let a UTF-8 body run to three times the intended ceiling.
  const emoji = "🙂"; // 4 bytes, 2 UTF-16 code units
  const r = await readBounded(streaming([emoji.repeat(10)]).res, 39);
  assert.equal(r.ok, false, "40 bytes must not pass a 39-byte limit");
  assert.equal((await readBounded(streaming([emoji.repeat(10)]).res, 40)).ok, true);
});

test("a refusal says it knows nothing, rather than implying emptiness", async () => {
  // The honesty rule this repo applies everywhere else: "could not read" is not
  // "there was nothing there", and a caller that confuses them publishes a
  // confident zero.
  const r = await readBounded(streaming(["a".repeat(500)]).res, 10);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.detail : "", /not the same as it being empty/);
});

test("readBoundedJson refuses an over-long body and unparseable JSON alike", async () => {
  const good = await readBoundedJson<{ a: number }>(streaming(['{"a":1}']).res, 1000);
  assert.deepEqual(good, { ok: true, value: { a: 1 } });

  assert.equal((await readBoundedJson(streaming(["a".repeat(500)]).res, 10)).ok, false);
  assert.equal((await readBoundedJson(streaming(["not json"]).res, 1000)).ok, false);
});

test("the default ceiling leaves real feeds far below it", async () => {
  // A GeckoTerminal page is tens of kilobytes and a Rialto quote is smaller, so
  // the bound must never be the reason a legitimate read fails.
  assert.equal(MAX_READ_BYTES, 2_000_000);
  assert.equal((await readBounded(streaming(["x".repeat(200_000)]).res)).ok, true);
});

test("EVERY VENUE READ GOES THROUGH THE BOUND", () => {
  // A helper nothing calls is worth nothing. Before this, `worker/src` and
  // `packages/core/src` contained no maxBytes, content-length or byteLength
  // check of any kind, so one hostile or broken feed could decide this worker's
  // memory ceiling — and the worker is a long-lived process holding an armed
  // session key.
  const at = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const lanes = [
    "./venues/geckoterminal.ts",
    "./venues/bitquery.ts",
    "./venues/research.ts",
    "./venues/rialto.ts",
  ];
  for (const lane of lanes) {
    const src = at(lane);
    // `[<(]` because most of these call sites are generic —
    // `readBoundedJson<{ data?: unknown[] }>(res)` — so a regex demanding an
    // immediate paren fails on code that is perfectly correct.
    assert.match(src, /readBounded(Json)?[<(]/, `${lane} must read through the bound`);
    // And must not have kept the unbounded read beside it. Comments are stripped
    // first: several of these files explain the change in prose that names the
    // very call being forbidden.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    assert.doesNotMatch(code, /await (res|r)\.json\(\)/, `${lane} still has an unbounded json read`);
  }
});
