import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AlertStream,
  STREAM_DEFAULTS,
  backoffDelayMs,
  frameTimeMs,
  type AlertStreamOptions,
  type ClockPort,
  type SocketLike,
  type StreamDeadLetter,
  type StreamFrame,
  type StreamFrameMeta,
  type StreamGap,
  type StreamState,
  type StreamStateDetail,
  type TimerPort,
} from "./stream";

// Compile-time proof that Node 22's global WebSocket fits the port. Never called: no network in tests.
const nodeSocketFactory: (url: string) => SocketLike = (url) => new WebSocket(url);

const SECRET_KEY = "sk_live_9f8e7d6c5b4a39281706";
const SECRET_URL = `wss://stream.test/ws/alerts?key=${SECRET_KEY}&chain=robinhood`;
const REDACTED = "wss://stream.test/ws/alerts?key=[redacted]&chain=robinhood";
const T0 = 1_790_000_000_000;

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise<void>((r) => setImmediate(r));
}

/** A manual clock that also owns the timers, so time only moves when a test moves it. */
class ManualTime implements ClockPort, TimerPort {
  t = T0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.timers) {
        if (e[1].at > target) continue;
        if (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[0] < next[0])) next = e;
      }
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
      await settle();
    }
    this.t = target;
    await settle();
  }
}

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  open(): void {
    this.onopen?.({});
  }
  frame(obj: unknown): void {
    this.onmessage?.({ data: typeof obj === "string" ? obj : JSON.stringify(obj) });
  }
  raw(data: unknown): void {
    this.onmessage?.({ data });
  }
  serverClose(code = 1006, reason = ""): void {
    this.onclose?.({ code, reason });
  }
}

function welcome(heartbeatSeconds = 10, extra: Record<string, unknown> = {}) {
  return { type: "welcome", stream: "alerts", realtime: true, delaySeconds: 0, heartbeatSeconds, filter: { chain: "robinhood" }, ...extra };
}

