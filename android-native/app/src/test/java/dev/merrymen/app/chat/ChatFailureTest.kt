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
    val kinds = listOf("key-rejected", "rate-limited", "provider-down", "unreachable", "model-missing", "billing", "other")
    val lines = kinds.map { failureLine("llm-error", kind = it, provider = "Groq") }
    assertEquals(kinds.size, lines.toSet().size)
    assertTrue(lines[0].contains("Groq refused the API key"))
    assertTrue(lines[1].contains("rate-limited by Groq"))
    assertEquals("an unknown kind is 'other'", lines.last(), failureLine("llm-error", kind = "new-kind", provider = "Groq"))
    // A provider "name" that is really an error message is not repeated.
    assertFalse(failureLine("llm-error", kind = "rate-limited", provider = "<b>429: {\"error\"}").contains("429"))
  }

  /**
   * The incident: the house Groq account was put on hold over an unpaid bill,
   * and every hosted owner was told "a reason I don't recognise … its setup
   * needs a look". The web's sentences (terminal/chat-thread.ts llmLine), word
   * for word.
   */
  @Test fun aBillingHoldIsSaidAsOneAndAHouseKeyIsOursToFix() {
    val ours = "That's ours to fix, not yours — nothing in your Settings will change it."
    assertEquals(
      "My brain's provider, Groq, has paused the house account I run on, so I can't answer in my own words right now. $ours",
      failureLine("llm-error", kind = "billing", provider = "Groq", house = true),
    )
    assertEquals(
      "My brain's provider has paused the house account I run on, so I can't answer in my own words right now. $ours",
      failureLine("llm-error", kind = "billing", house = true),
    )
    assertEquals(
      "My brain couldn't answer: Groq has put the account behind its API key on hold over billing. " +
        "Asking again won't help until that's settled, or another provider is chosen in Settings.",
      failureLine("llm-error", kind = "billing", provider = "Groq"),
    )
    assertEquals(
      "My brain couldn't answer: its provider has put the account behind its API key on hold over billing. " +
        "Asking again won't help until that's settled, or another provider is chosen in Settings.",
      failureLine("llm-error", kind = "billing"),
    )
    assertEquals(
      "My brain couldn't answer: Groq refused the house key I run on. $ours",
      failureLine("llm-error", kind = "key-rejected", provider = "Groq", house = true),
    )
    assertEquals(
      "My brain couldn't answer: Groq says the house model I run on isn't available. $ours",
      failureLine("llm-error", kind = "model-missing", provider = "Groq", house = true),
    )
    // The owner's own key is said as it always was.
    assertEquals(
      "My brain couldn't answer: Groq refused the API key it's set up with. Asking again won't help until that key is replaced.",
      failureLine("llm-error", kind = "key-rejected", provider = "Groq"),
    )
    assertEquals(
      "My brain couldn't answer: Groq says the model it's set to use isn't available. Asking again won't help until the model is changed.",
      failureLine("llm-error", kind = "model-missing", provider = "Groq"),
    )
    // A house key changes nothing where whose key it is does not matter.
    for (kind in listOf("rate-limited", "provider-down", "unreachable", "other", "new-kind")) {
      assertEquals(kind, failureLine("llm-error", kind = kind, provider = "Groq"), failureLine("llm-error", kind = kind, provider = "Groq", house = true))
    }
    // The operator's bill is not the tenant's business.
    val house = failureLine("llm-error", kind = "billing", provider = "Groq", house = true)
    assertFalse(house.contains("billing") || house.contains("overdue"))
  }

  @Test fun retryIsOfferedOnlyWhereAskingAgainCanWork() {
    assertTrue(retryHelps("network", null))
    assertTrue(retryHelps("llm-error", "rate-limited"))
    assertFalse(retryHelps("llm-error", "key-rejected"))
    assertFalse(retryHelps("llm-error", "model-missing"))
    assertFalse("a hold does not pass on its own", retryHelps("llm-error", "billing"))
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

  @Test fun theHouseFlagReachesTheLineWhetherJsonOrStreamedAndAHoldHasNoRetry() {
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    val groqHold = "groq 400 — organization_delinquent: Organization has been restricted because of overdue payment(s)."

    rig.route("POST /api/chat") {
      json("""{"reply":null,"why":"llm-error","kind":"billing","provider":"Groq","house":true,"detail":"$groqHold"}""")
    }
    runBlocking { chat.sendNow("hi", null) }
    rig.route("POST /api/chat") {
      sse("error" to """{"why":"llm-error","kind":"billing","provider":"Groq","house":true,"detail":"$groqHold"}""")
    }
    runBlocking { chat.sendNow("hi again", null) }
    // An older server says nothing of whose key it was: the owner's own.
    rig.route("POST /api/chat") {
      sse("error" to """{"why":"llm-error","kind":"billing","provider":"Groq","detail":"$groqHold"}""")
    }
    runBlocking { chat.sendNow("and again", null) }

    val agent = chat.thread.value.messages.filter { it.role == "agent" }
    val house = failureLine("llm-error", kind = "billing", provider = "Groq", house = true)
    assertEquals(listOf(house, house, failureLine("llm-error", kind = "billing", provider = "Groq")), agent.map { it.text })
    assertTrue("a hold does not pass on its own: no Retry", agent.all { it.retry == null && it.failed == "llm-error" })
    assertTrue(agent.none { it.text.contains("organization_delinquent") || it.text.contains("overdue") })
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
