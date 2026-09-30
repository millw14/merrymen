/**
 * THE SHELL'S ONE FETCH, driven against the answers a real deployment gives.
 *
 * `requestJson` parsed the body before it looked at the status, so a proxy's
 * HTML 502 surfaced as "Unexpected token '<'" and a timeout as the raw
 * DOMException "signal timed out" — both printed verbatim in the shell's alert.
 * Neither says what happened, and neither says what to do.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { RequestError, requestJson } from "./request-json";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(status: number, body: string, contentType: string) {
  globalThis.fetch = async () => new Response(body, { status, headers: { "content-type": contentType } });
}
function refuse(error: unknown) {
  globalThis.fetch = async () => {
    throw error;
  };
}
async function failure(): Promise<RequestError> {
  try {
    await requestJson("/api/grants");
  } catch (e) {
    assert.ok(e instanceof RequestError, `expected a RequestError, got ${String(e)}`);
    return e;
  }
  assert.fail("the request should have failed");
}
const RAW = /Unexpected token|JSON|DOMException|signal timed out|fetch failed|Failed to fetch/i;

describe("requestJson", () => {
  it("returns the body of a JSON answer", async () => {
    answer(200, JSON.stringify({ exists: false }), "application/json");
    assert.deepEqual(await requestJson("/api/grants"), { exists: false });
  });

  it("reads the status before the body: an HTML 502 is a failed request, not a parse error", async () => {
    answer(502, "<html><body>Bad gateway</body></html>", "text/html; charset=utf-8");
    const e = await failure();
    assert.equal(e.status, 502);
    assert.doesNotMatch(e.message, RAW);
  });

  it("refuses a 200 that is not JSON rather than handing back garbage", async () => {
    answer(200, "<!doctype html><title>Sign in</title>", "text/html");
    const e = await failure();
    assert.equal(e.status, 200);
    assert.doesNotMatch(e.message, RAW);
  });

  it("does not parse a body it was never promised was JSON", async () => {
    // Parse-and-see would hand `null` back as the account status here, and the
    // shell would crash reading `.exists` on it. The header is the contract.
    answer(200, "null", "text/plain; charset=utf-8");
    const e = await failure();
    assert.equal(e.status, 200);
    assert.doesNotMatch(e.message, RAW);
  });

  it("keeps the server's own words when it gave some", async () => {
    answer(409, JSON.stringify({ error: "this agent account is already linked to a different login" }), "application/json");
    assert.equal((await failure()).message, "this agent account is already linked to a different login");
    answer(400, JSON.stringify({ errors: ["perTradeUsdg is 0", "dailyUsdg is 0"] }), "application/json");
    assert.equal((await failure()).message, "perTradeUsdg is 0 dailyUsdg is 0");
  });

  it("says a timeout in plain words", async () => {
    refuse(new DOMException("signal timed out", "TimeoutError"));
    const e = await failure();
    assert.equal(e.status, 0, "no answer at all is status 0");
    assert.doesNotMatch(e.message, RAW);
    assert.match(e.message, /reach merrymen/);
  });

  it("says a dropped connection in plain words", async () => {
    refuse(new TypeError("fetch failed"));
    const e = await failure();
    assert.equal(e.status, 0);
    assert.match(e.message, /reach merrymen/);
  });

  it("lets a caller abort an in-flight request", async () => {
    const caller = new AbortController();
    let received: AbortSignal | null | undefined;
    globalThis.fetch = async (_url, init) => {
      received = init?.signal;
      assert.ok(received);
      return new Promise<Response>((_resolve, reject) => {
        received!.addEventListener("abort", () => reject(received!.reason), { once: true });
      });
    };

    const pending = requestJson("/api/auth/privy", { signal: caller.signal });
    const canceled = new DOMException("Sign-in was restarted", "AbortError");
    caller.abort(canceled);

    await assert.rejects(pending, (error: unknown) => error instanceof RequestError && error.status === 0);
    assert.equal(received?.aborted, true, "the request must receive cancellation from its caller");
    assert.equal(received?.reason, canceled);
  });

  it("supports caller cancellation in browsers without AbortSignal.any", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
    Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
    try {
      const caller = new AbortController();
      let received: AbortSignal | null | undefined;
      globalThis.fetch = async (_url, init) => {
        received = init?.signal;
        assert.ok(received);
        return new Promise<Response>((_resolve, reject) => {
          received!.addEventListener("abort", () => reject(received!.reason), { once: true });
        });
      };
      const pending = requestJson("/api/auth/privy", { signal: caller.signal });
      caller.abort();
      await assert.rejects(pending, RequestError);
      assert.equal(received?.aborted, true, "the request must reach fetch and retain cancellation");
    } finally {
      if (descriptor) Object.defineProperty(AbortSignal, "any", descriptor);
      else Reflect.deleteProperty(AbortSignal, "any");
    }
  });

  it("passes through cancellation that occurred before the request started", async () => {
    const caller = new AbortController();
    caller.abort();
    globalThis.fetch = async (_url, init) => {
      assert.equal(init?.signal?.aborted, true);
      assert.equal(init.signal.reason, caller.signal.reason);
      throw init.signal.reason;
    };
    await assert.rejects(requestJson("/api/auth/privy", { signal: caller.signal }), RequestError);
  });

  it("keeps cancellation active while reading the body and releases it afterwards", async () => {
    const caller = new AbortController();
    let received: AbortSignal | null | undefined;
    let finishBody!: (value: unknown) => void;
    const body = new Promise((resolve) => { finishBody = resolve; });
    globalThis.fetch = async (_url, init) => {
      received = init?.signal;
      const response = new Response("{}", { headers: { "content-type": "application/json" } });
      response.json = () => body;
      return response;
    };
    const pending = requestJson("/api/auth/privy", { signal: caller.signal });
    await Promise.resolve();
    caller.abort();
    assert.equal(received?.aborted, true, "body reading must still be cancellable");
    finishBody({ ok: true });
    await pending;

    const nextCaller = new AbortController();
    await requestJson("/api/auth/privy", { signal: nextCaller.signal });
    nextCaller.abort();
    assert.equal(received?.aborted, false, "completed requests must release their caller listener");
  });

  it("keeps the 20-second deadline when the caller supplies a signal", async (t) => {
    const caller = new AbortController();
    const deadline = new AbortController();
    t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
      assert.equal(milliseconds, 20000);
      return deadline.signal;
    });
    let received: AbortSignal | null | undefined;
    globalThis.fetch = async (_url, init) => {
      received = init?.signal;
      assert.ok(received);
      return new Promise<Response>((_resolve, reject) => {
        received!.addEventListener("abort", () => reject(received!.reason), { once: true });
      });
    };

    const pending = requestJson("/api/auth/privy", { signal: caller.signal });
    const expired = new DOMException("signal timed out", "TimeoutError");
    deadline.abort(expired);

    await assert.rejects(pending, (error: unknown) => error instanceof RequestError && error.status === 0);
    assert.equal(received?.aborted, true, "the request must retain its own deadline");
    assert.equal(received?.reason, expired);
    assert.equal(caller.signal.aborted, false, "the request must not cancel the caller's other work");
  });
});

describe("what a server error may say to the owner", () => {
  // Several routes on this path fill `error` with the raw exception on a 500 —
  // the grants store's own message among them — and requestJson passed it
  // through word for word, into the sign-in and create-agent screens. A 4xx is
  // a route telling the owner something; a 5xx is our failure, and its text is
  // ours to read, not theirs.
  it("a 500 carrying a driver's message is shown the plain sentence, and the body goes to the console", async () => {
    const warned: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args);
    try {
      answer(500, JSON.stringify({ error: "connect ECONNREFUSED 127.0.0.1:5432" }), "application/json");
      const e = await failure();
      assert.equal(e.status, 500);
      assert.doesNotMatch(e.message, /ECONNREFUSED|127\.0\.0\.1|5432/);
      assert.match(e.message, /merrymen answered with an error \(500\)/);
      assert.ok(warned.some((args) => JSON.stringify(args).includes("ECONNREFUSED")), "the cause is kept where a developer looks");
    } finally {
      console.warn = warn;
    }
  });

  it("nor does a 502 whose body reads like a transport error", async () => {
    answer(502, JSON.stringify({ error: "fetch failed" }), "application/json");
    const e = await failure();
    assert.doesNotMatch(e.message, RAW);
  });
});

describe("a 5xx a route wrote for the owner", () => {
  it("keeps its words when the route marked them as the owner's", async () => {
    answer(503, JSON.stringify({ error: "couldn't check this account's ownership — please try again", ownerFacing: true }), "application/json");
    assert.equal((await failure()).message, "couldn't check this account's ownership — please try again");
  });
});
