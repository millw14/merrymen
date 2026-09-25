import type { Metadata } from "next";
import { Providers } from "@/terminal/Providers";
import { DEFAULT_LOCALE } from "@/lib/locale";
import { AppsClient } from "./AppsClient";
import "../connect.css";
import "../mcp-connect.css";

export const metadata: Metadata = {
  title: "Connected apps · merrymen",
  description: "See and revoke the AI assistants and tokens that can reach your Merrymen agent.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ConnectedAppsPage() {
  return <Providers locale={DEFAULT_LOCALE}><AppsClient /></Providers>;
}
