package dev.merrymen.app.data

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.PersistentCookieJar
import dev.merrymen.app.net.Session
import dev.merrymen.app.net.WebAuth
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

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
  /** We never reached it. NOT a fact about the account. */
  data class Unreachable(val cause: String) : Loaded<Nothing>
}

fun <T> ApiResult<T>.toLoaded(): Loaded<T> = when (this) {
  is ApiResult.Ok -> Loaded.Value(value)
  is ApiResult.Refused -> Loaded.Refused(status, message)
  is ApiResult.Unreachable -> Loaded.Unreachable(cause)
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
  private val social: Social,
) {
  private val _signedIn = MutableStateFlow<String?>(null)
  val signedIn: StateFlow<String?> = _signedIn.asStateFlow()

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
  private val _identityKnown = MutableStateFlow(false)
  val identityKnown: StateFlow<Boolean> = _identityKnown.asStateFlow()

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
   */
  suspend fun bootstrap(): Loaded<Unit> {
    session.dropRetiredGatePassword()
    return when (val v = api.version()) {
      is ApiResult.Ok -> {
        refreshIdentity()
        Loaded.Value(Unit)
      }
      is ApiResult.Refused -> Loaded.Refused(v.status, v.message)
      is ApiResult.Unreachable -> Loaded.Unreachable(v.cause)
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
  suspend fun refreshIdentity() {
    when (val s = api.session()) {
      is ApiResult.Ok -> { _signedIn.value = s.value.address; _identityKnown.value = true }
      // A 401 from the SESSION route is a real "signed out" — we reached it and
      // it said so. A non-401 refusal or an unreachable server leaves identity
      // UNKNOWN, not signed-out.
      is ApiResult.Refused -> if (s.status == 401) { _signedIn.value = null; _identityKnown.value = true }
      is ApiResult.Unreachable -> Unit
    }
  }

  /** Called after the WebView flow settles, to pick up a fresh session cookie. */
  suspend fun adoptWebSession() {
    WebAuth.harvest(session.originNow(), jar)
    refreshIdentity()
  }

  /** Sign-out has to reach the SERVER, or the session outlives the app. */
  suspend fun signOut() {
    api.logout()
    // What this wallet liked and wired is not the next wallet's business.
    social.forget()
    WebAuth.forget(jar)
    session.clearSession()
    _signedIn.value = null
  }
}
