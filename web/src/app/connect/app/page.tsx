import type { Metadata } from "next";
import { Providers } from "@/terminal/Providers";
import { DEFAULT_LOCALE } from "@/lib/locale";
import { ConsentClient } from "./ConsentClient";
import "../connect.css";
import "../mcp-connect.css";

export const metadata: Metadata = {
  title: "Connect an AI assistant · merrymen",
  description: "Choose what an AI assistant can see and do with your Merrymen agent.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ConsentPage() {
  return <Providers locale={DEFAULT_LOCALE}><ConsentClient /></Providers>;
}
