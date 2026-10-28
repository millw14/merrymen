/**
 * THE SHARED STREAM CONNECTION — one socket to the provider's realtime feed
 * per fleet, and the only code that holds it open.
 *
 * A socket that connects once is a demo. This one has to outlive quiet
 * filters, server restarts, network changes, replayed events, malformed
 * frames and a slow database, without ever losing control of its retry rate
 * and without ever losing an event quietly. Everything it cannot deliver is
 * either dead-lettered (a frame we could not read) or reported as a coverage
 * gap (a stretch of time we did not read at all) so the ingestor can recover
 * it over REST. Nothing is dropped without one of those two receipts.
 *
 * LIVENESS IS THE APPLICATION HEARTBEAT, NOT THE LAST ALERT. A Robinhood-only
 * subscription can be quiet for a long time on a perfectly healthy socket, and
 * the transport-level ping/pong is invisible to WebSocket application code.
 * The provider sends a JSON `heartbeat` on the interval it announces in
 * `welcome`; silence for 2.5 of those intervals means the connection is dead
 * even if the TCP session says otherwise, so we close it ourselves rather than
 * wait for a close event that may never come.
 *
 * BACKOFF RESETS ON A HEALTHY CONNECTION, NOT ON A CONNECTED ONE. Resetting
 * when the TCP handshake completes (or even on `welcome`) turns a server that
 * accepts and immediately drops into a tight reconnect loop at the base
 * delay. The attempt counter only returns to zero after a connection has
 * delivered `welcome` and then stayed up, heartbeats flowing, for
 * `healthyAfterMs`. Full jitter (uniform over [0, ceiling)) keeps a fleet of
 * restarts from reconnecting in lockstep.
 *
 * BACKPRESSURE NEVER DROPS SILENTLY. Frames are handed to the consumer in
 * order through a bounded queue. When the consumer (persistence) falls so far
 * behind that the queue is full, the next frame is NOT queued: the socket is
 * closed, a gap from the last processed event time to now is emitted for REST
 * recovery, and the reconnect waits until the queue has drained. Dropping the
 * newest frame and carrying on would be the silent loss this module exists to
 * prevent; dropping the oldest would be worse, because those were accepted.
 *
 * THE URL IS A SECRET. Browser-compatible WebSocket clients cannot set an
 * Authorization header, so the provider takes the key in the query string,
 * which makes the whole URL a credential. The caller hands us both the real
 * URL and a redacted label; only the label ever appears in a state detail.
 * Close reasons, error messages and dead-letter payloads are untrusted text
 * that could echo the URL back, so every one of them is scrubbed of the URL
 * and of every credential-looking query value before it leaves this module.
 *
 * CLIENT-SIDE COHORT FILTERING. The provider's runtime `subscribe` takes one
 * value per filter (one trader, one chain). A 150-trader cohort cannot be
 * expressed that way, so the fleet subscribes by CHAIN and the ingestor
 * filters traders itself (ingest.ts). This module only carries the message.
 */

import { sanitizeText } from "../research/news";

// ── Ports ─────────────────────────────────────────────────────────────────

export type StreamState = "connecting" | "open" | "backoff" | "stopped";

/**
 * Handler slots are declared through a method signature so they compare
 * bivariantly: the platform's `(ev: MessageEvent) => any` must fit a slot we
 * only ever fill with our own handler.
 */
type Handler<E> = { bivarianceHack(ev: E): void }["bivarianceHack"];

/**
 * The subset of the WebSocket API this module uses. Node 22's global
 * `WebSocket` satisfies it (see stream.test.ts); tests use a fake.
 */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: Handler<unknown> | null;
  onmessage: Handler<{ data: unknown }> | null;
  onclose: Handler<{ code: number; reason: string }> | null;
  onerror: Handler<unknown> | null;
}

export interface ClockPort {
  now(): number;
}

