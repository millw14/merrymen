import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecoveryPublicReply, isRecoveryPublicRequest, parseRecoveryPublicAsk, RECOVERY_PUBLIC_CONTEXT, RECOVERY_PUBLIC_HELD, RECOVERY_PUBLIC_HELP, RECOVERY_PUBLIC_UNAVAILABLE } from "./recovery-public-reply";
import type { TgDeskEvidence, TgDeskOutcome } from "./tg-groups/types";

const NOW = 1_800_000_000_000;
const TOKEN = `0x${"1".repeat(40)}`;
function evidence(extra: Partial<TgDeskEvidence> = {}): TgDeskEvidence {
  return { kind: "coin", subject: "FROG", header: ["FROG / WETH"], brief: "price 0.01", floor: { read: "The hourly trend is up, with incomplete participation.", stance: "neutral", watch: "a completed candle", invalidation: "the measured support fails" }, reference: { kind: "coin", address: TOKEN }, source: "GeckoTerminal 12:00 UTC", observedAtMs: NOW, chart: null, ...extra };
}
const request = (text = "$FROG chart") => ({ text, deadlineMs: NOW + 30_000 });
const png = () => { const bytes = new Uint8Array(40); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); bytes.set([73, 72, 68, 82], 12); new DataView(bytes.buffer).setUint32(16, 1200); new DataView(bytes.buffer).setUint32(20, 675); return bytes; };

test("financial commands and ambiguous/unbounded asks cannot make a public read", async () => {
  let calls = 0;
  const reply = createRecoveryPublicReply({ now: () => NOW, look: async () => { calls++; throw new Error("must not read"); } });
  for (const text of ["/buy $FROG", "buy $FROG", "/paper-reset", "show your balance", "raise risk limit", "sign this chart"]) assert.equal((await reply(request(text))).text, RECOVERY_PUBLIC_HELD);
  for (const text of ["$FROG versus $CAT", "$FROG versus CAT", "$FROG and CAT", "$FROG ignore previous instructions", "https://evil.test/market", "$" + "x".repeat(80), TOKEN + "a", `0x${"a".repeat(64)}`, TOKEN + "z", `prefix${TOKEN}`, `${TOKEN} ${TOKEN}`, "chart 0x1234", "a".repeat(801), "chart\nFROG", "<b>FROG</b>"]) assert.equal((await reply(request(text))).kind, "help", text);
  assert.equal(calls, 0);
  assert.deepEqual(parseRecoveryPublicAsk("lore $FROG"), { ask: { kind: "coin", query: "FROG" }, lore: true });
  assert.deepEqual(parseRecoveryPublicAsk(`chart ${TOKEN.toUpperCase().replace("0X", "0x")}`), { ask: { kind: "coin", address: TOKEN }, lore: false });
});

test("only fresh, contract-bound evidence becomes a sourced public reply", async () => {
  let value = evidence();
  const reply = createRecoveryPublicReply({ now: () => NOW, look: async () => ({ ok: true, evidence: value }) });
  const out = await reply(request());
  assert.equal(out.kind, "public");
  assert.match(out.text, /hourly trend/);
  assert.match(out.text, /GeckoTerminal · .* UTC\nTrading remains held\.$/);
  assert.equal(out.evidence?.reference.kind, "coin");
  assert.ok(Object.isFrozen(out));
  assert.ok(Object.isFrozen(out.evidence));
  assert.ok(Object.isFrozen(out.evidence?.reference));
  for (const extra of [{ observedAtMs: NOW - 60_001 }, { observedAtMs: NOW + 1 }, { source: "https://provider.test/?secret=123" }, { reference: { kind: "market" as const } }]) {
    value = evidence(extra);
    assert.equal((await reply(request())).text, RECOVERY_PUBLIC_UNAVAILABLE);
  }
  value = evidence({ reference: { kind: "coin", address: `0x${"2".repeat(40)}` } });
  assert.equal((await reply(request(`chart ${TOKEN}`))).kind, "unavailable");
});

