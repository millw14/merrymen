import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { isHostedMode } from "@merrymen/core";
import { Providers } from "../terminal/Providers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale } from "../lib/locale";

/** Registration is available before paper launch; only hosted login is needed. */
export async function PilotPage({ children }: { children: ReactNode }) {
  if (!isHostedMode()) notFound();
  const jar = await cookies();
  return <Providers locale={normalizeLocale(jar.get(LOCALE_COOKIE)?.value) ?? DEFAULT_LOCALE}>{children}</Providers>;
}
