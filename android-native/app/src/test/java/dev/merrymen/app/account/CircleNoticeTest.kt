package dev.merrymen.app.account

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.ui.screens.circleNoticeFor
import dev.merrymen.app.ui.screens.readCircleFor
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * THE CIRCLE NEVER SHOWS THE CHAIN CLIENT'S EXCEPTION. /api/circle fills
 * `error` with it (circle/route.ts: `e instanceof Error ? e.message : …`): the
 * RPC's status and URL, the request body with the holder's address, the
 * library's version. The web never renders it; this screen pasted it after
 * "That's our chain read failing".
 */
class CircleNoticeTest {
  private val holder = "0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be"
  private val viem = "HTTP request failed.\\n\\nStatus: 429\\nURL: https://rpc.chain.robinhood.com\\n" +
    "Request body: {\\\"method\\\":\\\"eth_call\\\",\\\"params\\\":[{\\\"data\\\":\\\"0x70a08231000000000000000000000000${holder.drop(2)}\\\"}]}\\n\\n" +
    "Details: rate limited\\nVersion: viem@2.21.0"

  private fun readAnswer(body: String) = runBlocking {
    val server = MockWebServer()
    server.start()
    try {
      server.answer(body)
      (readCircleFor(apiFor(server), signedIn = holder, hosted = true) {} as Loaded.Value).value
    } finally {
      server.shutdown()
    }
  }

  private fun assertNoDump(text: String) {
    for (raw in listOf("HTTP request failed", "Status: 429", "rpc.chain", "eth_call", holder.drop(2), "viem", "rate limited")) {
      assertFalse("'$raw' shown: $text", text.contains(raw))
    }
  }

  @Test fun anUnreadableStandingIsSaidInTheAppsWordsOnly() {
    val v = readAnswer("""{"why":"unreadable","tiers":[],"error":"$viem"}""")
    val (title, body) = circleNoticeFor(v)
    assertEquals("Couldn't read your balance", title)
    assertEquals("That's our chain read failing, not your wallet. It should clear on its own.", body)
    assertNoDump(title + body)
  }

  @Test fun aReasonThisBuildDoesNotKnowEchoesNothing() {
    val v = readAnswer("""{"why":"rpc-quota","tiers":[],"error":"$viem"}""")
    val (title, body) = circleNoticeFor(v)
    assertEquals("Couldn't read where you stand", title)
    assertNoDump(title + body)
    assertFalse("the raw reason code is not a sentence: $body", body.contains("rpc-quota"))
  }
}
