import Link from "next/link";
import { Logo } from "./Logo";
import { Icon } from "./Icon";

const GITHUB = "https://github.com/millw14/merrymen";

export function Nav() {
  return (
    <header className="nav">
      <div className="wrap nav-inner">
        <Link href="/" className="brand">
          <Logo size={22} />
          <span>merrymen</span>
        </Link>
        <nav className="nav-links">
          <Link href="/#features">Features</Link>
          <Link href="/#telegram">Telegram</Link>
          <Link href="/#install">Install</Link>
          <Link href="/docs">Docs</Link>
        </nav>
        <div className="nav-right">
          <a href={GITHUB} target="_blank" rel="noreferrer" className="nav-ghost">
            GitHub
          </a>
          <Link href="/docs" className="btn btn-primary">
            Get started <Icon name="arrow" size={15} />
          </Link>
        </div>
      </div>
    </header>
  );
}
