import { NextResponse } from "next/server";
import { readTheses } from "@/lib/read-theses";
import { readAgent } from "@/lib/read-agent";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, {params}:{params:Promise<{slug:string}>}) {
  const {slug}=await params;
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(slug)) return NextResponse.json({error:"Invalid agent"},{status:400});
  const agent=await readAgent(slug);
  const activity = agent ? await readTheses({ agentSlug: slug, limit: 40 }) : null;
  return agent ? NextResponse.json({ ...agent, theses: activity?.theses ?? [], thesesRead: activity?.source !== "none" }) : NextResponse.json({error:"Agent not found"},{status:404});
}
