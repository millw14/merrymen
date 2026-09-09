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

/** True when the refusal means "you are not signed in", across the API's shapes. */
fun Loaded<*>.needsSignIn(): Boolean = this is Loaded.Refused && status == 401

class Repository(
  val api: MerrymenApi,
  private val session: Session,
  private val jar: PersistentCookieJar,
  private val social: Social,
) {
  private val _signedIn = MutableStateFlow<String?>(null)
  val signedIn: StateFlow<String?> = _signedIn.asStateFlow()

  val origin get() = session.origin

  suspend fun originNow() = session.originNow()

  suspend fun setOrigin(value: String) = session.setOrigin(value)

  /**
   * Open the door if a password is stored, then find out who we are.
   *
   * Order matters: while the site gate is on, EVERY /api path except /api/gate
   * answers 401 {"error":"gated"} — including the ones that would tell us
   * whether we are signed in. Asking the identity question first would report
   * "signed out" for a perfectly good session behind a closed door.
   */
  suspend fun bootstrap(): Loaded<Unit> {
    session.gatePassword()?.let { pw -> api.gate(pw) }
    return when (val v = api.version()) {
      is ApiResult.Ok -> {
        refreshIdentity()
        Loaded.Value(Unit)
      }
      is ApiResult.Refused -> Loaded.Refused(v.status, v.message)
      is ApiResult.Unreachable -> Loaded.Unreachable(v.cause)
    }
  }

  suspend fun openGate(password: String): Loaded<Unit> {
    val r = api.gate(password)
    if (r is ApiResult.Ok) session.setGatePassword(password)
    return r.toLoaded()
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
      is ApiResult.Ok -> _signedIn.value = s.value.address
      is ApiResult.Refused -> if (s.status == 401) _signedIn.value = null
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
