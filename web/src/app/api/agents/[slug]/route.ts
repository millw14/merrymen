import { NextResponse } from "next/server";
import { readAgent } from "@/lib/read-agent";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, {params}:{params:Promise<{slug:string}>}) {
  const {slug}=await params;
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(slug)) return NextResponse.json({error:"Invalid agent"},{status:400});
  const agent=await readAgent(slug);
  return agent ? NextResponse.json(agent) : NextResponse.json({error:"Agent not found"},{status:404});
}
