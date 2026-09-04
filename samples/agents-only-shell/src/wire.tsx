import { castOf, regretOf, verbOf, whoOf, type Beat, type Lane } from "./beat";
import { elapsed, spellSpan } from "./clock";
import { money, pctPts, type LiveToken } from "./live";
import { strategyName } from "./strategy";
import { Face, FaceOn, FacesOn, Stamp } from "./ui";

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
  /** One agent's own rail: its rulebook is already stated above, so drop the stamp. */
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
              <div key={lane.id} className="wire-lull">
                <span className="wire-gut" />
                <i className="wire-node lull" aria-hidden />
                <div className="wire-body">nothing landed for {spellSpan(lane.ms)}</div>
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
                solo={solo}
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
  solo,
  onToken,
  onAgent,
}: {
  beat: Beat;
  big: number | null;
  tokens: LiveToken[];
  now: number;
  live?: boolean;
  solo?: boolean;
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
        <button type="button" className="wire-body wire-quiet" onClick={open}>
          <Face name={beat.actor.name} slug={beat.actor.slug} small />
          <span>
            <strong>{beat.actor.handle}</strong> looked at {beat.symbol} and left it alone
            {beat.reason ? ` — ${lower(beat.reason)}` : "."}
          </span>
        </button>
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
                {sideOf(beat, cast.length)}
              </span>
            )}
          </span>
        </button>

        {beat.kind === "trade" ? (
          <>
            {!solo && (
              <div className="wire-tag">
                <Stamp>{strategyName(beat.actor.strategy)}</Stamp>
              </div>
            )}
            {beat.reason ? <p className="wire-why">{beat.reason}</p> : null}
          </>
        ) : (
          <div className="wire-parts">
            {beat.parts.map((p) => (
              <button
                key={p.actor.slug}
                type="button"
                className="wire-part"
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

        {big != null && <p className="wire-big">{big}× the size of a typical trade on the wire.</p>}

        {regret != null && (
          <p className="wire-regret">
            {beat.symbol} is {pctPts(regret)} since they sold.
          </p>
        )}
      </div>
    </div>
  );
}

/** A dollar figure on its own says nothing, so it never ships without whichever context is true. */
function sideOf(beat: Beat, cast: number) {
  if (beat.kind === "chorus") return <em>across {cast}</em>;
  if (beat.weight != null) return <em>at {beat.weight}% of its book</em>;
  if (beat.action === "sell" && beat.crowd > 0) {
    return <em>{beat.crowd} agents still in</em>;
  }
  if (beat.crowd > 1) return <em>{beat.crowd} agents in it</em>;
  return null;
}

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
