/**
 * CONNECTING AN X ACCOUNT: OAuth 2.0 authorization code + PKCE, as a
 * confidential client (docs/x-posting.md, "The connection").
 *
 * Two actions, one POST, because both are owner acts that must travel with
 * the session and neither may be a GET a link can fire:
 *
 *   start   parks a single-use pending connect (the PKCE verifier sealed, the
 *           state stored only as a hash, fifteen minutes) under the SESSION's
 *           tenant and answers the X authorize URL. The state's one-letter
 *           prefix (w./i.) only tells the /connect/x page where to hand the
 *           code; it authorizes nothing.
 *
 *   finish  SPENDS the pending connect first — DELETE … RETURNING, so two
 *           finishes racing one state cannot both get it — and only then
 *           looks at anything else. A connect started by another owner is
 *           refused WITHOUT redeeming the code: that is the account-binding
 *           CSRF, where an attacker gets a victim to approve the attacker's
 *           authorize URL (or the reverse) and an X account lands on the
 *           wrong merrymen owner. Then the code is exchanged at once (X codes
 *           live about thirty seconds), X is asked which account the token
 *           posts as, and the sealed tokens are stored. The answer is
 *           {ok, username, postingEnabled}: whether posting is on NOW.
 *
 * CONNECTING IS NOT CONSENT. Nothing here turns posting on; a new connection
 * starts off, and a reconnect of a DIFFERENT X account clears the consent the
 * owner gave for the old one (store.ts upsertAccount). The switch is
 * POST /api/x/account {action:"enable"}, behind the warning. A reconnect of
 * the SAME account (after X revoked it) keeps the consent that owner already
 * gave it, so posting resumes — which is why finish says whether it is on.
 *
 * NOTHING X SAYS AND NO SECRET IS ECHOED OR LOGGED. A failure is logged as its
 * classification and status only — never the code, the state, a token or X's
 * body — and the owner is told one plain sentence. The callback is a PAGE
 * (/connect/x), not this route: the middleware refuses a cross-site request
 * on /api/*, and the SameSite=Strict session cookie is not sent on the
 * navigation back from x.com, so the page POSTs `finish` here same-origin.
 *
 * Hosted only: self-hosted answers 404, like every /api/x/* route.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { OWNER_CHANGED_SETTING, ownerMismatch } from "@/lib/order-owner";
import {
  X_COPY,
  X_PRIVATE_HEADERS,
  readXBody,
  withXpostDb,
  xpostApp,
  xpostAvailable,
  xpostDek,
  xpostFetch,
  xpostNow,
} from "@/lib/x-connect";
import {
  authorizeUrl,
  exchangeCode,
  fetchMe,
  newState,
  pkcePair,
  revokeToken,
  stateClient,
  type XApp,
  type XTokens,
} from "../../../../../../worker/src/xpost/client";
import { getAccount, prunePending, putPending, takePending, upsertAccount } from "../../../../../../worker/src/xpost/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `{action, client, owner}` or `{action, code, state, owner}` — a fraction of this. */
const BODY_MAX_BYTES = 4096;

/** X's own login plus 2FA can outlast five minutes; fifteen is the contract. */
const PENDING_TTL_MS = 15 * 60_000;

/**
 * An authorization code: printable ASCII with no spaces, of a sane length. Not
 * narrower — X does not document its alphabet, and a code refused here is an
 * owner told their link expired when it had not. It only ever travels
 * form-encoded (URLSearchParams), so no character in it can split a field.
 * The iOS app accepts exactly the same set before it finishes a connect
 * (NavigationPolicy.isXCode in ios-native/Policy): keep the two equal, or one
 * client tells an owner "that answer wasn't for this connection" for a code
 * the other takes.
 */
const CODE = /^[\x21-\x7e]{8,1024}$/;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: X_PRIVATE_HEADERS });
/** `ownerFacing` marks a 5xx sentence as written for the owner (terminal/request-json.ts shows it). */
const refuse = (status: number, error: string) =>
  json(status >= 500 ? { error, ownerFacing: true } : { error }, status);

/**
 * THE FRESH TOKENS COULD NOT BE KEPT, so they are handed back to X. Best
 * effort and never thrown: the answer the owner gets is the same either way,
 * and a token nobody stored is a token nobody can use — this only stops it
 * lingering at X for its two hours.
 */
async function giveBack(app: XApp, tokens: XTokens): Promise<void> {
  const xFetch = xpostFetch();
  await Promise.all([
    tokens.refreshToken ? revokeToken(app, tokens.refreshToken, "refresh_token", { fetch: xFetch }) : null,
    revokeToken(app, tokens.accessToken, "access_token", { fetch: xFetch }),
  ]);
}

