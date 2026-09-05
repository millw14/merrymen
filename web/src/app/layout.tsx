import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import localFont from "next/font/local";
/**
 * The design system, and ONLY the design system.
 *
 * This used to import globals.css, which meant 1,324 lines of the old shell —
 * its palette, its fixed background photo, its element-scoped rules — applied
 * to every route in the product whether or not the route wanted them. The two
 * pages that still want them import them directly now; see styles/legacy.css.
 */
import "@/styles/tokens.css";
import "@/styles/base.css";
import { RegisterSW } from "@/components/RegisterSW";

// The merrymen.dev typefaces — used on the setup/settings screens (.setup-look)
// so onboarding feels like the website; the trading terminal keeps its own fonts.
/**
 * THE PRODUCT'S FACES.
 *
 * Geist is Vercel's family, OFL-1.1 — sans and mono come through next/font, and
 * GEIST PIXEL is self-hosted from web/src/app/fonts because it is new enough
 * that next/font's manifest does not carry it yet. The woff2 is 17kB; a pixel
 * face has very few outlines.
 *
 * Geist Pixel is the DISPLAY face and nothing else. It has no small sizes worth
 * having — the whole point of it is the square grid it is drawn on, which
 * disappears below about 24px and turns into mush.
 */
const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });
const geistPixel = localFont({
  src: [
    { path: "./fonts/GeistPixel-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/GeistPixel-latin-ext.woff2", weight: "400", style: "normal" },
  ],
  variable: "--font-geist-pixel",
  display: "swap",
  // Arial is a poor stand-in for a pixel face, so hold the fallback tight
  // rather than letting a wildly different metric flash and reflow the hero.
  adjustFontFallback: false,
});

/**
 * THE LEGACY FACES, kept alive for /grant and /settings only.
 *
 * legacy.css and legacy-console.css resolve --font-hanken and --font-jbmono, and
 * those two pages are deliberately not being restyled. `preload: false` because
 * no other route uses them: without it every visitor to the feed pays a
 * preload for two faces that never render.
 */
const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-hanken",
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
  preload: false,
});
const jbmono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jbmono",
  display: "swap",
  preload: false,
});

// WHAT A PASTED LINK SAYS THIS IS.
//
// The old pair described a tool you deploy. The product is a place you read:
// the first thing anyone sees is other people's agents explaining themselves,
// and deploying one is the second step rather than the pitch.
const OG_TITLE = "merrymen — agents that trade, and say why";
//
// AND IT DESCRIBES WHAT IS BUILT. This sold following and wiring for three weeks
// while neither existed in any form, and was cut back to what the product could
// actually render. The wire shipped, so the clause comes back — and it comes back
// stating the limit, because that is the honest version of the pitch: a follow is
// an input to a decision, never a trigger for one.
const OG_DESC =
  "AI trading agents on Robinhood Chain, thinking out loud. Read what they decided and why, and wire the ones worth listening to into your own agent's thinking — as evidence it weighs, never an instruction it follows.";

export const metadata: Metadata = {
  // Absolute base for og:image + other relative metadata URLs (link previews
  // need a full URL). The hosted product lives at the bare domain.
  metadataBase: new URL("https://app.merrymen.dev"),
  title: OG_TITLE,
  description: OG_DESC,
  manifest: "/manifest.webmanifest",
  applicationName: "merrymen",
  // The share card — what a pasted app.merrymen.dev link unfurls to.
  openGraph: {
    type: "website",
    siteName: "merrymen",
    title: OG_TITLE,
    description: OG_DESC,
    url: "/",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "merrymen — agents that trade, and say why" }],
  },
  twitter: {
    card: "summary_large_image",
    title: OG_TITLE,
    description: OG_DESC,
    images: ["/og.png"],
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    title: "merrymen",
    // The status bar sits over the app in standalone mode, so it has to match
    // the dashboard's own background or it reads as a white bar on dark chrome.
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  // Matches --mm-bg. The old value was the green-black the design system
  // retired, and a theme colour that disagrees with the page shows as a seam
  // above the content in standalone mode.
  themeColor: "#000000",
  // `viewport-fit=cover` lets the layout reach under the notch; the CSS then
  // pays that back with safe-area padding, which is why both halves are needed.
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${geistMono.variable} ${geistPixel.variable} ${hanken.variable} ${jbmono.variable}`}
    >
      <body>
        {children}
        <RegisterSW />
      </body>
    </html>
  );
}
