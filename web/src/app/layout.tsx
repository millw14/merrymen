import type { Metadata } from "next";
import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

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
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${hanken.variable} ${jbmono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
