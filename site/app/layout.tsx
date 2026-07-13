import type { Metadata } from "next";
import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { ScrollFx } from "@/components/ScrollFx";

// A refined, warm humanist grotesque — the closest open-source match to the
// polished agency-grade grotesques these sites use. One family, many weights.
const hanken = Hanken_Grotesk({
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
    "Self-hosted trading agents for Robinhood Chain that you never have to trust: keys stay on your machine, every cap is enforced by the account contract on-chain. Name your agent, chat with it and steer it from Telegram.",
  keywords: ["merrymen", "Robinhood Chain", "trading agent", "self-hosted", "non-custodial", "self-custody", "Telegram bot", "crypto", "autonomous agent"],
  openGraph: {
    title: "merrymen — trading agents you never have to trust",
    description:
      "Self-hosted, non-custodial trading agents inside caps the chain itself enforces. Verify the wall on-chain; steer the band from Telegram.",
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
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${hanken.variable} ${mono.variable}`}>
      <body>
        {/* Arm the reveal layer before first paint so content never flashes in
            un-animated; a delayed backstop un-hides everything if JS stalled. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var d=document.documentElement;if(!matchMedia('(prefers-reduced-motion: reduce)').matches){d.classList.add('fx-ready');setTimeout(function(){if(!document.querySelector('[data-reveal].is-in'))d.classList.add('fx-done')},4000)}}catch(e){}",
          }}
        />
        <div className="page">
          <div className="ambient" />
          <div className="halftone" />
          <div className="grain" />
          <ScrollFx />
          <Nav />
          <main>{children}</main>
          <Footer />
        </div>
      </body>
    </html>
  );
}
