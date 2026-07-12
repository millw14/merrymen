/**
 * A seamless keyword marquee — two identical tracks scrolling as one loop.
 * Pure CSS motion (see .marquee in globals.css); reduced-motion holds it still.
 */
export function Marquee({ items }: { items: string[] }) {
  const Row = () => (
    <div className="marquee-row" aria-hidden>
      {items.map((t, i) => (
        <span className="marquee-item" key={i}>
          {t}
          <span className="marquee-dot" />
        </span>
      ))}
    </div>
  );
  return (
    <div className="marquee" aria-hidden>
      <div className="marquee-track">
        <Row />
        <Row />
      </div>
    </div>
  );
}
