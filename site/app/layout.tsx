import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-jb", display: "swap" });

const url = "https://merrymen.dev";

export const metadata: Metadata = {
  metadataBase: new URL(url),
  title: {
    default: "merrymen — autonomous trading agents for Robinhood Chain",
    template: "%s — merrymen",
  },
  description:
    "Self-hosted autonomous trading agents for Robinhood Chain. Your keys, your caps, hard on-chain permission walls. Name your agent, chat with it and control it from Telegram — it can even run your PC.",
  keywords: ["merrymen", "Robinhood Chain", "trading agent", "self-hosted", "Telegram bot", "crypto", "autonomous agent"],
  openGraph: {
    title: "merrymen — autonomous trading agents for Robinhood Chain",
    description:
      "Self-hosted trading agents inside hard on-chain permission walls. Chat with and control your agent from Telegram.",
    url,
    siteName: "merrymen",
    type: "website",
  },
  twitter: { card: "summary_large_image", title: "merrymen", description: "Autonomous trading agents you own and control." },
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body>
        <div className="page">
          <div className="aurora" />
          <Nav />
          <main>{children}</main>
          <Footer />
        </div>
      </body>
    </html>
  );
}
