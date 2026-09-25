package dev.merrymen.app.settings

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.TelegramTest
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.ui.screens.telegramTestLine
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Test

/** P05: "Test the bot" says what the route said, in the web's words (Settings.tsx testTelegram). */
class TelegramLineTest {
  @Test fun theTelegramTestSaysWhatTheRouteSaid() {
    assertEquals("✓ connected as @merrybot", telegramTestLine(ApiResult.Ok(TelegramTest(ok = true, username = "merrybot"))))
    assertEquals("✗ no token set", telegramTestLine(ApiResult.Ok(TelegramTest(ok = false, reason = "no token set"))))
    assertEquals("✗ failed", telegramTestLine(ApiResult.Ok(TelegramTest(ok = false))))
    assertEquals("Sign in to test your bot.", telegramTestLine(ApiResult.Refused(401, "not signed in")))
    assertEquals("Can't reach merrymen right now: timeout", telegramTestLine(ApiResult.Unreachable("timeout")))
  }

  /**
   * THE ROUTE REFUSES A BODY WITHOUT `action: "test"` (telegram/route.ts:
   * `if (body.action !== "test")` → 400 "unknown action") before it looks at
   * any token. The field was a default, and the API's Json leaves defaults
   * out, so every tap sent `{}` and the owner read "✗ unknown action".
   */
  @Test fun theTestAsksTheRouteForATest() = runBlocking {
    val server = MockWebServer()
    server.start()
    try {
      val api = apiFor(server)
      server.answer("""{"ok":false,"reason":"no token set"}""")
      val r = api.telegramTest(null)
      assertEquals("""{"action":"test"}""", server.takeRequest().body.readUtf8())
      assertEquals("✗ no token set", telegramTestLine(r))

      server.answer("""{"ok":true,"username":"merrybot"}""")
      api.telegramTest("123456789:typed-but-not-saved")
      assertEquals(
        """{"action":"test","token":"123456789:typed-but-not-saved"}""",
        server.takeRequest().body.readUtf8(),
      )
    } finally {
      server.shutdown()
    }
  }
}
