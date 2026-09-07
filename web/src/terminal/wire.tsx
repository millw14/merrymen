import { verbOf, whoOf, type Beat, type Lane } from "./beat";
import { elapsed, useNow } from "./clock";
import { money, type LiveToken } from "./live";
import { Coin, Delta, FaceOn } from "./ui";

function logoOf(tokens: LiveToken[], symbol: string | null): LiveToken | undefined {
  if (!symbol) return undefined;
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
  const actor = beat.actor;
  const open = () => {
    if (tok && onToken) onToken(tok.id);
    else if (onAgent) onAgent(actor.slug);
  };

  const cls = ["wire-beat", beat.kind === "trade" ? beat.action : "view"].join(" ");

  return (
    <div className={cls}>
      <button type="button" className="wire-mark" onClick={open}>
        <FaceOn name={actor.name} slug={actor.slug} symbol={beat.symbol ?? ""} logo={tok?.logo ?? ""} />
      </button>
      <div className="wire-body">
        <button type="button" className="wire-hit" onClick={open}>
          <span className="wire-said">
            <span className="wire-line">
              {/* TWO SENTENCES, BUILT TWO DIFFERENT WAYS, and the difference is
                  the point. A trade has a direction the rail may conjugate. A
                  view does not, so it prints what the PUBLISHER wrote — which
                  is where the conditional already lives, and the only string
                  that knows whether anything could have happened. */}
              <strong>{whoOf(beat)}</strong>{" "}
              {beat.kind === "trade" ? (
                <>
                  {verbOf(beat)} {beat.symbol}{" "}
                </>
              ) : (
                <>{beat.head} </>
              )}
              <em className="wire-when">{whenOf(beat.at, now)}</em>
            </span>
          </span>
        </button>

        {/* The take, when it adds something the line did not already say. A
            view whose head IS its reasoning must not print it twice. */}
        {beat.reason && (beat.kind === "trade" || beat.reason !== beat.head) ? (
          <p className="wire-why">{beat.reason}</p>
        ) : null}

        {beat.symbol ? (
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
        ) : null}
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
