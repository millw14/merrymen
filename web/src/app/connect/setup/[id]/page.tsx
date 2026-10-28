import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Providers } from "@/terminal/Providers";
import { DEFAULT_LOCALE } from "@/lib/locale";
import { SetupClient } from "./SetupClient";
import "../../connect.css";
import "./setup.css";

export const metadata: Metadata = {
  title: "Review your Merryman · merrymen",
  description: "Review your assistant’s setup and trading limits, sign with your wallet, then return to your chat.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function SetupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^prp_[0-9a-f]{32}$/.test(id)) notFound();
  return <Providers locale={DEFAULT_LOCALE}><SetupClient id={id} /></Providers>;
}