export interface TimerPort {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real timers, for production wiring. Tests inject a manual clock instead. */
export const SYSTEM_TIMERS: TimerPort = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** The credential-bearing URL and the only form of it that may be shown. */
export interface StreamEndpoint {
  url: string;
  redacted: string;
}

/** A runtime filter, sent as `{"action":"subscribe", ...filter}`. */
export type StreamFilter = Readonly<Record<string, string | number | boolean>>;

/** A parsed data frame (`alert`, `trade` or `retract`). Untrusted; the ingestor normalises it. */
export type StreamFrame = Readonly<Record<string, unknown>> & { readonly type: string };

export interface StreamFrameMeta {
  /** The provider marked this frame as a replay of recent history on (re)connect or subscribe. */
  replay: boolean;
  /** Our clock when the frame arrived, before any queueing. */
  receivedAt: number;
}

export interface StreamGap {
  fromMs: number;
  toMs: number;
  reason: string;
}

export interface StreamDeadLetter {
  /** Scrubbed and truncated; never the full frame and never the URL. */
  payload: string;
  error: string;
}

export interface StreamStateDetail {
  /** The redacted endpoint label. The real URL never appears here. */
  endpoint: string;
  /** Increments per socket; lets a consumer run reconnect work once per connection. */
  connection: number;
  /** Reconnect attempts since the last healthy connection. */
  attempt: number;
  reason?: string;
  code?: number;
  delayMs?: number;
  realtime?: boolean | null;
  delaySeconds?: number | null;
  heartbeatSeconds?: number;
  filter?: Record<string, string | number | boolean | null> | null;
}

export interface AlertStreamOptions {
  endpoint: StreamEndpoint;
  createSocket: (url: string) => SocketLike;
  clock: ClockPort;
  timers: TimerPort;
  /** Uniform [0, 1). Injected so jitter is testable. */
  random: () => number;
  /** Sent after every `welcome`. Null sends nothing (the URL's own filter applies). */
  subscription?: StreamFilter | null;
  maxQueue?: number;
  maxFrameBytes?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  healthyAfterMs?: number;
  /** Assumed until `welcome` says otherwise. */
  defaultHeartbeatSeconds?: number;
  onFrame: (frame: StreamFrame, meta: StreamFrameMeta) => void | Promise<void>;
  onGap: (gap: StreamGap) => void | Promise<void>;
  onDeadLetter: (dl: StreamDeadLetter) => void | Promise<void>;
  onState: (state: StreamState, detail: StreamStateDetail) => void;
}

export interface AlertStreamStats {
  state: StreamState;
  /** True between a `welcome` and the end of that socket. */
  connected: boolean;
  connection: number;
  attempt: number;
  lastFrameAt: number | null;
  lastWelcomeAt: number | null;
  heartbeatSeconds: number;
  realtime: boolean | null;
  delaySeconds: number | null;
  filter: Record<string, string | number | boolean | null> | null;
  queueDepth: number;
  oldestQueuedAt: number | null;
  lastProcessedEventAt: number | null;
  framesReceived: number;
  dataFrames: number;
  replayFrames: number;
  processed: number;
  deadLetters: number;
  gaps: number;
  reconnects: number;
  /** Provider-reported fields from the latest heartbeat, display only. */
  providerLastEventAt: number | null;
  providerBuffered: number | null;
}

export const STREAM_DEFAULTS = {
  maxQueue: 5000,
  maxFrameBytes: 64 * 1024,
  backoffBaseMs: 1_000,
  backoffCapMs: 60_000,
  healthyAfterMs: 30_000,
  defaultHeartbeatSeconds: 20,
  /** Silence tolerated, in heartbeat intervals, before the socket is declared dead. */
  heartbeatGrace: 2.5,
  deadLetterPayloadMax: 1_024,
} as const;

/** Frame types that carry data for the ingestor. Everything else is control. */
const DATA_TYPES: ReadonlySet<string> = new Set(["alert", "trade", "retract"]);

/** Query parameters whose values are credentials, not filters. `token` is a filter here. */
const SECRET_PARAM = /^(key|api[-_]?key|access[-_]?token|auth|authorization|secret|password)$/i;

/** Application close codes (the WebSocket API only lets clients send 1000 or 3000–4999). */
const CLOSE = { shutdown: 1000, heartbeat: 4000, backpressure: 4001, socketError: 4002 } as const;

// ── Pure helpers ──────────────────────────────────────────────────────────

/**
 * Exponential backoff with FULL jitter: uniform over [0, min(cap, base·2^attempt)).
 * `attempt` 0 is the first reconnect.
 */
export function backoffDelayMs(attempt: number, random: () => number, baseMs: number = STREAM_DEFAULTS.backoffBaseMs, capMs: number = STREAM_DEFAULTS.backoffCapMs): number {
  const a = Number.isSafeInteger(attempt) && attempt > 0 ? Math.min(attempt, 30) : 0;
  const ceiling = Math.min(capMs, baseMs * 2 ** a);
  const r = random();
  const unit = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1 - Number.EPSILON) : 0.5;
  return Math.floor(unit * ceiling);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The event time a data frame carries, in ms. `/ws/alerts` sends `ts`, the
 * on-chain stream `blockTs`. A value that looks like seconds is scaled.
 */
export function frameTimeMs(frame: Readonly<Record<string, unknown>>): number | null {
  const raw = finiteNumber(frame.ts) ?? finiteNumber(frame.blockTs);
  if (raw === null || raw <= 0) return null;
  if (raw < 1e12) return raw >= 1e9 ? Math.round(raw * 1000) : null;
  return raw;
}

/** A short, sanitised summary of a filter object the server echoed. Display only. */
function summarizeFilter(raw: unknown, scrub: (s: string) => string): Record<string, string | number | boolean | null> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, string | number | boolean | null> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= 8) break;
    const key = sanitizeText(k, 32);
    if (!key) continue;
    if (SECRET_PARAM.test(key)) continue;
    if (typeof v === "string") out[key] = sanitizeText(scrub(v), 64);
    else if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    else if (typeof v === "boolean") out[key] = v;
    else if (v === null) out[key] = null;
    else continue;
    n++;
  }
  return out;
}

