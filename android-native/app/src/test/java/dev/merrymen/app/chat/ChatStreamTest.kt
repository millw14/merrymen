package dev.merrymen.app.chat

import dev.merrymen.app.net.Asked
import dev.merrymen.app.net.ChatBody
import dev.merrymen.app.net.HTML_PAGE
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.SseReplyReader
import dev.merrymen.app.net.StreamedReply
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.net.askAgent
import dev.merrymen.app.net.streamSafe
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * THE STREAM, CUT EVERY WAY THE NETWORK CAN CUT IT.
 *
 * A proposal marker `<<CMD …>>` is only ever read from `done`'s complete reply,
 * so nothing of one may reach the screen while the reply is still arriving —
 * not the `<<`, not the `<` that might become one, not a `<think>` a model
 * leaked. These feed fixed transcripts to the real reader split at EVERY byte,
 * including mid-marker and mid-character, and hold every emitted line to that.
 */
class ChatStreamTest {
  private fun event(name: String, json: String) = "event: $name\ndata: $json\n\n"

  /** The server's own framing (lib/chat-stream.ts sseEvent), with a marker and a leaked thought. */
  private val proposing =
    event("text", """{"t":"Sure — <thi"}""") +
      event("text", """{"t":"nk>should I?</think>I can buy that. "}""") +
      ": keep-alive\n\n" +
      event("text", """{"t":"Spend it on TSLA 🚀 now <<CM"}""") +
      event("text", """{"t":"D buy {\"symbol\":\"TSLA\",\"usdgAmount\":5}>>"}""") +
      event("done", """{"reply":"Sure — I can buy that. Spend it on TSLA 🚀 now","command":{"id":"buy","args":{"symbol":"TSLA","usdgAmount":5}}}""") +
      event("text", """{"t":" and one more thing"}""")

  private fun readSplitAt(transcript: ByteArray, cuts: List<Int>): Pair<StreamedReply, List<String>> {
    val shown = mutableListOf<String>()
    val reader = SseReplyReader { shown += it }
    var from = 0
    var out: StreamedReply? = null
    for (cut in cuts + transcript.size) {
      if (cut <= from) continue
      out = out ?: reader.feed(transcript.copyOfRange(from, cut))
      from = cut
    }
    return (out ?: reader.finish()) to shown
  }

  private fun assertSafe(shown: List<String>) {
    for (s in shown) {
      assertFalse("a partial marker reached the screen: $s", s.contains("<<"))
      assertFalse("a thought reached the screen: $s", s.contains("<think", ignoreCase = true))
      assertFalse("a lone < reached the screen: $s", s.endsWith("<"))
      assertFalse("mojibake from a character cut in two: $s", s.contains('�'))
    }
  }

  @Test fun everyTwoPieceSplitGivesTheSameReplyAndNeverAMarker() {
    val bytes = proposing.toByteArray()
    for (cut in 1 until bytes.size) {
      val (out, shown) = readSplitAt(bytes, listOf(cut))
      assertEquals("split at $cut", "Sure — I can buy that. Spend it on TSLA 🚀 now", out.reply)
      assertEquals("buy", out.command!!.id)
      assertEquals(JsonPrimitive(5), out.command!!.args["usdgAmount"])
      assertSafe(shown)
      assertEquals("the text grows and is never rewritten", shown, shown.sortedBy { it.length })
    }
  }

  @Test fun byteByByteIsTheSameReplyAndNothingAfterDoneIsAdded() {
    val bytes = proposing.toByteArray()
    val (out, shown) = readSplitAt(bytes, (1 until bytes.size).toList())
    assertEquals("Sure — I can buy that. Spend it on TSLA 🚀 now", out.reply)
    assertSafe(shown)
    assertEquals("Sure — I can buy that. Spend it on TSLA 🚀 now", shown.last().trimEnd())
    assertTrue(shown.none { it.contains("one more thing") })
  }

  @Test fun oneAnswerPerStreamEvenIfMoreIsFedAfterIt() {
    val shown = mutableListOf<String>()
    val reader = SseReplyReader { shown += it }
    assertEquals("buy", reader.feed(proposing.toByteArray())!!.command!!.id)
    val before = shown.toList()
    // A second done behind the first must not become a second reply, and text
    // behind it must not grow the bubble the first one already settled.
    val late = event("text", """{"t":"late words"}""") + event("done", """{"reply":"a second answer"}""")
    assertNull(reader.feed(late.toByteArray()))
    assertEquals(before, shown)
    assertEquals("Sure — I can buy that. Spend it on TSLA 🚀 now", reader.finish().reply)
  }

  @Test fun theCarriageReturnFramingReadsTheSame() {
    val crlf = proposing.replace("\n", "\r\n").toByteArray()
    for (cut in 1 until crlf.size step 3) {
      val (out, shown) = readSplitAt(crlf, listOf(cut))
      assertEquals("buy", out.command?.id)
      assertSafe(shown)
    }
  }

  @Test fun aStreamWithNoDoneIsCutOffNotTheHalfThatArrived() {
    val half = event("text", """{"t":"Your balance is "}""") + event("text", """{"t":"fine, but"}""")
    val (out, shown) = readSplitAt(half.toByteArray(), emptyList())
    assertNull(out.reply)
    assertEquals("cut-off", out.why)
    assertEquals("Your balance is fine, but", shown.last())
  }

