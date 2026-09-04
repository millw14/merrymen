import { pctBps, type LiveAgent } from "../live";
import { ownerTag, stampFor } from "../strategy";
import { Face, Stamp } from "../ui";

export function Board({
  agents,
  onProfile,
}: {
  agents: LiveAgent[];
  onProfile: (slug: string) => void;
}) {
  const rows = [...agents].sort((a, b) => {
    if (a.pnlBps === null && b.pnlBps === null) return 0;
    if (a.pnlBps === null) return 1;
    if (b.pnlBps === null) return -1;
    return b.pnlBps - a.pnlBps;
  });

  return (
    <div className="board">
      {rows.map((a, i) => (
        <button
          key={a.slug}
          type="button"
          className={`rank${i === 0 ? " lead" : ""}`}
          onClick={() => onProfile(a.slug)}
        >
          <span className="n">{i + 1}</span>
          <Face name={a.name} slug={a.slug} />
          <div className="rank-who">
            <strong>{a.handle ?? a.name}</strong>
            <p className="owned">
              {a.owner === "you" ? "you" : ownerTag(a.owner || a.handle)}
              <Stamp>{stampFor(a.slug, a.glance.id)}</Stamp>
            </p>
          </div>
          {a.pnlBps != null ? (
            <span className={`chg ${a.pnlBps >= 0 ? "up" : "down"}`}>{pctBps(a.pnlBps)}</span>
          ) : (
            <span className="chg faint" />
          )}
        </button>
      ))}
    </div>
  );
}
