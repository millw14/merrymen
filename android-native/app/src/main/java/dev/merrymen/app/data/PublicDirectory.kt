package dev.merrymen.app.data

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.LeaderRow
import dev.merrymen.app.net.Leaderboard
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.ServerBound
import dev.merrymen.app.net.agentDirectory
import dev.merrymen.app.ui.feed.BOARD_EVERY_MS
import dev.merrymen.app.ui.feed.ReadLoop
import dev.merrymen.app.ui.feed.Slot
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

/** Public identity only, even when an older server ignores ?view=directory. */
internal fun directoryOnly(board: Leaderboard) = Leaderboard(
  agents = board.agents.map { row ->
    LeaderRow(
      slug = row.slug, name = row.name, handle = row.handle,
      handleVerified = row.handleVerified, mode = row.mode, notRunning = row.notRunning,
    )
  },
  directory = true, fetchedAt = board.fetchedAt, source = board.source, retired = board.retired,
)

/** One in-memory public list for Home and Agents, replaced when the server changes. */
class PublicDirectory(private val api: MerrymenApi, private val now: () -> Long = System::currentTimeMillis) {
  private var current: PublicDirectoryRead? = null

  @Synchronized fun forTurn(turn: Long): PublicDirectoryRead {
    if (!api.servers.holds(turn)) return PublicDirectoryRead(api, turn, now)
    return current?.takeIf { it.turn == turn } ?: PublicDirectoryRead(api, turn, now).also { current = it }
  }

  /** Repository invokes this before publishing the new origin; owner changes keep public names. */
  @Synchronized fun forgetIfMoved() {
    current?.takeIf { !api.servers.holds(it.turn) }?.let {
      it.clear()
      current = null
    }
  }
}

class PublicDirectoryRead internal constructor(
  private val api: MerrymenApi,
  internal val turn: Long,
  private val now: () -> Long,
) {
  private val state = MutableStateFlow(Slot<Leaderboard>())
  val board = state.asStateFlow()
  // Both screens share this lock and clock. A second reader of a just-loaded
  // list reuses it instead of starting another request. Polling remains tied
  // to visible screens; no background network work or persisted book data.
  val loop = ReadLoop(BOARD_EVERY_MS) {
    if (!api.servers.holds(turn)) return@ReadLoop false
    val at = now()
    if (state.value.fresh && state.value.okAtMs?.let { at - it in 0 until BOARD_EVERY_MS } == true) return@ReadLoop true
    val result = withContext(ServerBound(turn)) { api.agentDirectory() }
    if (!api.servers.holds(turn)) return@ReadLoop false
    val identities = when (result) {
      is ApiResult.Ok -> ApiResult.Ok(directoryOnly(result.value))
      is ApiResult.Refused -> result
      is ApiResult.Unreachable -> result
    }
    state.value = state.value.after(identities, now()) { it.source == "none" }
    state.value.fresh
  }

  internal fun clear() { state.value = Slot() }
}