async function start(tenant: `0x${string}`, input: Record<string, unknown>): Promise<Response> {
  const client = input.client;
  if (client !== "web" && client !== "ios") return refuse(400, "Say where the connection finishes: web or ios.");
  const app = xpostApp();
  const dek = xpostDek();
  if (!xpostAvailable(isHostedMode()) || !app || !app.redirectUri || !dek) return refuse(503, X_COPY.unavailable);
  const redirectUri = app.redirectUri;
  const now = xpostNow();
  const state = newState(client);
  const { verifier, challenge } = pkcePair();
  try {
    const parked = await withXpostDb(async (db) => {
      if (!db) return false;
      await prunePending(db, now);
      await putPending(db, dek, { state, tenant, verifier, redirectUri, expiresAtMs: now + PENDING_TTL_MS });
      return true;
    });
    if (!parked) return refuse(503, X_COPY.unavailable);
  } catch {
    console.warn("[x-connect] start: could not park the pending connect");
    return refuse(503, X_COPY.storeDown);
  }
  return json({ url: authorizeUrl(app, { state, challenge, redirectUri }) });
}

async function finish(tenant: `0x${string}`, input: Record<string, unknown>): Promise<Response> {
  const app = xpostApp();
  const dek = xpostDek();
  if (!xpostAvailable(isHostedMode()) || !app || !dek) return refuse(503, X_COPY.unavailable);
  const code = input.code;
  const state = input.state;
  // A malformed code or state is, to the owner, the same as a spent one: start again.
  if (typeof code !== "string" || !CODE.test(code) || stateClient(state) === null) return refuse(400, X_COPY.expired);
  const now = xpostNow();

  // SPENT FIRST, before any network call and before the tenant is compared,
  // so a state can be tried exactly once whoever tries it.
  let pending: Awaited<ReturnType<typeof takePending>>;
  try {
    pending = await withXpostDb(async (db) => (db ? takePending(db, dek, state as string, now) : null));
  } catch {
    console.warn("[x-connect] finish: could not read the pending connect");
    return refuse(503, X_COPY.storeDown);
  }
  if (!pending) return refuse(400, X_COPY.expired);
  if (pending.tenant !== tenant.toLowerCase()) {
    // THE CODE IS NOT REDEEMED. Whoever approved on X approved for another
    // owner's connect; exchanging it would bind their X account to that owner.
    console.warn("[x-connect] finish refused: the connect was started by another owner");
    return refuse(403, X_COPY.wrongOwner);
  }

  const xFetch = xpostFetch();
  const exchanged = await exchangeCode(
    app,
    { code, verifier: pending.verifier, redirectUri: pending.redirectUri },
    { fetch: xFetch, nowMs: now },
  );
  if (!exchanged.ok) {
    console.warn(`[x-connect] finish: token exchange failed (${exchanged.failure} ${exchanged.status ?? "-"})`);
    return refuse(502, X_COPY.xFailed);
  }
  const tokens = exchanged.value;

  // WHICH ACCOUNT THIS TOKEN POSTS AS — the only source of the handle the
  // warning will name. Never a typed handle, never the sign-in's.
  const me = await fetchMe(tokens.accessToken, { fetch: xFetch, nowMs: now });
  if (!me.ok) {
    console.warn(`[x-connect] finish: users/me failed (${me.failure} ${me.status ?? "-"})`);
    await giveBack(app, tokens);
    return refuse(502, X_COPY.xFailed);
  }

  // WHETHER POSTING IS ON NOW, read back after the write. A reconnect of the
  // SAME X account keeps the consent the owner gave it (store.ts
  // upsertAccount), so a connection X had revoked starts posting again from
  // the next pass; the page must say so rather than "won't post anything yet".
  let postingEnabled: boolean;
  try {
    const stored = await withXpostDb(async (db) => {
      if (!db) return null;
      await upsertAccount(db, dek, { tenant, xUserId: me.value.id, username: me.value.username, tokens, nowMs: now });
      return { posting: (await getAccount(db, tenant))?.posting === true };
    });
    if (!stored) {
      await giveBack(app, tokens);
      return refuse(503, X_COPY.unavailable);
    }
    postingEnabled = stored.posting;
  } catch {
    console.warn("[x-connect] finish: could not store the connection");
    await giveBack(app, tokens);
    return refuse(503, X_COPY.storeDown);
  }
  return json({ ok: true, username: me.value.username, postingEnabled });
}

export async function POST(req: Request) {
  if (!isHostedMode()) return refuse(404, "not found");
  const tenant = tenantOf(req);
  if (!tenant) return refuse(401, X_COPY.signedOut);

  const body = await readXBody(req, BODY_MAX_BYTES);
  if (!body.ok) return refuse(body.status, body.status === 413 ? X_COPY.tooLarge : X_COPY.badJson);
  const input = body.value;

  if (input.action === "start") {
    // Starting is an owner act like any other change: the body names the
    // owner the client believes is signed in, and a different session is
    // refused before a pending connect is parked under it.
    if (typeof input.owner !== "string") return refuse(400, X_COPY.noOwner);
    if (ownerMismatch(input.owner, tenant)) return refuse(409, OWNER_CHANGED_SETTING);
    return start(tenant, input);
  }
  if (input.action === "finish") {
    // Optional here: the /connect/x page does not know who is signed in, and
    // the pending connect's own tenant is the binding that matters. When the
    // iOS app names an owner, a different session is still refused.
    if (ownerMismatch(input.owner, tenant)) return refuse(409, OWNER_CHANGED_SETTING);
    return finish(tenant, input);
  }
  return refuse(400, "Unknown action.");
}
