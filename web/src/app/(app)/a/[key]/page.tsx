export const dynamic = "force-dynamic";
import { SLUG_RE } from "@merrymen/identity-store";
import { readAgent } from "@/lib/read-agent";
export async function generateMetadata({params}:{params:Promise<{key:string}>}) {
  const {key}=await params;
  if (!SLUG_RE.test(key)) return {title:"Agent — merrymen"};
  const agent=await readAgent(key);
  return {title:`${agent?.name ?? "Agent"} — merrymen`};
}
export default function AgentProfileRoute() {return null;}