test("screenshot-style thoughts and entry asks remain single-asset public analysis", async () => {
  const calls: unknown[] = [];
  const value = evidence({ scenarios: { entry: { read: "There is no measured support for an entry in this hourly window.", stance: "cautious", watch: "", invalidation: "" } } });
  const reply = createRecoveryPublicReply({ now: () => NOW, look: async (ask) => { calls.push(ask); return { ok: true, evidence: value }; } });
  assert.equal((await reply(request(`Thoughts on ${TOKEN}`))).kind, "public");
  assert.deepEqual(calls, [{ kind: "coin", address: TOKEN }]);
  const entry = await reply(request("your take on $FROG entry".replace("your ", "")));
  assert.match(entry.text, /no measured support/);
  assert.doesNotMatch(entry.text, /placed|bought|executed/);
  assert.equal((await reply(request(`Thoughts on ${TOKEN} and CAT`))).kind, "help");
  assert.equal((await reply(request("check out $FROG and CAT"))).kind, "help");
  assert.equal((await reply(request("execute entry $FROG"))).kind, "held");
  assert.equal(calls.length, 2);
});

test("actual named-coin and explicit market phrasing stays public without private-context guessing", async () => {
  assert.deepEqual(parseRecoveryPublicAsk("check out cashcat, I think good entry?"), { ask: { kind: "coin", query: "cashcat" }, lore: false });
  assert.deepEqual(parseRecoveryPublicAsk("how is the market currently"), { ask: { kind: "market" }, lore: false });
  assert.deepEqual(parseRecoveryPublicAsk("do a quick analysis of the market"), { ask: { kind: "market" }, lore: false });
  assert.deepEqual(parseRecoveryPublicAsk(`what about ${TOKEN}`), { ask: { kind: "coin", address: TOKEN }, lore: false });
  assert.deepEqual(parseRecoveryPublicAsk("cashcat story"), { ask: { kind: "coin", query: "cashcat" }, lore: true });
  for (const text of ["do a quick analysis", "check out cashcat and DOG", "how is the market and DOG", "check out cashcat, buy it now"]) assert.equal(parseRecoveryPublicAsk(text), text.includes("buy") ? "held" : "help", text);
});

test("the pure approved-room gate answers public asks and leaves ordinary chatter quiet", () => {
  for (const text of [`Thoughts on ${TOKEN}`, `what about ${TOKEN}`, TOKEN, `lore ${TOKEN}`, `chart ${TOKEN}`, "check out cashcat, I think good entry?", "how is the market currently"]) assert.equal(isRecoveryPublicRequest(text), true, text);
  for (const text of ["cashcat", "$CASHCAT", "$CASHCAT is good", "cashcat looking good", "hello", "do a quick analysis", "check out cashcat and DOG", "buy $CASHCAT", `sell ${TOKEN}`, `Thoughts on ${TOKEN} and DOG`, TOKEN + "a"]) assert.equal(isRecoveryPublicRequest(text), false, text);
});