function errText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return typeof err === "string" ? err : "unknown error";
}

/** Every string worth scrubbing out of anything we emit: the URL in its forms and its credential values. */
function secretsOf(url: string): string[] {
  const out = new Set<string>([url]);
  try {
    const u = new URL(url);
    out.add(u.href);
    out.add(u.search);
    for (const [k, v] of u.searchParams) {
      if (!SECRET_PARAM.test(k)) continue;
      out.add(v);
      out.add(encodeURIComponent(v));
    }
    if (u.password) out.add(u.password);
  } catch {
    // An unparsable URL is still scrubbed as a raw string.
  }
  // Longest first, so a full URL is replaced before the key inside it.
  return [...out].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
}

// ── The client ────────────────────────────────────────────────────────────

interface QueueItem {
  frame: StreamFrame;
  meta: StreamFrameMeta;
}

type Resolved = {
  maxQueue: number;
  maxFrameBytes: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  healthyAfterMs: number;
  defaultHeartbeatSeconds: number;
};

export class AlertStream {
  private readonly o: AlertStreamOptions;
  private readonly cfg: Resolved;
  private readonly url: string;
  private readonly redacted: string;
  private readonly secrets: string[];
  private readonly lowWater: number;

  private state: StreamState = "stopped";
  private running = false;
  private socket: SocketLike | null = null;
  /** Bumped whenever a socket is abandoned; handlers of an older socket compare and go quiet. */
  private gen = 0;
  private attempt = 0;
  private connected = false;
  private openedAt: number | null = null;
  private reconnectTimer: unknown = null;
  private watchdogTimer: unknown = null;
  private healthyTimer: unknown = null;
  /** The reconnect timer fired while the queue was still too full; connect once it drains. */
  private awaitingDrain = false;
  private subscription: StreamFilter | null;

  private queue: Array<QueueItem | undefined> = [];
  private head = 0;
  private draining = false;
  private drainWaiters: Array<() => void> = [];

  private heartbeatSeconds: number;
  private realtime: boolean | null = null;
  private delaySeconds: number | null = null;
  private filter: Record<string, string | number | boolean | null> | null = null;
  private lastFrameAt: number | null = null;
  private lastWelcomeAt: number | null = null;
  private lastProcessedEventAt: number | null = null;
  private providerLastEventAt: number | null = null;
  private providerBuffered: number | null = null;
  private counts = { framesReceived: 0, dataFrames: 0, replayFrames: 0, processed: 0, deadLetters: 0, gaps: 0, reconnects: 0 };

