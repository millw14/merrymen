import { castOf, regretOf, verbOf, whoOf, type Beat, type Lane } from "./beat";
import { elapsed } from "./clock";
import { money, pctPts, type LiveToken } from "./live";
import { Face, FaceOn, FacesOn } from "./ui";

function logoOf(tokens: LiveToken[], symbol: string): LiveToken | undefined {
  return tokens.find((t) => t.symbol.toUpperCase() === symbol.toUpperCase());
}

export function Wire({
  lanes,
  tokens,
  now,
  solo,
  onToken,
  onAgent,
}: {
  lanes: Lane[];
  tokens: LiveToken[];
  now: number;
  /** One agent's own rail: every beat is theirs, so the agent count is noise. */
  solo?: boolean;
  onToken?: (id: string) => void;
  onAgent?: (slug: string) => void;
}) {
  let first = true;
  return (
    <div className="wire">
      {lanes.map((lane) => {
        switch (lane.kind) {
          case "span":
            return (
              <div key={lane.id} className="wire-span">
                <span className="wire-gut" />
                <i className="wire-node span" aria-hidden />
                <div className="wire-body">
                  <strong>{lane.label}</strong>
                  <span>
                    {lane.trades} {lane.trades === 1 ? "trade" : "trades"}
                    {solo ? "" : ` · ${lane.agents} ${lane.agents === 1 ? "agent" : "agents"}`}
                    {lane.movedUsd > 0 ? ` · $${Math.round(lane.movedUsd).toLocaleString("en-US")} moved` : ""}
                  </span>
                </div>
              </div>
            );
          case "lull":
            return (
              <div key={lane.id} className="wire-lull" aria-hidden>
                <span className="wire-gut" />
                <i className="wire-node lull" />
              </div>
            );
          case "beat": {
            const live = first;
            first = false;
            return (
              <BeatRow
                key={lane.id}
                beat={lane.beat}
                big={lane.big}
                tokens={tokens}
                now={now}
                live={live}
                onToken={onToken}
                onAgent={onAgent}
              />
            );
          }
          default: {
            const _x: never = lane;
            return _x;
          }
        }
      })}
    </div>
  );
}

function BeatRow({
  beat,
  big,
  tokens,
  now,
  live,
  onToken,
  onAgent,
}: {
  beat: Beat;
  big: number | null;
  tokens: LiveToken[];
  now: number;
  live?: boolean;
  onToken?: (id: string) => void;
  onAgent?: (slug: string) => void;
}) {
  const tok = logoOf(tokens, beat.symbol);
  const cast = castOf(beat);
  const age = elapsed(beat.at, now);
  const regret = regretOf(beat);
  const open = () => {
    if (tok && onToken) onToken(tok.id);
    else if (onAgent) onAgent(cast[0]!.slug);
  };

  if (beat.kind === "trade" && beat.action === "hold") {
    return (
      <div className="wire-beat hold quiet">
        <span className="wire-gut">{live ? "now" : age.text}</span>
        <i className={live ? "wire-node beat now" : "wire-node beat"} aria-hidden />
        <div className="wire-body">
          <button type="button" className="wire-quiet" onClick={open}>
            <Face name={beat.actor.name} slug={beat.actor.slug} small />
            <span>
              <strong>{beat.actor.handle}</strong> held {beat.symbol}
            </span>
          </button>
          {beat.reason ? <p className="wire-why">{beat.reason}</p> : null}
        </div>
      </div>
    );
  }

  const chorus = beat.kind === "chorus";
  const cls = ["wire-beat", beat.action, chorus ? "chorus" : "", big ? "big" : "", live ? "live" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls}>
      <span className="wire-gut">{live ? "now" : age.text}</span>
      <i className={live ? "wire-node beat now" : "wire-node beat"} aria-hidden />
      <div className="wire-body">
        <button type="button" className="wire-hit" onClick={open}>
          {chorus ? (
            <FacesOn cast={cast} symbol={beat.symbol} logo={tok?.logo ?? ""} />
          ) : (
            <FaceOn name={cast[0]!.name} slug={cast[0]!.slug} symbol={beat.symbol} logo={tok?.logo ?? ""} />
          )}
          <span className="wire-said">
            <span className="wire-line">
              <strong>{whoOf(beat)}</strong> {verbOf(beat)} {beat.symbol}
            </span>
            {beat.sizeUsd != null && (
              <span className="wire-size">
                <b>{money(beat.sizeUsd)}</b>
                {sideOf(beat)}
              </span>
            )}
          </span>
        </button>

        {beat.kind === "trade" ? (
          beat.reason ? <p className="wire-why">{beat.reason}</p> : null
        ) : (
          <div className="wire-parts">
            {beat.parts.map((p) => (
              <button
                key={p.actor.slug}
                type="button"
                className="wire-part wire-voice"
                onClick={() => onAgent?.(p.actor.slug)}
              >
                <Face name={p.actor.name} slug={p.actor.slug} small />
                <span>
                  <strong>{p.actor.handle}</strong> {p.reason}
                </span>
                <em>{elapsed(p.at, now).text}</em>
              </button>
            ))}
          </div>
        )}

        {big != null && <p className="wire-big">{big}× typical</p>}

        {regret != null && <p className="wire-regret">{pctPts(regret)} since they sold</p>}
      </div>
    </div>
  );
}

/** A dollar figure on its own says nothing, so it never ships without whichever context is true. */
function sideOf(beat: Beat) {
  if (beat.kind === "chorus") return null;
  if (beat.weight != null) return <em>at {beat.weight}% of its book</em>;
  const floor = beat.action === "sell" ? 0 : 1;
  if (beat.crowd.length > floor) {
    return (
      <span className="faces crowd">
        {beat.crowd.slice(0, 3).map((a) => (
          <Face key={a.slug} name={a.name} slug={a.slug} small />
        ))}
        {beat.crowd.length > 3 ? <em>+{beat.crowd.length - 3}</em> : null}
      </span>
    );
  }
  return null;
}
