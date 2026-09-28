/**
 * A voice note is fetched and transcribed inside the strictly serial poll
 * loop, so neither hop may hang: one that never answered held every later
 * message for as long as the process lived.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { transcribeVoice } from "./voice";

const realFetch = globalThis.fetch;
afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = realFetch;
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const settled = <T>(p: Promise<T>) => {
  const box: { done: boolean; value?: T } = { done: false };
  void p.then((v) => {
    box.done = true;
    box.value = v;
  });
  return box;
};
const opts = { key: "sk-test", base: "https://stt.example/v1" };

describe("transcribeVoice is bounded", () => {
  it("a download that never answers gives up at 60s with a reason, and never reaches the transcriber", async () => {
    const urls: string[] = [];
    let signal: AbortSignal | undefined;
    globalThis.fetch = ((url: string, init?: { signal?: AbortSignal }) => {
      urls.push(String(url));
      signal = init?.signal;
      return new Promise(() => {}); // not even to its signal
    }) as typeof fetch;
    mock.timers.enable({ apis: ["setTimeout"] });
    const r = settled(transcribeVoice("https://api.telegram.org/file/bot1:a/voice.ogg", opts));
    mock.timers.tick(59_999);
    await flush();
    assert.equal(r.done, false);
    mock.timers.tick(1);
    await flush();
    assert.deepEqual(r.value, { text: null, reason: "couldn't download the voice note: timed out after 60s" });
    assert.equal(signal?.aborted, true, "the request itself was told to stop");
    assert.equal(urls.length, 1);
  });

  it("a transcription that never answers gives up 60s after it was sent", async () => {
    globalThis.fetch = ((url: string) =>
      String(url).endsWith("/audio/transcriptions")
        ? new Promise(() => {})
        : Promise.resolve(new Response(new Uint8Array([1, 2, 3])))) as typeof fetch;
    mock.timers.enable({ apis: ["setTimeout"] });
    const r = settled(transcribeVoice("https://api.telegram.org/file/bot1:a/voice.ogg", opts));
    await flush();
    mock.timers.tick(59_999);
    await flush();
    assert.equal(r.done, false);
    mock.timers.tick(1);
    await flush();
    assert.deepEqual(r.value, { text: null, reason: "transcription timed out after 60s" });
  });

  it("a prompt answer is passed through as before", async () => {
    globalThis.fetch = ((url: string) =>
      Promise.resolve(
        String(url).endsWith("/audio/transcriptions")
          ? Response.json({ text: " buy nvda " })
          : new Response(new Uint8Array([1, 2, 3])),
      )) as typeof fetch;
    assert.deepEqual(await transcribeVoice("https://api.telegram.org/file/bot1:a/voice.ogg", opts), { text: "buy nvda" });
  });
});
