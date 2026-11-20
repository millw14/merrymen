/**
 * WHAT THIS SESSION'S OWN AGENT IS, NAMED ONCE FOR EVERY SCREEN.
 *
 * `mine` (App.tsx) needs a live Spot grant: it is the agent the desk talks to,
 * funds and stops. An owner who stopped theirs has none — a permission stopped
 * for a renewal that was never signed (the record is `stored`, grants/route.ts
 * GET), or a record Start over then removed — yet nothing of the agent itself
 * is gone: the identity store still maps the session to its slug, the settings
 * keep its name, and the book is on file. The feed already answers with that
 * identity (feed-identity.ts identityOf), so `live.mine` names it. Every screen
 * keyed on `mine` treated that owner as a newcomer: "Create your merryman" on
 * Home and Me, "Your agent starts here" beside every page, and "Private" on his
 * own profile (2026-11-18, a paper owner stopped for a re-signature and never
 * signed).
 *
 * A SLUG IS NOT AN AGENT. Every Privy sign-in claims one (identity-store.ts
 * resolveOrClaimDid, with no accounts), so the feed names a slug for a
 * newcomer who never made a Merryman too. "Stopped" needs evidence that a Spot
 * agent existed: the Spot GET's `stored` (a record held for this tenant), or
 * the owner-only /own read answering with a book (it refuses a slug with no
 * Spot account on record, read-agent.ts readOwnBook). Without either it is a
 * newcomer, as it always was.
 *
 * So the state is decided here, from the account read, the feed's identity,
 * the owner's own book and — only for a removed record — the Perps wallet,
 * and handed to every surface. Home, Me, the account card and the desktop
 * header used to repeat their own conditions, and each repetition is a place
 * to disagree.
 *
 * NOTHING HERE GRANTS ANYTHING. It picks words and links. The figures on a
 * stopped card come only from the owner-only /own route, which checks the
 * session against the identity store itself (read-agent.ts readOwnBook); a
 * wrong guess here gets a refusal, never somebody's money.
 *
 * Pure, so a test runs every state.
 */
import { dayLabel, usd } from "@/lib/format";
import type { AccountState } from "./HostedControls";
import type { ReadState } from "./live";
import type { OwnBookView } from "./profile-view";

/**
 * The Perps wallet's own answer, asked only for a removed record with a book on
 * file: a login whose Perps wallet holds a grant is trading there, and is not
 * told its agent is stopped. Null until that read answers; "none" also for a
 * deployment that offers no Perps, where no Perps wallet can be running.
 */
export type PerpsWalletRead = "held" | "none" | "unread" | null;

/**
 * The one way back for a stopped agent: /create, for a held record and a
 * removed one alike. It already sends a browser holding the saved wallet to
 * its renewal (CreateAgent.tsx "Resume your saved wallet", /grant#resign), and
 * signs a login-owned agent again otherwise. /grant#resign straight away gave
 * a Privy owner on another browser the owner-key restore form, which has no
 * key of his to take.
 */
export interface Restart {
  href: "/create";
  label: string;
}

/** An owner's own agent, stopped: who it is, and the one way to start it again. */
export interface StoppedOwner {
  name: string;
  slug: string;
  /** The record is held, stopped for a renewal (the Spot GET's `stored`), rather than removed. */
  stored: boolean;
  restart: Restart;
  /** His public page, where the owner's own view of the book lives. */
  profile: string;
}

export type OwnerState =
  /** A live Spot grant: the screens draw `mine`, or say it is loading. */
  | { kind: "live" }
  | { kind: "stopped-stored"; stopped: StoppedOwner }
  | { kind: "stopped-removed"; stopped: StoppedOwner }
  /** No Spot grant, a Perps one: the Spot screens are as they always were for this login. */
  | { kind: "perps-only" }
  /** A read that tells "stopped" from "new" has not answered yet: claim neither. */
  | { kind: "checking" }
  /**
   * Nothing to say about an agent: signed out, self-hosted with no grant, a
   * newcomer (a slug and no book), an account still loading or failed (the
   * screens' own states), a feed for another session, or an owner or Perps
   * read that was refused or failed.
   */
  | { kind: "none" };

export interface OwnerInputs {
  account: AccountState | null;
  /** The owner's feed read for this session (account-session.ts accountFeedRead): "unread" until it first answers. */
  feed: ReadState;
  /**
   * The feed has answered at least once (`live.feedTenant` is no longer
   * undefined). One that failed before it ever answered says nothing about
   * whose agent this is: unknown, not new.
   */
  feedAnswered: boolean;
  /** The feed names this session's tenant (account-session.ts feedMatchesAccount). */
  feedIsOwn: boolean;
  /** The feed's identity (`live.mine`): the name, and the slug the identity store holds for the session. */
  named: { name: string; slug: string | null } | null | undefined;
  /** The owner-only /own read for that slug (owner-reads.ts useOwnBookRead), asked for while ownBookSlug names it. */
  book: OwnBookRead;
  perps: PerpsWalletRead;
}

