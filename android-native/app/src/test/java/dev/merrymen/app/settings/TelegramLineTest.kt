package dev.merrymen.app.settings

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.TelegramTest
import dev.merrymen.app.ui.screens.telegramTestLine
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
}
