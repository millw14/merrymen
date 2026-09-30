import Link from "next/link";
import { Logo } from "./Logo";
import { TokenCA } from "./TokenCA";

const GITHUB = "https://github.com/millw14/merrymen";
const NPM = "https://www.npmjs.com/package/merrymen";
const X_URL = "https://x.com/MerrymenAI";
const SUPPORT = "support@merrymen.dev";
/**
 * The beta testers' room. Labelled "Beta group" rather than "Telegram" on
 * purpose — the Product and Docs columns already say "Telegram", meaning the
 * bot you connect to your own agent. Three identical labels pointing at two
 * unrelated things is how someone ends up pasting a bot token into a group
 * chat. Kept in sync with TELEGRAM_BETA in app/page.tsx.
 */
const TELEGRAM_BETA = "https://t.me/+oL-7xzghFwA4OTc8";

export function Footer() {
  return (
    <footer className="foot">
      <div className="wrap">
        <div className="foot-grid">
          <div className="foot-brand">
            <Link href="/" className="brand">
              <Logo size={20} />
              <span>merrymen</span>
            </Link>
            <p>Trading agents you never have to trust. Non-custodial on-chain trading: your owner key, your caps, your call.</p>
          </div>

          <div className="foot-col">
            <h5>Product</h5>
            <Link href="/#features">Features</Link>
            <Link href="/memescope">Memescope</Link>
            <Link href="/dashboard">Your merryman, live</Link>
            <Link href="/watch">Watch it trade</Link>
            <Link href="/#telegram">Telegram</Link>
            <Link href="/#install">Install</Link>
            <Link href="/#safety">Safety model</Link>
          </div>

          <div className="foot-col">
            <h5>Docs</h5>
            <Link href="/docs">Getting started</Link>
            <Link href="/api">API & SDK</Link>
            <Link href="/claude">Use it in Claude</Link>
            <Link href="/docs#wallet">Create a wallet</Link>
            <Link href="/docs#telegram">Set up Telegram</Link>
            <Link href="/docs#pc-control">PC control</Link>
            <a href={`mailto:${SUPPORT}`}>Support</a>
          </div>

          <div className="foot-col">
            <h5>Project</h5>
            <a href={TELEGRAM_BETA} target="_blank" rel="noreferrer">Beta group</a>
            <a href={X_URL} target="_blank" rel="noreferrer">X (Twitter)</a>
            <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
            <a href={NPM} target="_blank" rel="noreferrer">npm</a>
            <Link href="/token">$MERRYMEN · the Circle</Link>
            <Link href="/governance">Governance</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
          </div>
        </div>

        <TokenCA />

        <div className="foot-bottom">
          <span>© {new Date().getFullYear()} merrymen · MIT-licensed, open source</span>
          <span>
            Support: <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a> · Not financial advice. Trade at your own risk.
          </span>
        </div>
      </div>
    </footer>
  );
}