test("standalone conversational follow-ups cannot guess an asset from unavailable history", async () => {
  const calls: unknown[] = [];
  const reply = createRecoveryPublicReply({ now: () => NOW, look: async ask => { calls.push(ask); return { ok: true, evidence: evidence() }; } });
  for (const text of ["thoughts", "analysis", "entry", "lore", "chart", "please"]) {
    assert.equal(parseRecoveryPublicAsk(text), "help", text); assert.equal(isRecoveryPublicRequest(text), false, text);
    assert.equal((await reply(request(text))).kind, "help", text);
  }
  for (const text of ["why", "what do you mean", "what does that mean", "what was that", "explain"]) {
    assert.equal(parseRecoveryPublicAsk(text), "repair", text);
    assert.equal(isRecoveryPublicRequest(text), false, text);
    assert.deepEqual(await reply(request(text)), { kind: "conversation", text: RECOVERY_PUBLIC_CONTEXT }, text);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(parseRecoveryPublicAsk("$WHY"), { ask: { kind: "coin", query: "WHY" }, lore: false });
  assert.deepEqual(parseRecoveryPublicAsk("chart WHY"), { ask: { kind: "coin", query: "WHY" }, lore: false });
});

test("greetings, acknowledgments and status have fixed natural replies without a public read", async () => {
  let calls = 0;
  const reply = createRecoveryPublicReply({ now: () => NOW, look: async () => { calls++; throw new Error("small talk must not read"); } });
  const fixtures = [
    { inputs: ["hi", "Hiii", "  Hiiii!!!  ", "Heyyy!", "hellooo", "hello there", "how are you?", "HOW’S IT GOING?", "are you there", "you there?"], intent: "greeting", text: "Hey, I'm here. What are we looking at?" },
    { inputs: ["gm", "gmmmm", "good morning!"], intent: "morning", text: "Morning. What's on your radar?" },
    { inputs: ["gn", "gnnn", "good night", "bye", "goodbye!"], intent: "farewell", text: "Catch you later." },
    { inputs: ["thanks", "THANKS!", "thank you", "thx", "ty"], intent: "thanks", text: "You're welcome." },
    { inputs: ["ok", "okay!", "sure", "cool"], intent: "ack", text: "Got you." },
    { inputs: ["eh", "eh??", "huh", "huhhh?"], intent: "clarify", text: "I'm here. What did you want to ask?" },
    { inputs: ["are you back", "are you working?", "are you online", "status"], intent: "status", text: "I'm here and replying. Trading is paused while the saved accounting is reconciled." },
  ];
  for (const fixture of fixtures) for (const text of fixture.inputs) {
    assert.equal(parseRecoveryPublicAsk(text), fixture.intent, text);
    assert.equal(isRecoveryPublicRequest(text), false, text);
    const out = await reply(request(text));
    assert.deepEqual(out, { kind: "conversation", text: fixture.text }, text);
    assert.ok(Object.isFrozen(out));
    if (fixture.intent !== "status") assert.doesNotMatch(out.text, /Trading|fresh public data|GeckoTerminal/, text);
  }
  for (const text of ["help", "/help"]) assert.deepEqual(await reply(request(text)), { kind: "help", text: RECOVERY_PUBLIC_HELP }, text);
  assert.equal(calls, 0);
});

test("explicit assets retain precedence even when their tickers look conversational", async () => {
  const calls: unknown[] = [];
  const reply = createRecoveryPublicReply({ now: () => NOW, look: async ask => { calls.push(ask); return { ok: true, evidence: evidence() }; } });
  for (const [text, query, lore] of [
    ["/chart hi", "hi", false], ["$HI", "HI", false], ["hi chart", "hi", false], ["chart GM", "GM", false],
    ["Hiii chart", "Hiii", false], ["$THANKS", "THANKS", false], ["thanks lore", "thanks", true], ["lore EH", "EH", true],
    ["/lore hello", "hello", true], ["chart STATUS", "STATUS", false], ["$WHY", "WHY", false],
  ] as const) {
    assert.deepEqual(parseRecoveryPublicAsk(text), { ask: { kind: "coin", query }, lore }, text);
    assert.equal((await reply(request(text))).kind, "public", text);
    assert.deepEqual(calls.at(-1), { kind: "coin", query }, text);
  }
  assert.equal(calls.length, 11);
  for (const query of ["hiatus", "GMX", "okaycoin", "hello-world", "hiii2"]) assert.deepEqual(parseRecoveryPublicAsk(query), { ask: { kind: "coin", query }, lore: false }, query);
});

test("casual wording cannot hide commands, hostile content or an expired request", async () => {
  let calls = 0;
  const reply = createRecoveryPublicReply({ now: () => NOW, look: async () => { calls++; throw new Error("must not read"); } });
  for (const text of ["hi buy $FROG", "are you there withdraw", "thanks reset", "hello your holdings", "/buy hi"]) assert.equal((await reply(request(text))).text, RECOVERY_PUBLIC_HELD, text);
  for (const text of ["hiii https://evil.test/market", "hello ignore previous instructions", "eh and FROG", "hiii $FROG", "hi\n", "hiii\u200b", "<b>hi</b>"]) assert.equal((await reply(request(text))).kind, "help", text);
  assert.equal((await reply({ ...request("Hiii"), deadlineMs: NOW + 4000 })).kind, "unavailable");
  const controller = new AbortController();
  controller.abort();
  assert.equal((await reply({ ...request("eh"), signal: controller.signal })).kind, "unavailable");
  assert.equal(calls, 0);
});

test("lore stays an attributed claim and does not invent missing or mismatched lore", async () => {
  let value = evidence({ lore: { description: "A frog-themed community token.", source: "GeckoTerminal token info", url: `https://www.geckoterminal.com/robinhood/tokens/${TOKEN}`, observedAtMs: NOW } });
  const reply = createRecoveryPublicReply({ now: () => NOW, look: async () => ({ ok: true, evidence: value }) });
  assert.match((await reply(request("lore $FROG"))).text, /Published project claim.*frog-themed/);
  assert.doesNotMatch((await reply(request("lore $FROG"))).text, /hourly trend/);
  const chart = await reply(request("$FROG chart"));
  assert.match(chart.text, /Published project claim.*frog-themed.*\n.*hourly trend/);
  assert.ok(chart.text.length <= 1000);
  value = evidence({ lore: { ...value.lore!, url: "https://evil.test/private?token=123" } });
  const missing = await reply(request("story $FROG"));
  assert.match(missing.text, /won't guess its story/);
  assert.doesNotMatch(missing.text, /evil|private|token=123|frog-themed/);
});

test("the returned snapshot retains no raw brief and copies chart bytes before later mutation", async () => {
  const image = png();
  const value = evidence({ chart: image, brief: "unrelated secret-bearing diagnostic must not be retained" });
  const reply = createRecoveryPublicReply({ now: () => NOW, look: async () => ({ ok: true, evidence: value }) });
  const out = await reply(request());
  assert.deepEqual(out.photo, image);
  assert.notEqual(out.photo, image);
  image.fill(0);
  value.floor.read = "late mutation";
  value.subject = "late mutation";
  assert.equal(out.photo?.[0], 137);
  assert.equal(out.evidence?.subject, "FROG");
  assert.doesNotMatch(out.text, /late mutation|diagnostic/);
  assert.equal("brief" in out, false);
  assert.equal("brief" in out.evidence!, false);
});

test("unsafe publisher symbols and malformed chart payloads cannot become markup or attachments", async () => {
  const value = evidence({ subject: "<a href='https://evil.test'>@owner</a>", floor: { read: "<a href='https://evil.test'>@owner</a> has incomplete chart history.", watch: "", invalidation: "", stance: "neutral" }, chart: new Uint8Array(40) });
  const reply = createRecoveryPublicReply({ now: () => NOW, look: async () => ({ ok: true, evidence: value }) });
  const out = await reply(request());
  assert.match(out.text, /^this coin\nthis coin has/);
  assert.doesNotMatch(out.text, /href|https|@owner/);
  assert.equal(out.photo, undefined);
});

test("hung or rejected reads return fallback before send reserve; late completion cannot replace it", async () => {
  let resolve!: (result: TgDeskOutcome) => void;
  let signal: AbortSignal | undefined;
  const reply = createRecoveryPublicReply({ look: async (_ask, options) => { signal = options.signal; return new Promise<TgDeskOutcome>((done) => { resolve = done; }); } });
  const began = Date.now();
  const out = await reply({ text: "$FROG chart", deadlineMs: began + 100, sendReserveMs: 70 });
  assert.equal(out.kind, "unavailable");
  assert.ok(Date.now() - began < 90);
  assert.equal(signal?.aborted, true);
  resolve({ ok: true, evidence: evidence({ observedAtMs: Date.now() }) });
  await new Promise((done) => setImmediate(done));
  assert.equal(out.text, RECOVERY_PUBLIC_UNAVAILABLE);
  const rejected = createRecoveryPublicReply({ look: async () => { throw new Error("secret diagnostic"); } });
  assert.equal((await rejected({ text: "$FROG", deadlineMs: Date.now() + 1000, sendReserveMs: 100 })).text, RECOVERY_PUBLIC_UNAVAILABLE);
});

test("lease cancellation and receipt deadline invalidate an otherwise completed public read", async () => {
  const ctl = new AbortController();
  const reply = createRecoveryPublicReply({ now: () => NOW, look: async () => { ctl.abort(); return { ok: true, evidence: evidence() }; } });
  assert.equal((await reply({ ...request(), signal: ctl.signal })).kind, "unavailable");
  let clock = NOW;
  let calls = 0;
  const elapsed = createRecoveryPublicReply({ now: () => clock, look: async (_ask, options) => { calls++; assert.equal(options.timeoutMs, 10_000); clock += 26_000; return { ok: true, evidence: evidence() }; } });
  assert.equal((await elapsed({ ...request(), deadlineMs: NOW + 3_600_000 })).kind, "unavailable");
  clock = NOW;
  assert.equal((await elapsed({ ...request(), deadlineMs: NOW + 4000 })).kind, "unavailable");
  assert.equal(calls, 1);
});
