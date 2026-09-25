import type { Metadata } from "next";
import { DM_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "./brand.css";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { ScrollFx } from "@/components/ScrollFx";

// Match the hosted application’s primary typeface.
const sans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-jb", display: "swap" });

const url = "https://merrymen.dev";

export const metadata: Metadata = {
  metadataBase: new URL(url),
  title: {
    default: "merrymen — trading agents you never have to trust",
    template: "%s — merrymen",
  },
  description:
    "Trading agents you never have to trust — self-hosted or hosted. On-chain trading is non-custodial: your owner key never leaves you, every cap enforced by the account contract itself. Name your agent, chat with it and steer it from Telegram, or connect it to Claude and other AI assistants through the Merrymen MCP server.",
  // "non-custodial" is scoped to on-chain trading everywhere it appears —
  // deliberately, per the venue split in spikes/robinhood-mcp/DESIGN.md §9: a
  // future brokerage rail is custodial by construction (the broker holds the
  // account; merrymen holds a revocable trading token), and a product-wide
  // absolute here would become false the day it ships.
  keywords: ["merrymen", "Robinhood Chain", "trading agent", "self-hosted", "non-custodial on-chain trading", "session keys", "Telegram bot", "crypto", "autonomous agent", "MCP", "MCP server", "Claude", "Claude connector"],
  openGraph: {
    title: "merrymen — trading agents you never have to trust",
    description:
      "Trading agents inside hard caps — on-chain, the chain itself enforces them, non-custodially. Self-host it or run it hosted; your owner key never leaves you. Verify the wall in the explorer; steer the band from Telegram.",
    url,
    siteName: "merrymen",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "merrymen",
    description: "Trading agents you never have to trust — your keys, your caps, enforced on-chain.",
    site: "@MerrymenAI",
    creator: "@MerrymenAI",
  },
  icons: { icon: "/favicon.svg?v=2" },
  // Site-verification tokens (public by design — they prove ownership of the
  // domain to third-party platforms). Rendered as <meta name=… content=… />.
  other: {
    "virtual-protocol-site-verification": "26638f81e63af7797ea3c878c60be319",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <div className="page">
          <ScrollFx />
          <Nav />
          <div id="main-content" tabIndex={-1}>{children}</div>
          <Footer />
        </div>
      </body>
    </html>
  );
}
