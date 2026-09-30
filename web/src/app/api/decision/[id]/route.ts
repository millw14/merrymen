/**
 * ONE DECISION, AND EVERYTHING THAT HAPPENED BECAUSE OF IT.
 *
 * decision created -> intent -> submitted -> landed/refused/reverted ->
 * economic fill -> realised result -> what the agent said about it.
 *
 * This route is the reason the id has to survive into execution. Until it did,
 * there was nothing to ask this question of: the pre-trade thesis and the trade
 * carried DIFFERENT ids, so a reader holding either one could reconstruct at
 * most half the chain and had no way to know the other half existed.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────
 *
 * `signals_json`. It is the owner's whole balance sheet — cash, vault, equity,
 * every holding's value — and `thesis-policy.ts` keeps it off every public
 * surface by not selecting it. The same rule applies to a lifecycle view: this
 * is the chain of one decision, not a window into the book behind it.
 *
 * The agent id IS here, because it is the smart account that already appears on
 * chain and is what makes the row attributable at all.
 *
 * ── AND WHY A MISSING DECISION AND AN UNREADABLE ONE BOTH ANSWER 404 ─────
 *
 * Distinguishing them would tell a caller whether an id exists, which is the
 * one thing a stranger enumerating ids would want to learn. `lifecycleOf`
 * collapses them on purpose and this route keeps the collapse.
 */
import { NextResponse } from "next/server";
import { readPublicDecisionLifecycle } from "../../../../lib/read-decision-lifecycle";

export const runtime = "nodejs";
/** A ledger read: cacheable briefly, never per-caller. */
export const dynamic = "force-dynamic";

/**
 * Decision ids come from two mints with different shapes — `randomUUID()` for
 * everything the worker decides, and `dec_<16 hex>` from the Brain service — so
 * the check is a conservative charset and length rather than either shape. It
 * exists to keep something that is obviously not an id away from the database,
 * not to validate provenance.
 */
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID_RE.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const life = await readPublicDecisionLifecycle(id);
  if (!life) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json(life, {
    headers: { "Cache-Control": "public, max-age=15, s-maxage=30, stale-while-revalidate=60" },
  });
}
