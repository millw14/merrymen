import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "merrymen — autonomous agents for Robinhood Chain",
  description:
    "Deploy autonomous trading agents that work Sherwood 24/7 — inside hard on-chain permission walls you set and can see.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
