import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backoffMs, classifyRpcError } from "./rpc-error";

/**
 * The shapes below are the ones this chain actually produces, not invented
 * ones. The decisive case is the first: what arrives from Robinhood's RPC is a
 * viem `RpcRequestError` whose JSON-RPC body says "Rate Limit Hit" and which
 * carries NO HTTP status at all — so a status-only classifier would miss every
 * real rate limit and the whole module would be decorative.
 */

/** As viem constructs it: name, message, details, and a numeric `code`. */
const rateLimited = () =>
  Object.assign(new Error("RPC Request failed.\nDetails: Rate Limit Hit, limit will reset in 60 seconds"), {
    name: "RpcRequestError",
    details: "Rate Limit Hit, limit will reset in 60 seconds",
    shortMessage: "RPC Request failed.",
    code: 429,
  });

describe("classifyRpcError", () => {
  it("recognises the rate limit THIS chain actually sends", () => {
    const v = classifyRpcError(rateLimited());
    assert.equal(v.kind, "rate-limited");
    assert.equal(v.retryable, true);
  });

  it("recognises a rate limit with no status code at all", () => {
    // The form that broke getLogsAdaptive: an RpcRequestError whose only signal
    // is the body text. viem does not attach an HTTP status to these.
    const bare = Object.assign(new Error("Rate Limit Hit, limit will reset in 60 seconds"), {
      name: "RpcRequestError",
    });
    assert.equal(classifyRpcError(bare).kind, "rate-limited");
  });

  it("A RATE LIMIT IS NOT A RANGE ERROR, even when it says 'limit'", () => {
    // The whole bug in one assertion. "limit will reset in 60 seconds" contains
    // the word `limit`, and a looser matcher ordered the other way would call it
    // range-too-large and start halving the span.
    assert.equal(classifyRpcError(rateLimited()).kind, "rate-limited");
    assert.notEqual(classifyRpcError(rateLimited()).kind, "range-too-large");
  });

  it("recognises a genuine range error, which IS a hint about the question", () => {
    for (const msg of [
      "query returned more than 10000 results",
      "block range is too large",
      "eth_getLogs: too many blocks requested",
      "log response size exceeded",
    ]) {
      const v = classifyRpcError(new Error(msg));
      assert.equal(v.kind, "range-too-large", msg);
      // NOT retryable unchanged — the caller must narrow, not wait.
      assert.equal(v.retryable, false, msg);
    }
  });

  it("honours Retry-After, from a Headers object or a plain record", () => {
    const withHeaders = Object.assign(new Error("Too Many Requests"), {
      name: "HttpRequestError",
      status: 429,
      headers: new Headers({ "retry-after": "42" }),
    });
    assert.equal(classifyRpcError(withHeaders).retryAfterMs, 42_000);

    const withRecord = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      headers: { "Retry-After": "7" },
    });
    assert.equal(classifyRpcError(withRecord).retryAfterMs, 7_000);
  });

  it("a revert is an ANSWER, and retrying gets the same one", () => {
    const v = classifyRpcError(new Error("execution reverted: STF"));
    assert.equal(v.kind, "reverted");
    assert.equal(v.retryable, false);
  });

  it("timeouts and transport failures are retryable; they say nothing about the answer", () => {
    assert.equal(classifyRpcError(new Error("The request timed out.")).kind, "timeout");
    assert.equal(classifyRpcError(new Error("fetch failed")).kind, "transport");
    assert.equal(classifyRpcError(Object.assign(new Error("bad gateway"), { status: 502 })).kind, "transport");
    for (const e of ["The request timed out.", "fetch failed", "socket hang up"]) {
      assert.equal(classifyRpcError(new Error(e)).retryable, true, e);
    }
  });

  it("AN UNRECOGNISED FAILURE IS NOT RETRYABLE", () => {
    // When in doubt, stop. An unrecognised failure retried forever is how one
    // rate limit became millions of requests; surfaced once, it is a bug report.
    const v = classifyRpcError(new Error("something nobody has seen before"));
    assert.equal(v.kind, "other");
    assert.equal(v.retryable, false);
  });

  it("never throws, whatever it is handed", () => {
    for (const junk of [null, undefined, 42, "a string", {}, [], new Error("")]) {
      const v = classifyRpcError(junk);
      assert.ok(typeof v.kind === "string" && typeof v.retryable === "boolean", String(junk));
      assert.ok(v.detail.length > 0);
    }
  });
});

