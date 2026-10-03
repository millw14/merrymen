import assert from "node:assert/strict";
import { test } from "node:test";
import { sendChatAction, sendMessage, sendPhotoBytes, type FetchLike } from "./api";

const epoch = 1_800_000_000_000;
const expired = { ok: false, reason: "request failed: timed out" };
const notStarted = { ...expired, noDelivery: true };
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r)); };
const watch = <T>(p: Promise<T>) => {
  const state: { done: boolean; value?: T } = { done: false };
  void p.then((v) => { state.done = true; state.value = v; });
  return state;
};

test("a reply deadline caps a JSON transport that ignores abort", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: epoch });
  let signal: AbortSignal | undefined;
  const fetchFn: FetchLike = (_url, init) => { signal = init?.signal; return new Promise(() => {}); };
  const result = watch(sendMessage({ token: "1:a", fetchFn, timeoutMs: 90_000, deadlineAtMs: epoch + 30_000 }, -1, "read"));
  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(result.done, false);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(result.value, expired);
  assert.equal(signal?.aborted, true);
});

test("a reply deadline also bounds a JSON body after headers arrive", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: epoch });
  const fetchFn: FetchLike = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });
  const result = watch(sendMessage({ token: "1:a", fetchFn, deadlineAtMs: epoch + 500 }, -1, "read"));
  await flush();
  t.mock.timers.tick(500);
  await flush();
  assert.deepEqual(result.value, expired);
});

test("a photo cannot take its usual sixty seconds past the reply deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: epoch });
  const signals: AbortSignal[] = [];
  const fetchFn: FetchLike = (_url, init) => { signals.push(init!.signal!); return new Promise(() => {}); };
  const result = watch(sendPhotoBytes({ token: "1:a", fetchFn, deadlineAtMs: epoch + 2_000 }, -1, new Uint8Array([1]), "read"));
  t.mock.timers.tick(1_999);
  await flush();
  assert.equal(result.done, false);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(result.value, expired);
  assert.equal(signals.length, 1, "an uncertain upload is never blindly retried");
  assert.equal(signals[0]!.aborted, true);
});

test("a refused photo caption retry shares the original deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: epoch });
  let requests = 0;
  const fetchFn: FetchLike = async () => {
    requests++;
    if (requests === 1) {
      t.mock.timers.tick(29_000);
      return { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: can't parse entities" }) };
    }
    return new Promise(() => {});
  };
  const result = watch(sendPhotoBytes({ token: "1:a", fetchFn, deadlineAtMs: epoch + 30_000 }, -1, new Uint8Array([1]), "<b>read</b>"));
  await flush();
  assert.equal(requests, 2, "Telegram explicitly refused the first upload");
  t.mock.timers.tick(999);
  await flush();
  assert.equal(result.done, false);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(result.value, expired);
});

test("an expired caption retry starts no second upload", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: epoch });
  let requests = 0;
  const fetchFn: FetchLike = async () => {
    requests++;
    return { ok: false, status: 400, json: async () => {
      t.mock.timers.setTime(epoch + 30_000);
      return { ok: false, description: "Bad Request: can't parse entities" };
    } };
  };
  assert.deepEqual(await sendPhotoBytes({ token: "1:a", fetchFn, deadlineAtMs: epoch + 30_000 }, -1, new Uint8Array([1]), "<b>read</b>"), notStarted);
  assert.equal(requests, 1);
});

test("JSON formatting fallback shares the same absolute reply deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: epoch });
  let requests = 0;
  const fetchFn: FetchLike = async () => {
    requests++;
    if (requests === 1) {
      t.mock.timers.tick(750);
      return { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: can't parse entities" }) };
    }
    return new Promise(() => {});
  };
  const result = watch(sendMessage({ token: "1:a", fetchFn, deadlineAtMs: epoch + 1_000 }, -1, "<b>read</b>"));
  await flush();
  assert.equal(requests, 2);
  t.mock.timers.tick(250);
  await flush();
  assert.deepEqual(result.value, expired);
});

