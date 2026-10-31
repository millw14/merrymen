import type { Metadata } from "next";
import { PilotPage } from "@/pilot/PilotPage";
import { PilotAdmin } from "@/pilot/PilotAdmin";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Paper pilot administration", referrer: "no-referrer", robots: { index: false, follow: false } };
export default function AdminPaperPilot() { return <PilotPage><PilotAdmin/></PilotPage>; }
