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
 *    Judged against each open order's OWN deadline — the one GET and the
 *    orchestrator's sweep read — and held for a claimed order until it can no
 *    longer be trading (lib/order-state.ts).
 *
 * 3. IT EXPIRES, enforced at the claim. A settings write is timeless; an order
 *    is not. The child returns early from its drain when it is unarmed,
 *    restarting, or when the market was unreadable, and the command file
 *    survives a restart — so without this, an owner who clicked during a wobble
 *    and closed the tab gets a fill hours later, at a price they never saw,
 *    into a book they never looked at. The window is TWO TICKS of the tick this
 *    tenant actually runs, not a constant tuned for the default one — see
 *    orderTtlFor (lib/order-ceiling.ts).
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
 *
 * ── TWO WALLETS: `?wallet=spot` (or none) AND `?wallet=perps` ───────────
 *
 * A login has two wallets, each its own account, queue and worker, and the
 * request names the one it means (wallet-param.ts; absent is Spot, exactly as
 * every client before Perps sent it). Everything above holds for both, read
 * for the wallet named: its account (agent-for.ts, never the other's), its
 * ceiling and order window (its own settings), its one-at-a-time slot (its own
 * account's rows), its queue (hosted, a row bound to its account, which the
 * ferry hands only to that wallet's worker; self-hosted, its own home's
 * commands). The Perps wallet differs in what it takes:
 *
 * - EXITS ONLY (readPerpsWalletOrder): close one perpetual position, or close
 *   all of them, on the practice book. No entry, no Spot order, no energy buy
 *   is ever queued for it, and the Spot wallet refuses an exit
 *   (SPOT_WALLET_HOLDS_NO_PERPS). The worker judges both again
 *   (order-gate.ts walletOrderRefusal) before anything is built.
 * - BOUND TO THE ACCOUNT THE OWNER REVIEWED: a Perps order names it
 *   (`expectedAccount`) and is refused when the Perps wallet is now another
 *   one — a renewal in another tab, a different login — so a Close is never
 *   carried out on an account nobody looked at. It is checked, never queued
 *   as sent: what the order is bound to is the account this route resolved.
 *   Hosted, the row's agent_id, which the ferry joins on, so only that
 *   account's worker is handed it. Self-hosted, the file names it
 *   (FileCommand.account), because the Perps home outlives the account in it,
 *   and the worker answers it without running it on any other.
 * - ONLY WHERE A PERPS WORKER RUNS (perps-enabled.ts perpsWorkersRun, D1).
 *   Under any other MERRYMEN_PERPS the wallet's worker is stood down and its
 *   practice positions are frozen; an exit queued then would run whenever
 *   perps came back, closing positions at a price nobody was shown. So it is
 *   refused, and nothing is queued or read.
 * - The fleet recovery hold refuses a Perps exit as it refuses any order
 *   (placeRecoveryCheckedOrder, D11). Rule 8a's "an exit is always
 *   attemptable" waits for the live build, where a hold could strand a real
 *   position; a practice position waiting out a hold costs nothing.
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { purposeHome } from "@merrymen/home";
import { isHostedMode, type GrantPurpose } from "@merrymen/core";
// RELATIVE, NOT THE ALIASES, so a test can run this route. `tsx --test`
// resolves against the root tsconfig, which has no @merrymen/command-files or
// @merrymen/settings; the build resolves either way (lib/order-ceiling.ts
// reaches settings the same way). ceiling/route.test.ts runs POST for real.
import { openCommands, readCommandState, writeCommand } from "../../../../../worker/src/command-files";
import { isPerpExitPurpose } from "../../../../../worker/src/perps/owner-order";
import { tenantOf } from "@/lib/auth";
import { withReadDb } from "@/lib/ledger";
import { hostedAgentFor, diskAgent } from "@/lib/agent-for";
import { ceilingFor, orderTtlFor } from "@/lib/order-ceiling";
import { OWNER_CHANGED, OWNER_CHANGED_LOOKUP, ownerMismatch } from "@/lib/order-owner";
import { placeRecoveryCheckedOrder } from "@/lib/recovery-orders";
import {
  LEDGER_UNREADABLE,
  SPOT_WALLET_HOLDS_NO_PERPS,
  namesPerpExit,
  placedResponse,
  placeSelfHostedOrder,
  readHostedOrder,
  readOrder,
  readPerpsWalletOrder,
  selfHostedOrderReply,
  type OrderAsked,
  type OrderBody,
  type PerpsWalletOrder,
} from "@/lib/order-state";
import { perpsWalletRefused, perpsWorkersRun } from "@/lib/perps-enabled";
import { walletUnknown } from "@/lib/route-guard";
import { readWalletParam } from "@/lib/wallet-param";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const agentFor = (req: Request, wallet: GrantPurpose) => (isHostedMode() ? hostedAgentFor(req, wallet) : diskAgent(wallet));

/** The refusal while no Perps worker runs here (D1): `what` is what was not done. */
const perpsStoodDown = (what: string) =>
  perpsWalletRefused(
    `${what} Practice perpetuals are not running here, so your Perps wallet's practice positions stay exactly as they are until they do. Kill all agents still stops it.`,
  );

/**
 * The primary key for this order, in this minute.
 *
 * A HASH, and the minute bucket is what makes a retry idempotent without making
 * a second, genuinely-intended order impossible: ask for the same thing again
 * next minute and it is a new id, as it should be.
 */
function orderId(agent: string, o: { side: string; symbol: string; usdgAmount: number; purpose?: string; book?: string }, nowMs: number): string {
  const bucket = Math.floor(nowMs / 60_000);
  // THE ENERGY MARKER IS PART OF WHAT THE ORDER IS, so it is part of its id: a
  // get-energy card and a plain buy card with the same numbers in the same
  // minute are two different orders, and the second must not be answered
  // "already queued" off the first. Appended only when present, so every other
  // order keeps the id it always had.
  const purpose = o.purpose ? `|${o.purpose}` : "";
  // AN EXIT'S BOOK, the same way: a Close all of the practice book and a Close
  // all of every book are two orders. Only an exit carries one, so every other
  // order's id is unchanged (hashing "" adds nothing).
  const book = isPerpExitPurpose(o.purpose) && o.book ? `|${o.book}` : "";
  return createHash("sha256")
    .update(`${agent.toLowerCase()}|${o.side}|${o.symbol}|${o.usdgAmount}|${bucket}${purpose}`)
    .update(book)
    .digest("hex")
    .slice(0, 32);
}

export async function POST(req: Request) {
  // WHICH WALLET, before anything is read: one this route cannot read is
  // refused, never guessed (wallet-param.ts; absent is Spot).
  const wallet = readWalletParam(req);
  if (wallet === null) return walletUnknown("Nothing was queued.");
  // NO PERPS WORKER RUNS HERE, so nothing is queued for one (D1), and nothing
  // is read on the way to saying so.
  if (wallet === "perps" && !perpsWorkersRun()) return perpsStoodDown("No Perps order was queued.");
  // Hosted, `tenantOf` is a server-verified wallet and the account is resolved
  // through the grant store — a caller can never name someone else's agent.
  // Self-hosted there is no auth and the localhost middleware is the perimeter.
  const agent = await agentFor(req, wallet);
  if (!agent) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  let body: OrderBody;
  try {
    body = (await req.json()) as OrderBody;
  } catch {
    return NextResponse.json({ error: "body is not JSON" }, { status: 400 });
  }
  // A PERPS ORDER IS AN OBJECT, OR IT IS NOTHING: a JSON `null`, a list or a
  // string is refused before a field is read off it.
  if (wallet === "perps" && (!body || typeof body !== "object" || Array.isArray(body))) {
    return NextResponse.json({ error: "That is not an order. Nothing was queued." }, { status: 400 });
  }
  // FOR THE OWNER WHO CONFIRMED IT, OR NOT AT ALL. The session is whatever
  // this browser held when the request left; the chat card names the owner who
  // tapped, and another wallet signed in since (another tab can do it unseen)
  // places nothing — before the ceiling, which would be the other wallet's.
  if (isHostedMode() && ownerMismatch((body as { owner?: unknown }).owner, tenantOf(req))) {
    return NextResponse.json({ error: OWNER_CHANGED }, { status: 409 });
  }
  // FOR THE PERPS ACCOUNT THE OWNER REVIEWED, OR NOT AT ALL. The desk and the
  // chat card name the account they showed (`expectedAccount`), and the order
  // is bound to the account resolved above — never to one the body names. A
  // Perps wallet renewed or replaced since the owner looked is another
  // account, and an exit for it is one nobody reviewed. Required: a Perps
  // order that does not say which account it was reviewed for is refused.
  if (wallet === "perps") {
    const expected = (body as { expectedAccount?: unknown }).expectedAccount;
    if (typeof expected !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(expected)) {
      return NextResponse.json(
        { error: "Reload your Perps wallet and review this again: the order does not say which account you reviewed. Nothing was queued." },
        { status: 400 },
      );
    }
    if (expected.toLowerCase() !== agent.toLowerCase()) {
      return NextResponse.json(
        { error: "Your Perps wallet has changed since you reviewed this, so nothing was queued. Review it again.", code: "account-changed" },
        { status: 409 },
      );
    }
  }
  // WHAT EACH WALLET TAKES: the Perps wallet the owner's exits and nothing
  // else; the Spot wallet everything it always took, and never an exit.
  const read: { order: OrderAsked | PerpsWalletOrder } | { error: string } =
    wallet === "perps" ? readPerpsWalletOrder(body)
    : namesPerpExit(body) ? { error: SPOT_WALLET_HOLDS_NO_PERPS }
    : readOrder(body);
  if ("error" in read) return NextResponse.json({ error: read.error }, { status: 400 });
  const order = read.order;

  // The owner's own ceiling on a typed order. The setting is named for the
  // Telegram surface because that is the surface that existed when it was
  // written; it means the same thing here, and applying it is the point —
  // silently inheriting nothing would let this surface claim more than the
  // owner's configured limit allows. Enforced again in the worker.
  //
  // RESOLVED FOR THE CALLER, NOT FOR THIS CONTAINER — see lib/order-ceiling.ts,
  // which GET /api/orders/ceiling also calls, so the chat's amount chips offer
  // exactly the ceiling this refuses at. Falls back to the house's value (the
  // smaller, SAFE direction) when the tenant stored none or the store cannot be
  // read. Enforced again in the worker, which reads the settings.json the
  // orchestrator wrote for that child: two gates, neither relying on the other.
  const ceiling = await ceilingFor(req, isHostedMode(), wallet);
  if (ceiling > 0 && order.usdgAmount > ceiling) {
    return NextResponse.json(
      { error: `${order.usdgAmount} USDG is over your ${ceiling} USDG limit for a chat order. Raise it in Settings if you mean it.` },
      { status: 400 },
    );
  }

  const now = Date.now();
  const ttlMs = await orderTtlFor(req, isHostedMode(), wallet);
  // ONE DEADLINE, stamped on the order and handed back to the card, so the
  // worker that enforces it, the slot that waits on it and the card that
  // follows it all read the same number.
  const expiresAt = now + ttlMs;
  const id = orderId(agent, order, now);
  const args = { ...order };

  // Both rails run the rules in lib/order-state.ts, where a test drives them
  // against a real sqlite and real files: ONE AT A TIME, judged row by row
  // against each open order's own `expiresAt`, and only a key collision is a
  // duplicate.
  const result = isHostedMode()
    ? await withReadDb((db) => placeRecoveryCheckedOrder(db, { agent, id, args, expiresAt, now }), wallet).catch(
        () => ({ ok: false as const, why: "unreachable" as const }),
      )
    : // The web process and the worker share one MERRYMEN_HOME — no table, no
      // ferry. Each wallet's worker drains its own home (purposeHome: Spot's is
      // MERRYMEN_HOME itself, as it always was; Perps's is accounts/perps).
      // A PERPS EXIT NAMES ITS ACCOUNT ON THE FILE: the Perps home outlives
      // the account in it (a wallet made again under another owner key is
      // another account in the same `accounts/perps`), so the account the
      // owner reviewed rides with the exit and the worker runs it on no other
      // (command-files.ts FileCommand.account).
      placeSelfHostedOrder(
        { open: () => openCommands(purposeHome(wallet)), write: (cmd) => writeCommand(purposeHome(wallet), cmd) },
        { id, args, expiresAt, now, ...(wallet === "perps" ? { account: agent } : {}) },
      );

  // THE DEADLINE GOES BACK WITH THE ID — and as a DURATION, so the card waits
  // out this order's own window on its own clock instead of a constant of its
  // own, or of the server's epoch read against a browser clock that may be
  // minutes off. For a duplicate it is this request's figure, at most a minute
  // past the queued row's (same minute bucket), which can only lengthen the
  // wait, never cut it.
  const reply = placedResponse(result, { id, expiresAt, now });
  return NextResponse.json(reply.body, { status: reply.status });
}

/**
 * What happened to an order. Polled by the card that placed it.
 *
 * FIVE STATES, NOT TWO. "queued" and "running" look the same to somebody
 * watching a spinner and mean different things when it stops changing:
 * queued-forever is a worker that is not draining, running-forever is an order
 * that hung. "none" is neither — it is the honest answer when nothing was ever
 * asked for, and it must never be returned for an order that ran.
 *
 * "expired" is the fifth, and the only one that means NOTHING WAS SENT. It used
 * to be the card's own guess, made on a fixed seven-minute timer that ran
 * shorter than the order's real window at the hosted tick; now it is said here,
 * from the order's own `expiresAt`, and only for an order nobody claimed — see
 * lib/order-state.ts for why a claimed one is never called expired. The slot
 * is released at that same instant, so "ask again" is never refused.
 *
 * BY ID when the card names one, scoped to the caller's agent either way.
 *
 * An unreadable ledger is a 503, not "none": a read that failed is not a
 * record of nothing, and the card treats a failed poll as no answer yet.
 *
 * THE RECEIPT RIDES ALONG when the worker wrote one (C3): the side, coin,
 * size, hash and refusing rule it read off the ledger, shape-checked in
 * lib/order-state.ts and never composed here. The chat templates its receipt
 * line from it; an older worker's answer carries none and renders `result`.
 */
export async function GET(req: Request) {
  const wallet = readWalletParam(req);
  if (wallet === null) return walletUnknown("Nothing was read.");
  if (wallet === "perps" && !perpsWorkersRun()) return perpsStoodDown("Its orders were not read.");
  const agent = await agentFor(req, wallet);
  if (!agent) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const id = params.get("id") ?? "";
  // FOR THE OWNER WHO CONFIRMED, like POST: the chat's lookup after a lost
  // placement names them, and what is open under another wallet's session
  // (another tab signed it in) would be followed in their thread as theirs.
  if (isHostedMode() && ownerMismatch(params.get("owner"), tenantOf(req))) {
    return NextResponse.json({ error: OWNER_CHANGED_LOOKUP }, { status: 409 });
  }

  if (!isHostedMode()) {
    // Self-hosted the files ARE the record: there is no orchestrator to ferry a
    // result into a table, so reading the table would answer "none" for an
    // order that had already filled.
    return NextResponse.json(selfHostedOrderReply(id, id ? readCommandState(purposeHome(wallet), id) : null, Date.now()));
  }

  const reply = await withReadDb((db) => readHostedOrder(db, agent, id, Date.now()), wallet).catch(() => LEDGER_UNREADABLE);
  return NextResponse.json(reply.body, { status: reply.status });
}
