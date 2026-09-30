import type { Metadata } from "next";
import { Providers } from "@/terminal/Providers";
import { DEFAULT_LOCALE } from "@/lib/locale";
import { ExportClient } from "./ExportClient";
import "../../connect.css";
import "../../mcp-connect.css";

export const metadata: Metadata = {
  title: "Download an export · merrymen",
  description: "Download a report your AI assistant prepared.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function ExportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Providers locale={DEFAULT_LOCALE}><ExportClient id={id} /></Providers>;
}