test("expired or invalid reply deadlines never start a Telegram request", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: epoch });
  let requests = 0;
  const fetchFn: FetchLike = async () => { requests++; throw new Error("must not send"); };
  for (const deadlineAtMs of [epoch - 1, epoch, Number.NaN, Number.POSITIVE_INFINITY]) {
    const opts = { token: "1:a", fetchFn, deadlineAtMs };
    assert.deepEqual(await sendMessage(opts, -1, "read"), notStarted);
    assert.deepEqual(await sendPhotoBytes(opts, -1, new Uint8Array([1]), "read"), notStarted);
    assert.equal((await sendChatAction(opts, -1, "typing")).ok, false);
  }
  assert.equal(requests, 0);
});

test("a deadline exhausted preparing a photo never starts its upload", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: epoch });
  const append = FormData.prototype.append;
  t.mock.method(FormData.prototype, "append", function (this: FormData, ...args: Parameters<typeof append>) {
    append.apply(this, args);
    t.mock.timers.setTime(epoch + 30_000);
  });
  let requests = 0;
  const fetchFn: FetchLike = async () => { requests++; throw new Error("must not upload late"); };
  assert.deepEqual(await sendPhotoBytes({ token: "1:a", fetchFn, deadlineAtMs: epoch + 30_000 }, -1, new Uint8Array([1]), "read"), notStarted);
  assert.equal(requests, 0);
});

test("only explicit Telegram refusals prove that a started request did not deliver", async () => {
  for (const photo of [false, true]) {
    const send = (fetchFn: FetchLike) => photo
      ? sendPhotoBytes({ token: "1:a", fetchFn }, -1, new Uint8Array([1]), "read")
      : sendMessage({ token: "1:a", fetchFn }, -1, "read");
    const refused = await send(async () => ({ ok: false, status: 429, json: async () => ({ ok: false, description: "Too Many Requests", parameters: { retry_after: 30 } }) }));
    assert.equal(refused.noDelivery, true);
    assert.equal(refused.retryAfterSec, 30);
    const unknownFetches: FetchLike[] = [
      async () => { throw new Error("ECONNRESET"); },
      async () => ({ ok: false, status: 502, json: async () => { throw new Error("invalid JSON"); } }),
      async () => ({ ok: false, status: 400, json: async () => ({ description: "Bad Request: can't parse entities" }) }),
    ];
    for (const fetchFn of unknownFetches) {
      let requests = 0;
      const unknown = await send((url, init) => { requests++; return fetchFn(url, init); });
      assert.equal(unknown.ok, false);
      assert.equal(unknown.noDelivery, undefined, "a broken response is not proof of non-delivery");
      assert.equal(requests, 1, "an ambiguous send is never retried for formatting");
    }
  }
});

test("a refused formatting retry followed by a broken transport stays uncertain", async () => {
  for (const photo of [false, true]) {
    let requests = 0;
    const fetchFn: FetchLike = async () => {
      requests++;
      if (requests === 1) return { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: can't parse entities" }) };
      throw new Error("ECONNRESET");
    };
    const result = photo
      ? await sendPhotoBytes({ token: "1:a", fetchFn }, -1, new Uint8Array([1]), "<b>read</b>")
      : await sendMessage({ token: "1:a", fetchFn }, -1, "<b>read</b>");
    assert.equal(requests, 2);
    assert.equal(result.noDelivery, undefined);
  }
});

test("an ambiguous keyboard error cannot cause a duplicate or prove non-delivery", async () => {
  let requests = 0;
  const fetchFn: FetchLike = async () => { requests++; throw new Error("button URL transport failed"); };
  const result = await sendMessage({ token: "1:a", fetchFn }, -1, "read", { keyboard: [[{ text: "chart", url: "https://example.com" }]] });
  assert.equal(requests, 1);
  assert.equal(result.noDelivery, undefined);
});

test("local token and photo preparation failures prove no delivery", async (t) => {
  let requests = 0;
  const fetchFn: FetchLike = async () => { requests++; throw new Error("must not send"); };
  assert.equal((await sendMessage({ token: "../bad", fetchFn }, -1, "read")).noDelivery, true);
  assert.equal((await sendPhotoBytes({ token: "../bad", fetchFn }, -1, new Uint8Array([1]), "read")).noDelivery, true);
  t.mock.method(FormData.prototype, "append", () => { throw new Error("cannot prepare form"); });
  assert.equal((await sendPhotoBytes({ token: "1:a", fetchFn }, -1, new Uint8Array([1]), "read")).noDelivery, true);
  assert.equal(requests, 0);
});
