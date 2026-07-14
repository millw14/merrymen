import Link from "next/link";
import { Logo } from "./Logo";
import { TokenCA } from "./TokenCA";

const GITHUB = "https://github.com/millw14/merrymen";
const NPM = "https://www.npmjs.com/package/merrymen";
const X_URL = "https://x.com/MerrymenAI";
const TOKEN_EXPLORER = "https://robinhoodchain.blockscout.com/token/0xa15cd06dd305269a0f48bebeb30aa3588fba7b32";

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
            <p>Trading agents you never have to trust. Your keys, your caps, your machine — enforced on-chain.</p>
          </div>

          <div className="foot-col">
            <h5>Product</h5>
            <Link href="/#features">Features</Link>
            <Link href="/#telegram">Telegram</Link>
            <Link href="/#install">Install</Link>
            <Link href="/#safety">Safety model</Link>
          </div>

          <div className="foot-col">
            <h5>Docs</h5>
            <Link href="/docs">Getting started</Link>
            <Link href="/docs#wallet">Create a wallet</Link>
            <Link href="/docs#telegram">Set up Telegram</Link>
            <Link href="/docs#pc-control">PC control</Link>
          </div>

          <div className="foot-col">
            <h5>Project</h5>
            <a href={X_URL} target="_blank" rel="noreferrer">X (Twitter)</a>
            <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
            <a href={NPM} target="_blank" rel="noreferrer">npm</a>
            <a href={TOKEN_EXPLORER} target="_blank" rel="noreferrer">$MERRYMEN token</a>
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
          </div>
        </div>

        <TokenCA />

        <div className="foot-bottom">
          <span>© {new Date().getFullYear()} merrymen · MIT-licensed, open source</span>
          <span>Not financial advice. Trade at your own risk.</span>
        </div>
      </div>
    </footer>
  );
}
