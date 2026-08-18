import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { RegisterSW } from "@/components/RegisterSW";
import { TelegramLinkModal } from "@/components/TelegramLinkModal";

// The merrymen.dev typefaces — used on the setup/settings screens (.setup-look)
// so onboarding feels like the website; the trading terminal keeps its own fonts.
const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-hanken",
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});
const jbmono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jbmono", display: "swap" });

export const metadata: Metadata = {
  title: "merrymen — autonomous agents for Robinhood Chain",
  description:
    "Deploy autonomous trading agents that work Sherwood 24/7 — inside hard on-chain permission walls you set and can see.",
  manifest: "/manifest.webmanifest",
  applicationName: "merrymen",
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
  themeColor: "#0d1512",
  // `viewport-fit=cover` lets the layout reach under the notch; the CSS then
  // pays that back with safe-area padding, which is why both halves are needed.
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${hanken.variable} ${jbmono.variable}`}>
      <body>
        {children}
        <RegisterSW />
        <TelegramLinkModal />
      </body>
    </html>
  );
}
