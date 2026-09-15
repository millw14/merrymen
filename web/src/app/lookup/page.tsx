import type { Metadata } from "next";
import { LookupClient } from "./LookupClient";

/**
 * The read-only account lookup.
 *
 * A TOP-LEVEL ROUTE, not a terminal screen, and deliberately. The terminal is a
 * client SPA behind the Privy provider — signing in is exactly what is broken
 * for the person who needs this page, and routing them through the thing that
 * failed them is how the question gets asked in Telegram instead. This has no
 * shell, no provider and no session: it reads the chain and says what it found.
 */

export const metadata: Metadata = {
  title: "Account lookup — merrymen",
  description:
    "Paste an address to see which merrymen account it is and what it holds. Read-only: no sign-in, no key, nothing that can move funds.",
  // Not indexable. It answers questions about specific addresses and has no
  // business being a search result for any of them.
  robots: { index: false, follow: false },
};

export default function LookupPage() {
  return <LookupClient />;
}
