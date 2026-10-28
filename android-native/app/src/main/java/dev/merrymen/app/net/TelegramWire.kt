package dev.merrymen.app.net

import java.net.URLEncoder
import kotlinx.serialization.Serializable

/** The current connection contract, including the worker's measured listening state. */
@Serializable
data class TelegramConnection(
  val enabled: Boolean = false,
  val hasToken: Boolean = false,
  /** getMe accepted the token; this alone does not prove the bot is listening. */
  val connected: Boolean = false,
  val botUsername: String? = null,
  val ownerId: Long? = null,
  val linkCode: String? = null,
  val linkPending: Boolean = false,
  val botElsewhere: Boolean = false,
  val listening: TelegramListening? = null,
  val tradingHeld: String? = null,
  val control: Boolean = true,
  val canReadAllGroupMessages: Boolean? = null,
  val canJoinGroups: Boolean? = null,
)

@Serializable
data class TelegramListening(
  val state: String = "unknown",
  val lastOkAt: Long? = null,
  val reason: String? = null,
)

/**
 * The owner parameter closes the session-change window around a bearer-code
 * read. The server refuses a different wallet instead of returning its code.
 * Self-hosted has one operator and no wallet session to name.
 */
suspend fun MerrymenApi.telegramConnection(owner: String?): ApiResult<TelegramConnection> =
  getJson("/api/telegram" + (owner?.let { "?owner=" + URLEncoder.encode(it, "UTF-8") } ?: ""))

/** Never build an arbitrary destination from a server-provided username or code. */
fun telegramChatUrl(botUsername: String?, linkCode: String? = null): String? {
  val bot = botUsername?.takeIf { Regex("^[A-Za-z0-9_]{3,64}$").matches(it) } ?: return null
  if (linkCode == null) return "https://t.me/$bot"
  val code = linkCode.takeIf { Regex("^[A-Za-z0-9_-]{1,64}$").matches(it) } ?: return null
  return "https://t.me/$bot?start=$code"
}

data class TelegramConnectionMessage(val title: String, val detail: String)

/** Unknown or absent liveness never becomes a promise that the bot answers. */
fun TelegramConnection.connectionMessage(): TelegramConnectionMessage = when {
  !hasToken -> TelegramConnectionMessage("Connect your agent to Telegram", "Create a bot with guided setup, or connect a bot you already own.")
  !enabled -> TelegramConnectionMessage("Telegram is off", "Your bot is saved. Turn Telegram on in connection settings when you're ready.")
  listening?.state == "revoked" && !connected -> TelegramConnectionMessage("Bot token needs updating", "Telegram refused the saved token. Update it in connection settings.")
  !connected -> TelegramConnectionMessage("Couldn't verify your bot", "The token may need updating, or Telegram may be unavailable. Check the saved token or try refreshing.")
  botElsewhere -> TelegramConnectionMessage("Bot connected elsewhere", "This bot belongs to another Merrymen agent. Review the connection in settings.")
  listening?.state == "conflict" -> TelegramConnectionMessage("Another program is using this bot", "Your agent isn't receiving its messages. Stop the other bot connection, then refresh.")
  listening?.state == "not-listening" -> TelegramConnectionMessage("Bot isn't listening", "Your bot is saved, but your agent hasn't received messages recently. Check your agent's status on Home.")
  listening?.state == "held" -> TelegramConnectionMessage("Trading paused for recovery", if (linkCode == null && ownerId == null) "Your bot is saved. It can answer and link your chat once your agent resumes." else "Your bot connection is saved. Trading remains paused while your agent recovers.")
  linkPending -> TelegramConnectionMessage("Bot saved", "Your agent hasn't picked up this bot yet. The link to your chat appears once it is running.")
  ownerId == null -> TelegramConnectionMessage("Link your Telegram chat", if (linkCode != null) "Open your bot and tap Start to connect your private chat." else "Your bot is saved. The link to your chat appears once your agent is running.")
  listening?.state == "live" -> TelegramConnectionMessage("Your bot is listening", "Your private chat is linked. Open Telegram to talk with your agent.")
  else -> TelegramConnectionMessage("Your chat is linked", "Your bot is saved. Its listening status hasn't been confirmed yet.")
}
