import type { Metadata } from "next";
import { PilotPage } from "@/pilot/PilotPage";
import { PilotJoin } from "@/pilot/PilotJoin";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Join the paper Perps pilot", referrer: "no-referrer", robots: { index: false, follow: false } };
export default function JoinPaperPilot() { return <PilotPage><PilotJoin/></PilotPage>; }
