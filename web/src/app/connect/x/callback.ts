/**
 * WHAT X'S REDIRECT MEANS, DECIDED BEFORE THE PAGE DOES ANYTHING WITH IT.
 *
 * X sends the owner back to /connect/x?code=…&state=… (or ?error=…&state=…
 * when they said no). Exactly one of four things follows, and which one is a
 * pure function of the query, so it lives here where a test executes it:
 *
 *   ios       the connect was started by the app (state "i.…"): hand the
 *             code to merrymen://x-connect, where ASWebAuthenticationSession
 *             is waiting. The app POSTs the finish through its own session.
 *   finish    started on the web (state "w.…") and approved: POST the finish
 *             same-origin, which carries the session cookie this navigation
 *             from x.com did not.
 *   declined  started on the web and not approved.
 *   nothing   no state we could have issued. Nothing is sent anywhere.
 *
 * THE PREFIX ONLY ROUTES; IT AUTHORIZES NOTHING. The finish route spends the
 * pending connect and compares its owner to the session — this file cannot
 * make a code count for anybody.
 *
 * NOT worker/src/xpost/client.ts's stateClient, on purpose: that module
 * imports node:crypto and holds the one read of the X client secret, and this
 * file ships to the browser. The pattern is the same one, and callback.test.ts
 * holds the two equal.
 *
 * Only the keys the app needs are handed on — code, state, error — so a
 * parameter somebody appended to the callback URL never reaches the app.
 */

export type XCallback =
  | { kind: "ios"; href: string }
  | { kind: "finish"; code: string; state: string }
  | { kind: "declined" }
  | { kind: "nothing" };

/** The same shape newState() mints: a one-letter client, a dot, 24 random bytes as base64url. */
const STATE = /^[wi]\.[A-Za-z0-9_-]{32}$/;

/** Who finishes a connect with this state, or null for anything that is not one of ours. */
export function callbackClient(state: unknown): "web" | "ios" | null {
  if (typeof state !== "string" || !STATE.test(state)) return null;
  return state.startsWith("i.") ? "ios" : "web";
}

/** The scheme the iOS app registered for the end of an X connect. */
export const IOS_CALLBACK = "merrymen://x-connect";

export function readCallback(search: string): XCallback {
  const q = new URLSearchParams(search);
  const state = q.get("state");
  const code = q.get("code");
  const error = q.get("error");
  const client = callbackClient(state);
  if (client === null) return { kind: "nothing" };
  if (client === "ios") {
    if (!code && !error) return { kind: "nothing" };
    const handOn = new URLSearchParams();
    if (code) handOn.set("code", code);
    handOn.set("state", state!);
    if (error) handOn.set("error", error);
    return { kind: "ios", href: `${IOS_CALLBACK}?${handOn.toString()}` };
  }
  if (error) return { kind: "declined" };
  if (!code) return { kind: "nothing" };
  return { kind: "finish", code, state: state! };
}
