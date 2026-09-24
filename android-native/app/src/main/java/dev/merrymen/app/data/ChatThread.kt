package dev.merrymen.app.data

import android.content.Context
import dev.merrymen.app.net.MerrymenApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * THE ONE CHAT THREAD, FOR THE WHOLE APP — a stub with a fixed contract.
 *
 * The conversation has to outlive the Chat screen: a reply that arrives while
 * the owner is on the Feed, an order placed from chat whose outcome lands
 * minutes later, a thread that survives the app being killed. None of that can
 * live in a composable, so it lives here, app-scoped, held by AppContainer as
 * `container.chat`.
 *
 * THE CONTRACT, which other code is built against and which must not change:
 *   - constructed once as ChatThread(context, api, repo, appScope);
 *   - [unread] counts agent lines and receipts that landed while Chat was not
 *     on screen (the tab bar draws its dot from it);
 *   - [forget] drops everything that belongs to the current wallet. It is
 *     registered as a forget hook here, so it runs on sign-out and on a wallet
 *     switch without any screen having to remember to call it.
 *
 * The thread itself — streaming, persistence per address, order follow-through
 * and receipts — is filled in behind this contract. Until then it holds
 * nothing, so there is nothing to forget but the count.
 */
class ChatThread(
  private val context: Context,
  private val api: MerrymenApi,
  private val repo: Repository,
  /** Outlives every screen; work that must finish after the Chat tab closes runs here. */
  private val appScope: CoroutineScope,
) {
  private val _unread = MutableStateFlow(0)
  /** New lines the owner has not seen. 0 draws no dot. */
  val unread: StateFlow<Int> = _unread.asStateFlow()

  init {
    repo.addForgetHook { forget() }
  }

  /** Drop the current wallet's thread. Runs on sign-out and on a wallet switch. */
  suspend fun forget() {
    _unread.value = 0
  }
}
