package dev.merrymen.app.data

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.CookieStores
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.OriginCheck
import dev.merrymen.app.net.SessionStore
import dev.merrymen.app.net.checkOrigin
import dev.merrymen.app.net.isOtherServer
import dev.merrymen.app.net.serverOf
import dev.merrymen.app.net.ServerBound
import dev.merrymen.app.net.ServerTurns
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * WHAT THE APP KNOWS, AND HOW SURE IT IS.
 *
 * `Loaded` carries the three-state distinction the whole product is built on
 * and that a naive `T?` throws away: a value, a refusal the server explained,
 * and no answer at all. A screen that renders "—" for the second and third
 * cases equally is the bug this repo keeps paying for; a screen that renders
 * "0" for either is the expensive version of it.
 */
sealed interface Loaded<out T> {
  data object Idle : Loaded<Nothing>
  data object Loading : Loaded<Nothing>
  data class Value<T>(val value: T) : Loaded<T>
  /** The server said no, and said why. Keep the status: 401 != 503. */
  data class Refused(val status: Int, val message: String) : Loaded<Nothing>
  /**
   * We never got an answer we could read. NOT a fact about the account.
   * [unreadable] as on [ApiResult.Unreachable]: merrymen answered and this app
   * could not read it, which is not "couldn't reach".
   */
  data class Unreachable(val cause: String, val unreadable: Boolean = false) : Loaded<Nothing>
}

fun <T> ApiResult<T>.toLoaded(): Loaded<T> = when (this) {
  is ApiResult.Ok -> Loaded.Value(value)
  is ApiResult.Refused -> Loaded.Refused(status, message)
  is ApiResult.Unreachable -> Loaded.Unreachable(cause, unreadable)
}

/**
 * True when the refusal means "you are not signed in".
 *
 * A plain 401 now. There used to be a second 401 — the site password's, with
 * the error text gated — which meant "the door is shut", not "you are signed
 * out", and this had to tell them apart. The password was removed server-side
 * (46c852d1) and no route sends that error any more, so there is one 401 and it
 * is about the session.
 */
fun Loaded<*>.needsSignIn(): Boolean = this is Loaded.Refused && status == 401

/**
 * WHOSE UNSAVED WORK A SCREEN IS HOLDING: the server it was read from and the
 * wallet it was read for.
 *
 * A draft, a consent half given, a restart armed, a save's report — each was
 * made against one server's values for one wallet, and must not outlive
 * either. Keyed on the wallet alone, a Server change between two self-hosted
 * servers (null on both sides) kept the old server's unsaved edits over the
 * new server's values, and Save could apply one server's trading and risk
 * settings to the other.
 *
 * [serverTurn] is the SETTLED turn — the one a finished move arrived at — so
 * the key moves once, when the new server's address can be read, not twice.
 * It is also the turn a save from this form is bound to ([ServerBound]).
 */
data class FormOwner(val serverTurn: Long, val signedIn: String?)

/** The [FormOwner] for [turn] (Repository.serverTurn) and [signedIn]; see there. */
fun formOwnerOf(turn: Long, signedIn: String?): FormOwner = FormOwner(turn - turn % 2, signedIn)

/** The first wait before [Repository.askUntilKnown] asks again, and the longest it waits. */
const val IDENTITY_RETRY_FIRST_MS = 3_000L
const val IDENTITY_RETRY_MAX_MS = 60_000L

/**
 * THE APP'S ONE ACCOUNT OF WHO IT ACTS FOR, against which server.
 *
 * Takes its Android pieces as interfaces — the stored session as
 * [SessionStore], the two cookie stores as [CookieStores] — so the wiring that
 * decides when a wallet's state goes (sign-out, a switch, a Server change, the
 * retired password at start) runs in a JVM test against the real class.
 */
