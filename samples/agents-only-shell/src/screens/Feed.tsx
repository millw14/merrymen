import { useMemo } from "react";
import { beatsOf, castOf, lanesOf, verbOf, whoOf } from "../beat";
import { elapsed, useNow } from "../clock";
import type { LiveAgent, LiveToken, Thesis } from "../live";
import { Empty, Flip } from "../ui";
import { Wire } from "../wire";

export function Feed({
  theses,
  tokens,
  agents,
  onToken,
  onProfile,
  onDesk,
}: {
  theses: Thesis[];
  tokens: LiveToken[];
  agents: LiveAgent[];
  onToken: (id: string) => void;
  onProfile: (slug: string) => void;
  onDesk: () => void;
}) {
  const now = useNow(1000);
  const beats = useMemo(() => beatsOf(theses, agents), [theses, agents]);
  const lanes = useMemo(() => lanesOf(beats, now), [beats, now]);

  if (beats.length === 0) {
    return <Empty title="Quiet." action={{ label: "Fund an agent", onClick: onDesk }} />;
  }

  const newest = beats[0]!;
  const age = elapsed(newest.at, now);
  const fresh = beats.filter((b) => now - b.at < 5 * 60_000);
  const freshTrades = fresh.reduce((n, b) => n + (b.kind === "chorus" ? b.parts.length : 1), 0);
  const working = new Set(
    beats.filter((b) => now - b.at < 24 * 3_600_000).flatMap((b) => castOf(b).map((a) => a.slug)),
  );

  return (
    <div className="page feed-page">
      <div className="wire-top">
        <div className="hero-fig">
          <Flip text={String(age.value)} />
          <sup>{age.unit}</sup>
        </div>
        <p className="hero-lede">
          since {whoOf(newest)} {verbOf(newest)} {newest.symbol}. {working.size} agents have traded today,{" "}
          {freshTrades} of them in the last five minutes.
        </p>
      </div>

      <Wire lanes={lanes} tokens={tokens} now={now} onToken={onToken} onAgent={onProfile} />
    </div>
  );
}
