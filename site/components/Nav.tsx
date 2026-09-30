"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Logo } from "./Logo";
import { Icon } from "./Icon";

const links = [
  ["/#features", "Features"], ["/memescope", "Markets"], ["/dashboard", "Agents"],
  ["/watch", "Activity"], ["/claude", "Claude & MCP"], ["/api", "Developers"], ["/docs", "Docs"],
];
export function Nav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); toggle.current?.focus(); } };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open]);
  return <header className="nav">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <div className="wrap nav-inner">
      <Link href="/" className="brand" aria-label="Merrymen home" onClick={() => setOpen(false)}><Logo size={25} /><span>merrymen</span></Link>
      <nav className="nav-links" aria-label="Main navigation">
        {links.map(([href, title]) => <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}>{title}</Link>)}
      </nav>
      <div className="nav-right"><a href="https://app.merrymen.dev" className="btn btn-primary">Open app <Icon name="arrow" size={16} /></a><button ref={toggle} className="nav-menu-toggle" aria-expanded={open} aria-controls="mobile-navigation" aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen(!open)}>{open ? "✕" : <span aria-hidden>☰</span>}</button></div>
    </div>
    <nav className="mobile-navigation" id="mobile-navigation" aria-label="Mobile navigation" hidden={!open}>
      {[...links, ["/app", "Mobile app"], ["/token", "$MERRYMEN"], ["/#telegram", "Telegram"]].map(([href, title]) => <Link key={href} href={href} onClick={() => setOpen(false)} aria-current={pathname === href ? "page" : undefined}>{title}<span aria-hidden>↗</span></Link>)}
    </nav>
  </header>;
}
