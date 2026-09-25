package dev.merrymen.app.net

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * A 2xx THAT DOES NOT DECODE IS NOT A CRASH, and a page of HTML is not a sentence.
 *
 * Before this, getJson decoded inside ApiResult.map with nothing catching, so
 * any 200 the model could not read — a proxy's HTML page, a null where the
 * model has a default, a field that grew past Int — threw out of whichever
 * LaunchedEffect asked and took the whole process down. And a refusal with no
 * JSON in it had its raw body pasted into the notice, so a Next 404 page
 * arrived on the phone as markup.
 */
class DecodeFailureTest {
  private lateinit var server: MockWebServer
  private lateinit var api: MerrymenApi

  @Before fun start() {
    server = MockWebServer()
    server.start()
    api = apiFor(server)
  }

  @After fun stop() = server.shutdown()

  // ── a 2xx the model cannot read ───────────────────────────────────────────

  @Test fun anHtml200IsUnreadableNotAThrow() = runBlocking {
    server.answer(HTML_PAGE, 200, "text/html")
    val r = api.theses()
    // Unreadable, not unreachable: the server answered. And the sentence names
    // no type — "(ThesesPage)" was our word for our model, and R8 renames it.
    assertEquals(ApiResult.Unreachable(UNREADABLE_ANSWER, unreadable = true), r)
    assertFalse((r as ApiResult.Unreachable).said.contains("ThesesPage"))
    assertFalse(r.said.contains("reach"))
  }

  @Test fun noAnswerAtAllIsNotUnreadable() = runBlocking {
    server.shutdown()
    val r = api.version() as ApiResult.Unreachable
    assertFalse(r.unreadable)
    assertTrue(r.said.startsWith(CANT_REACH))
  }

  @Test fun aNullWhereTheModelHasADefaultIsUnreachable() = runBlocking {
    // coerceInputValues stays false on purpose: coercing would turn an unread
    // null into the default, and for a figure that default is a confident 0.
    server.answer("""{"theses":null}""")
    assertTrue(api.theses() is ApiResult.Unreachable)
  }

  @Test fun aMissingRequiredFieldIsUnreachable() = runBlocking {
    server.answer("""{"positions":[{"value_usdg":5}]}""")
    assertTrue(api.feed() is ApiResult.Unreachable)
  }

  @Test fun anIntOverflowIsUnreachable() = runBlocking {
    server.answer("""{"why":"ok","tokens":99999999999}""")
    assertTrue(api.tier() is ApiResult.Unreachable)
  }

  @Test fun anOutOfShapeWriteAnswerIsUnreachableSoItReadsAsUnknown() = runBlocking {
    // A write whose answer cannot be read may still have happened. It must
    // reach the caller as "no answer", never as a refusal that says it did not.
    server.answer("""{"id":["not","a","string"],"queued":true}""")
    assertTrue(api.order("buy", "NVDA", 1.0) is ApiResult.Unreachable)
  }

  // ── figures that may be unread now decode as unread ──────────────────────

  @Test fun aCandleWithAMissingPriceDecodesAndTheBarIsIncomplete() = runBlocking {
    server.answer(
      """{"candles":{"state":"ok","interval":3600,"label":"1h","gaps":0,
          "candles":[{"t":1,"o":1.0,"h":2.0,"l":0.5,"c":1.5,"v":10},{"t":2,"o":1.5,"h":null,"l":1.0,"c":1.2}]}}""",
    )
    val d = (api.token("0xabc") as ApiResult.Ok).value
    val bars = d.candles!!.candles
    assertEquals(2, bars.size)
    assertNull(bars[1].h)
  }

  @Test fun aHolderWithNoValueDecodesAsUnread() = runBlocking {
    server.answer("""{"ledger":{"holders":[{"slug":"a","name":"A","valueUsdg":null}]}}""")
    val d = (api.token("0xabc") as ApiResult.Ok).value
    assertNull(d.ledger.holders.single().valueUsdg)
  }

  // ── refusals never carry a page of markup ────────────────────────────────

  @Test fun a404HtmlPageSaysOnlyItsStatus() = runBlocking {
    server.answer(HTML_PAGE, 404, "text/html")
    assertEquals(ApiResult.Refused(404, "HTTP 404"), api.agent("nobody"))
  }

  @Test fun aPlainText4xxSaysOnlyItsStatus() = runBlocking {
    server.answer("Forbidden: cross-site request", 403, "text/plain")
    assertEquals(ApiResult.Refused(403, "HTTP 403"), api.feed())
  }

  @Test fun aJson4xxWithNothingSayableSaysOnlyItsStatus() = runBlocking {
    server.answer("""{"ok":false}""", 400)
    assertEquals(ApiResult.Refused(400, "HTTP 400"), api.feed())
  }

  @Test fun a5xxIsTheGenericLine() = runBlocking {
    server.answer("""{"error":"TypeError: cannot read properties of undefined (reading 'x')"}""", 503)
    assertEquals(ApiResult.Refused(503, "merrymen answered with an error (503). Try again in a moment."), api.feed())
  }

  @Test fun a5xxHtmlPageIsTheGenericLine() = runBlocking {
    server.answer(HTML_PAGE, 502, "text/html")
    assertEquals(ApiResult.Refused(502, "merrymen answered with an error (502). Try again in a moment."), api.feed())
  }

  @Test fun a5xxWrittenForOwnersIsShown() = runBlocking {
    server.answer("""{"error":"couldn't check this account's ownership","ownerFacing":true}""", 503)
    assertEquals(ApiResult.Refused(503, "couldn't check this account's ownership"), api.grants())
  }

  @Test fun every4xxShapeStillSpeaks() = runBlocking {
    server.answer("""{"error":"over your 5 USDG limit"}""", 400)
    assertEquals(ApiResult.Refused(400, "over your 5 USDG limit"), api.order("buy", "NVDA", 10.0))
    server.answer("""{"errors":["OWNER_CHANGED_SETTING"]}""", 409)
    assertEquals(ApiResult.Refused(409, "OWNER_CHANGED_SETTING"), api.settings())
    server.answer("""{"reply":null,"why":"not signed in"}""", 401)
    assertEquals(ApiResult.Refused(401, "not signed in"), api.feed())
  }
}
