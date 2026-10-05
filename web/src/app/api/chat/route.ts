/** Dashboard narration. The partner adapter supplies its own authoritative state. */
import { NextResponse } from "next/server";
import { isHostedMode, type StoredGrant } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { agentReplyResponse, currentEnergy, type AgentChatBody } from "@/lib/agent-chat";
import { diskAgent } from "@/lib/agent-for";
import { getGrantStore } from "@merrymen/grant-store";
import { readAgentEnergy } from "@/lib/agent-energy";
import { ceilingFor } from "@/lib/order-ceiling";
import { ledgerChatReply } from "@/lib/chat-ledger-facts";
import { fomoChatTurn } from "@/lib/fomo-chat";
import { fomoEnabledFor } from "@/lib/fomo-switch";
import { withReadDb } from "@/lib/ledger";
import { readFleetRecoveryView, type FleetRecoveryView } from "../../../../../worker/src/fleet-recovery";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const hosted = isHostedMode();
  const tenant = hosted ? tenantOf(req) : null;
  if (hosted && !tenant) {
    return NextResponse.json({ reply: null, why: "not signed in" }, { status: 401 });
  }
  let body: AgentChatBody;
  try {
    body = await req.json() as AgentChatBody;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("bad body");
  } catch {
    return NextResponse.json({ reply: null, why: "bad body" }, { status: 400 });
  }
  // The shell may still be showing A's confirmed account after another tab
  // signed in as B. Its state and history belong to A, while this request's
  // cookie now belongs to B. Refuse before any account, model or history read.
  if (hosted && (typeof body.expectedTenant !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(body.expectedTenant) ||
    body.expectedTenant.toLowerCase() !== tenant)) {
    return NextResponse.json(
      { reply: null, why: "session-changed", error: "Your sign-in changed. Reload your agent and try again." },
      { status: 409 },
    );
  }
  // STREAMED ONLY WHEN ASKED. The chat screen sends `Accept: text/event-stream`
  // and reads the agent's words as they arrive; anything that did not ask gets
  // the one JSON answer it always got. See agentReplyResponse for what may be
  // shown before the reply is complete — nothing of a command marker, ever.
  const stream = /text\/event-stream/i.test(req.headers.get("accept") ?? "");

  // THE RECOVERY HOLD, BEFORE ANYTHING IS ANSWERED. Resolve the account and
  // recovery scope from the same authenticated grant. Browser state and older
  // agents rows cannot choose whose hold we read. Read ahead of Fomo research
  // too: an unreadable hold refuses every turn alike, and a research answer to
  // a held owner says the hold (agent-chat.ts RESEARCH_DURING_RECOVERY).
  let grant: StoredGrant | null = null;
  let recovery: FleetRecoveryView | null = null;
  try {
    grant = hosted && tenant ? await getGrantStore().get(tenant) : null;
    if (tenant && grant) {
      const scope = { tenant, smartAccount: grant.smartAccount, chainId: grant.chainId };
      recovery = await withReadDb(db => {
        if (!db) throw new Error("Recovery status is unavailable.");
        return readFleetRecoveryView(db, scope, null);
      });
    }
  } catch {
    return NextResponse.json({ reply: null, why: "recovery-unavailable" }, { status: 503 });
  }

  // FOMO RESEARCH, BEFORE THE LEDGER — decided on the server by the
  // deterministic planner (lib/fomo-chat.ts), for the session's own tenant (or
  // this install's), never from the body. The planner leaves the owner's own
  // book alone ("what did you buy today?" is the ledger's), so ordering it
  // first cannot steal a ledger question; ordering it second would let the
  // ledger's trade-history patterns answer a question about somebody else's
  // trades with ours. A factual answer is sent as one, JSON even for a stream;
  // an analysis question hands the model the server's evidence, with the
  // deterministic answer as the reply when there is no model or it fails.
  const fomoTurn = await fomoChatTurn(body, { tenant, now: Date.now(), hosted }).catch(() => null);
  if (fomoTurn && "factualReply" in fomoTurn) {
    return agentReplyResponse(body, { stream, signal: req.signal }, { factualReply: fomoTurn.factualReply, factualSource: "research", recovery });
  }
  const fomo = fomoTurn && "fomo" in fomoTurn ? fomoTurn.fomo : null;

  // THE AGENT'S ENERGY, FROM ITS WORKER — read here, on the server, and never
  // taken from the body. The browser's `state` is the browser's own account of
  // things and iOS sends none at all; this is the report of the one process
  // that throttles, so it reaches the web, iOS and Android chats alike and a
  // client cannot write it. The agent is the caller's own (their grant, or the
  // grant on this disk) — never one the request names. Best effort: no report
  // is no ENERGY block, and the model is told to say it cannot see its energy.
  //
  // With it, the owner's chat-order ceiling: the one figure the model may use
  // to size a get-energy proposal from the worker's estimate without asking.
  //
  // ONLY WHILE ITS DAY LASTS. A report whose day has ended is not today's —
  // the worker may not have published since (currentEnergy) — so it is no
  // report, and the model says it cannot see its energy instead of blaming it.
  const account = hosted ? grant?.smartAccount ?? null : await diskAgent();
  const factualReply = fomo ? undefined : await ledgerChatReply(body, account, Math.floor(Date.now() / 1000));
  const report = currentEnergy(!recovery && account ? await readAgentEnergy(account) : null, Math.floor(Date.now() / 1000));
  const energy = report
    ? { ...report, ceilingUsdg: await ceilingFor(req, hosted).catch(() => null) }
    : null;
  // The Fomo switches are settings change-settings may name only where this deployment runs Fomo.
  const fomoSettings = fomoEnabledFor(hosted);
  return agentReplyResponse(body, { stream, signal: req.signal }, { energy, factualReply, fomo, recovery, fomoSettings });
}
