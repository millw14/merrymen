package dev.merrymen.app.settings

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.TelegramConnection
import dev.merrymen.app.net.TelegramListening
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.net.connectionMessage
import dev.merrymen.app.net.telegramChatUrl
import dev.merrymen.app.net.telegramConnection
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TelegramConnectionTest {
  private val linked = TelegramConnection(enabled = true, hasToken = true, connected = true, ownerId = 42)

  @Test fun aValidTokenAndLinkedOwnerDoNotProveTheBotIsListening() {
    assertEquals("Your chat is linked", linked.connectionMessage().title)
    assertEquals("Your chat is linked", linked.copy(listening = TelegramListening("unknown")).connectionMessage().title)
    assertEquals("Your bot is listening", linked.copy(listening = TelegramListening("live")).connectionMessage().title)
    assertEquals("Bot isn't listening", linked.copy(listening = TelegramListening("not-listening")).connectionMessage().title)
    assertEquals("Another program is using this bot", linked.copy(listening = TelegramListening("conflict")).connectionMessage().title)
  }

  @Test fun aHeldNewBotDoesNotPromiseAWorkingChatOrAnotherLinkCodeSoon() {
    val held = linked.copy(ownerId = null, linkPending = true, listening = TelegramListening("held"), tradingHeld = "recovery")
    assertEquals("Trading paused for recovery", held.connectionMessage().title)
    assertTrue(held.connectionMessage().detail.contains("once your agent resumes"))
  }

  @Test fun aBotMovedToAnotherAgentIsNotReportedAsAwaitingItsWorker() {
    assertEquals("Bot connected elsewhere", linked.copy(botElsewhere = true, linkPending = true).connectionMessage().title)
  }

  @Test fun aRefusedOldTokenAndANewlySavedTokenHaveDifferentRemedies() {
    val revoked = linked.copy(connected = false, listening = TelegramListening("revoked"))
    assertEquals("Bot token needs updating", revoked.connectionMessage().title)
    assertEquals("Your chat is linked", revoked.copy(connected = true).connectionMessage().title)
    assertEquals("Telegram is off", revoked.copy(enabled = false).connectionMessage().title)
  }

  @Test fun chatLinksRemainOnTelegramAndDoNotNeedToExposeACodeForALinkedOwner() {
    assertEquals("https://t.me/merrybot", telegramChatUrl("merrybot"))
    assertEquals("https://t.me/merrybot?start=AB12CD", telegramChatUrl("merrybot", "AB12CD"))
    assertNull(telegramChatUrl("evil.com/path"))
    assertNull(telegramChatUrl("merrybot", "CODE&other=1"))
    assertNull(telegramChatUrl("merrybot", ""))
    assertNull(telegramChatUrl(null))
  }

  @Test fun bearerCodeReadsNameTheWalletTheyWereOpenedFor() = runBlocking {
    val server = MockWebServer()
    server.start()
    try {
      val api = apiFor(server)
      server.answer("""{"enabled":true,"hasToken":true,"connected":true,"listening":{"state":"conflict","lastOkAt":1720000000,"reason":null},"botElsewhere":true,"linkPending":false,"canJoinGroups":null}""")
      val result = api.telegramConnection("0xowner") as ApiResult.Ok
      assertEquals("/api/telegram?owner=0xowner", server.takeRequest().path)
      assertEquals("conflict", result.value.listening?.state)
      assertEquals(1720000000L, result.value.listening?.lastOkAt)
      assertTrue(result.value.botElsewhere)
      assertNull(result.value.canJoinGroups)

      server.answer("""{"enabled":true,"hasToken":true,"connected":true,"ownerId":42}""")
      val older = api.telegramConnection(null) as ApiResult.Ok
      assertEquals("/api/telegram", server.takeRequest().path)
      assertNull(older.value.listening)
      assertFalse(older.value.linkPending)
      assertEquals("Your chat is linked", older.value.connectionMessage().title)
    } finally {
      server.shutdown()
    }
  }
}