  @Test fun aDoneWithNoBlankLineAfterItIsCutOff() {
    val unterminated = event("text", """{"t":"hi"}""") + "event: done\ndata: {\"reply\":\"hi\"}\n"
    assertEquals("cut-off", readSplitAt(unterminated.toByteArray(), emptyList()).first.why)
  }

  @Test fun anErrorEventCarriesTheKindAndTheDetailStaysOutOfTheText() {
    val failed = event("text", """{"t":"Let me"}""") +
      event("error", """{"why":"llm-error","kind":"rate-limited","provider":"Groq","detail":"429 invalid_api_key sk-…"}""")
    val (out, shown) = readSplitAt(failed.toByteArray(), listOf(9))
    assertNull(out.reply)
    assertEquals("llm-error", out.why)
    assertEquals("rate-limited", out.kind)
    assertEquals("Groq", out.provider)
    assertTrue(shown.none { it.contains("429") })
  }

  @Test fun noiseAndBrokenJsonAreIgnoredNotThrown() {
    val noisy = "retry: 100\n\n" + "data: {not json\n\n" + "event: text\ndata: {\"t\":5}\n\n" +
      event("text", """{"t":"ok"}""") + event("done", """{"reply":"ok"}""")
    val (out, shown) = readSplitAt(noisy.toByteArray(), emptyList())
    assertEquals("ok", out.reply)
    assertEquals(listOf("ok"), shown)
  }

  @Test fun theSafePrefixRules() {
    assertEquals("Hello ", streamSafe("Hello <<CMD buy {}>>"))
    assertEquals("Hello ", streamSafe("Hello <"))
    assertEquals("a <b> c", streamSafe("a <b> c"))
    assertEquals("before", streamSafe("before<think>half a thought"))
    assertEquals("beforeafter", streamSafe("before<|think|>x</|think|>after"))
    assertEquals("x", streamSafe("   x"))
  }

  // ── over the wire ───────────────────────────────────────────────────────

  private lateinit var server: MockWebServer
  private lateinit var api: MerrymenApi

  @Before fun start() {
    server = MockWebServer()
    server.start()
    api = apiFor(server)
  }

  @After fun stop() = server.shutdown()

  @Test fun theStreamArrivesInPiecesAndTheRequestAsksForIt() = runBlocking {
    server.enqueue(
      MockResponse().setHeader("content-type", "text/event-stream; charset=utf-8")
        .setBody(Buffer().writeUtf8(proposing))
        .throttleBody(7, 5, TimeUnit.MILLISECONDS),
    )
    val shown = mutableListOf<String>()
    val out = api.askAgent(ChatBody(message = "buy tsla"), onText = { shown += it })
    out as Asked.Replied
    assertEquals("Sure — I can buy that. Spend it on TSLA 🚀 now", out.reply)
    assertEquals("buy", out.command!!.id)
    assertTrue("it streamed", shown.size > 1)
    assertSafe(shown)
    assertEquals("text/event-stream, application/json", server.takeRequest().getHeader("accept"))
  }

  @Test fun aPlainJsonAnswerStillWorks() = runBlocking {
    server.answer("""{"reply":null,"why":"no-llm"}""")
    assertEquals(Asked.Failed("no-llm"), api.askAgent(ChatBody(message = "hi")) {})
    server.answer("""{"reply":"Hello there","command":{"id":"open-settings","args":{}}}""")
    val r = api.askAgent(ChatBody(message = "hi")) {} as Asked.Replied
    assertEquals("Hello there", r.reply)
    assertEquals("open-settings", r.command!!.id)
    server.answer("""{"reply":null,"why":"llm-error","kind":"key-rejected","provider":"Groq","detail":"401 bad key"}""")
    assertEquals(Asked.Failed("llm-error", kind = "key-rejected", provider = "Groq"), api.askAgent(ChatBody(message = "hi")) {})
  }

  @Test fun anErrorStatusIsTheServerNotAGarbledAnswer() = runBlocking {
    server.answer(HTML_PAGE, code = 502, type = "text/html")
    assertEquals(Asked.Failed("server", status = 502), api.askAgent(ChatBody(message = "hi")) {})
    server.answer("""{"reply":null,"why":"not signed in"}""", code = 401)
    assertEquals(Asked.Failed("signed-out"), api.askAgent(ChatBody(message = "hi")) {})
    server.answer(HTML_PAGE, code = 200, type = "text/html")
    assertEquals(Asked.Failed("unreadable"), api.askAgent(ChatBody(message = "hi")) {})
  }

  @Test fun aStreamThatDropsIsCutOff() = runBlocking {
    server.enqueue(
      MockResponse().setHeader("content-type", "text/event-stream")
        .setBody(event("text", """{"t":"Your balance is"}""") + event("text", """{"t":" fine"}"""))
        .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY),
    )
    val out = api.askAgent(ChatBody(message = "hi")) {}
    assertEquals(Asked.Failed("cut-off"), out)
  }
}
