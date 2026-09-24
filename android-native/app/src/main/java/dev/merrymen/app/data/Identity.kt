package dev.merrymen.app.data

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.SessionView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Something that holds a fact about ONE wallet and must drop it when the app
 * stops acting for that wallet: likes, wires, a chat thread, a pending confirm.
 */
fun interface ForgetHook {
  suspend fun forget()
}

/**
 * WHO THE APP IS ACTING FOR, AND WHEN THAT STOPS BEING TRUE.
 *
 * Kept apart from [Repository] because none of it needs Android — it is a fold
 * over /api/auth/session answers — and it is the piece whose mistakes cost the
 * most: a chat thread, a pending confirm or a like set that outlives its wallet
 * shows one owner's account to another, or acts for the wrong one.
 *
 * TWO MOMENTS END A WALLET'S TURN, and the forget hooks run on both:
 *   - sign-out, which the app does itself;
 *   - a DIFFERENT address answering the session route. The WebView can sign a
 *     second wallet in while the app still holds the first one's state, and the
 *     app only finds out on its next identity read.
 *
 * "Different" is measured against the LAST ADDRESS THE STATE BELONGS TO, not the
 * previous answer. A session that expires (A, then signed out) and is then
 * signed into as B went A → null → B; comparing with the previous answer would
 * see null → B, run nothing, and hand B everything A left in memory.
 */
class Identity {
  private val _signedIn = MutableStateFlow<String?>(null)
  /** The signed-in address, or null — signed out OR not yet known; see [identityKnown]. */
  val signedIn: StateFlow<String?> = _signedIn.asStateFlow()

  private val _identityKnown = MutableStateFlow(false)
  /** True once the session route has genuinely answered. Until then null is not "signed out". */
  val identityKnown: StateFlow<Boolean> = _identityKnown.asStateFlow()

  private val _hosted = MutableStateFlow<Boolean?>(null)
  /**
   * Whether this server is the hosted service, as its session route said. Null
   * until it answers. Self-hosted there is no sign-in at all — the route
   * answers {hosted:false, address:null} — so "signed out" there is not a
   * state anybody can leave.
   */
  val hosted: StateFlow<Boolean?> = _hosted.asStateFlow()

  private val _canOfferSignIn = MutableStateFlow(false)
  /**
   * Whether a "Sign in" offer is TRUE here: hosted, and nobody signed in. The
   * web's rule (session.hosted && !session.address). A self-hosted install that
   * showed one would send the reader to a sign-in that does not exist.
   */
  val canOfferSignIn: StateFlow<Boolean> = _canOfferSignIn.asStateFlow()

  private val hooks = CopyOnWriteArrayList<ForgetHook>()
  private val turn = Mutex()

  /** The address whose state the app currently holds. Survives a null answer; see the class note. */
  private var owner: String? = null

  /** Run [hook] whenever a wallet's turn ends. Registered once, for the app's life. */
  fun addForgetHook(hook: ForgetHook) {
    hooks += hook
  }

  /**
   * Fold one answer from the session route in.
   *
   * Unreachable, or a refusal other than 401, leaves everything ALONE: not
   * knowing is not being signed out, and treating it as such logs people out
   * on a flaky train. A 401 is a real "signed out" — the route was reached and
   * said so — but it says nothing about hosting, so [hosted] keeps what it had.
   */
  suspend fun answered(r: ApiResult<SessionView>) = turn.withLock {
    when (r) {
      is ApiResult.Ok -> {
        val address = r.value.address
        if (address != null && owner != null && !address.equals(owner, ignoreCase = true)) {
          // A SWITCH. The old wallet's state goes before the new address is
          // published, so nothing renders A's thread under B's name.
          forgetAll()
        }
        if (address != null) owner = address
        r.value.hosted?.let { _hosted.value = it }
        _signedIn.value = address
        _identityKnown.value = true
      }
      is ApiResult.Refused -> if (r.status == 401) {
        _signedIn.value = null
        _identityKnown.value = true
      }
      is ApiResult.Unreachable -> Unit
    }
    recompute()
  }

  /** The app signed out: every hook runs, and no wallet's state is held any more. */
  suspend fun signedOut() = turn.withLock {
    forgetAll()
    owner = null
    _signedIn.value = null
    recompute()
  }

  private suspend fun forgetAll() {
    for (h in hooks) {
      // ONE HOOK FAILING MUST NOT KEEP THE OTHERS' STATE ALIVE. A thread store
      // that could not delete its file is a problem; the likes of the last
      // wallet staying on screen because of it would be a worse one.
      try {
        h.forget()
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        android.util.Log.w("Identity", "a forget hook failed", e)
      }
    }
  }

  private fun recompute() {
    _canOfferSignIn.value = _hosted.value == true && _signedIn.value == null
  }
}