class Repository(
  val api: MerrymenApi,
  private val session: SessionStore,
  private val cookies: CookieStores,
  /** Who we act for, and the hooks that run when that changes. Pure; see [Identity]. */
  private val identity: Identity = Identity(),
) {
  val signedIn: StateFlow<String?> = identity.signedIn

  /**
   * WHETHER WE HAVE ACTUALLY ASKED "who are you" AND GOT AN ANSWER.
   *
   * `signedIn` is null for two different facts a screen must not conflate:
   * "we asked the session route and it said you are signed out" and "we never
   * got to ask" — because the server was unreachable or refused for some other
   * reason. A "Not signed in — sign in" banner is only true in the FIRST case;
   * in the second it tells a reader something about their account that nobody
   * checked. So this flag flips true only once `session()` has genuinely
   * answered.
   */
  val identityKnown: StateFlow<Boolean> = identity.identityKnown

  /** Hosted (true), self-hosted (false), or not yet said (null). */
  val hosted: StateFlow<Boolean?> = identity.hosted

  /**
   * Whether offering "Sign in" is true here: hosted AND nobody signed in.
   * Self-hosted has no sign-in, so no banner, button or LoadedBlock action may
   * offer one there.
   */
  val canOfferSignIn: StateFlow<Boolean> = identity.canOfferSignIn

  /**
   * REGISTER STATE THAT BELONGS TO ONE WALLET, so it is dropped when that
   * wallet's turn ends: on [signOut], when the session route answers with a
   * DIFFERENT address than the one the app holds state for (a wallet switched
   * in the WebView), and when [setOrigin] moves to another server. Hooks run in
   * registration order, on Dispatchers.IO, before the new address is published,
   * and one failing does not stop the rest. Register once, at construction
   * (AppContainer, or an app-scoped store's init). The rules a hook must keep
   * are on [ForgetHook]: above all, never call this class's identity methods
   * from one.
   *
   * Not run on the first answer after a cold start: nothing in memory belongs
   * to anybody yet. A store that PERSISTS per-wallet state must key it by
   * address for exactly that reason. Not run when a session merely EXPIRES
   * (401, or address null) either — so what a screen renders must follow
   * [signedIn], not only the hook.
   */
  fun addForgetHook(hook: ForgetHook) = identity.addForgetHook(hook)

  /**
   * THE SERVER IN USE, which sign-in, every web screen, Share and the Settings
   * field build from. The server the stored address names ([serverOf]): an
   * older build stored a pasted "…/home" as it was, and sign-in would open
   * /home/home.
   */
  val origin: Flow<String> get() = session.origin.map(::serverOf)

  suspend fun originNow() = serverOf(session.originNow())

  /**
   * SAVE A NEW SERVER ADDRESS — or refuse it, with a sentence the owner reads.
   *
   * Refused means NOTHING was saved: [checkOrigin] says why ("Start the address
   * with https://…"). It used to store whatever was typed, and an address with
   * no scheme then crashed the app on that save and on every launch after.
   *
   * ANOTHER HOST IS THE END OF A WALLET'S TURN. Who the old server said we
   * were, whether it was hosted, and every per-wallet store all belong to that
   * server; the forget hooks run and identity goes back to "not asked yet"
   * ([Identity.serverChanged]). The session cookie stays behind with the host
   * that set it — the jar is scoped, so it is simply not sent to the new one —
   * and comes back into use if the owner points the app back.
   *
   * THE TURN ENDS BEFORE THE NEW ADDRESS CAN BE SEEN, and no request crosses
   * it. It used to store the address first and end the turn after, so a
   * confirmed order that had already passed its owner check could read the
   * new address in that gap and be placed on a server its owner never looked
   * at — self-hosted, with no owner in the body for that server to refuse. Now
   * the move is one piece ([ServerTurns]): every request from before it stops
   * going anywhere, the hooks run, the address is stored, and only then can a
   * request read it. An identity read caught in the middle is refused, not
   * sent, and one that left before is dropped by the turn count as before.
   * The move cannot be cut in half by a cancelled screen, and two moves never
   * overlap.
   */
  suspend fun setOrigin(value: String): OriginCheck {
    identity.refuseInsideHook("setOrigin")
    val checked = checkOrigin(value, session.fallbackOrigin)
    if (checked !is OriginCheck.Ok) return checked
    withContext(NonCancellable) {
      moving.withLock {
        val before = session.originNow()
        if (!isOtherServer(before, checked.origin)) {
          // The same server, written as normalised: nobody's turn ends.
          session.setOrigin(checked)
          return@withLock
        }
        api.servers.leave()
        try {
          identity.serverChanged()
          session.setOrigin(checked)
        } finally {
          api.servers.arrive()
        }
      }
    }
    return checked
  }

  /** One Server change at a time; see [setOrigin]. */
  private val moving = Mutex()

  /**
   * WHICH SERVER THE APP IS ON, as a number that moves when the Server in
   * Settings becomes another host ([ServerTurns]). A screen notes the turn it
   * read in, and binds what the owner decides there to it (ServerBound).
   * What a screen holds that nobody has saved is keyed on it with the wallet
   * ([formOwnerOf]), because [signedIn] alone does not move between two
   * self-hosted servers: it is null on both.
   */
  val serverTurn: StateFlow<Long> get() = api.servers.now

  /**
   * Is the server there, and who does it say we are.
   *
   * NO DOOR TO OPEN FIRST. This used to POST a stored site password to the
   * gate route before anything else, because every other route answered 401
   * until it had. The route was deleted server-side on 2026-09-16 (46c852d1),
   * so on every cold start that POST was a pointless 404 carrying a password to
   * a server that no longer asks for one. An install upgraded from that build
   * still has the password stored, so it is deleted here; on every later start
   * the delete finds nothing.
   *
   * THE COOKIE GOES TOO, FROM BOTH STORES. The gate's cookie, mm_gate, carried
   * the password as its VALUE, and the jar kept sending it on every request to
   * a server that no longer reads it. Dropping it from the jar alone was undone
   * by the first WebView page: 0.1.0 had seeded it into the WebView's store,
   * and the sign-in hand-back copied it straight back. So it is expired there
   * as well (and the hand-back skips it; see WebAuth.RETIRED_COOKIES).
   *
   * THE WEBVIEW'S SIDE ONCE PER INSTALL, NOT ONCE PER START. Touching the
   * WebView's store starts the WebView itself on the main thread and flushes
   * to disk, and Home waits for this call — a cost every cold start paid for
   * a cookie that is gone after the first. So it runs until it has worked
   * once and is recorded ([SessionStore.webViewGateExpired]); a start whose
   * WebView refused (missing, mid-update) leaves no record and the next start
   * tries again. The jar's side is a map lookup, and stays on every start.
   */
  suspend fun bootstrap(): Loaded<Unit> {
    identity.refuseInsideHook("bootstrap")
    session.dropRetiredGatePassword()
    cookies.dropFromJar("mm_gate")
    if (!session.webViewGateExpired() && cookies.expireInWebView(session.originNow(), "mm_gate")) {
      session.markWebViewGateExpired()
    }
    return when (val v = api.version()) {
      is ApiResult.Ok -> {
        refreshIdentity()
        Loaded.Value(Unit)
      }
      is ApiResult.Refused -> Loaded.Refused(v.status, v.message)
      is ApiResult.Unreachable -> Loaded.Unreachable(v.cause, v.unreadable)
    }
  }

  /**
   * Who the session says we are.
   *
   * /api/auth/session exists for exactly this and is documented "read-only,
   * safe to poll". Inferring it from /api/grants instead conflated two
   * different questions — "are you signed in" and "do you have an agent" — so
   * a signed-in owner who had not minted one yet read as signed OUT.
   *
   * Unreachable leaves the answer ALONE. Not knowing is not the same as being
   * signed out, and treating it as such logs people out on a flaky train.
   *
   * The turn is read BEFORE asking: an answer that lands after a sign-out or a
   * Server change describes a session that no longer exists, and is dropped.
   */
  suspend fun refreshIdentity() {
    identity.refuseInsideHook("refreshIdentity")
    val asOf = identity.turn
    identity.answered(api.session(), asOf)
  }

  /**
   * KEEP ASKING WHO IS SIGNED IN UNTIL SOMEBODY ANSWERS.
   *
   * [bootstrap] asks once, and only after the version read answered. A cold
   * start whose first request failed (airplane mode, a DNS blip on wake, a
   * server restart) never asked again for the life of the process: every
   * read after the network came back worked, but identity stayed unknown, so
   * Chat said "Checking who's signed in…" for good, Trade told a signed-in
   * owner to sign in, no screen offered Sign in, and chat orders kept on disk
   * were never followed again. So while identity is unknown this asks the
   * session route again after a pause that doubles up to a minute, and
   * returns once an answer has landed, from here or from anything else that
   * asked. It pauses BEFORE the first ask, so a start whose bootstrap is
   * still out does not ask twice. The shell runs it while the app is in
   * front, and again whenever a Server change makes identity unknown.
   */
  suspend fun askUntilKnown(pause: suspend (Long) -> Unit = { delay(it) }) {
    var wait = IDENTITY_RETRY_FIRST_MS
    while (!identity.identityKnown.value) {
      pause(wait)
      if (identity.identityKnown.value) return
      refreshIdentity()
      wait = (wait * 2).coerceAtMost(IDENTITY_RETRY_MAX_MS)
    }
  }

  /**
   * HAND A WEB PAGE THE SESSION THE APP IS USING, before it loads
   * (WebAuth.seedLines: httpOnly and SameSite=Strict, as the server sets it).
   *
   * ONCE PER INSTALL, WHATEVER THE WEBVIEW ALREADY HOLDS. An older build
   * seeded the session as "mm_session=…; Path=/", without HttpOnly, and on an
   * upgraded phone that copy is still in the WebView's store with the jar's
   * value (the jar harvested it from there). The rule that leaves a
   * same-valued session alone left it for any script on the page to read,
   * until the owner next signed in. So the first handoff with a session to
   * give writes it regardless, and that is recorded
   * ([SessionStore.webViewSessionReseeded]); every handoff after it keeps the
   * skip, which keeps the server's own expiry on the cookie. Recorded only
   * when a session was written: a WebView that refused, or a jar holding no
   * session for [origin] (nobody signed in there), leaves it for the next
   * handoff, which costs nothing because the WebView is being opened anyway.
   */
  suspend fun seedWebView(origin: String) {
    val first = !session.webViewSessionReseeded()
    if (cookies.seedWebView(origin, rewriteSame = first) && first) session.markWebViewSessionReseeded()
  }

  /** Called after the WebView flow settles, to pick up a fresh session cookie. */
  suspend fun adoptWebSession() {
    identity.refuseInsideHook("adoptWebSession")
    cookies.harvest(session.originNow())
    refreshIdentity()
  }

  /**
   * Sign-out has to reach the SERVER, or the session outlives the app.
   *
   * Refused first thing from inside a forget hook ([Identity.refuseInsideHook]):
   * everything after that line is destructive, and a hook that got past it
   * would wipe the session while the wallet stayed published.
   */
  suspend fun signOut() {
    identity.refuseInsideHook("signOut")
    api.logout()
    cookies.forgetAll()
    session.clearSession()
    // What this wallet liked, wired and said in chat is not the next wallet's
    // business: every forget hook runs here.
    identity.signedOut()
  }
}
