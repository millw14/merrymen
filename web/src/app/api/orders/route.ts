/**
 * AN OWNER'S OWN BUY OR SELL, PLACED FROM THE APP.
 *
 * ── WHY THIS IS NOT A NEW WAY INTO THE WALL ──────────────────────────────
 *
 * It is not an order engine. It writes one row onto the command channel that
 * `/api/selftest` already uses, and the WORKER — the only process holding a
 * key — decides whether it is a trade. Every refusal that has always applied
 * still applies, unchanged and in the same place: the sealed per-trade cap, the
 * daily cap, the asset allowlist, no-exit, the drawdown breaker, gas. This
 * route cannot widen any of them and does not try.
 *
 * What it adds is the ability to ASK. The selftest route's own header said this
 * was coming and set the terms: "The only `kind` written here is a literal, so
 * a compromised session cannot use this to make the agent trade. When chat
 * orders land they go through the same channel with their own validation and
 * their own wall check — the channel is deliberately dumb."
 *
 * ── THE THREE THINGS THAT MAKE ONE CLICK MEAN AT MOST ONE TRADE ──────────
 *
 * 1. THE ID IS A HASH OF THE ORDER, NOT A RANDOM UUID. Same tenant, same side,
 *    same symbol, same size, same minute → the same primary key, so a retry
 *    after a lost response, a double-click, or a component that mounts twice
 *    collides on the INSERT and is answered "already queued" instead of
 *    becoming a second position at a second price with a second gas bill.
 *    It is a HASH and never a concatenation, because the id becomes a FILENAME
 *    under a child's home in a process that can see every tenant's home —
 *    command-files.ts states that boundary and validates the shape again.
 *
 * 2. ONE ORDER IN FLIGHT AT A TIME. A second is refused while the first is
 *    unanswered. A queue one client can fill faster than a worker drains it is
 *    an account draining over hours with no view of it and no way to stop.
 *
 * 3. IT EXPIRES. Five minutes, enforced at the claim. A settings write is
 *    timeless; an order is not. The child returns early from its drain when it
 *    is unarmed, restarting, or when the market was unreadable, and the command
 *    file survives a restart — so without this, an owner who clicked during a
 *    wobble and closed the tab gets a fill hours later, at a price they never
 *    saw, into a book they never looked at.
 *
 * ── WHAT THIS ROUTE DELIBERATELY DOES NOT DECIDE ─────────────────────────
 *
 * Whether the symbol is tradable. The watch set, the grant's sellable assets
 * and the venue live in the worker, and only the worker can answer without
 * guessing. Checking here would mean maintaining a second, weaker copy of the
 * wall in the web tier — and a wrong "yes" from this side is exactly the shape
 * of the bug the wall exists to prevent. So the validation here is about the
 * SHAPE of a request and the SIZE the owner allowed; the meaning is decided
 * once more, in the process that holds the key.
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { merrymenHome } from "@merrymen/home";
import { isHostedMode } from "@merrymen/core";
import { hasPendingCommand, readCommandState, writeCommand } from "@merrymen/command-files";
import { resolveConfig } from "@merrymen/settings";
import { tenantOf } from "@/lib/auth";
import { withReadDb } from "@/lib/ledger";
import { hostedAgentFor, diskAgent } from "@/lib/agent-for";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How long an order stays willing to fill.
 *
 * Long enough to survive one slow tick (60s default) and a ferry pass (15s)
 * with room to spare; short enough that nobody gets a fill from a market they
 * have stopped watching. Minutes, not hours — see the header.
 */
const ORDER_TTL_MS = 5 * 60_000;

const agentFor = (req: Request) => (isHostedMode() ? hostedAgentFor(req) : diskAgent());

interface OrderBody {
  side?: unknown;
  symbol?: unknown;
  usdgAmount?: unknown;
}

/**
 * The order this request is asking for, or the reason it is not one.
 *
 * SHAPE ONLY. Everything here is something the web tier can know for certain:
 * that "buy" is a side, that a symbol looks like a ticker rather than a
 * sentence, that a size is a finite positive number, and that it is inside the
 * ceiling the owner set for a typed order. Nothing here asks whether the trade
 * is a good idea or even a possible one.
 */
function readOrder(body: OrderBody): { order: { side: "buy" | "sell"; symbol: string; usdgAmount: number } } | { error: string } {
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
  return { order: { side, symbol, usdgAmount: Math.round(usdgAmount * 100) / 100 } };
}

/**
 * The primary key for this order, in this minute.
 *
 * A HASH, and the minute bucket is what makes a retry idempotent without making
 * a second, genuinely-intended order impossible: ask for the same thing again
 * next minute and it is a new id, as it should be.
 */
function orderId(agent: string, o: { side: string; symbol: string; usdgAmount: number }, nowMs: number): string {
  const bucket = Math.floor(nowMs / 60_000);
  return createHash("sha256")
    .update(`${agent.toLowerCase()}|${o.side}|${o.symbol}|${o.usdgAmount}|${bucket}`)
    .digest("hex")
    .slice(0, 32);
}

