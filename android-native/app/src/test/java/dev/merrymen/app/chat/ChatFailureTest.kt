package dev.merrymen.app.chat

import dev.merrymen.app.chat.ChatRig.Companion.A
import dev.merrymen.app.chat.ChatRig.Companion.json
import dev.merrymen.app.chat.ChatRig.Companion.sse
import dev.merrymen.app.data.historyFor
import dev.merrymen.app.net.HTML_PAGE
import dev.merrymen.app.ui.failureLine
import dev.merrymen.app.ui.retryHelps
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A FAILED REPLY IS SAID IN THE AGENT'S VOICE, AND NEVER IN THE PROVIDER'S.
 *
 * The phone printed `why — detail`, the server's redacted debug line included.
 * Each failure now maps to one of the web's sentences; the route's `detail`
 * never reaches a line, a Retry is offered only where asking again can work,
 * and the failed line is kept out of what the model is told it said.
 */
class ChatFailureTest {
  private val rig = ChatRig()

  @After fun stop() = rig.close()

  private val detail = "401 invalid_api_key sk-live-abc123"

  @Test fun everyFailureHasItsOwnSentence() {
    val kinds = listOf("signed-out", "no-llm", "timeout", "cut-off", "network", "server", "unreadable", "no-address")
    val lines = kinds.map { failureLine(it, status = 502) }
    assertEquals("no two failures read the same", kinds.size, lines.toSet().size)
    assertEquals("My answer was cut off before I finished, so I haven't kept half of it. Try again.", failureLine("cut-off"))
    assertTrue(failureLine("server", status = 502).contains("(the server said 502)"))
    assertEquals(failureLine("unreadable"), failureLine("a-kind-from-the-future"))
  }

  @Test fun aModelFailureIsSaidByItsKindWithTheProvidersName() {
    val kinds = listOf("key-rejected", "rate-limited", "provider-down", "unreachable", "model-missing", "other")
    val lines = kinds.map { failureLine("llm-error", kind = it, provider = "Groq") }
    assertEquals(kinds.size, lines.toSet().size)
    assertTrue(lines[0].contains("Groq refused the API key"))
    assertTrue(lines[1].contains("rate-limited by Groq"))
    assertEquals("an unknown kind is 'other'", lines[5], failureLine("llm-error", kind = "new-kind", provider = "Groq"))
    // A provider "name" that is really an error message is not repeated.
    assertFalse(failureLine("llm-error", kind = "rate-limited", provider = "<b>429: {\"error\"}").contains("429"))
  }

  @Test fun retryIsOfferedOnlyWhereAskingAgainCanWork() {
    assertTrue(retryHelps("network", null))
    assertTrue(retryHelps("llm-error", "rate-limited"))
    assertFalse(retryHelps("llm-error", "key-rejected"))
    assertFalse(retryHelps("llm-error", "model-missing"))
    assertFalse(retryHelps("llm-error", null))
    assertFalse(retryHelps("no-address", null))
  }

  @Test fun theDetailNeverReachesTheThreadWhetherJsonOrStreamed() {
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }

    rig.route("POST /api/chat") {
      json("""{"reply":null,"why":"llm-error","kind":"key-rejected","provider":"Groq","detail":"$detail"}""")
    }
    runBlocking { chat.sendNow("hi", null) }
    rig.route("POST /api/chat") {
      sse("text" to """{"t":"Let me"}""", "error" to """{"why":"llm-error","kind":"rate-limited","provider":"Groq","detail":"$detail"}""")
    }
    runBlocking { chat.sendNow("hi again", null) }

    val lines = chat.thread.value.messages
    assertTrue(lines.none { it.text.contains("invalid_api_key") || it.text.contains("sk-live") })
    val keyLine = lines[1]
    assertEquals("llm-error", keyLine.failed)
    assertNull("a rejected key will fail the same way: no Retry", keyLine.retry)
    assertNotNull("a rate limit passes: Retry", lines[3].retry)
    // Failures are ours, not the model's: left out of what it is told was said.
    assertEquals(listOf("hi", "hi again"), historyFor(lines).map { it.content })
  }

  @Test fun aRetryPutsTheQuestionAgainOnceAndGivesTheDraftBack() {
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    rig.route("POST /api/chat") { MockResponse().setResponseCode(502).setHeader("content-type", "text/html").setBody(HTML_PAGE) }
    chat.setDraft("what do you hold?")
    runBlocking { chat.sendNow("what do you hold?", null) }
    val failed = chat.thread.value.messages.last()
    assertEquals(failureLine("server", status = 502), failed.text)
    assertEquals("the words come back", "what do you hold?", chat.draft.value)

    rig.route("POST /api/chat") { json("""{"reply":"NVDA, up 25%."}""") }
    chat.setDraft("")
    runBlocking { chat.sendNow(failed.retry!!, failed.id) }
    assertEquals(
      "the failed line is replaced, the question is not asked twice",
      listOf("what do you hold?", "NVDA, up 25%."),
      chat.thread.value.messages.map { it.text },
    )
    val sent = rig.seen.filter { it.path == "/api/chat" }.last().body
    assertFalse("the retried question is not also in the history", sent.contains("\"history\":[{\"role\":\"user\",\"content\":\"what do you hold?\""))
  }
}
