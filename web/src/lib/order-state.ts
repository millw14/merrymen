/**
 * WHAT BECAME OF AN ORDER, AND WHO HOLDS THE SLOT — from the order's own clock.
 *
 * Split out of api/orders/route.ts so the rules can be executed by a test across
 * the deadline — the route imports the settings and command-file modules, which
 * the test runner cannot resolve. No clock of its own, and no import the
 * browser cannot load: the card (terminal/order-follow.ts) reads the grace from
 * here. The database arrives as a parameter shaped like the ledger's driver, so
 * a test hands it an in-memory sqlite and runs the very statements the route
 * runs.
 *
 * "expired" is the one answer here that tells an owner NOTHING WAS SENT, so it
 * is said only when that is certain: the order was never claimed, and it is
 * past its own `expiresAt` plus the grace the route holds the one-at-a-time
 * slot for. Every other late state stays what it is — a claimed order is the
 * worker's to answer, however long it takes, because it may still fill.
 *
 * ONE DEADLINE FOR ALL THREE READERS. The slot, this answer and the
 * orchestrator's stale sweep each read the row's own `expiresAt`. The slot used
 * to read `now - ttlMs` from whichever request was asking, so after the tenant
 * changed its tick the slot and GET disagreed about the same row — and a
 * second order was admitted beside one GET still called queued.
 */
// Browser-safe: chat-commands.ts, which the card bundles, imports it too.
import { MERRYMEN_TOKEN } from "@merrymen/core";

/**
 * How long after its expiry an UNCLAIMED row may still hold the one-at-a-time
 * slot, and how long GET waits before calling it expired.
 *
 * The expiry is enforced in the CHILD, at the claim, so a row can legitimately
 * be a ferry pass and a tick behind its own deadline while it is genuinely
 * being decided. Past that it either answered or never will.
 *
 * The orchestrator's ORDER_GRACE_MS is the same figure, stated there because
 * the two processes share no module: the ferry must not close a row before the
 * route would free its slot, or a second order is admitted beside a live one.
 */
export const ORDER_STALE_GRACE_MS = 2 * 60_000;

/**
 * How long past deadline AND grace a CLAIMED row goes on holding the slot.
 *
 * A claimed order may be waiting on its receipt well after its deadline — the
 * deadline bounds when the order STARTS (the worker refuses a late claim, and
 * refuses an order its intent queue reaches late), not when it finishes. So
 * the slot is released only once the order's own run cannot still be filling
 * it; freeing it earlier is "ask again" with the first order on chain. The
 * orchestrator's sweep closes such a row at the same moment, with a sentence
 * that does not claim to know.
 * Stated again in worker/src/command-files.ts for that sweep; a test holds the
 * two equal.
 */
export const ORDER_IN_FLIGHT_MS = 10 * 60_000;

/** The shortest an order window may ever be, whatever the tick. */
export const ORDER_TTL_FLOOR_MS = 5 * 60_000;

/**
 * How long an order stays willing to fill, for a given tick.
 *
 * Two ticks plus a ferry pass is the smallest window that survives missing one
 * — the child drains at most ONE command per tick — with the original five
 * minutes as a floor so a fast tick does not make orders expire faster than a
 * person can watch them. The route supplies the CALLER's tick, not the
 * container's.
 */
export function orderTtlMs(tickSeconds: number): number {
  return Math.max(ORDER_TTL_FLOOR_MS, (2 * tickSeconds + 15) * 1000);
}

export type OrderState = "queued" | "running" | "done" | "expired";

/**
 * The deadline an order was placed with, or null when it carries none.
 *
 * NULL IS NOT "ALREADY EXPIRED". The worker's `isExpired` treats a missing
 * `expiresAt` as no expiry at all, so an order without one can still be run —
 * and saying it expired would be telling the owner nothing was sent about an
 * order that may yet fill.
 */
