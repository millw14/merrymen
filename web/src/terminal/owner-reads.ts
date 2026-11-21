/**
 * THE TWO OWNER-ONLY READS BEHIND owner-state.ts, as hooks.
 *
 * Neither is a new path to anything. The book is profile-view.ts fetchOwnBook,
 * the session-checked /api/agents/<slug>/own the owner's profile already reads;
 * the Perps wallet is account-session.ts fetchAccountForSession, the
 * tenant-bound read the Perps screens already make. Each answer is kept with
 * the slug or login it was asked for, so a change of either never shows the
 * last one's answer.
 */
import { useEffect, useState } from "react";
import type { AccountState } from "./HostedControls";
import { fetchAccountForSession } from "./account-session";
import type { OwnBookRead, PerpsWalletRead } from "./owner-state";
import { fetchOwnBook, type OwnBookView } from "./profile-view";

/**
 * The owner's own view of `slug`'s book: undefined while it is being read (or
 * with no slug to read), null when it was refused or could not be read. Asked
 * again whenever `refreshKey` changes; the last answer stays until the next
 * one lands, so a refresh never blanks the figure.
 */
export function useOwnBookRead(slug: string | null, refreshKey: unknown): OwnBookRead {
  const [own, setOwn] = useState<{ slug: string; view: OwnBookView | null } | null>(null);
  useEffect(() => {
    if (!slug) {
      setOwn(null);
      return;
    }
    let alive = true;
    void fetchOwnBook(slug).then((view) => {
      if (alive) setOwn({ slug, view });
    });
    return () => {
      alive = false;
    };
  }, [slug, refreshKey]);
  return slug && own && own.slug === slug ? own.view : undefined;
}

/**
 * Does this login hold a Perps wallet? Asked only while `ask` (owner-state.ts
 * perpsReadWanted), and again whenever `refreshKey` changes. Null until the
 * read for this login answers; "unread" when it failed or the login changed
 * under it.
 */
export function usePerpsWalletRead(session: AccountState["session"] | null, ask: boolean, refreshKey: unknown): PerpsWalletRead {
  const who = ask && session?.hosted && session.address ? session.address.toLowerCase() : null;
  const [read, setRead] = useState<{ who: string; value: Exclude<PerpsWalletRead, null> } | null>(null);
  useEffect(() => {
    if (!who) return;
    let alive = true;
    void fetchAccountForSession({ hosted: true, address: who }, "perps")
      .then(
        (r) => (r.kind === "ready" ? (r.account.status.exists ? "held" : "none") : "unread") as Exclude<PerpsWalletRead, null>,
        () => "unread" as const,
      )
      .then((value) => {
        if (alive) setRead({ who, value });
      });
    return () => {
      alive = false;
    };
  }, [who, refreshKey]);
  return who && read?.who === who ? read.value : null;
}
