import Link from "next/link";
import { Logo } from "./Logo";
import { Icon } from "./Icon";

const GITHUB = "https://github.com/millw14/merrymen";
const X_URL = "https://x.com/MerrymenAI";

function XMark({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function Nav() {
  return (
    <header className="nav">
      <div className="wrap nav-inner">
        <Link href="/" className="brand">
          <Logo size={22} />
          <span>merrymen</span>
        </Link>
        <nav className="nav-links">
          <Link href="/#features" data-text="Features"><span>Features</span></Link>
          <Link href="/#telegram" data-text="Telegram"><span>Telegram</span></Link>
          <Link href="/token" data-text="Token"><span>Token</span></Link>
          <Link href="/docs" data-text="Docs"><span>Docs</span></Link>
        </nav>
        <div className="nav-right">
          <a href={X_URL} target="_blank" rel="noreferrer" className="nav-ghost nav-social" aria-label="merrymen on X">
            <XMark />
          </a>
          <a href={GITHUB} target="_blank" rel="noreferrer" className="nav-ghost">
            GitHub
          </a>
          <span className="mag" data-magnetic>
            <Link href="/docs" className="btn btn-primary has-box">
              Get started <span className="box"><Icon name="arrow" size={15} /></span>
            </Link>
          </span>
        </div>
      </div>
    </header>
  );
}
