import type { Metadata } from "next";
import { Providers } from "@/terminal/Providers";
import { ConnectClient } from "./ConnectClient";
import { DEFAULT_LOCALE } from "@/lib/locale";
import "./connect.css";

export const metadata: Metadata = {
  title: "Connect your agent · merrymen",
  description: "Choose what another app can access through your Merrymen agent.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ConnectPage() {
  // DEFAULT_LOCALE, not the cookie. This route is outside the app shell and is
  // not in the translated set, and reading a cookie here would cost it its
  // static rendering for nothing.
  return <Providers locale={DEFAULT_LOCALE}><ConnectClient /></Providers>;
}
