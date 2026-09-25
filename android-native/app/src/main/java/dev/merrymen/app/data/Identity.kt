package dev.merrymen.app.data

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.SessionView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.coroutineContext

/**
 * Something that holds a fact about ONE wallet and must drop it when the app
 * stops acting for that wallet: likes, wires, a chat thread, a pending confirm.
 *
 * THE RULES A HOOK LIVES BY, because it runs inside the moment a wallet's turn
 * ends:
 *   - It runs on Dispatchers.IO (the runner puts it there), so deleting a file
 *     is fine and blocks nobody. Anything it publishes must be safe to write
 *     from a background thread — a StateFlow is, Compose snapshot state is.
 *   - It must NOT call back into Repository's identity methods
 *     (refreshIdentity, signOut, setOrigin, adoptWebSession, bootstrap). They
 *     wait for the turn this hook is running inside, so the call would wait for
 *     itself forever. Instead the call throws before it does anything — no
 *     logout sent, no cookie wiped, no server stored — and the runner logs
 *     that as the one hook's failure rather than freezing the app. The hook
 *     still did not do its job.
 *   - It must not assume it runs on EVERY end of a session. It does not run
 *     when a session simply expires (a 401, or the route answering address
 *     null): nothing proves the next wallet is a different one yet. What a
 *     screen RENDERS must be keyed on Repository.signedIn, not only on "the
 *     hook has not run".
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
 * THREE MOMENTS END A WALLET'S TURN, and the forget hooks run on all of them:
 *   - sign-out, which the app does itself;
 *   - a DIFFERENT address answering the session route. The WebView can sign a
 *     second wallet in while the app still holds the first one's state, and the
 *     app only finds out on its next identity read;
 *   - the Server changing to another host ([serverChanged]). Whatever the old
 *     server said about who we are, and whether it is hosted, is not something
 *     the new one said.
 *
 * "Different" is measured against the LAST ADDRESS THE STATE BELONGS TO, not the
 * previous answer. A session that expires (A, then signed out) and is then
 * signed into as B went A → null → B; comparing with the previous answer would
 * see null → B, run nothing, and hand B everything A left in memory.
 *
 * AN ANSWER FROM BEFORE A TURN ENDED IS DROPPED. A session read that left
 * before a sign-out or a Server change and lands after it describes a session
 * that is gone — the old cookie, the old host. Folding it in would publish the
 * old wallet as signed in on the new server. [turn] counts turn ends; a reader
 * takes it before asking and hands it back with the answer.
 *
 * [hookContext] is where hooks run: Dispatchers.IO in the app, a test's own
 * dispatcher in a test.
 */
class Identity(private val hookContext: CoroutineContext = Dispatchers.IO) {
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
  private val lock = Mutex()

  /** The address whose state the app currently holds. Survives a null answer; see the class note. */
  private var owner: String? = null

  @Volatile private var turns = 0L

  /** How many turns have ended. Take it BEFORE asking the session route; see the class note. */
  val turn: Long get() = turns

  /** Run [hook] whenever a wallet's turn ends. Registered once, for the app's life. */
  fun addForgetHook(hook: ForgetHook) {
    hooks += hook
  }

  /**
   * Fold one answer from the session route in. [asOf] is the [turn] read
   * before the question was sent; an answer from an earlier turn is dropped.
   *
   * Unreachable, or a refusal other than 401, leaves everything ALONE: not
   * knowing is not being signed out, and treating it as such logs people out
   * on a flaky train. A 401 is a real "signed out" — the route was reached and
   * said so — but it says nothing about hosting, so [hosted] keeps what it had.
   */
  suspend fun answered(r: ApiResult<SessionView>, asOf: Long = turn) = locked {
    if (asOf != turns) return@locked
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
  suspend fun signedOut() = locked {
    turns++
    forgetAll()
    owner = null
    _signedIn.value = null
    recompute()
  }

  /**
   * THE SERVER IS ANOTHER HOST NOW. Every hook runs, and everything this fold
   * learned from the old server is unlearned: who is signed in, that we know
   * it, and whether it is hosted. Until the new server answers, a screen must
   * read "not asked yet", not the old server's verdict — a hosted "Sign in"
   * offer on a self-hosted laptop, or the reverse.
   */
  suspend fun serverChanged() = locked {
    turns++
    forgetAll()
    owner = null
    _signedIn.value = null
    _identityKnown.value = false
    _hosted.value = null
    recompute()
  }

  /**
   * THROWS WHEN CALLED FROM INSIDE A FORGET HOOK, before anything else happens.
   *
   * Repository calls this FIRST in each of its identity methods. Checking only
   * at the lock was too late: signOut had already posted logout and wiped both
   * cookie stores, and setOrigin had already stored the new server, before the
   * lock refused — so a hook that broke the rule left a wallet published with
   * no session behind it, or the old server's verdict standing against a new
   * one. Refused here, the hook fails with nothing done, and the runner logs it.
   */
  internal suspend fun refuseInsideHook(what: String) {
    check(coroutineContext[RunningHooksKey] == null) {
      "a forget hook called $what; hooks must not call refreshIdentity, signOut, setOrigin, adoptWebSession or bootstrap"
    }
  }

  /**
   * The lock, refusing to be taken from inside a forget hook. The Mutex is not
   * reentrant, so a hook that asked for it would wait for the turn it is itself
   * part of, and the app would stop answering. Failing the hook is recoverable;
   * that is not. (Repository refuses earlier still; this is for a caller of
   * Identity itself.)
   */
  private suspend fun <T> locked(block: suspend () -> T): T {
    refuseInsideHook("into identity")
    return lock.withLock { block() }
  }

  private suspend fun forgetAll() = withContext(hookContext + RunningHooks) {
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

  /** Marks the coroutine that is running forget hooks; see [locked]. */
  private object RunningHooks : AbstractCoroutineContextElement(RunningHooksKey)

  private object RunningHooksKey : CoroutineContext.Key<RunningHooks>
}
