import { useEffect, useMemo, useState } from "react";
import { beatsOf, lanesOf, type Beat } from "../beat";
import type { LiveAgent, LiveToken, Thesis } from "../live";
import { Empty } from "../ui";
import { Wire } from "../wire";

type Asset = "all" | "stock" | "etf";
type Topic =
  | "trades"
  | "closed"
  | "theses"
  | "multi"
  | "listings"
  | "spikes"
  | "milestones"
  | "newcomers";

const ASSETS: { id: Asset; label: string }[] = [
  { id: "all", label: "All" },
  { id: "stock", label: "Stocks" },
  { id: "etf", label: "ETFs" },
];

const TOPICS: { id: Topic; label: string }[] = [
  { id: "trades", label: "Trades" },
  { id: "closed", label: "Closed positions" },
  { id: "theses", label: "Theses" },
  { id: "multi", label: "Multi-user trades" },
  { id: "listings", label: "New listings" },
  { id: "spikes", label: "Price spikes" },
  { id: "milestones", label: "Profit milestones" },
  { id: "newcomers", label: "New traders" },
];

const SPIKE = 2;
const MILESTONE = 100;
const MULTI_MS = 12 * 3_600_000;

function allTopics(): Record<Topic, boolean> {
  return {
    trades: true,
    closed: true,
    theses: true,
    multi: true,
    listings: true,
    spikes: true,
    milestones: true,
    newcomers: true,
  };
}

function emptyTopics(): Record<Topic, boolean> {
  return {
    trades: false,
    closed: false,
    theses: false,
    multi: false,
    listings: false,
    spikes: false,
    milestones: false,
    newcomers: false,
  };
}