const LIVE: OwnerState = { kind: "live" };
const NONE: OwnerState = { kind: "none" };
const CHECKING: OwnerState = { kind: "checking" };
const PERPS_ONLY: OwnerState = { kind: "perps-only" };

type Candidate = { name: string; slug: string; stored: boolean };

/** Everything but the owner's book and the Perps wallet: a final answer, or the agent those reads must confirm. */
function candidateOf(i: Omit<OwnerInputs, "book" | "perps">): { state: OwnerState } | Candidate {
  const a = i.account;
  if (!a) return { state: NONE };
  if (a.status.exists) return { state: LIVE };
  // HOSTED AND SIGNED IN ONLY. Signed out there is nobody's agent; self-hosted
  // the feed names no slug (identityOf with no tenant), and the install's own
  // screens are what they always were.
  if (!a.session.hosted || !a.session.address) return { state: NONE };
  // Before the feed's first answer, "stopped" and "new" look the same: wait.
  if (i.feed === "unread") return { state: CHECKING };
  // A FEED THAT HAS ONLY FAILED must not hold a newcomer on "One moment…" with
  // no way to create an agent for as long as the outage lasts. Only a record
  // the server says is held for renewal keeps waiting (that owner needs the
  // feed's name, not Create); anyone else gets the screens main always showed.
  if (!i.feedAnswered) return { state: a.status.stored === true ? CHECKING : NONE };
  // A feed answered for another session names nobody's agent here.
  if (!i.feedIsOwn || !i.named?.slug) return { state: NONE };
  return { name: i.named.name, slug: i.named.slug, stored: a.status.stored === true };
}

export function ownerStateOf(i: OwnerInputs): OwnerState {
  const s = candidateOf(i);
  if ("state" in s) return s.state;
  // A SPOT RECORD HELD FOR THIS TENANT is a Spot agent that existed, whatever
  // the Perps wallet holds: stopped, with no other read to wait for.
  if (s.stored) return { kind: "stopped-stored", stopped: stoppedOwner(s) };
  // REMOVED, OR NEVER MADE. Only the owner's book tells them apart: a refusal
  // is a newcomer (or a read that failed), and says what it always said.
  if (i.book === undefined) return CHECKING;
  if (i.book === null) return NONE;
  if (i.perps === null) return CHECKING;
  if (i.perps === "held") return PERPS_ONLY;
  // Could not tell: what the Spot screens said before, rather than "stopped"
  // to an owner who may be trading on Perps.
  if (i.perps === "unread") return NONE;
  return { kind: "stopped-removed", stopped: stoppedOwner(s) };
}

function stoppedOwner(s: Candidate): StoppedOwner {
  return {
    name: s.name,
    slug: s.slug,
    stored: s.stored,
    // Neither promises the book comes back as it was: a login-owned agent
    // comes back on the same account, a key made in the browser on a new one.
    restart: { href: "/create", label: "Start it again" },
    profile: `/a/${encodeURIComponent(s.slug)}`,
  };
}

/** The slug to ask /own about: the session's own, while it may be a stopped agent's (and for its figure). */
export function ownBookSlug(i: Omit<OwnerInputs, "book" | "perps">): string | null {
  const s = candidateOf(i);
  return "state" in s ? null : s.slug;
}

/** Ask the Perps wallet only where it decides the answer: a removed record whose book is on file. */
export function perpsReadWanted(i: Omit<OwnerInputs, "perps">): boolean {
  const s = candidateOf(i);
  return !("state" in s) && !s.stored && !!i.book;
}

/** The stopped agent, or null. */
export function stoppedOf(s: OwnerState): StoppedOwner | null {
  return s.kind === "stopped-stored" || s.kind === "stopped-removed" ? s.stopped : null;
}

/**
 * IS THIS PROFILE THE SESSION'S OWN AGENT? From the feed's identity, which is
 * the session's and needs no live grant — not from `mine`, which does, and
 * which made a stopped owner's own page a stranger's.
 *
 * Only a guess for the page's words and the /own request: the server decides
 * whose book that is (read-agent.ts readOwnBook). A feed for another session
 * owns nothing here.
 */
export function ownsProfile(feedIsOwn: boolean, named: { slug: string | null } | null | undefined, slug: string): boolean {
  return feedIsOwn && !!named?.slug && named.slug === slug;
}

/** The owner's own book as read: undefined while in flight, null when refused or unreachable. */
export type OwnBookRead = OwnBookView | null | undefined;

/**
 * THE STOPPED CARD'S ONE FIGURE, from the owner's own read and nothing else.
 *
 * Nothing at all while the read is in flight or was refused: no figure is
 * better than one nobody read. A read that answered without a value is a dash,
 * never $0.00. Paper is said once, in the label beside the figure.
 */
export function stoppedFigure(book: OwnBookRead): { label: string; value: string; asOf: string | null; held: boolean } | null {
  if (!book) return null;
  const f = book.figures;
  const label = f?.book === "paper" ? "Paper value" : "Value";
  if (!f || f.equityUsdg === null) return { label, value: "—", asOf: null, held: false };
  return { label, value: usd(f.equityUsdg), asOf: f.equityAt === null ? null : dayLabel(f.equityAt * 1000), held: f.held };
}
