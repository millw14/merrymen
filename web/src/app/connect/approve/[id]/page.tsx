import type { Metadata } from "next";
import { Providers } from "@/terminal/Providers";
import { DEFAULT_LOCALE } from "@/lib/locale";
import { ApproveClient } from "./ApproveClient";
import "../../connect.css";
import "../../mcp-connect.css";

export const metadata: Metadata = {
  title: "Approve a request · merrymen",
  description: "Review and approve or decline something your AI assistant prepared.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function ApprovePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Providers locale={DEFAULT_LOCALE}><ApproveClient id={id} /></Providers>;
}
