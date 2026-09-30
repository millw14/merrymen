import { cookies } from "next/headers";

import { App } from "@/terminal/App";
import { Providers } from "@/terminal/Providers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale } from "@/lib/locale";

// The whole terminal mounts here and nowhere else, so this is the one place a
// provider has to sit for every screen to be inside it. Still a SERVER
// component — it imports a client module and passes a client element as
// children, which does not make this file client code.

/**
 * WHY THIS ROUTE GROUP IS RENDERED PER REQUEST, AND WHAT THAT BOUGHT.
 *
 * Reading a cookie here is the first request-time read in the app, and it costs
 * these nineteen routes their static rendering. That is a real cost and it was
 * taken deliberately, because the alternative is worse for the person this work
 * is for.
 *
 * COPY IS NOT A FIGURE. `format.ts` may read `html[lang]` from the DOM because
 * every figure is null at SSR, so what the server renders is an em dash in any
 * language. Text has no such property: it renders on the first paint with no
 * data behind it. A server that guessed English while the reader had chosen
 * Spanish would hand React two different sentences for the same node, and React
 * would resolve that by replacing the text the reader is already looking at.
 *
 * SCOPED TO `(app)` RATHER THAN THE ROOT LAYOUT, which is why `/connect`,
 * `/lookup` and the redirect routes are untouched and still static. What became
 * dynamic is the app shell, which sits behind a sign-in and is not a page
 * anybody links to. The render reaches no database — `mounted.test.ts` proves
 * that by walking the import graph — so the cost is CPU, not a round trip.
 *
 * The `<html lang>` attribute is NOT set from here. It is still written by the
 * inline script in the root layout, before the first paint, so the font stacks
 * resolve without this route group having to be involved.
 */
export default async function AppLayout() {
  const jar = await cookies();
  const locale = normalizeLocale(jar.get(LOCALE_COOKIE)?.value) ?? DEFAULT_LOCALE;
  return (
    <Providers locale={locale}>
      <App />
    </Providers>
  );
}
