import { useState, type ReactNode } from "react";
import { faceSrc } from "./live";
import { ownerTag } from "./strategy";

function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function gradient(seed: string): string {
  const h = hueOf(seed);
  return `linear-gradient(145deg, hsl(${h} 62% 62%), hsl(${(h + 42) % 360} 58% 44%))`;
}

export function Face({
  name,
  slug,
  large,
  small,
  pin,
}: {
  name: string;
  slug?: string | null;
  large?: boolean;
  small?: boolean;
  pin?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const src = faceSrc(slug ?? null);
  const cls = large ? "face lg" : pin ? "face pin" : small ? "face sm" : "face";
  return (
    <span className={cls} style={{ background: gradient(name) }} aria-hidden>
      {initialsOf(name)}
      {src && !failed && <img src={src} alt="" onError={() => setFailed(true)} />}
    </span>
  );
}

export function NameBlock({
  title,
  owner,
}: {
  title: string;
  owner?: string | null;
}) {
  return (
    <div className="name-block">
      <strong>{title}</strong>
      {owner ? (
        <p className="owned">{owner === "you" ? "owned by you" : `owned by ${ownerTag(owner)}`}</p>
      ) : null}
    </div>
  );
}

export function Stamp({ children }: { children: ReactNode }) {
  return <i className="tag">{children}</i>;
}

export function ThesisBody({ text }: { text: string }) {
  return <p className="thesis-body">{text}</p>;
}

export function Coin({ symbol, logo }: { symbol: string; logo: string }) {
  const [failed, setFailed] = useState(false);
  const initials =
    symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  return (
    <span className="coin" style={!logo || failed ? { background: gradient(symbol) } : undefined}>
      {!logo || failed ? (
        initials
      ) : (
        <img src={logo} alt="" onError={() => setFailed(true)} />
      )}
    </span>
  );
}

export function Pill({
  on,
  children,
  onClick,
}: {
  on: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" className={on ? "pill on" : "pill"} onClick={onClick}>
      {children}
    </button>
  );
}

export function Switch({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={on ? "switch on" : "switch"}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    >
      <i />
    </button>
  );
}

export function Spark({ values, down }: { values: number[]; down?: boolean }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 360;
  const h = 96;
  const pad = 3;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (v - min) / span) * (h - pad * 2);
    return `${x},${y}`;
  });
  return (
    <svg className={down ? "chart down" : "chart"} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <path className="line" d={`M ${pts.join(" L ")}`} />
    </svg>
  );
}

export function TabIcon({ id }: { id: "home" | "feed" | "agent" | "board" | "you" }) {
  switch (id) {
    case "home":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-8.5Z" />
        </svg>
      );
    case "feed":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M5 7h14M5 12h14M5 17h9" />
        </svg>
      );
    case "agent":
      return <LogoMark size={15} />;
    case "board":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M6 18V10M12 18V6M18 18v-5" />
        </svg>
      );
    case "you":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="9" r="3.1" />
          <path d="M5.6 19c1.3-2.8 3.8-4.2 6.4-4.2S17.1 16.2 18.4 19" />
        </svg>
      );
    default: {
      const _x: never = id;
      return _x;
    }
  }
}

export function LogoMark({ size = 22 }: { size?: number }) {
  const w = Math.round(size * (940 / 630));
  return (
    <svg
      className="logo-mark"
      width={w}
      height={size}
      viewBox="0 0 940 630"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect x="280" y="1" width="324" height="47" rx="23.5" />
      <rect x="403" y="72" width="258" height="49" rx="24.5" />
      <rect x="138" y="137" width="51" height="54" rx="25.5" />
      <rect x="473" y="137" width="227" height="54" rx="27" />
      <rect x="742" y="137" width="50" height="54" rx="25" />
      <rect x="64" y="212" width="199" height="48" rx="24" />
      <rect x="516" y="212" width="204" height="48" rx="24" />
      <rect x="766" y="212" width="109" height="48" rx="24" />
      <rect x="0" y="288" width="126" height="48" rx="24" />
      <rect x="161" y="288" width="582" height="48" rx="24" />
      <rect x="812" y="288" width="128" height="48" rx="24" />
      <rect x="64" y="366" width="199" height="47" rx="23.5" />
      <rect x="518" y="366" width="202" height="47" rx="23.5" />
      <rect x="766" y="366" width="109" height="47" rx="23.5" />
      <rect x="138" y="436" width="51" height="48" rx="24" />
      <rect x="473" y="436" width="227" height="48" rx="24" />
      <rect x="742" y="436" width="51" height="48" rx="24" />
      <rect x="403" y="510" width="259" height="48" rx="24" />
      <rect x="280" y="582" width="324" height="47" rx="23.5" />
    </svg>
  );
}
