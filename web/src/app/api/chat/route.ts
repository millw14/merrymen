/** Dashboard narration. The partner adapter supplies its own authoritative state. */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { agentReplyResponse, type AgentChatBody } from "@/lib/agent-chat";
import { diskAgent, hostedAgentFor } from "@/lib/agent-for";
import { readAgentEnergy } from "@/lib/agent-energy";
import { ceilingFor } from "@/lib/order-ceiling";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const hosted = isHostedMode();
  if (hosted && !tenantOf(req)) {
    return NextResponse.json({ reply: null, why: "not signed in" }, { status: 401 });
  }
  let body: AgentChatBody;
  try {
    body = await req.json() as AgentChatBody;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("bad body");
  } catch {
    return NextResponse.json({ reply: null, why: "bad body" }, { status: 400 });
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
  const account = hosted ? await hostedAgentFor(req) : await diskAgent();
  const report = account ? await readAgentEnergy(account) : null;
  const energy = report
    ? { ...report, ceilingUsdg: await ceilingFor(req, hosted).catch(() => null) }
    : null;
  // STREAMED ONLY WHEN ASKED. The chat screen sends `Accept: text/event-stream`
  // and reads the agent's words as they arrive; anything that did not ask gets
  // the one JSON answer it always got. See agentReplyResponse for what may be
  // shown before the reply is complete — nothing of a command marker, ever.
  const stream = /text\/event-stream/i.test(req.headers.get("accept") ?? "");
  return agentReplyResponse(body, { stream, signal: req.signal }, { energy });
}
