import { castOf, verbOf, whoOf, type Beat, type Lane } from "./beat";
import { elapsed, useNow } from "./clock";
import { money, type LiveToken } from "./live";
import { Coin, Delta, FaceOn, FacesOn } from "./ui";

function logoOf(tokens: LiveToken[], symbol: string): LiveToken | undefined {
  return tokens.find((t) => t.symbol.toUpperCase() === symbol.toUpperCase());
}

export function Wire({
  lanes,
  tokens,
  onToken,
  onAgent,
}: {
  lanes: Lane[];
  tokens: LiveToken[];
  onToken?: (id: string) => void;
  onAgent?: (slug: string) => void;
}) {
  const now = useNow(30_000);
  return (
    <div className="wire">
      {lanes.map((lane) => {
        switch (lane.kind) {
          case "lull":
            return <div key={lane.id} className="wire-lull" aria-hidden />;
          case "beat": {
            return (
              <BeatRow
                key={lane.id}
                beat={lane.beat}
                tokens={tokens}
                now={now}
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
  tokens,
  now,
  onToken,
  onAgent,
}: {
  beat: Beat;
  tokens: LiveToken[];
  now: number;
  onToken?: (id: string) => void;
  onAgent?: (slug: string) => void;
}) {
  const tok = logoOf(tokens, beat.symbol);
  const cast = castOf(beat);
  const open = () => {
    if (tok && onToken) onToken(tok.id);
    else if (onAgent) onAgent(cast[0]!.slug);
  };

  const chorus = beat.kind === "chorus";
  const cls = ["wire-beat", beat.action, chorus ? "chorus" : ""].filter(Boolean).join(" ");

  return (
    <div className={cls}>
      <button type="button" className="wire-mark" onClick={open}>
        {chorus ? (
          <FacesOn cast={cast} symbol={beat.symbol} logo={tok?.logo ?? ""} />
        ) : (
          <FaceOn name={cast[0]!.name} slug={cast[0]!.slug} symbol={beat.symbol} logo={tok?.logo ?? ""} />
        )}
      </button>
      <div className="wire-body">
        <button type="button" className="wire-hit" onClick={open}>
          <span className="wire-said">
            <span className="wire-line">
              <strong>{whoOf(beat)}</strong> {verbOf(beat)} {beat.symbol}{" "}
              <em className="wire-when">{whenOf(beat.at, now)}</em>
            </span>
          </span>
        </button>

        {beat.kind === "trade" ? (
          <>
            {beat.reason ? <p className="wire-why">{beat.reason}</p> : null}
            <div className="wire-parts">
              <button type="button" className="wire-part" onClick={open}>
                <span className="wire-seat">
                  <Coin symbol={beat.symbol} logo={tok?.logo ?? ""} />
                  {beat.symbol}
                </span>
                <span className="wire-part-fig">
                  {beat.sizeUsd != null ? <b>{money(beat.sizeUsd)}</b> : null}
                  <Delta value={tok?.change24hPct ?? null} suffix="%" size={11} />
                </span>
              </button>
            </div>
          </>
        ) : (
          <div className="wire-parts">
            {beat.parts.map((p) => (
              <button
                key={p.actor.slug}
                type="button"
                className="wire-part wire-voice"
                onClick={() => onAgent?.(p.actor.slug)}
              >
                <span>{p.reason}</span>
                <span className="wire-part-fig">
                  {p.sizeUsd != null ? <b>{money(p.sizeUsd)}</b> : null}
                  <Delta value={tok?.change24hPct ?? null} suffix="%" size={11} />
                </span>
              </button>
            ))}
          </div>
        )}

      </div>
    </div>
  );
}

function whenOf(at: number, now: number): string {
  const age = elapsed(at, now);
  switch (age.unit) {
    case "s":
      return "now";
    case "m":
    case "h":
    case "d":
      return age.text;
    default: {
      const _x: never = age.unit;
      return _x;
    }
  }
}
