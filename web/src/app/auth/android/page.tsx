import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { Providers } from "@/terminal/Providers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale } from "@/lib/locale";
import { androidAuthReturnHref, isAndroidAuthWebView } from "@/lib/android-auth";
import { AndroidSignIn } from "./AndroidSignIn";
import { privyEnabled } from "@/lib/privy-client";

export const metadata: Metadata = { title: "Sign in to Merrymen", referrer: "no-referrer", robots: { index: false, follow: false } };

export default async function AndroidAuthPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const h = await headers();
  // The external browser has another storage partition. Let the original
  // WebView finish its saved state/PKCE flow, then the existing owner proof.
  // The UA only selects presentation; it grants no authority or session.
  if (!isAndroidAuthWebView(h.get("user-agent") ?? "") || !privyEnabled()) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(await searchParams)) {
      for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, item);
    }
    const href = androidAuthReturnHref(params);
    return <main style={{ maxWidth: 480, margin: "0 auto", padding: "48px 24px" }}>
      <h1>Return to Merrymen</h1>
      <p>Finish this sign-in in the Merrymen app where you started.</p>
      {href && <a className="flow-primary" href={href} referrerPolicy="no-referrer">Return to the app</a>}
      <p>If the app does not open, return to it and choose “Continue in Merrymen”.</p>
      <a href="/home">Open Merrymen on the web</a>
    </main>;
  }
  const jar = await cookies();
  const locale = normalizeLocale(jar.get(LOCALE_COOKIE)?.value) ?? DEFAULT_LOCALE;
  return <Providers locale={locale}><AndroidSignIn /></Providers>;
}
