/**
 * SIGNING OUT HAS TO END BOTH SESSIONS, OR IT ENDS NEITHER.
 *
 * The button used to POST `/api/auth/logout` and stop there. That clears the
 * SERVER cookie and leaves Privy authenticated in the browser — and
 * `PrivySignIn`'s prove-on-authenticated effect then fires immediately,
 * re-signs, and mints a fresh session. The owner's words: "I signed out and it
 * forcefully signed me back in." There is no way out of that loop from the UI,
 * which also means no way to sign in as a different wallet.
 *
 * ORDER MATTERS AND IS THE WHOLE FIX. Privy goes first, so `authenticated` is
 * already false by the time the cookie is cleared; the effect's guard then
 * holds and nothing re-proves. Clearing the cookie first leaves a window in
 * which the effect can win the race, which is exactly the bug.
 *
 * The Privy logout is best-effort: if it throws, the server session is still
 * cleared. A half-signed-out state that forgets the server is recoverable —
 * the browser one is not, because a stale Privy session just re-proves.
 *
 * TWO COMPONENTS, NOT A CONDITIONAL HOOK. `Providers` renders NO PrivyProvider
 * when Privy is disabled for a deployment, so `usePrivy()` would throw there.
 * The branch is on a build-time flag and each component calls its hooks
 * unconditionally.
 */
"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useState } from "react";
import { privyEnabled } from "@/lib/privy-client";
import { requestJson } from "./HostedControls";

async function clearServerSession(): Promise<void> {
  await requestJson("/api/auth/logout", { method: "POST" });
}

function Button({
  onClick,
  busy,
  className,
}: {
  onClick: () => void;
  busy: boolean;
  className?: string;
}) {
  return (
    <button className={className} onClick={onClick} disabled={busy}>
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}

function SignOutWithPrivy({ after, className }: { after: () => void; className?: string }) {
  const { logout } = usePrivy();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      className={className}
      busy={busy}
      onClick={() => {
        setBusy(true);
        void (async () => {
          try {
            // FIRST. This is what stops the prove-on-authenticated effect.
            await logout();
          } catch {
            /* best effort — the server session still gets cleared below */
          }
          try {
            await clearServerSession();
          } finally {
            setBusy(false);
            after();
          }
        })();
      }}
    />
  );
}

function SignOutServerOnly({ after, className }: { after: () => void; className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      className={className}
      busy={busy}
      onClick={() => {
        setBusy(true);
        void clearServerSession().finally(() => {
          setBusy(false);
          after();
        });
      }}
    />
  );
}

export function SignOut({ after, className }: { after: () => void; className?: string }) {
  return privyEnabled() ? (
    <SignOutWithPrivy after={after} className={className} />
  ) : (
    <SignOutServerOnly after={after} className={className} />
  );
}
