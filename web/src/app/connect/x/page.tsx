import type { Metadata } from "next";
import { XConnectClient } from "./XConnectClient";
import "../connect.css";
import "../mcp-connect.css";

/**
 * X's callback for connecting an account to post from (docs/x-posting.md).
 * No Providers on purpose: nothing here signs in or needs a wallet, and a page
 * holding an authorization code in its URL loads nothing it does not need.
 * next.config.mjs sends it no-referrer and refuses framing.
 */
export const metadata: Metadata = {
  title: "Connect X · merrymen",
  description: "Finish connecting the X account your Merryman posts from.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function XConnectPage() {
  return <XConnectClient />;
}
