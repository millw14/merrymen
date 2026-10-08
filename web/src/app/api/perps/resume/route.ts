import { readRequestPurpose } from "@/lib/account-purpose";
import { ownerControlHead } from "../../../../../../worker/src/perps/owner-controls";
/** Dashboard-only request to clear an owner's flatten halt. Never clears an incident. */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { purposeHome } from "@merrymen/home";
import { commandWhereabouts, openCommands, readCommandState, writeCommand } from "../../../../../../worker/src/command-files";
import { resolveConfig } from "../../../../../../worker/src/settings";
import { getSettingsStore } from "@merrymen/settings-store";
import { tenantOf } from "@/lib/auth";
import { diskAgent, hostedAgentFor } from "@/lib/agent-for";
import { withReadDb } from "@/lib/ledger";
import { OWNER_CHANGED_SETTING, OWNER_CHANGED_LOOKUP, ownerMismatch } from "@/lib/order-owner";
import { holdsSlot, hostedOrderReply, isDuplicateKey, orderExpiresAt, orderTtlMs, selfHostedOrderReply } from "@/lib/order-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const agentFor = (req: Request, purpose: "spot" | "perps") => isHostedMode() ? hostedAgentFor(req, purpose) : diskAgent(purpose);

export async function POST(req: Request) {
  const purpose = readRequestPurpose(req);
  if (!purpose) return NextResponse.json({ error: "Invalid account purpose" }, { status: 400 });
  const agent = await agentFor(req, purpose);
  if (!agent) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  let body: { owner?: unknown; mode?: unknown; confirm?: unknown } | null;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "body is not JSON" }, { status: 400 }); }
  // New control: unlike legacy clients, it must name the owner who saw the question.
  if (isHostedMode() && (typeof body?.owner !== "string" || ownerMismatch(body.owner, tenantOf(req)))) {
    return NextResponse.json({ error: OWNER_CHANGED_SETTING }, { status: 409 });
  }
  if (body?.confirm !== true || (body.mode !== "paper" && body.mode !== "live")) {
    return NextResponse.json({ error: "Confirm whether you want to resume paper or real-money perpetual entries." }, { status: 400 });
  }
  let tick = resolveConfig(purpose).tickSeconds;
  if (isHostedMode()) {
    const tenant = tenantOf(req);
    try { tick = (tenant ? (await getSettingsStore(purpose).get(tenant))?.tickSeconds : undefined) ?? tick; } catch { /* fallback */ }
  }
  let expectedControlHead: string | null = null;
  try {
    expectedControlHead = await withReadDb(async db => {
      if (!db) throw new Error("unread");
      const row = await db.prepare("SELECT owner_controls_json FROM perp_accounts WHERE agent_id = ? AND mode = ?").get(agent, body!.mode) as {owner_controls_json: string | null} | undefined;
      return row ? ownerControlHead(row.owner_controls_json, agent, body!.mode) : null;
    }, isHostedMode() ? "spot" : purpose);
  } catch { return NextResponse.json({ error: "The current entry halt could not be read. Refresh before resuming." }, { status: 503 }); }
  if (!expectedControlHead) return NextResponse.json({ error: "The worker must record the current halt before it can be resumed. Wait for its next update." }, { status: 409 });
  const now = Date.now(), expiresAt = now + orderTtlMs(tick);
  const id = createHash("sha256").update(`${agent.toLowerCase()}|resume-perps|${body.mode}|${expectedControlHead}|${Math.floor(now / 60_000)}`).digest("hex").slice(0, 32);
  const args = { mode: body.mode, expectedControlHead, expiresAt };
  const queued = (duplicate = false) => NextResponse.json({ id, queued: true, expiresAt, expiresInMs: expiresAt - now, ...(duplicate ? { duplicate: true } : {}) });
  const busy = () => NextResponse.json({ error: "Another request is still waiting on your agent. Wait for its result before resuming entries." }, { status: 409 });
  try {
    if (!isHostedMode()) {
      if (commandWhereabouts(purposeHome(purpose), id) !== "gone") return queued(true);
      if (openCommands(purposeHome(purpose)).some((f) => holdsSlot({ claimed: f.state === "running", expiresAt: f.expiresAt, at: f.at }, now))) return busy();
      writeCommand(purposeHome(purpose), { id, kind: "resume-perps", args, expiresAt, at: now });
      return queued();
    }
    const result = await withReadDb(async (db) => {
      if (!db) throw new Error("unread");
      const duplicate = await db.prepare("SELECT id FROM agent_commands WHERE agent_id = ? AND id = ?").get(agent, id);
      if (duplicate) return "duplicate";
      const open = await db.prepare("SELECT claimed_at, args, created_at FROM agent_commands WHERE agent_id = ? AND kind IN ('trade', 'resume-perps') AND done_at IS NULL").all(agent) as { claimed_at: number | null; args: unknown; created_at: number }[];
      if (open.some((r) => holdsSlot({ claimed: r.claimed_at != null, expiresAt: orderExpiresAt(r.args), at: Number(r.created_at) }, now))) return "busy";
      try {
        await db.prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(id, agent, "resume-perps", JSON.stringify(args), now);
      } catch (e) { if (isDuplicateKey(e)) return "duplicate"; throw e; }
      return "queued";
    }, isHostedMode() ? "spot" : purpose);
    return result === "busy" ? busy() : queued(result === "duplicate");
  } catch {
    return NextResponse.json({ error: "Could not queue the request. Entries have not been reported as resumed." }, { status: 503 });
  }
}

export async function GET(req: Request) {
  const purpose = readRequestPurpose(req);
  if (!purpose) return NextResponse.json({ error: "Invalid account purpose" }, { status: 400 });
  const agent = await agentFor(req, purpose);
  if (!agent) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const params = new URL(req.url).searchParams, id = params.get("id");
  if (isHostedMode() && ownerMismatch(params.get("owner"), tenantOf(req))) return NextResponse.json({ error: OWNER_CHANGED_LOOKUP }, { status: 409 });
  if (!id || !/^[a-f0-9]{32}$/.test(id)) return NextResponse.json({ error: "request id is missing or invalid" }, { status: 400 });
  try {
    if (!isHostedMode()) return NextResponse.json(selfHostedOrderReply(id, readCommandState(purposeHome(purpose), id), Date.now()));
    const answer = await withReadDb(async (db) => {
      if (!db) throw new Error("unread");
      const row = await db.prepare("SELECT * FROM agent_commands WHERE agent_id = ? AND kind = 'resume-perps' AND id = ?").get(agent, id) as Record<string, unknown> | undefined;
      return row ? hostedOrderReply(row, Date.now()) : { state: "none" };
    }, isHostedMode() ? "spot" : purpose);
    return NextResponse.json(answer);
  } catch { return NextResponse.json({ error: "The worker's answer could not be read." }, { status: 503 }); }
}