export async function POST(req: Request) {
  // Hosted, `tenantOf` is a server-verified wallet and the account is resolved
  // through the grant store — a caller can never name someone else's agent.
  // Self-hosted there is no auth and the localhost middleware is the perimeter.
  const agent = await agentFor(req);
  if (!agent) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  let body: OrderBody;
  try {
    body = (await req.json()) as OrderBody;
  } catch {
    return NextResponse.json({ error: "body is not JSON" }, { status: 400 });
  }
  const read = readOrder(body);
  if ("error" in read) return NextResponse.json({ error: read.error }, { status: 400 });
  const order = read.order;

  // The owner's own ceiling on a typed order. The setting is named for the
  // Telegram surface because that is the surface that existed when it was
  // written; it means the same thing here, and applying it is the point —
  // silently inheriting nothing would let this surface claim more than the
  // owner's configured limit allows. Enforced again in the worker.
  const ceiling = resolveConfig().telegramMaxActionUsdg;
  if (ceiling > 0 && order.usdgAmount > ceiling) {
    return NextResponse.json(
      { error: `${order.usdgAmount} USDG is over your ${ceiling} USDG limit for a chat order. Raise it in Settings if you mean it.` },
      { status: 400 },
    );
  }

  const now = Date.now();
  const id = orderId(agent, order, now);
  const args = { ...order };

  if (!isHostedMode()) {
    // The web process and the worker share one MERRYMEN_HOME — no table, no
    // ferry. `hasPendingCommand` is the self-hosted form of the one-at-a-time
    // rule; the id collision is handled by the file simply being rewritten,
    // which for an identical order in the same minute is a no-op.
    try {
      if (hasPendingCommand(merrymenHome())) {
        return NextResponse.json({ error: "you already have an order waiting. Let that one finish first." }, { status: 409 });
      }
      writeCommand(merrymenHome(), { id, kind: "trade", at: now, args, expiresAt: now + ORDER_TTL_MS });
      return NextResponse.json({ id, queued: true });
    } catch (e) {
      return NextResponse.json({ error: `couldn't queue it: ${e instanceof Error ? e.message : String(e)}` }, { status: 503 });
    }
  }

  const result = await withReadDb(async (db) => {
    if (!db) return { ok: false as const, why: "unreachable" as const };
    // ONE AT A TIME. Checked before the insert rather than relying on the key
    // collision, because two DIFFERENT orders a second apart are two different
    // ids and the collision would not catch them.
    try {
      const open = (await db
        .prepare("SELECT id FROM agent_commands WHERE agent_id = ? AND kind = 'trade' AND done_at IS NULL LIMIT 1")
        .get(agent)) as { id?: string } | undefined;
      if (open?.id) return { ok: false as const, why: "in-flight" as const };
    } catch {
      return { ok: false as const, why: "unreachable" as const };
    }
    try {
      await db
        .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, ?, ?, ?)")
        // Milliseconds — the column has no default, so forgetting it is a write
        // error rather than a silently-wrong unit.
        .run(id, agent, "trade", JSON.stringify({ ...args, expiresAt: now + ORDER_TTL_MS }), now);
      return { ok: true as const };
    } catch {
      // The primary key did its job: this exact order, this minute, is already
      // queued. Reported as success with `duplicate`, because from the owner's
      // side the thing they asked for IS queued — telling them it failed would
      // invite the retry this is here to absorb.
      return { ok: true as const, duplicate: true };
    }
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error:
          result.why === "in-flight"
            ? "you already have an order waiting. Let that one finish first."
            : "couldn't queue it — the ledger is unreachable, which usually means this agent's worker has never run",
      },
      { status: result.why === "in-flight" ? 409 : 503 },
    );
  }
  return NextResponse.json({ id, queued: true, ...(result.duplicate ? { duplicate: true } : {}) });
}

/**
 * What happened to the most recent order. Polled by the card that placed it.
 *
 * FOUR STATES, NOT TWO. "queued" and "running" look the same to somebody
 * watching a spinner and mean different things when it stops changing:
 * queued-forever is a worker that is not draining, running-forever is an order
 * that hung. "none" is neither — it is the honest answer when nothing was ever
 * asked for, and it must never be returned for an order that ran.
 */
export async function GET(req: Request) {
  const agent = await agentFor(req);
  if (!agent) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  if (!isHostedMode()) {
    // Self-hosted the files ARE the record: there is no orchestrator to ferry a
    // result into a table, so reading the table would answer "none" for an
    // order that had already filled.
    const id = new URL(req.url).searchParams.get("id") ?? "";
    const st = id ? readCommandState(merrymenHome(), id) : null;
    if (!st) return NextResponse.json({ state: "none" });
    return NextResponse.json({
      id,
      state: st.state,
      result: st.result?.line ?? null,
      ok: st.result?.ok ?? null,
      at: st.result?.at ?? null,
    });
  }

  const row = await withReadDb(async (db) => {
    if (!db) return null;
    try {
      return ((await db
        .prepare(
          `SELECT id, created_at, claimed_at, done_at, result FROM agent_commands
            WHERE agent_id = ? AND kind = 'trade' ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(agent)) ?? null) as Record<string, unknown> | null;
    } catch {
      return null;
    }
  });

  if (!row) return NextResponse.json({ state: "none" });
  const done = row.done_at !== null && row.done_at !== undefined;
  const claimed = row.claimed_at !== null && row.claimed_at !== undefined;
  return NextResponse.json({
    id: String(row.id),
    state: done ? "done" : claimed ? "running" : "queued",
    result: row.result === null || row.result === undefined ? null : String(row.result),
    at: Number(row.created_at),
  });
}