  constructor(options: AlertStreamOptions) {
    this.o = options;
    const pos = (v: number | undefined, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
    this.cfg = {
      maxQueue: Math.floor(pos(options.maxQueue, STREAM_DEFAULTS.maxQueue)),
      maxFrameBytes: Math.floor(pos(options.maxFrameBytes, STREAM_DEFAULTS.maxFrameBytes)),
      backoffBaseMs: pos(options.backoffBaseMs, STREAM_DEFAULTS.backoffBaseMs),
      backoffCapMs: pos(options.backoffCapMs, STREAM_DEFAULTS.backoffCapMs),
      healthyAfterMs: pos(options.healthyAfterMs, STREAM_DEFAULTS.healthyAfterMs),
      defaultHeartbeatSeconds: pos(options.defaultHeartbeatSeconds, STREAM_DEFAULTS.defaultHeartbeatSeconds),
    };
    this.lowWater = Math.floor(this.cfg.maxQueue / 4);
    this.url = options.endpoint.url;
    this.secrets = secretsOf(this.url);
    // A label that itself carries the credential is not a redaction.
    const label = sanitizeText(options.endpoint.redacted, 200);
    this.redacted = label && !this.secrets.some((s) => label.includes(s)) ? label : "[redacted endpoint]";
    this.heartbeatSeconds = this.cfg.defaultHeartbeatSeconds;
    this.subscription = options.subscription ?? null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(reason = "stopped"): void {
    if (!this.running && this.state === "stopped") return;
    this.running = false;
    this.awaitingDrain = false;
    this.clear("reconnectTimer");
    const s = this.socket;
    this.detach();
    if (s) {
      try {
        s.close(CLOSE.shutdown, "shutdown");
      } catch {
        // Already closed; nothing to do.
      }
    }
    this.setState("stopped", { reason: this.scrub(reason) });
  }

  /**
   * Change the runtime filter. Remembered and re-sent after every reconnect;
   * sent now when connected. Null asks the server to drop its runtime filter.
   */
  subscribe(filter: StreamFilter | null): boolean {
    this.subscription = filter;
    if (!this.connected) return false;
    return this.sendSubscription(filter === null);
  }

  /** Resolves once every queued frame has been handed to `onFrame`. */
  drained(): Promise<void> {
    if (!this.draining && this.queueLength() === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  stats(): AlertStreamStats {
    const oldest = this.queue[this.head];
    return {
      state: this.state,
      connected: this.connected,
      connection: this.gen,
      attempt: this.attempt,
      lastFrameAt: this.lastFrameAt,
      lastWelcomeAt: this.lastWelcomeAt,
      heartbeatSeconds: this.heartbeatSeconds,
      realtime: this.realtime,
      delaySeconds: this.delaySeconds,
      filter: this.filter,
      queueDepth: this.queueLength(),
      oldestQueuedAt: oldest ? oldest.meta.receivedAt : null,
      lastProcessedEventAt: this.lastProcessedEventAt,
      ...this.counts,
      providerLastEventAt: this.providerLastEventAt,
      providerBuffered: this.providerBuffered,
    };
  }

  // ── Connection lifecycle ───────────────────────────────────────────────

  private connect(): void {
    if (!this.running) return;
    this.clear("reconnectTimer");
    this.awaitingDrain = false;
    const gen = ++this.gen;
    this.connected = false;
    this.openedAt = null;
    this.setState("connecting", {});
    let socket: SocketLike;
    try {
      socket = this.o.createSocket(this.url);
    } catch (err) {
      // The error text from a URL parser typically quotes the URL. Scrubbed.
      this.scheduleReconnect("connect-failed", undefined, errText(err));
      return;
    }
    this.socket = socket;
    if ("binaryType" in socket) {
      try {
        (socket as { binaryType?: string }).binaryType = "arraybuffer";
      } catch {
        // Not settable on this implementation; Blob frames are dead-lettered.
      }
    }
    socket.onopen = () => {
      if (gen === this.gen) this.openedAt = this.o.clock.now();
    };
    socket.onmessage = (ev) => {
      if (gen === this.gen) this.receive(ev ? ev.data : undefined);
    };
    socket.onclose = (ev) => {
      if (gen !== this.gen) return;
      this.detach();
      const code = ev && typeof ev.code === "number" ? ev.code : undefined;
      const reason = ev && typeof ev.reason === "string" ? ev.reason : "";
      this.scheduleReconnect("closed", code, reason);
    };
    socket.onerror = () => {
      if (gen === this.gen) this.drop("socket-error", CLOSE.socketError);
    };
    // Armed before the handshake completes, so a connect that hangs is also caught.
    this.armWatchdog();
  }

  /** Abandon the current socket: older handlers go quiet, timers stop. */
  private detach(): void {
    const s = this.socket;
    this.gen++;
    if (s) {
      s.onopen = null;
      s.onmessage = null;
      s.onclose = null;
      s.onerror = null;
    }
    this.socket = null;
    this.connected = false;
    this.clear("watchdogTimer");
    this.clear("healthyTimer");
  }

  /** Close the socket from our side and reconnect, without waiting for a close event that may never arrive. */
  private drop(reason: string, code: number): void {
    const s = this.socket;
    this.detach();
    if (s) {
      try {
        s.close(code, reason);
      } catch {
        // A socket that cannot be closed is already gone.
      }
    }
    this.scheduleReconnect(reason, code);
  }

  private scheduleReconnect(reason: string, code?: number, message?: string): void {
    if (!this.running || this.reconnectTimer !== null) return;
    const delayMs = backoffDelayMs(this.attempt, this.o.random, this.cfg.backoffBaseMs, this.cfg.backoffCapMs);
    this.attempt++;
    this.counts.reconnects++;
    const detail: Partial<StreamStateDetail> = { reason: this.scrub(reason), delayMs };
    if (code !== undefined) detail.code = code;
    if (message) detail.reason = `${detail.reason}: ${sanitizeText(this.scrub(message), 160)}`;
    this.setState("backoff", detail);
    this.reconnectTimer = this.o.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      // Reconnecting into a queue that is still full would overflow again on
      // the replay alone. Wait for persistence to catch up first.
      if (this.queueLength() > this.lowWater) {
        this.awaitingDrain = true;
        return;
      }
      this.connect();
    }, delayMs);
  }

  private armWatchdog(): void {
    this.clear("watchdogTimer");
    const gen = this.gen;
    const ms = Math.round(this.heartbeatSeconds * 1000 * STREAM_DEFAULTS.heartbeatGrace);
    this.watchdogTimer = this.o.timers.setTimeout(() => {
      this.watchdogTimer = null;
      if (gen === this.gen && this.running) this.drop("heartbeat-timeout", CLOSE.heartbeat);
    }, ms);
  }

  private armHealthy(): void {
    this.clear("healthyTimer");
    const gen = this.gen;
    this.healthyTimer = this.o.timers.setTimeout(() => {
      this.healthyTimer = null;
      if (gen === this.gen && this.connected) this.attempt = 0;
    }, this.cfg.healthyAfterMs);
  }

  private clear(which: "reconnectTimer" | "watchdogTimer" | "healthyTimer"): void {
    const h = this[which];
    if (h !== null) this.o.timers.clearTimeout(h);
    this[which] = null;
  }

  // ── Frames ─────────────────────────────────────────────────────────────

  private receive(data: unknown): void {
    const receivedAt = this.o.clock.now();
    this.counts.framesReceived++;
    const max = this.cfg.maxFrameBytes;
    let text: string;
    if (typeof data === "string") {
      // UTF-8 is at least one byte per UTF-16 unit, so the cheap length check is a safe pre-filter.
      if (data.length > max || Buffer.byteLength(data, "utf8") > max) {
        this.deadLetter(data, `frame-too-large: over ${max} bytes`);
        return;
      }
      text = data;
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (bytes.byteLength > max) {
        this.deadLetter(new TextDecoder().decode(bytes.subarray(0, 2 * STREAM_DEFAULTS.deadLetterPayloadMax)), `frame-too-large: over ${max} bytes`);
        return;
      }
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        this.deadLetter("", "invalid-utf8");
        return;
      }
    } else {
      this.deadLetter("", "unsupported-frame-encoding");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.deadLetter(text, "invalid-json");
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      this.deadLetter(text, "missing-type");
      return;
    }

    // Only a well-formed application frame proves the connection is alive.
    this.lastFrameAt = receivedAt;
    const type = parsed.type;
    if (type === "welcome") {
      this.onWelcome(parsed, receivedAt);
      return;
    }
    this.armWatchdog();
    if (type === "heartbeat") {
      this.providerLastEventAt = finiteNumber(parsed.lastEventAt);
      this.providerBuffered = finiteNumber(parsed.buffered);
      return;
    }
    if (type === "subscribed") {
      this.filter = summarizeFilter(parsed.filter, (s) => this.scrub(s));
      return;
    }
    if (DATA_TYPES.has(type)) {
      this.enqueue(parsed as StreamFrame, { replay: parsed.replay === true, receivedAt });
      return;
    }
    this.deadLetter(text, `unknown-frame-type: ${sanitizeText(type, 32)}`);
  }

  private onWelcome(f: Record<string, unknown>, receivedAt: number): void {
    const hb = finiteNumber(f.heartbeatSeconds);
    this.heartbeatSeconds = hb !== null && hb >= 1 && hb <= 600 ? hb : this.cfg.defaultHeartbeatSeconds;
    this.realtime = typeof f.realtime === "boolean" ? f.realtime : null;
    const d = finiteNumber(f.delaySeconds);
    this.delaySeconds = d !== null && d >= 0 ? d : null;
    this.filter = summarizeFilter(f.filter, (s) => this.scrub(s));
    this.lastWelcomeAt = receivedAt;
    if (this.openedAt === null) this.openedAt = receivedAt;
    const firstWelcome = !this.connected;
    this.connected = true;
    this.armWatchdog();
    if (!firstWelcome) return;
    this.armHealthy();
    if (this.subscription) this.sendSubscription(false);
    this.setState("open", {
      realtime: this.realtime,
      delaySeconds: this.delaySeconds,
      heartbeatSeconds: this.heartbeatSeconds,
      filter: this.filter,
    });
  }

  private sendSubscription(unsubscribe: boolean): boolean {
    const s = this.socket;
    if (!s) return false;
    const msg = unsubscribe || !this.subscription ? { action: "unsubscribe" } : { ...this.subscription, action: "subscribe" };
    try {
      s.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      this.deadLetter("", `subscribe-send-failed: ${errText(err)}`);
      return false;
    }
  }

  // ── Queue and backpressure ─────────────────────────────────────────────

  private queueLength(): number {
    return this.queue.length - this.head;
  }

  private enqueue(frame: StreamFrame, meta: StreamFrameMeta): void {
    if (this.queueLength() >= this.cfg.maxQueue) {
      this.overflow(frame, meta.receivedAt);
      return;
    }
    this.queue.push({ frame, meta });
    this.counts.dataFrames++;
    if (meta.replay) this.counts.replayFrames++;
    void this.drain();
  }

  private overflow(rejected: StreamFrame, now: number): void {
    const oldest = this.queue[this.head];
    const from =
      this.lastProcessedEventAt ??
      (oldest ? frameTimeMs(oldest.frame) ?? oldest.meta.receivedAt : null) ??
      frameTimeMs(rejected) ??
      this.openedAt ??
      now;
    this.emitGap({ fromMs: Math.min(from, now), toMs: now, reason: "stream-backpressure" });
    this.drop("backpressure", CLOSE.backpressure);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.head < this.queue.length) {
        const item = this.queue[this.head];
        this.queue[this.head] = undefined;
        this.head++;
        if (this.head > 1024 && this.head * 2 >= this.queue.length) {
          this.queue = this.queue.slice(this.head);
          this.head = 0;
        }
        if (!item) continue;
        try {
          await this.o.onFrame(item.frame, item.meta);
          this.counts.processed++;
          const ts = frameTimeMs(item.frame);
          if (ts !== null) this.lastProcessedEventAt = ts;
        } catch (err) {
          let payload = "";
          try {
            payload = JSON.stringify(item.frame);
          } catch {
            payload = "";
          }
          this.deadLetter(payload, `handler-failed: ${errText(err)}`);
        }
        if (this.awaitingDrain && this.running && this.queueLength() <= this.lowWater) this.connect();
      }
    } finally {
      this.draining = false;
      if (this.awaitingDrain && this.running) this.connect();
      const waiters = this.drainWaiters;
      this.drainWaiters = [];
      for (const w of waiters) w();
    }
  }

  // ── Outputs ────────────────────────────────────────────────────────────

  private scrub(s: string): string {
    let out = s;
    for (const secret of this.secrets) if (out.includes(secret)) out = out.split(secret).join("[redacted]");
    return out;
  }

  private deadLetter(raw: string, error: string): void {
    this.counts.deadLetters++;
    const max = STREAM_DEFAULTS.deadLetterPayloadMax;
    // Scrub BEFORE truncating: cutting first could leave half a key that no longer matches.
    const longest = this.secrets[0]?.length ?? 0;
    const payload = sanitizeText(this.scrub(raw.slice(0, max + longest + 16)), max);
    const dl: StreamDeadLetter = { payload, error: sanitizeText(this.scrub(error), 200) };
    try {
      const r = this.o.onDeadLetter(dl);
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => undefined);
    } catch {
      // A failing dead-letter sink must not take the stream down.
    }
  }

  private emitGap(gap: StreamGap): void {
    this.counts.gaps++;
    try {
      const r = this.o.onGap(gap);
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => undefined);
    } catch {
      // Reported in stats().gaps either way.
    }
  }

  private setState(state: StreamState, extra: Partial<StreamStateDetail>): void {
    this.state = state;
    const detail: StreamStateDetail = { endpoint: this.redacted, connection: this.gen, attempt: this.attempt, ...extra };
    try {
      this.o.onState(state, detail);
    } catch {
      // Observers do not get to break the connection.
    }
  }
}
