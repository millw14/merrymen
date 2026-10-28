/**
 * /why keeps the owner's tx hash. The model reads redacted evidence ("[hash]",
 * "[address]"); the owner gets their own evidence when narration fails, and the
 * receipt's tx line under a narration that works. narrateWhy runs for real, its
 * model call answered by a stubbed fetch: nothing leaves the process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { LlmCreds } from "../llm";
import { whyAnswer } from "./why-answer";

const HASH = `0x${"ab".repeat(32)}`;
const ADDRESS = `0x${"cd".repeat(20)}`;
const TX_LINE = `• tx: <code>${HASH}</code>`;
const EVIDENCE = [
  "🧾 <b>Why my last trade</b>",
  "• buy (requested 5.00 USDG) — landed",
  `• note: paid to ${ADDRESS} because spread &lt; 1%`,
  TX_LINE,
].join("\n");
const creds: LlmCreds = { provider: "custom", transport: "openai", baseUrl: "http://llm.invalid/v1", apiKey: "", model: "fixture", vision: false };

async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = real; }
}

test("with the model down, /why sends the owner's own evidence, real tx hash included", async () => {
  let calls = 0;
  for (const stub of [
    (async () => { calls++; throw new Error("connection refused"); }) as unknown as typeof fetch,
    (async () => { calls++; return new Response("upstream down", { status: 500 }); }) as unknown as typeof fetch,
    // A 200 with nothing written is a failure too (llmText), and narrateWhy answers its input.
    (async () => { calls++; return Response.json({ choices: [{ finish_reason: "stop", message: { content: "" } }] }); }) as unknown as typeof fetch,
  ]) {
    const reply = await withFetch(stub, () => whyAnswer({ text: EVIDENCE, hasTrade: true }, creds));
    assert.equal(reply, EVIDENCE);
    assert.ok(reply.includes(HASH) && reply.includes(ADDRESS));
    assert.ok(!reply.includes("[hash]") && !reply.includes("[address]"), reply);
  }
  assert.ok(calls >= 3, "the model was asked each time");
});

test("with the model up, it reads redacted evidence and the owner gets the narration with the receipt's tx line under it", async () => {
  const prompts: string[] = [];
  const stub = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    prompts.push(body.messages.find((m) => m.role === "user")!.content);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "I bought **because** the spread was <1%." } }] });
  }) as unknown as typeof fetch;
  const reply = await withFetch(stub, () => whyAnswer({ text: EVIDENCE, hasTrade: true }, creds));
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0]!.includes("[hash]") && prompts[0]!.includes("[address]"), prompts[0]);
  assert.ok(!prompts[0]!.includes(HASH) && !prompts[0]!.includes(ADDRESS.slice(2)), "no hash or address reaches the model");
  assert.equal(reply, `I bought <b>because</b> the spread was &lt;1%.\n\n${TX_LINE}`);
  assert.ok(reply.endsWith(TX_LINE));

  // No receipt line (a refused trade has no tx): the narration alone.
  const refused = EVIDENCE.split("\n").filter((line) => line !== TX_LINE).join("\n");
  assert.equal(await withFetch(stub, () => whyAnswer({ text: refused, hasTrade: true }, creds)), "I bought <b>because</b> the spread was &lt;1%.");
});

test("with no trade or no model, /why sends the evidence and asks no model", async () => {
  const stub = (async () => assert.fail("no model call")) as unknown as typeof fetch;
  await withFetch(stub, async () => {
    assert.equal(await whyAnswer({ text: EVIDENCE, hasTrade: true }, null), EVIDENCE);
    assert.equal(await whyAnswer({ text: "nothing yet", hasTrade: false }, creds), "nothing yet");
  });
});
