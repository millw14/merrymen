/** Dashboard narration. The partner adapter supplies its own authoritative state. */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { agentReplyResponse, currentEnergy, type AgentChatBody } from "@/lib/agent-chat";
import { diskAgent, hostedAgentFor } from "@/lib/agent-for";
import { readAgentEnergy } from "@/lib/agent-energy";
import { ceilingFor } from "@/lib/order-ceiling";
import { ledgerChatReply } from "@/lib/chat-ledger-facts";

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
  const account = hosted ? await hostedAgentFor(req) : await diskAgent();
  const factualReply = await ledgerChatReply(body, account, Math.floor(Date.now() / 1000));
  const report = currentEnergy(account ? await readAgentEnergy(account) : null, Math.floor(Date.now() / 1000));
  const energy = report
    ? { ...report, ceilingUsdg: await ceilingFor(req, hosted).catch(() => null) }
    : null;
  // STREAMED ONLY WHEN ASKED. The chat screen sends `Accept: text/event-stream`
  // and reads the agent's words as they arrive; anything that did not ask gets
  // the one JSON answer it always got. See agentReplyResponse for what may be
  // shown before the reply is complete — nothing of a command marker, ever.
  const stream = /text\/event-stream/i.test(req.headers.get("accept") ?? "");
  return agentReplyResponse(body, { stream, signal: req.signal }, { energy, factualReply });
}
