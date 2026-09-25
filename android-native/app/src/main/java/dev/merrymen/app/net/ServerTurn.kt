package dev.merrymen.app.net

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext

/**
 * WHICH SERVER A REQUEST WAS ASKED FOR, as a number that moves whenever the
 * Server in Settings becomes another host.
 *
 * Why a number and not the address: a request reads the stored address when
 * it is built, and building one suspends (the address is on disk). A
 * confirmed order that had passed its owner check could sit in that read
 * while the owner saved another server, wake up holding the NEW address, and
 * POST there — self-hosted, with no owner in the body for the new server to
 * refuse. The owner confirmed an order on one server and it was placed on
 * another. Comparing addresses cannot catch that (the address it read IS the
 * current one); comparing the turn it was asked in with the turn now can.
 *
 * EVEN WHILE SETTLED ON ONE SERVER, ODD WHILE MOVING TO ANOTHER. A move is
 * [leave], then the old server's turn ends (every forget hook runs), then the
 * new address is stored, then [arrive] — Repository.setOrigin is the only
 * thing that moves it. So by the time any request can read the new address,
 * the hooks have already run, and no request taken in the old turn can go
 * anywhere: not to the new server, whose address it may have read, and not to
 * the old one either, whose owner has just been forgotten here.
 *
 * WHY ONE CHECK, RIGHT BEFORE THE REQUEST LEAVES, IS ENOUGH. The turn only
 * ever goes up. A request takes its turn t, THEN reads the address, then
 * checks, under the same lock [leave] takes, that the turn is still t and
 * even. If it is, no move began at any point between the taking and the
 * check — so the address it read is the one turn t points at. If it is not,
 * nothing is sent.
 */
class ServerTurns {
  private val lock = Any()
  private val _now = MutableStateFlow(0L)

  /**
   * The turn now. A screen that holds unsaved work keys it on this (see
   * FormOwner), and a tap binds its requests to it ([MerrymenApi.boundHere]).
   */
  val now: StateFlow<Long> = _now.asStateFlow()

  /** Whether a request asked for in [turn] may still go: settled, and on the same server since. */
  fun holds(turn: Long): Boolean = synchronized(lock) { settled(turn) && _now.value == turn }

  /**
   * Run [send] — which must only hand the request to the transport, never
   * wait on it — while [turn] holds, and atomically with a move starting: a
   * move either began after it went (the request left for the server it was
   * asked for), or before, and it did not go. False when it did not run.
   */
  fun sendIf(turn: Long, send: () -> Unit): Boolean {
    synchronized(lock) {
      if (!settled(turn) || _now.value != turn) return false
      send()
      return true
    }
  }

  /** A move to another server begins: nothing asked for before this goes anywhere from now on. */
  internal fun leave() = synchronized(lock) {
    check(settled(_now.value)) { "a Server change began while another was under way" }
    _now.value = _now.value + 1
  }

  /** The move is over: the new address is stored, and requests asked for from here go to it. */
  internal fun arrive() = synchronized(lock) {
    check(!settled(_now.value)) { "a Server change ended that never began" }
    _now.value = _now.value + 1
  }

  private fun settled(turn: Long) = turn % 2 == 0L
}

/**
 * EVERY REQUEST MADE IN A COROUTINE CARRYING THIS IS FOR SERVER TURN [turn],
 * or is not sent at all.
 *
 * Taken at the moment the owner decides — the confirm card drawn, the form
 * read, the tap — and put on the coroutine that carries the decision out
 * (`scope.launch(api.boundHere()) { … }`, `withContext(ServerBound(t))`), so
 * a request that leaves after the Server changed does not go to a server the
 * owner never saw. A request made with no binding takes the turn at the
 * moment it is built, which still keeps its address and its turn together.
 */
class ServerBound(val turn: Long) : AbstractCoroutineContextElement(Key) {
  companion object Key : CoroutineContext.Key<ServerBound>
}

/**
 * The status an [ApiResult.Refused] carries when THIS APP refused to send the
 * request — no server said anything, and nothing was sent. Not an HTTP status,
 * so no caller's 401, 409 or 5xx branch can mistake it for one.
 */
const val NOT_SENT = 0

/**
 * Why a request was not sent: the Server in Settings became another host after
 * it was asked for. A clause, as [NOT_A_WEB_ADDRESS] is, for "That didn't go
 * through: …".
 */
const val SERVER_CHANGED = "the Server in Settings changed before this went out, so it wasn't sent to either server"

/** The same, as the whole sentence an [ApiResult.Refused] with [NOT_SENT] carries. */
const val SERVER_CHANGED_SENTENCE = "The Server in Settings changed before this went out, so it wasn't sent to either server."

/**
 * What a READ says when the Server changed under it — before it went, or while
 * its answer was on the way. The answer is the old server's, and a screen that
 * showed it would present it as the new one's.
 */
const val SERVER_CHANGED_READ = "the Server in Settings changed while this was being read"
