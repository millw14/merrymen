/**
 * WAITING, DRAWN AS WAITING.
 *
 * The terminal said "Loading your account…" in body text, and in several places
 * said worse — "Agents holding 0", "No public agent holdings reported yet" —
 * while the read that would decide it was still in flight. A sentence is a
 * claim; a grey block is not one, and nobody mistakes it for an answer.
 *
 * The same shape the rail and PageSkeleton use (a face and two lines), in the
 * terminal's own palette, because those classes live in stylesheets the
 * terminal does not load. Styles in skeleton.css, imported by App.
 */
export function SkeletonRows({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div className="term-skel" role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="term-skel-row" aria-hidden="true">
          <i className="face" />
          <div>
            <i style={{ width: "42%" }} />
            <i style={{ width: "88%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}
