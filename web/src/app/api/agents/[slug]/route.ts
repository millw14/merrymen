import { NextResponse } from "next/server";
import { readTheses } from "@/lib/read-theses";
import { readAgent, readAgentSummary } from "@/lib/read-agent";
import { walletNotSupported } from "@/lib/route-guard";
export const dynamic = "force-dynamic";
export async function GET(req: Request, {params}:{params:Promise<{slug:string}>}) {
  const walletRefused = walletNotSupported(req);
  if (walletRefused) return walletRefused;
  const {slug}=await params;
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(slug)) return NextResponse.json({error:"Invalid agent"},{status:400});
  const view = new URL(req.url).searchParams.get("view");
  if (view === "summary" || view === "activity") {
    let summary;
    try { summary = await readAgentSummary(slug); }
    catch { return NextResponse.json({ error: "This agent could not be read right now." }, { status: 503 }); }
    if (!summary) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    if (view === "summary") return NextResponse.json(summary);
    const activity = await readTheses({ agentSlug: slug, limit: 40, figures: false });
    return NextResponse.json({ ...activity, figuresIncluded: false });
  }
  const agent=await readAgent(slug);
  if (view === "details") return agent ? NextResponse.json(agent) : NextResponse.json({ error: "Agent not found" }, { status: 404 });
  const activity = agent ? await readTheses({ agentSlug: slug, limit: 40 }) : null;
  return agent ? NextResponse.json({ ...agent, theses: activity?.theses ?? [], thesesRead: activity?.source !== "none" }) : NextResponse.json({error:"Agent not found"},{status:404});
}
