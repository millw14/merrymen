/**
 * A STREAMED REPLY MAY NEVER SHOW A COMMAND MARKER, NOT EVEN HALF OF ONE.
 *
 * The chat now streams, and a proposal is the LAST thing a reply does:
 * `<<CMD buy {...}>>`, anchored to the end (chat-commands.ts). Streaming it as
 * it arrives would put `<<CMD buy {"symb` on the owner's screen — plumbing, and
 * a half-written instruction — and would tempt a client to act on a marker
 * before the end-anchor could be checked. So everything from the first `<<`
 * is held back until the reply is complete, and the complete text goes through
 * splitCommand exactly as the unstreamed reply did.
 *
 * These feed replies in one character at a time, which is the worst case a
 * provider can produce, and check every intermediate screen.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readReplyStream, sseEvent, streamSafe } from "./chat-stream";

/** Every screen a character-by-character stream would show. */
function screens(raw: string): string[] {
  const out: string[] = [];
  for (let i = 1; i <= raw.length; i++) out.push(streamSafe(raw.slice(0, i)));
  return out;
}

const PROPOSAL = 'Happy to — I will place it and my key decides.\n<<CMD buy {"symbol":"TSLA","usdgAmount":5}>>';

describe("what may be shown while a reply is still arriving", () => {
  it("NO SCREEN EVER CARRIES ANY PART OF THE MARKER", () => {
    for (const s of screens(PROPOSAL)) {
      assert.ok(!s.includes("<"), `a partial marker reached the screen: ${JSON.stringify(s)}`);
      assert.ok(!s.includes("CMD"), `a partial marker reached the screen: ${JSON.stringify(s)}`);
    }
    assert.equal(streamSafe(PROPOSAL), "Happy to — I will place it and my key decides.\n");
  });

  it("everything after a mid-reply marker waits for the end, too", () => {
    // A marker in the MIDDLE is very likely quoted from somebody else's text;
    // the full reply scrubs it, so the stream must not show what follows it
    // before that scrub has run.
    const raw = 'It said <<CMD sell {"symbol":"X","usdgAmount":1}>> in its reason, which I ignore.';
    for (const s of screens(raw)) assert.equal(s.includes("<") || s.includes("ignore"), false);
  });

  it("A LONE '<' IS HELD, because the next character may make it a marker", () => {
    assert.equal(streamSafe("Price is <"), "Price is ");
    assert.equal(streamSafe("Price is < $5"), "Price is ");
    // Once it can no longer become one, it shows.
    assert.equal(streamSafe("a <b> tag"), "a <b> tag");
  });

  it("a reasoning block never shows, finished or not", () => {
    for (const s of screens("<think>I should buy</think>Here is my answer.")) {
      assert.ok(!/think|should buy/.test(s), `reasoning reached the screen: ${JSON.stringify(s)}`);
    }
    assert.equal(streamSafe("<think>x</think>Here is my answer."), "Here is my answer.");
    assert.equal(streamSafe("Hi <|think|>still going"), "Hi ");
  });

  it("EACH SCREEN EXTENDS THE LAST, so it can be sent as appended text", () => {
    for (const raw of [PROPOSAL, "<think>a</think>Hello there, friend.", "One < two and three > zero, done."]) {
      const seen = screens(raw);
      for (let i = 1; i < seen.length; i++) {
        assert.ok(seen[i]!.startsWith(seen[i - 1]!), `screen ${i} rewrote what was already shown in ${JSON.stringify(raw)}`);
      }
    }
  });
});

/** A response body delivered in the given chunks, split wherever the test says. */
function body(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

/** Cut a string into pieces of `n` characters — including mid-line and mid-JSON. */
const shred = (s: string, n: number) => Array.from({ length: Math.ceil(s.length / n) }, (_, i) => s.slice(i * n, i * n + n));

describe("reading the stream in the browser", () => {
  const wire =
    sseEvent("text", { t: "Happy to — " }) +
    sseEvent("text", { t: "I will place it." }) +
    sseEvent("done", { reply: "Happy to — I will place it.", command: { id: "buy", args: { symbol: "TSLA", usdgAmount: 5 } } });

  it("THE FINAL REPLY AND ITS COMMAND COME FROM `done`, not from the pieces", async () => {
    for (const n of [1, 3, 7, 1000]) {
      const shown: string[] = [];
      const out = await readReplyStream(body(shred(wire, n)), (t) => shown.push(t));
      assert.deepEqual(out, { reply: "Happy to — I will place it.", command: { id: "buy", args: { symbol: "TSLA", usdgAmount: 5 } } });
      assert.equal(shown.at(-1), "Happy to — I will place it.");
    }
  });

  it("CRLF framing reads the same", async () => {
    const out = await readReplyStream(body([wire.replace(/\n/g, "\r\n")]), () => {});
    assert.equal(out.reply, "Happy to — I will place it.");
  });

  it("the browser applies the hold-back again, whatever the server sent", async () => {
    // Two gates, neither relying on the other: a server that forgot to hold
    // back still cannot put a marker on this screen.
    const shown: string[] = [];
    await readReplyStream(
      body([sseEvent("text", { t: "Sure. <<CMD bu" }), sseEvent("text", { t: 'y {"symbol":"T"}>>' }), sseEvent("done", { reply: "Sure." })]),
      (t) => shown.push(t),
    );
    for (const s of shown) assert.ok(!s.includes("<"), JSON.stringify(s));
  });

  it("AN ERROR EVENT IS AN ERROR, carrying what the server classified", async () => {
    const out = await readReplyStream(
      body([sseEvent("text", { t: "Hal" }), sseEvent("error", { why: "llm-error", kind: "rate-limited", provider: "Groq", detail: "groq 429 — rate limited" })]),
      () => {},
    );
    assert.deepEqual(out, { reply: null, why: "llm-error", kind: "rate-limited", provider: "Groq", detail: "groq 429 — rate limited" });
  });

  it("A STREAM THAT ENDS WITHOUT `done` WAS CUT OFF, and is not a reply", async () => {
    // Half an answer shown as the whole one is a sentence the agent never
    // finished — possibly the half before "but not until…".
    const out = await readReplyStream(body([sseEvent("text", { t: "Yes, I would sell" })]), () => {});
    assert.deepEqual(out, { reply: null, why: "cut-off" });
  });

  it("garbage between events is skipped, not rendered", async () => {
    const out = await readReplyStream(body([": keep-alive\n\n", "data: not json\n\n", sseEvent("done", { reply: "ok" })]), () => {});
    assert.equal(out.reply, "ok");
  });
});
