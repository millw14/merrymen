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
          <Link href="/#features" data-text="Features"><span>Features</span></Link>
          <Link href="/#telegram" data-text="Telegram"><span>Telegram</span></Link>
          <Link href="/#install" data-text="Install"><span>Install</span></Link>
          <Link href="/docs" data-text="Docs"><span>Docs</span></Link>
        </nav>
        <div className="nav-right">
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
