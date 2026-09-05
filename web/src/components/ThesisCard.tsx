import Link from "next/link";
import type { PublicThesis } from "@/lib/thesis";
import { badgeOf, hasTrade } from "@/lib/thesis-badge";
import { timeAgo } from "@/lib/time";
import { AgentAvatar } from "@/components/AgentAvatar";

/**
 * THE ATOM.
 *
 * The old card printed the trade line first, in body type, and the reasoning
 * underneath in something smaller. That is backwards for this product: anyone
 * can see that an agent bought NVDA, and the only thing that makes an agent
 * worth following is WHY. So the reasoning is the largest text on the card and
 * the trade is a strip underneath it.
 *
 * THE CARD IS NOT A LINK. There is no per-thesis id anywhere — decisions are
 * grouped by content over a 24h window, so a post is a group and not a row —
 * and faking a permalink would produce a URL that resolves to something else
 * tomorrow. ONE real target: the agent. The token would need an address on
 * PublicThesis, which carries only a symbol; the wire would need a follow graph,
 * which is not built. This comment claimed all three.
 */

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ThesisCard({
  t,
  wired = false,
  hideAgent = false,
}: {
  t: PublicThesis;
  /** Does the viewer's own agent read this one? Drives the avatar ring. */
  wired?: boolean;
  /** On an agent's own profile, every card is the same agent — so don't repeat it. */
  hideAgent?: boolean;
}) {
  const b = badgeOf(t);
  const trade = hasTrade(t);
  const turned = t.outcome === "refused" || t.outcome === "reverted";
  // THE CHIP'S OWN BORDER IS THE FILL STATUS. "buying" carries a dashed edge
  // that goes solid the moment the trade lands. A refusal is NOT unsettled —
  // it is a settled fact, and keeps its solid edge and its amber.
  const unsettled = t.outcome === "pending";

  const who = (
    <span className="mm-who">
      <span className="nm">{t.name}</span>
      {/* Unverified: this is what the owner typed, and nothing has checked that
          they own it. Dim, never a link. Absent renders as nothing at all —
          never "@unknown". */}
      {t.handle && <span className="at mono">@{t.handle}</span>}
    </span>
  );

  return (
    <article className={`mm-post${b.kind === "thesis" ? " is-thesis" : ""}`}>
      {!hideAgent &&
        (t.slug ? (
          <Link href={`/a/${t.slug}`} className="mm-post-face" aria-label={t.name}>
            <AgentAvatar name={t.name} slug={t.slug} wired={wired} />
          </Link>
        ) : (
          <span className="mm-post-face">
            <AgentAvatar name={t.name} slug={t.slug} wired={wired} />
          </span>
        ))}

      <div className="mm-post-body">
        <header className="mm-post-head">
          {!hideAgent && (t.slug ? <Link href={`/a/${t.slug}`}>{who}</Link> : who)}
          <span className={`mm-chip ${badgeClass(b.kind)}${unsettled ? " unsettled" : ""}`}>
            {b.label}
          </span>
          {/* Said plainly, next to the action, because somebody skimming must
              never mistake a pretend fill for a real one. Quieter than the
              action badge: it qualifies the post, it does not compete with it. */}
          {t.paper && <span className="mm-chip quiet unsettled">paper</span>}
          <time className="mm-when mono">{timeAgo(t.at)}</time>
        </header>

        {/* THE PRODUCT. Largest text on the card. */}
        {t.reason && <p className="mm-say">{t.reason}</p>}

        {/* Subordinate. A thesis has none of this — its words are the post. */}
        {trade && (
          <div
            className={`mm-trade${turned ? " turned" : ""}${t.paper ? " sim" : ""}${t.shadow ? " shadow" : ""}`}
          >
            {t.symbol && <span className="sym mono">{t.symbol}</span>}
            {t.sizeUsdg !== null && <span className="amt mono">{money(t.sizeUsdg)}</span>}
            {t.outcomeText && <span className="out mono">{t.outcomeText}</span>}
          </div>
        )}

        {/* The count IS the answer to an agent that repeats itself: it posts as
            often as it likes, the ledger keeps every row, and the feed declines
            to print the same sentence two hundred times. */}
        {t.said > 1 && (
          <p className="mm-said mono">
            ×{t.said} · first said {timeAgo(t.firstAt)}
          </p>
        )}
      </div>
    </article>
  );
}

function badgeClass(kind: ReturnType<typeof badgeOf>["kind"]): string {
  if (kind === "bought") return "up";
  if (kind === "sold") return "down";
  if (kind === "turned") return "warn";
  if (kind === "thesis") return "wire";
  return "quiet";
}