export function Feed({
  compact = false,
  theses,
  tokens,
  agents,
  onToken,
  onProfile,
  onDesk,
}: {
  compact?: boolean;
  theses: Thesis[];
  tokens: LiveToken[];
  agents: LiveAgent[];
  onToken: (id: string) => void;
  onProfile: (slug: string) => void;
  onDesk: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState(false);
  const [asset, setAsset] = useState<Asset>("all");
  const [on, setOn] = useState(allTopics);

  const beats = useMemo(() => beatsOf(theses, agents), [theses, agents]);
  const tape = useMemo(() => tapeOf(beats), [beats]);
  const shown = useMemo(
    () => beats.filter((b) => keepBeat(b, tokens, on, asset, tape)),
    [beats, tokens, on, asset, tape],
  );
  const lanes = useMemo(() => lanesOf(shown), [shown]);
  const chosen = countOn(on);
  const filtered = asset !== "all" || chosen < TOPICS.length;

  const reset = () => {
    setAsset("all");
    setOn(allTopics());
  };

  useEffect(() => {
    if (!open) {
      setPick(false);
      return;
    }
    const hide = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const scroller = document.querySelector(".body");
    const prev = scroller instanceof HTMLElement ? scroller.style.overflow : "";
    if (scroller instanceof HTMLElement) scroller.style.overflow = "hidden";
    document.addEventListener("keydown", hide);
    return () => {
      if (scroller instanceof HTMLElement) scroller.style.overflow = prev;
      document.removeEventListener("keydown", hide);
    };
  }, [open]);

  return (
    <div className="page feed-page">
      <header className="feed-head">
        {compact ? (
          <h2>Latest activity</h2>
        ) : (
          <h1 className="top-title">Feed</h1>
        )}
        <button
          type="button"
          className={`${compact ? "sidebar-feed-filter" : "icon-btn"} ${filtered ? "on" : ""}`}
          aria-label="Filter"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          {compact ? "Filters" : <FilterIcon />}
        </button>
      </header>

      {shown.length === 0 ? (
        filtered ? (
          <Empty
            title="Nothing matches."
            action={{ label: "Clear filters", onClick: reset }}
          />
        ) : (
          <Empty
            title="Quiet."
            action={{ label: "Fund an agent", onClick: onDesk }}
          />
        )
      ) : (
        <Wire
          lanes={lanes}
          tokens={tokens}
          onToken={onToken}
          onAgent={onProfile}
        />
      )}

      {open && (
        <div className="feed-scrim" onClick={() => setOpen(false)}>
          <div
            className="feed-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Filters"
            onClick={(e) => e.stopPropagation()}
          >
            <i className="feed-grip" aria-hidden />
            <h2>Filters</h2>
            <div className="feed-asset">
              <span>Asset Type</span>
              <div className="feed-asset-pick">
                <button
                  type="button"
                  aria-expanded={pick}
                  onClick={() => setPick((v) => !v)}
                >
                  {labelOf(asset)}
                  <Chevron />
                </button>
                {pick && (
                  <div className="feed-asset-menu" role="listbox">
                    {ASSETS.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        role="option"
                        aria-selected={asset === a.id}
                        className={asset === a.id ? "on" : ""}
                        onClick={() => {
                          setAsset(a.id);
                          setPick(false);
                        }}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <button
              type="button"
              className="feed-clear"
              onClick={() => setOn(chosen === 0 ? allTopics() : emptyTopics())}
            >
              {chosen === 0 ? "Select all" : "Deselect all"}
            </button>
            <ul className="feed-topics">
              {TOPICS.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on[t.id]}
                    className={on[t.id] ? "on" : ""}
                    onClick={() =>
                      setOn((prev) => ({ ...prev, [t.id]: !prev[t.id] }))
                    }
                  >
                    <span>{t.label}</span>
                    <i className="feed-check" aria-hidden>
                      {on[t.id] ? <Tick /> : null}
                    </i>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="feed-shut"
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FilterIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function Tick() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
    >
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}

function labelOf(asset: Asset): string {
  switch (asset) {
    case "all":
      return "All";
    case "stock":
      return "Stocks";
    case "etf":
      return "ETFs";
    default: {
      const _x: never = asset;
      return _x;
    }
  }
}

function countOn(on: Record<Topic, boolean>): number {
  return TOPICS.reduce((n, t) => n + (on[t.id] ? 1 : 0), 0);
}

function slugsOf(beat: Beat): string[] {
  return beat.kind === "chorus"
    ? beat.actors.map((a) => a.slug)
    : [beat.actor.slug];
}

function otherHand(a: Beat, b: Beat): boolean {
  const left = slugsOf(a);
  const right = slugsOf(b);
  return (
    left.some((s) => !right.includes(s)) || right.some((s) => !left.includes(s))
  );
}

interface Tape {
  once: Set<string>;
  crowd: Set<string>;
  first: Set<string>;
}

function tapeOf(beats: Beat[]): Tape {
  const n = new Map<string, number>();
  const firstAt = new Map<string, number>();
  const firstId = new Map<string, string>();
  for (const b of beats) {
    for (const slug of slugsOf(b)) n.set(slug, (n.get(slug) ?? 0) + 1);
    const prev = firstAt.get(b.symbol);
    if (prev == null || b.at < prev) {
      firstAt.set(b.symbol, b.at);
      firstId.set(b.symbol, b.id);
    }
  }
  const crowd = new Set<string>();
  for (const a of beats) {
    const hit = beats.some(
      (b) =>
        a.id !== b.id &&
        a.symbol === b.symbol &&
        Math.abs(a.at - b.at) <= MULTI_MS &&
        otherHand(a, b),
    );
    if (hit) crowd.add(a.id);
  }
  return {
    once: new Set([...n].filter(([, c]) => c === 1).map(([slug]) => slug)),
    crowd,
    first: new Set(firstId.values()),
  };
}

function keepBeat(
  beat: Beat,
  tokens: LiveToken[],
  on: Record<Topic, boolean>,
  asset: Asset,
  tape: Tape,
): boolean {
  const tok = tokens.find((t) => t.symbol.toUpperCase() === beat.symbol);
  if (asset !== "all" && tok?.kind !== asset) return false;
  return marksOf(beat, tok, tape).some((t) => on[t]);
}

function marksOf(beat: Beat, tok: LiveToken | undefined, tape: Tape): Topic[] {
  const out: Topic[] = [];
  if (beat.action === "buy") out.push("trades");
  if (beat.action === "sell") out.push("closed");
  const said =
    beat.kind === "trade"
      ? beat.reason.trim()
      : beat.parts.some((p) => p.reason.trim());
  if (said) out.push("theses");
  if (tape.crowd.has(beat.id)) out.push("multi");
  if (tape.first.has(beat.id)) out.push("listings");
  if (tok && tok.change24hPct != null && Math.abs(tok.change24hPct) >= SPIKE)
    out.push("spikes");
  if (beat.sizeUsd != null && beat.sizeUsd >= MILESTONE) out.push("milestones");
  if (slugsOf(beat).every((s) => tape.once.has(s))) out.push("newcomers");
  return out;
}
