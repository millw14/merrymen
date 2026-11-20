import { stoppedFigure, type OwnBookRead, type StoppedOwner } from "./owner-state";

/**
 * A STOPPED AGENT, SAID AS ONE — never the newcomer's "Create your merryman"
 * to an owner whose agent, name, profile and book all still exist
 * (owner-state.ts). Two sentences, the owner's own figure when it was read,
 * and the one way back.
 *
 * TRUE FOR EVERY OWNER. Nothing here promises the same book after a restart: a
 * login-owned agent comes back on the same account, one whose key was made in
 * the browser comes back on a new one. What is kept is kept now.
 */
export function StoppedWords({ stopped }: { stopped: StoppedOwner }) {
  return (
    <>
      <h2>{stopped.name} is stopped</h2>
      <p>It isn&apos;t trading. Its record and profile are kept.</p>
    </>
  );
}

/**
 * The owner's own value, from the owner-only /own read the profile makes, and
 * nothing at all until it answers or when it was refused (stoppedFigure).
 */
export function StoppedFigure({ book }: { book: OwnBookRead }) {
  const f = stoppedFigure(book);
  if (!f) return null;
  const note = [f.asOf && `as of ${f.asOf}`, f.held && "pending reconciliation"].filter(Boolean).join(" · ");
  return (
    <p className="stopped-figure">
      <span className="account-label">{f.label}</span> <strong>{f.value}</strong>
      {note && <> <small>{note}</small></>}
    </p>
  );
}

/** The card beside a page (the account entry, Me): words, figure, the one restart and his profile. */
export function StoppedAgentCard({ stopped, book }: { stopped: StoppedOwner; book: OwnBookRead }) {
  return (
    <section className="hosted-entry stopped-agent" aria-label="Your agent">
      <StoppedWords stopped={stopped} />
      <StoppedFigure book={book} />
      <a className="flow-primary" href={stopped.restart.href}>{stopped.restart.label}</a>
      <a className="flow-secondary" href={stopped.profile}>View profile</a>
    </section>
  );
}
