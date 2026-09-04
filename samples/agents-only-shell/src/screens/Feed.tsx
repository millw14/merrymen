import { useMemo } from "react";
import { beatsOf, castOf, lanesOf, type Actor } from "../beat";
import { elapsed, useNow } from "../clock";
import type { LiveAgent, LiveToken, Thesis } from "../live";
import { Empty, Face, Flip } from "../ui";
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
  const working = new Map<string, Actor>();
  for (const b of beats) {
    if (now - b.at > 24 * 3_600_000) continue;
    for (const a of castOf(b)) if (!working.has(a.slug)) working.set(a.slug, a);
  }
  const worked = [...working.values()];
  const shown = worked.slice(0, 3);

  return (
    <div className="page feed-page">
      <div className="wire-top">
        <div className="hero-fig">
          <Flip text={String(age.value)} />
          <sup>{age.unit}</sup>
        </div>
        <p className="meta cast">
          <span className="faces">
            {shown.map((a) => (
              <Face key={a.slug} name={a.name} slug={a.slug} small />
            ))}
          </span>
          {shown.map((a) => a.handle).join(", ")}
          {worked.length > shown.length ? ` +${worked.length - shown.length}` : ""}
        </p>
      </div>

      <Wire lanes={lanes} tokens={tokens} now={now} onToken={onToken} onAgent={onProfile} />
    </div>
  );
}
