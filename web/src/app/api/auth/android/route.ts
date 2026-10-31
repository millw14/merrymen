import { NextResponse } from "next/server";
import { androidOAuthEnabled } from "@/lib/android-auth";
import { privyConfigured } from "@/lib/privy";
import { privyEnabled } from "@/lib/privy-client";
import { requestOrigin } from "@/lib/auth";
import { walletNotSupported } from "@/lib/route-guard";

/** Enable only after the HTTPS association and Privy redirect are deployed. */
export async function GET(req: Request) {
  const walletRefused = walletNotSupported(req);
  if (walletRefused) return walletRefused;
  return NextResponse.json({
    enabled: androidOAuthEnabled(requestOrigin(req), process.env.MERRYMEN_ANDROID_OAUTH_ENABLED, privyConfigured() && privyEnabled()),
  }, { headers: { "Cache-Control": "no-store" } });
}