/**
 * A SPENT QUOTA IS NOT A RATE LIMIT, and the fleet lost a day to the difference.
 *
 * From 2026-09-28 01:48 UTC the house endpoint answered every read — at any
 * rate, from any IP — with the body below under HTTP 429. Filed as
 * `rate-limited`, it looked like throttling to everyone reading the meter.
 */
const ALCHEMY_MONTHLY =
  "Monthly capacity limit exceeded. Visit https://dashboard.alchemy.com/settings/billing to upgrade your scaling policy for continued service.";

describe("classifyRpcError — a spent quota", () => {
  it("RECOGNISES THE BODY THE HOUSE ENDPOINT ACTUALLY SENT", () => {
    // As viem raises it on the path where the JSON-RPC error reaches it intact.
    const e = Object.assign(new Error(`RPC Request failed.\nDetails: ${ALCHEMY_MONTHLY}`), {
      name: "RpcRequestError",
      details: ALCHEMY_MONTHLY,
      shortMessage: "RPC Request failed.",
      code: 429,
    });
    const v = classifyRpcError(e);
    assert.equal(v.kind, "quota-exhausted");
    assert.equal(v.retryable, false, "backing off does not refill a monthly quota");
  });

  it("AND THE MARKER the transport stamps when it read that body off a 429", async () => {
    const { QUOTA_MARKER } = await import("./rpc-error");
    const e = Object.assign(
      new Error(`HTTP request failed. Status: 429 Too Many Requests · ${QUOTA_MARKER}: the provider says so`),
      { status: 429 },
    );
    // "Too Many Requests" and a 429 status are both in there. The quota verdict
    // must win, or this is filed as a rate limit exactly as before.
    assert.equal(classifyRpcError(e).kind, "quota-exhausted");
  });

  it("A PER-SECOND LIMIT STAYS A RATE LIMIT, even when it says 'capacity'", () => {
    // Alchemy's own throughput refusal. It IS a rate, and backing off is the
    // right answer to it — reading it as a spent quota would stop the fleet
    // retrying something that clears in a second.
    const cups = Object.assign(
      new Error(
        "Your app has exceeded its compute units per second capacity. If you have retries enabled, you can safely ignore this message.",
      ),
      { code: 429 },
    );
    assert.equal(classifyRpcError(cups).kind, "rate-limited");
    // And this chain's own public-endpoint limit, which resets in a minute.
    assert.equal(classifyRpcError(rateLimited()).kind, "rate-limited");
  });

  it("the same fact in other providers' words", async () => {
    const { saysQuotaExhausted } = await import("./rpc-error");
    for (const msg of ["daily request count exceeded, request rate limited", "Quota exceeded for this project", ALCHEMY_MONTHLY]) {
      assert.equal(saysQuotaExhausted(msg), true, msg);
    }
    for (const msg of ["Too Many Requests", "Rate Limit Hit, limit will reset in 60 seconds", "execution reverted"]) {
      assert.equal(saysQuotaExhausted(msg), false, msg);
    }
  });
});

describe("backoffMs", () => {
  it("grows exponentially and stays under the cap", () => {
    for (let a = 0; a < 12; a++) {
      const ms = backoffMs(a, 500, 30_000);
      assert.ok(ms >= 0 && ms <= 30_000, `attempt ${a} gave ${ms}`);
    }
  });

  it("IS FULLY JITTERED, because the callers were rate-limited in step", () => {
    // A fleet of agents throttled by the same provider at the same instant must
    // not come back at the same instant either. Full jitter, not a ±10% wobble:
    // the whole distribution has to spread, so the samples must differ.
    const samples = new Set(Array.from({ length: 40 }, () => backoffMs(6, 500, 30_000)));
    assert.ok(samples.size > 20, `expected a spread, got ${samples.size} distinct values`);
  });
});
