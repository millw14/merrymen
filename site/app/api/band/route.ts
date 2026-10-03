import { NextResponse } from "next/server";
import { PUBLIC_LEADERBOARD, readPublicAgents } from "@/lib/public-leaderboard";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const response = await fetch(PUBLIC_LEADERBOARD, { cache: "no-store" });
    if (!response.ok) {
      return NextResponse.json({ agents: null }, { status: 502 });
    }
    const agents = readPublicAgents(await response.json());
    if (!agents) {
      return NextResponse.json({ agents: null }, { status: 502 });
    }
    return NextResponse.json(
      { total: agents.length, agents: agents.slice(0, 5) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ agents: null }, { status: 502 });
  }
}