function alert(n: number, ts: number, extra: Record<string, unknown> = {}) {
  return { type: "alert", alertType: "buy", eventId: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`, userId: "u1", ts, ...extra };
}

function harness(opts: Partial<AlertStreamOptions> = {}) {
  const time = new ManualTime();
  const sockets: FakeSocket[] = [];
  const frames: Array<{ frame: StreamFrame; meta: StreamFrameMeta }> = [];
  const gaps: StreamGap[] = [];
  const dead: StreamDeadLetter[] = [];
  const states: Array<{ state: StreamState; detail: StreamStateDetail }> = [];
  const stream = new AlertStream({
    endpoint: { url: SECRET_URL, redacted: REDACTED },
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    clock: time,
    timers: time,
    random: () => 0.5,
    onFrame: (frame, meta) => {
      frames.push({ frame, meta });
    },
    onGap: (g) => {
      gaps.push(g);
    },
    onDeadLetter: (d) => {
      dead.push(d);
    },
    onState: (state, detail) => {
      states.push({ state, detail });
    },
    ...opts,
  });
  const last = () => {
    const s = sockets[sockets.length - 1];
    assert.ok(s, "a socket was created");
    return s;
  };
  const backoffs = () => states.filter((s) => s.state === "backoff").map((s) => s.detail);
  /** Advance exactly to the scheduled reconnect, so no unrelated watchdog fires on the way. */
  const reconnect = () => time.advance(backoffs().at(-1)?.delayMs ?? 0);
  return { time, sockets, frames, gaps, dead, states, stream, last, backoffs, reconnect };
}

describe("backoff", () => {
  it("is full jitter: uniform below a ceiling that doubles from 1 s to a 60 s cap", () => {
    assert.equal(typeof nodeSocketFactory, "function");
    assert.equal(backoffDelayMs(0, () => 0), 0);
    assert.equal(backoffDelayMs(0, () => 0.999999), 999);
    assert.equal(backoffDelayMs(1, () => 0.999999), 1_999);
    assert.equal(backoffDelayMs(5, () => 0.999999), 31_999);
    assert.equal(backoffDelayMs(6, () => 0.999999), 59_999, "64 s ceiling is capped at 60 s");
    assert.equal(backoffDelayMs(1_000, () => 0.999999), 59_999);
    assert.equal(backoffDelayMs(3, () => 0.5), 4_000);
    // A broken random source can never produce a delay outside the bounds.
    assert.equal(backoffDelayMs(2, () => 1), 3_999);
    assert.equal(backoffDelayMs(2, () => -5), 0);
    assert.equal(backoffDelayMs(2, () => Number.NaN), 2_000);
    for (let attempt = 0; attempt < 12; attempt++) {
      const ceiling = Math.min(60_000, 1_000 * 2 ** attempt);
      for (const r of [0, 0.1, 0.37, 0.5, 0.93, 0.999999]) {
        const d = backoffDelayMs(attempt, () => r);
        assert.ok(d >= 0 && d < ceiling, `attempt ${attempt} r ${r} → ${d} within [0, ${ceiling})`);
      }
    }
  });

  it("grows across failed connections and stays capped", async () => {
    const h = harness({ random: () => 0.999999 });
    h.stream.start();
    for (let i = 0; i < 8; i++) {
      h.last().serverClose(1006, "");
      await h.reconnect();
    }
    assert.deepEqual(
      h.backoffs().map((d) => d.delayMs),
      [999, 1_999, 3_999, 7_999, 15_999, 31_999, 59_999, 59_999],
    );
    assert.equal(h.sockets.length, 9);
    h.stream.stop();
  });

  it("resets only after a connection has stayed healthy, not on connect or welcome", async () => {
    const h = harness({ random: () => 0.999999 });
    h.stream.start();
    h.last().serverClose();
    await h.reconnect();
    h.last().serverClose();
    await h.reconnect();
    // Accepts, welcomes, then drops at once: a flapping server must not reset the backoff.
    h.last().frame(welcome(10));
    h.last().serverClose();
    assert.equal(h.backoffs().at(-1)?.delayMs, 3_999);
    await h.reconnect();

    // This one stays up, heartbeats flowing, past healthyAfterMs (30 s).
    h.last().frame(welcome(10));
    for (let i = 0; i < 4; i++) {
      await h.time.advance(9_000);
      h.last().frame({ type: "heartbeat", ts: h.time.now(), lastEventAt: null, quietSeconds: 9, buffered: 0 });
    }
    assert.ok(h.time.now() - T0 > 30_000);
    h.last().serverClose(1001, "going away");
    assert.equal(h.backoffs().at(-1)?.delayMs, 999, "back to the base ceiling");
    assert.equal(h.backoffs().at(-1)?.code, 1001);
    h.stream.stop();
  });
});

describe("heartbeat watchdog", () => {
  it("closes and reconnects after 2.5 announced intervals of silence, and any valid frame re-arms it", async () => {
    const h = harness();
    h.stream.start();
    const first = h.last();
    first.open();
    first.frame(welcome(10));
    await h.time.advance(20_000);
    first.frame({ type: "heartbeat", ts: h.time.now(), lastEventAt: null, quietSeconds: 20, buffered: 0 });
    await h.time.advance(24_999);
    assert.equal(first.closed, null, "24.999 s of silence is inside 25 s");
    await h.time.advance(1);
    assert.deepEqual(first.closed, { code: 4000, reason: "heartbeat-timeout" });
    assert.equal(h.backoffs().at(-1)?.reason, "heartbeat-timeout");
    await h.reconnect();
    assert.equal(h.sockets.length, 2, "reconnected");
    h.stream.stop();
  });

  it("uses the default interval until welcome, so a socket that never speaks is dropped", async () => {
    const h = harness();
    h.stream.start();
    h.last().open();
    await h.time.advance(STREAM_DEFAULTS.defaultHeartbeatSeconds * 2.5 * 1000 - 1);
    assert.equal(h.last().closed, null);
    await h.time.advance(1);
    assert.equal(h.last().closed?.code, 4000);
    h.stream.stop();
  });

  it("does not treat garbage as proof of life", async () => {
    const h = harness();
    h.stream.start();
    h.last().frame(welcome(10));
    for (let i = 0; i < 5; i++) {
      await h.time.advance(5_000);
      h.last().frame("not json at all");
    }
    assert.equal(h.last().closed?.code, 4000);
    h.stream.stop();
  });
});

describe("frames", () => {
  it("dead-letters oversized, unparseable, typeless and unknown frames with truncated payloads", async () => {
    const h = harness();
    h.stream.start();
    const s = h.last();
    s.frame(welcome(10));
    s.frame(`{"type":"alert","pad":"${"x".repeat(70 * 1024)}"}`);
    s.frame("{not json");
    s.frame("[1,2,3]");
    s.frame({ type: "mystery", body: 1 });
    s.raw(new TextEncoder().encode(JSON.stringify(alert(1, T0))).buffer);
    s.raw(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
    s.raw({ some: "object" });
    s.raw(new Uint8Array(STREAM_DEFAULTS.maxFrameBytes + 1));
    await settle();
    assert.deepEqual(
      h.dead.map((d) => d.error.split(":")[0]),
      ["frame-too-large", "invalid-json", "missing-type", "unknown-frame-type", "invalid-utf8", "unsupported-frame-encoding", "frame-too-large"],
    );
    for (const d of h.dead) assert.ok(d.payload.length <= STREAM_DEFAULTS.deadLetterPayloadMax);
    assert.equal(h.frames.length, 1, "only the valid binary alert was delivered");
    assert.equal(h.frames[0]?.frame.ts, T0);
    assert.equal(h.stream.stats().deadLetters, 7);
    h.stream.stop();
  });

  it("delivers data frames in order with the replay flag and the receive time", async () => {
    const h = harness();
    h.stream.start();
    const s = h.last();
    s.frame(welcome(10));
    s.frame(alert(1, T0 - 60_000, { replay: true }));
    await h.time.advance(250);
    s.frame(alert(2, T0));
    s.frame({ type: "retract", id: "x1" });
    await settle();
    assert.deepEqual(
      h.frames.map((f) => [f.frame.type, f.meta.replay]),
      [
        ["alert", true],
        ["alert", false],
        ["retract", false],
      ],
    );
    assert.equal(h.frames[1]?.meta.receivedAt, T0 + 250);
    assert.equal(h.stream.stats().replayFrames, 1);
    h.stream.stop();
  });

  it("reads event time from ts or blockTs and scales seconds", () => {
    assert.equal(frameTimeMs({ ts: T0 }), T0);
    assert.equal(frameTimeMs({ blockTs: T0 }), T0);
    assert.equal(frameTimeMs({ ts: T0 / 1000 }), T0);
    assert.equal(frameTimeMs({ ts: "soon" }), null);
    assert.equal(frameTimeMs({}), null);
  });
});

describe("runtime subscription", () => {
  it("is sent after welcome, again after every reconnect, and can be changed live", async () => {
    const h = harness({ subscription: { chain: "robinhood" } });
    h.stream.start();
    const a = h.last();
    a.open();
    assert.deepEqual(a.sent, [], "nothing is sent before the protocol is proven");
    a.frame(welcome(10));
    assert.deepEqual(a.sent.map((m) => JSON.parse(m)), [{ chain: "robinhood", action: "subscribe" }]);
    a.frame({ type: "subscribed", filter: { chain: "robinhood" } });
    assert.deepEqual(h.stream.stats().filter, { chain: "robinhood" });

    assert.equal(h.stream.subscribe({ chain: "robinhood", type: "thesis" }), true);
    assert.deepEqual(JSON.parse(a.sent[1] ?? "{}"), { chain: "robinhood", type: "thesis", action: "subscribe" });

    a.serverClose();
    await h.reconnect();
    const b = h.last();
    assert.notEqual(a, b);
    b.frame(welcome(10));
    assert.deepEqual(JSON.parse(b.sent[0] ?? "{}"), { chain: "robinhood", type: "thesis", action: "subscribe" });

    h.stream.subscribe(null);
    assert.deepEqual(JSON.parse(b.sent[1] ?? "{}"), { action: "unsubscribe" });
    h.stream.stop();
  });

  it("emits open once per connection with what welcome said, and a fresh connection id each time", async () => {
    const h = harness();
    h.stream.start();
    h.last().frame(welcome(15, { realtime: false, delaySeconds: 15 }));
    h.last().frame(welcome(15));
    const opens = h.states.filter((s) => s.state === "open");
    assert.equal(opens.length, 1);
    assert.equal(opens[0]?.detail.realtime, false);
    assert.equal(opens[0]?.detail.delaySeconds, 15);
    assert.equal(opens[0]?.detail.heartbeatSeconds, 15);
    h.last().serverClose();
    await h.reconnect();
    h.last().frame(welcome(15));
    const ids = h.states.filter((s) => s.state === "open").map((s) => s.detail.connection);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
    h.stream.stop();
  });
});

describe("backpressure", () => {
  it("stops accepting when the queue is full, closes, emits a gap from the last processed event, and reconnects only after draining", async () => {
    const releases: Array<() => void> = [];
    const delivered: number[] = [];
    const h = harness({
      maxQueue: 3,
      onFrame: (frame) => {
        delivered.push(frame.ts as number);
        return new Promise<void>((r) => releases.push(r));
      },
    });
    h.stream.start();
    const s = h.last();
    const ts = (n: number) => T0 - 100_000 + n * 5_000;
    s.frame(welcome(10));
    s.frame(alert(1, ts(1)));
    await settle();
    releases.shift()?.(); // frame 1 fully processed
    await settle();
    s.frame(alert(2, ts(2))); // in flight, blocked
    await settle();
    s.frame(alert(3, ts(3)));
    s.frame(alert(4, ts(4)));
    s.frame(alert(5, ts(5))); // queue now holds 3, 4, 5
    await h.time.advance(1_000);
    const handler = s.onmessage;
    s.frame(alert(6, ts(6))); // does not fit

    assert.equal(h.gaps.length, 1);
    assert.deepEqual(h.gaps[0], { fromMs: ts(1), toMs: T0 + 1_000, reason: "stream-backpressure" });
    assert.deepEqual(s.closed, { code: 4001, reason: "backpressure" });
    assert.equal(h.backoffs().at(-1)?.reason, "backpressure");
    // The abandoned socket is deaf even if its old handler is still called.
    handler?.({ data: JSON.stringify(alert(7, ts(7))) });

    const delay = h.backoffs().at(-1)?.delayMs ?? 0;
    await h.time.advance(delay + 10_000);
    assert.equal(h.sockets.length, 1, "no reconnect into a full queue");
    assert.equal(h.stream.stats().queueDepth, 3);

    while (releases.length > 0 || h.stream.stats().queueDepth > 0) {
      releases.shift()?.();
      await settle();
    }
    await h.stream.drained();
    assert.equal(h.sockets.length, 2, "reconnected once drained");
    assert.deepEqual(delivered, [ts(1), ts(2), ts(3), ts(4), ts(5)], "every accepted frame was delivered; the rest is the gap");
    assert.equal(h.stream.stats().lastProcessedEventAt, ts(5));
    h.stream.stop();
  });

  it("dead-letters a frame whose handler throws and keeps going", async () => {
    let n = 0;
    const h = harness({
      onFrame: () => {
        n++;
        if (n === 1) throw new Error(`db down for ${SECRET_URL}`);
      },
    });
    h.stream.start();
    h.last().frame(welcome(10));
    h.last().frame(alert(1, T0));
    h.last().frame(alert(2, T0));
    await settle();
    assert.equal(n, 2);
    assert.equal(h.dead.length, 1);
    assert.match(h.dead[0]?.error ?? "", /^handler-failed/);
    assert.ok(!(h.dead[0]?.error ?? "").includes(SECRET_KEY));
    h.stream.stop();
  });
});

describe("secrecy and shutdown", () => {
  it("never lets the credential-bearing URL or its key reach a state, dead letter, gap or stats", async () => {
    let calls = 0;
    const made: FakeSocket[] = [];
    const h = harness({
      createSocket: (url) => {
        calls++;
        if (calls === 1) throw new TypeError(`Invalid URL: ${url}`);
        const s = new FakeSocket(url);
        made.push(s);
        return s;
      },
    });
    h.stream.start();
    assert.match(h.backoffs()[0]?.reason ?? "", /^connect-failed: TypeError: Invalid URL: \[redacted\]/);
    await h.reconnect();
    const s = made[0];
    assert.ok(s);
    assert.equal(s.url, SECRET_URL, "the socket itself gets the real URL");
    s.frame(welcome(10, { filter: { chain: "robinhood", key: SECRET_KEY, note: `echo ${SECRET_URL}` } }));
    s.frame(`{"type":"alert","oops":"${SECRET_URL}`);
    s.frame(`${"y".repeat(1_000)}${SECRET_KEY}`);
    s.frame({ type: "nope", key: SECRET_KEY });
    s.serverClose(1008, `bad key ${SECRET_KEY}`);
    await h.reconnect();
    h.stream.stop(`stopping ${SECRET_URL}`);

    const everything = JSON.stringify({ states: h.states, dead: h.dead, gaps: h.gaps, stats: h.stream.stats() });
    assert.ok(!everything.includes(SECRET_KEY), "key never emitted");
    assert.ok(!everything.includes("sk_live"), "not even a fragment of it");
    assert.ok(h.states.every((x) => x.detail.endpoint === REDACTED));
    assert.ok(h.dead.length >= 3);
    const closed = h.backoffs().find((b) => b.code === 1008);
    assert.ok(closed, "the policy close is reported with its code");
  });

  it("refuses a redaction label that still carries the key", () => {
    const h = harness({ endpoint: { url: SECRET_URL, redacted: SECRET_URL } });
    h.stream.start();
    assert.equal(h.states[0]?.detail.endpoint, "[redacted endpoint]");
    h.stream.stop();
  });

  it("stop closes with 1000, cancels the pending reconnect and reports stopped", async () => {
    const h = harness();
    h.stream.start();
    h.last().frame(welcome(10));
    const s = h.last();
    h.stream.stop();
    assert.deepEqual(s.closed, { code: 1000, reason: "shutdown" });
    assert.equal(h.states.at(-1)?.state, "stopped");
    await h.time.advance(10 * 60_000);
    assert.equal(h.sockets.length, 1, "no reconnect after stop");

    const h3 = harness();
    h3.stream.start();
    h3.last().serverClose();
    h3.stream.stop();
    await h3.time.advance(10 * 60_000);
    assert.equal(h3.sockets.length, 1, "a scheduled reconnect is cancelled");
  });

  it("treats a socket error as a dead connection without waiting for close", async () => {
    const h = harness();
    h.stream.start();
    const s = h.last();
    s.frame(welcome(10));
    s.onerror?.({});
    assert.equal(s.closed?.code, 4002);
    s.serverClose(1006, "late close"); // ignored: already abandoned
    assert.equal(h.backoffs().length, 1);
    await h.reconnect();
    assert.equal(h.sockets.length, 2);
    h.stream.stop();
  });
});
