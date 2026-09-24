package dev.merrymen.app.data

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.PersistentCookieJar
import dev.merrymen.app.net.Session
import dev.merrymen.app.net.WebAuth
import kotlinx.coroutines.flow.StateFlow

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

class Repository(
  val api: MerrymenApi,
  private val session: Session,
  private val jar: PersistentCookieJar,
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
   * wallet's turn ends: on [signOut], and when the session route answers with a
   * DIFFERENT address than the one the app holds state for (a wallet switched
   * in the WebView). Hooks run in registration order, before the new address is
   * published, and one failing does not stop the rest. Register once, at
   * construction (AppContainer, or an app-scoped store's init).
   *
   * Not run on the first answer after a cold start: nothing in memory belongs
   * to anybody yet. A store that PERSISTS per-wallet state must key it by
   * address for exactly that reason.
   */
  fun addForgetHook(hook: ForgetHook) = identity.addForgetHook(hook)

  val origin get() = session.origin

  suspend fun originNow() = session.originNow()

  suspend fun setOrigin(value: String) = session.setOrigin(value)

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
   * THE COOKIE GOES TOO. The gate's cookie, mm_gate, carried the password as
   * its VALUE, and the jar kept sending it on every request to a server that no
   * longer reads it. Nothing is gained by keeping a credential in flight that
   * nothing checks.
   */
  suspend fun bootstrap(): Loaded<Unit> {
    session.dropRetiredGatePassword()
    // Off the main thread: the jar reads and writes DataStore with runBlocking.
    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { jar.drop("mm_gate") }
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
   */
  suspend fun refreshIdentity() = identity.answered(api.session())

  /** Called after the WebView flow settles, to pick up a fresh session cookie. */
  suspend fun adoptWebSession() {
    WebAuth.harvest(session.originNow(), jar)
    refreshIdentity()
  }

  /** Sign-out has to reach the SERVER, or the session outlives the app. */
  suspend fun signOut() {
    api.logout()
    WebAuth.forget(jar)
    session.clearSession()
    // What this wallet liked, wired and said in chat is not the next wallet's
    // business: every forget hook runs here.
    identity.signedOut()
  }
}