export function orderExpiresAt(args: unknown): number | null {
  let bag: unknown = args;
  if (typeof args === "string") {
    try {
      bag = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (!bag || typeof bag !== "object") return null;
  const v = (bag as { expiresAt?: unknown }).expiresAt;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The one rule, for a table row and a command file alike. */
export function orderStateOf(
  o: { done: boolean; claimed: boolean; expiresAt: number | null },
  nowMs: number,
): OrderState {
  if (o.done) return "done";
  if (o.claimed) return "running";
  if (o.expiresAt !== null && nowMs > o.expiresAt + ORDER_STALE_GRACE_MS) return "expired";
  return "queued";
}

/** An unanswered order, as the one-at-a-time rule reads it. */
export interface SlotHolder {
  claimed: boolean;
  expiresAt: number | null;
  /** Placed (or, for a self-hosted marker, claimed) — used only when there is no deadline. */
  at: number;
}

/**
 * The moment an unanswered order stops holding the owner's slot.
 *
 * UNCLAIMED: at the instant GET first says "expired" — never earlier, or a
 * second order is admitted while the first can still be claimed; never later,
 * or the owner is told to ask again and then refused for asking.
 *
 * CLAIMED: the in-flight bound after that, because a claimed order can still
 * be trading. Not for ever: a child SIGKILLed mid-trade — the watchdog does
 * that in bulk on this fleet — never answers, and a row nothing can finish
 * used to refuse every future order from that owner, for good.
 *
 * NO DEADLINE (legacy rows only; nothing the route writes today) AND NOT YET
 * CLAIMED: never, until it is claimed. The worker's `isExpired` runs such an
 * order whenever it gets to it, and GET calls it queued for as long as it
 * waits, so there is no moment at which it stops being able to fill. It used
 * to let go at the floor window and its grace — the orchestrator's old seven
 * minutes — and admit a second order beside one the worker would still run.
 * Hosted, the ferry ends the wait: it delivers the row, or closes it as never
 * delivered. Self-hosted, the worker's next armed tick does.
 *
 * NO DEADLINE, CLAIMED: the floor window from when it was placed (or, for a
 * marker, claimed), and the in-flight bound after it, as for any claimed order.
 */
export function slotFreesAt(o: SlotHolder): number {
  if (o.expiresAt === null && !o.claimed) return Number.POSITIVE_INFINITY;
  const deadline = o.expiresAt ?? o.at + ORDER_TTL_FLOOR_MS;
  return deadline + ORDER_STALE_GRACE_MS + (o.claimed ? ORDER_IN_FLIGHT_MS : 0);
}

export function holdsSlot(o: SlotHolder, nowMs: number): boolean {
  return nowMs <= slotFreesAt(o);
}

/** What POST answers once the order exists. */
export interface OrderPlaced {
  id: string;
  queued: true;
  expiresAt: number;
  /**
   * How long from THIS RESPONSE until the order's deadline. The card waits on
   * its own clock from this, never on `expiresAt`: that is the server's epoch,
   * and a browser clock ten minutes fast made the card give up before it had
   * asked once.
   */
  expiresInMs: number;
  duplicate?: true;
}

export type PlaceResult =
  | { ok: true; duplicate?: true }
  | { ok: false; why: "in-flight" }
  | { ok: false; why: "unreachable"; detail?: string };

/**
 * The status and body POST sends for a placement's outcome.
 *
 * 200 means one thing only: a row (or file) exists. 409 is the one-at-a-time
 * rule. 503 is a queue that could not be read or written — never reported as
 * "queued", because an owner told their order was placed when no row exists
 * does not ask again.
 */
export function placedResponse(
  r: PlaceResult,
  o: { id: string; expiresAt: number; now: number },
): { status: 200; body: OrderPlaced } | { status: 409 | 503; body: { error: string } } {
  if (r.ok) {
    return {
      status: 200,
      body: {
        id: o.id,
        queued: true,
        expiresAt: o.expiresAt,
        expiresInMs: Math.max(0, o.expiresAt - o.now),
        ...(r.duplicate ? { duplicate: true as const } : {}),
      },
    };
  }
  if (r.why === "in-flight") {
    return { status: 409, body: { error: "you already have an order waiting. Let that one finish first." } };
  }
  return {
    status: 503,
    body: {
      error: r.detail
        ? `couldn't queue it: ${r.detail}`
        : "couldn't queue it — the ledger is unreachable, which usually means this agent's worker has never run",
    },
  };
}

// ── the ceiling on one chat order ─────────────────────────────────────────

/**
 * THE MOST ONE CHAT ORDER MAY SPEND, as the orders route enforces it — and
 * as the chat's amount chips offer it, because they read it from the same
 * resolution (lib/order-ceiling.ts, /api/orders/ceiling).
 *
 * Hosted, the tenant's own stored value; with nothing usable stored, or a
 * store that cannot be read, the house's (`fallback`: resolveConfig(), the web
 * process's own settings file and env). The fallback is the SAFE direction —
 * the default is the smaller number, and the sealed per-trade cap is the real
 * wall underneath either way. Self-hosted the web process and the worker
 * genuinely share one home, so the house's value IS the owner's and no store
 * is read. Zero is a value an owner may set: "no chat ceiling".
 *
 * The chips used to read the owner's value over SETTINGS_DEFAULTS instead,
 * so a house whose env set a ceiling below 25 offered a "(max)" chip this
 * refused.
 */
export async function chatOrderCeiling(s: {
  hosted: boolean;
  tenant: string | null;
  fallback: number;
  stored: (tenant: string) => Promise<{ telegramMaxActionUsdg?: unknown } | null | undefined>;
}): Promise<number> {
  if (!s.hosted || !s.tenant) return s.fallback;
  try {
    const own = (await s.stored(s.tenant))?.telegramMaxActionUsdg;
    return typeof own === "number" && Number.isFinite(own) && own >= 0 ? own : s.fallback;
  } catch {
    return s.fallback;
  }
}

// ── the order itself ──────────────────────────────────────────────────────

export interface OrderBody {
  side?: unknown;
  symbol?: unknown;
  usdgAmount?: unknown;
  purpose?: unknown;
}

/** A type, not an interface, so it fits the command file's flat-scalar `args`. */
export type OrderAsked = {
  side: "buy" | "sell";
  symbol: string;
  usdgAmount: number;
  /**
   * THE ONE MARKER THAT MAKES AN ORDER THE AGENT'S ENERGY BUY. Written only by
   * the get-energy card, as a value the command fixes (chat-commands.ts), and
   * kept here only when it is exactly "energy" — anything else is dropped, so
   * no other card, and no other value, can reach the worker's energy route
   * (worker/src/order-gate.ts orderRoute, which routes on it and never on the
   * symbol). Absent on every other order.
   */
  purpose?: "energy";
};

/**
 * The order this request is asking for, or the reason it is not one.
 *
 * SHAPE ONLY. Everything here is something the web tier can know for certain:
 * that "buy" is a side, that a symbol looks like a ticker rather than a
 * sentence, that a size is a finite positive number. Nothing here asks whether
 * the trade is a good idea or even a possible one — the watch set, the grant's
 * assets and every cap live in the worker, which decides again.
 */
export function readOrder(body: OrderBody): { order: OrderAsked } | { error: string } {
  const side = body.side === "buy" || body.side === "sell" ? body.side : null;
  if (!side) return { error: "that is neither a buy nor a sell" };
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{1,12}$/.test(symbol)) return { error: "that is not a symbol I can look up" };
  const usdgAmount = typeof body.usdgAmount === "number" ? body.usdgAmount : Number(body.usdgAmount);
  // NaN and Infinity die here rather than inside a BigInt conversion, and a
  // non-positive size dies here AND at the wall — two gates, neither relying
  // on the other, because a negative size passes every cap below it (they are
  // all upper bounds) and reduces the day's spend on its way past.
  if (!Number.isFinite(usdgAmount) || usdgAmount <= 0) return { error: "that is not an amount I can trade" };
  // Rounded to cents before it is hashed, so "25" and "25.000000001" are the
  // same order rather than two — the id is the idempotency key.
  const order: OrderAsked = { side, symbol, usdgAmount: Math.round(usdgAmount * 100) / 100 };
  // THE ENERGY MARKER, exactly or not at all (see OrderAsked.purpose). A
  // marked order is the get-energy card, which fixes a buy of $MERRYMEN — so a
  // marked order that says anything else did not come from it, and is refused
  // here rather than handed to a route that buys the reserve whatever the
  // symbol said. The worker refuses the same mismatch again.
  if (body.purpose === "energy") {
    if (side !== "buy" || symbol !== MERRYMEN_TOKEN.symbol) {
      // "$" + the ticker — a token's name, not a currency amount.
      return { error: `an energy order is a buy of ${"$" + MERRYMEN_TOKEN.symbol} and nothing else` };
    }
    order.purpose = "energy";
  }
  return { order };
}

/**
 * Was this write refused because the row already exists?
 *
 * SQLSTATE 23505 is Postgres's unique violation; node:sqlite raises
 * SQLITE_CONSTRAINT_PRIMARYKEY. Everything else — a missing column, a dropped
 * connection, a read-only disk — is a failure to write, and the difference
 * matters because one of them is honestly reported to the owner as "already
 * queued" and the other must never be.
 */
export function isDuplicateKey(e: unknown): boolean {
  const code = String((e as { code?: unknown })?.code ?? "");
  const msg = e instanceof Error ? e.message : String(e);
  return code === "23505" || /PRIMARYKEY|UNIQUE constraint|duplicate key/i.test(`${code} ${msg}`);
}

// ── hosted: the shared table ──────────────────────────────────────────────

/** The part of the ledger's driver these statements use (worker/src/db.ts `Db`). */
export interface OrderDb {
  prepare(sql: string): {
    run(...params: unknown[]): Promise<unknown>;
    get(...params: unknown[]): Promise<unknown>;
    all(...params: unknown[]): Promise<unknown[]>;
  };
}

const present = (v: unknown) => v !== null && v !== undefined;

/**
 * Put one order on the shared table, or say why not.
 *
 * ONE AT A TIME, checked before the insert rather than relying on the key
 * collision, because two DIFFERENT orders a second apart are two different ids
 * and the collision would not catch them. Judged ROW BY ROW against each row's
 * own deadline — the one GET and the orchestrator's sweep read — and not
 * against this request's window, which follows the tenant's CURRENT tick.
 *
 * ONLY A KEY COLLISION IS A DUPLICATE. The insert's catch used to swallow
 * EVERY database error and answer "queued" — so a missing column, a dropped
 * connection or a full disk all told the owner their order was placed when no
 * row existed.
 */
export async function placeHostedOrder(
  db: OrderDb | null,
  o: { agent: string; id: string; args: Record<string, unknown>; expiresAt: number; now: number },
): Promise<PlaceResult> {
  if (!db) return { ok: false, why: "unreachable" };
  try {
    // `done_at IS NULL` is the only bound the SQL can state; the deadline lives
    // inside `args`, so the rule is applied to each row below. The set stays
    // small: a new row is admitted only once every open one has let go.
    const open = (await db
      .prepare(
        "SELECT id, created_at, claimed_at, args FROM agent_commands WHERE agent_id = ? AND kind = 'trade' AND done_at IS NULL",
      )
      .all(o.agent)) as Record<string, unknown>[];
    const held = open.some((r) =>
      holdsSlot({ claimed: present(r.claimed_at), expiresAt: orderExpiresAt(r.args), at: Number(r.created_at) }, o.now),
    );
    if (held) return { ok: false, why: "in-flight" };
  } catch {
    return { ok: false, why: "unreachable" };
  }
  try {
    await db
      .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, ?, ?, ?)")
      // Milliseconds — the column has no default, so forgetting it is a write
      // error rather than a silently-wrong unit. The deadline rides in `args`,
      // where the ferry lifts it out for the child.
      .run(o.id, o.agent, "trade", JSON.stringify({ ...o.args, expiresAt: o.expiresAt }), o.now);
    return { ok: true };
  } catch (e) {
    if (!isDuplicateKey(e)) return { ok: false, why: "unreachable" };
    // The primary key did its job: this exact order, this minute, is already
    // on the queue. Reported as success — from the owner's side the thing
    // they asked for IS queued, and telling them it failed would invite the
    // retry this exists to absorb — but flagged, so the card can say "already
    // queued" rather than "placed it", which are different sentences.
    return { ok: true, duplicate: true };
  }
}

// ── the receipt (C3) ──────────────────────────────────────────────────────

/**
 * WHAT AN ORDER BECAME, AS THE WORKER READ IT OFF THE LEDGER.
 *
 * The child writes this beside `{ ok, line }` when an order finishes, from the
 * trade row or the verdict it just wrote — never from a model. The browser
 * templates "[Buy] $5.00 CASHCAT · Filled" from it, so it is the one place a
 * receipt's words can come from, and this module only carries it.
 */
export interface OrderReceipt {
  status: "filled" | "refused" | "failed" | "expired";
  side: "buy" | "sell" | null;
  symbol: string | null;
  token: string | null;
  usdgActual: number | null;
  txHash: string | null;
  rejectRule: string | null;
}

const RECEIPT_STATUSES = new Set(["filled", "refused", "failed", "expired"]);

/**
 * A receipt, checked field by field, or null when there is none.
 *
 * NOT TRUSTED FOR BEING OURS. It crosses two processes and a table, and the
 * self-hosted file sits in a home directory anything on the machine can write.
 * So each field must have the shape the ledger fact has — a 32-byte hash, a
 * 20-byte address, a rule slug — and a field that does not is NULL, which the
 * card renders as nothing. A size that is not a finite, non-negative number
 * is null, never 0: "$0.00 filled" is a claim, and nobody read it.
 *
 * WITHOUT A STATUS THERE IS NO RECEIPT. The status is the sentence; a receipt
 * that cannot say whether it filled has nothing to template.
 */
export function receiptOf(v: unknown): OrderReceipt | null {
  let bag: unknown = v;
  if (typeof v === "string") {
    try {
      bag = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return null;
  const r = bag as Record<string, unknown>;
  if (typeof r.status !== "string" || !RECEIPT_STATUSES.has(r.status)) return null;
  const text = (x: unknown, shape: RegExp) => (typeof x === "string" && shape.test(x) ? x : null);
  return {
    status: r.status as OrderReceipt["status"],
    side: r.side === "buy" || r.side === "sell" ? r.side : null,
    // A ticker, not a sentence: printable, no markup, bounded. Launchpad coins
    // carry lower case and the odd `$`, so the worker's own route shape
    // (A-Z0-9, 12) is too strict for what a fill can be named.
    symbol: text(r.symbol, /^[^\s<>"'`\u0000-\u001f]{1,24}$/),
    token: text(r.token, /^0x[0-9a-fA-F]{40}$/),
    usdgActual: typeof r.usdgActual === "number" && Number.isFinite(r.usdgActual) && r.usdgActual >= 0 ? r.usdgActual : null,
    txHash: text(r.txHash, /^0x[0-9a-fA-F]{64}$/),
    rejectRule: text(r.rejectRule, /^[a-z0-9][a-z0-9-]{0,63}$/i),
  };
}

/**
 * The hosted row's `result`: the worker's line, and the receipt when it rode
 * inside it.
 *
 * TWO WAYS A RECEIPT CAN CROSS THE TABLE, and the reader accepts both because
 * the ferry that writes them deploys at the same moment this does: a column of
 * its own (read in hostedOrderReply), or an envelope `{ line, receipt }` in
 * `result`. A worker's line is English and never parses as an object with a
 * `line`, so a bare line is always read as exactly what it was.
 */
export function resultOf(raw: unknown): { line: string | null; receipt: OrderReceipt | null } {
  if (!present(raw)) return { line: null, receipt: null };
  const s = String(raw);
  if (s.startsWith("{")) {
    try {
      const env = JSON.parse(s) as { line?: unknown; receipt?: unknown };
      if (env && typeof env === "object" && typeof env.line === "string") {
        return { line: env.line, receipt: receiptOf(env.receipt) };
      }
    } catch {
      /* a line that happens to start with a brace */
    }
  }
  return { line: s, receipt: null };
}

/** The hosted table row, as the card reads it. */
export function hostedOrderReply(
  row: Record<string, unknown>,
  nowMs: number,
): { id: string; state: OrderState; result: string | null; at: number; expiresAt: number | null; receipt?: OrderReceipt } {
  const expiresAt = orderExpiresAt(row.args);
  const { line, receipt: carried } = resultOf(row.result);
  // The column wins over the envelope: it is the one written for the purpose.
  const receipt = receiptOf(row.receipt) ?? carried;
  return {
    id: String(row.id),
    state: orderStateOf({ done: present(row.done_at), claimed: present(row.claimed_at), expiresAt }, nowMs),
    result: line,
    at: Number(row.created_at),
    expiresAt,
    // Only when one was written: an older worker's answer has none, and the
    // card then renders its line exactly as before.
    ...(receipt ? { receipt } : {}),
  };
}

/** A ledger that could not be read, as GET answers it. */
export const LEDGER_UNREADABLE = { status: 503, body: { error: "the ledger could not be read" } } as const;

/**
 * What happened to one of this agent's orders, as GET sends it.
 *
 * BY ID when the card names one. The latest row is the wrong answer to "what
 * happened to MY order" the moment there are two — and there can be two,
 * because the slot is released at a deadline even when nothing answered.
 * Scoped to the agent either way, so an id is never a way to read somebody
 * else's order.
 *
 * AN UNREADABLE LEDGER IS A 503, NOT "NONE". A read that failed is not a
 * record of nothing, and the card treats a failed poll as no answer yet.
 */
export async function readHostedOrder(
  db: OrderDb | null,
  agent: string,
  id: string,
  nowMs: number,
): Promise<
  { status: 200; body: ReturnType<typeof hostedOrderReply> | { state: "none" } } | typeof LEDGER_UNREADABLE
> {
  if (!db) return LEDGER_UNREADABLE;
  try {
    // `*`, NOT A COLUMN LIST, because of `receipt`. That column is created by
    // the WRITER's migrations and this reader deploys at the same moment, so
    // naming it would throw for the minute between the two — and a throw here
    // is a 503 on every order's card. `*` returns it where it exists and
    // nothing where it does not; hostedOrderReply reads only what it knows.
    const row = (await (id
      ? db
          .prepare(
            `SELECT * FROM agent_commands
              WHERE agent_id = ? AND kind = 'trade' AND id = ? LIMIT 1`,
          )
          .get(agent, id)
      : db
          .prepare(
            `SELECT * FROM agent_commands
              WHERE agent_id = ? AND kind = 'trade' ORDER BY created_at DESC, id DESC LIMIT 1`,
          )
          .get(agent))) as Record<string, unknown> | undefined;
    return { status: 200, body: row ? hostedOrderReply(row, nowMs) : { state: "none" } };
  } catch {
    return LEDGER_UNREADABLE;
  }
}

// ── self-hosted: the files ARE the record ─────────────────────────────────

/** worker/src/command-files.ts `OpenCommand`, as this rule reads it. */
export interface OpenFile {
  state: "queued" | "running";
  expiresAt: number | null;
  at: number;
}

/**
 * Self-hosted placement: the web process and the worker share one
 * MERRYMEN_HOME, so there is no table and no ferry. The files are passed in —
 * command-files.ts is not something the browser bundle may load.
 *
 * THE SAME SLOT RULE AS HOSTED. A queued file past its own deadline and grace
 * no longer holds the slot: GET calls it expired and says "ask again", and
 * asking again used to be refused, for as long as the worker stayed unarmed —
 * it only drains while armed. The file stays where it is; the worker drops it
 * as expired at the claim and writes the receipt that says so.
 *
 * A listing that throws is "unreachable", never "nothing waiting".
 */
export function placeSelfHostedOrder(
  files: { open(): OpenFile[]; write(cmd: { id: string; kind: "trade"; at: number; args: OrderAsked; expiresAt: number }): void },
  o: { id: string; args: OrderAsked; expiresAt: number; now: number },
): PlaceResult {
  try {
    const held = files
      .open()
      .some((f) => holdsSlot({ claimed: f.state === "running", expiresAt: f.expiresAt, at: f.at }, o.now));
    if (held) return { ok: false, why: "in-flight" };
    // The id collision is handled by the file simply being rewritten, which
    // for an identical order in the same minute is a no-op.
    files.write({ id: o.id, kind: "trade", at: o.now, args: o.args, expiresAt: o.expiresAt });
    return { ok: true };
  } catch (e) {
    return { ok: false, why: "unreachable", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** worker/src/command-files.ts `readCommandState`, as this reply reads it. */
export interface FileState {
  state: "queued" | "running" | "done";
  /** `receipt` is C3's, written by a worker that knows it; an older one writes none. */
  result?: { ok: boolean; line: string; at: number; receipt?: unknown };
  expiresAt?: number | null;
}

/**
 * The self-hosted answer. There is no orchestrator to ferry a result into a
 * table there, so reading the table would answer "none" for an order that had
 * already filled. A file still in the queue carries its own deadline, read in
 * the same read that found it queued.
 */
/**
 * GET's self-hosted body. The "none" arm names the other arm's fields as
 * absent so a caller can read them off either; `receipt` is present only when
 * the worker wrote one.
 */
export type SelfHostedReply =
  | { state: "none"; id?: undefined; result?: undefined; ok?: undefined; at?: undefined; expiresAt?: undefined; receipt?: undefined }
  | {
      id: string;
      state: OrderState;
      result: string | null;
      ok: boolean | null;
      at: number | null;
      expiresAt: number | null;
      receipt?: OrderReceipt;
    };

export function selfHostedOrderReply(id: string, st: FileState | null, nowMs: number): SelfHostedReply {
  if (!st) return { state: "none" };
  const expiresAt = st.state === "queued" ? (st.expiresAt ?? null) : null;
  const receipt = receiptOf(st.result?.receipt);
  return {
    id,
    state: orderStateOf({ done: st.state === "done", claimed: st.state === "running", expiresAt }, nowMs),
    result: st.result?.line ?? null,
    ok: st.result?.ok ?? null,
    at: st.result?.at ?? null,
    expiresAt,
    // Only when one was written: an older worker's answer carries none, and
    // the card renders its line exactly as before.
    ...(receipt ? { receipt } : {}),
  };
}
