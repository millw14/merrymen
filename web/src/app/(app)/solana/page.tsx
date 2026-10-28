import { notFound } from "next/navigation";
import { solanaEnabled } from "@/lib/solana-enabled";

// Per request, so the 404 follows the server's switch rather than the build's.
export const dynamic = "force-dynamic";
export default function TerminalRoute() {
  if (!solanaEnabled()) notFound();
  return null;
}
