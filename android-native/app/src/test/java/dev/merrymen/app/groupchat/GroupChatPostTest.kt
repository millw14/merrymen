package dev.merrymen.app.groupchat

import dev.merrymen.app.data.ComposerAfter
import dev.merrymen.app.data.GroupChatRoom
import dev.merrymen.app.data.SendResult
import dev.merrymen.app.data.composerAfter
import dev.merrymen.app.data.waitLine
import dev.merrymen.app.net.Http
import dev.merrymen.app.net.MemoryStore
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.PersistentCookieJar
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.net.origin
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * AN OWNER'S LINES: posted once, however the answer goes missing; a rate limit
 * honoured to the second; and only the owner's own lines taken back.
 *
 * The server here answers a resend of a known clientId with the line it
 * already stored — what the route does (room.ts ownerLineByKey) — so "posted
 * once" is checked against the room's own rule, not assumed.
 */
class GroupChatPostTest {
  private lateinit var server: MockWebServer
  private val room = RoomServer()
  private var clock = 1_790_294_830_000L
  private val stored = LinkedHashMap<String, String>() // clientId → stored line JSON
  private val nextId = AtomicInteger(5_000)

  @Before fun start() {
    server = MockWebServer()
    server.dispatcher = room
    server.start()
  }

  @After fun stop() = server.shutdown()

  /**
   * The client, WITHOUT OkHttp's own silent retry of a request whose connection
   * dropped: these tests are about what the STORE does with a lost answer. The
   * app's client does retry (Http.client); the room's post is kept off that
   * retry, which theRoomsPostIsOneAttemptEvenOnTheAppsOwnClient shows.
   */
  private fun api() = apiFor(server, OkHttpClient.Builder().retryOnConnectionFailure(false).build())

  private fun bodyOf(r: RecordedRequest): JsonObject = Json.parseToJsonElement(r.body.clone().readUtf8()).jsonObject

  /** The route's behaviour: store once per clientId, answer a resend with the stored line. */
  private fun storeLine(r: RecordedRequest): MockResponse {
    val b = bodyOf(r)
    val cid = b["clientId"]!!.jsonPrimitive.content
    val line = synchronized(stored) {
      stored.getOrPut(cid) {
        lineJson(nextId.getAndIncrement().toLong(), b["body"]!!.jsonPrimitive.content, author = "owner", slug = MY_SLUG, name = "Robin's owner")
      }
    }
    return json("""{"message":$line}""")
  }

  private fun roomWith(post: (RecordedRequest) -> MockResponse) {
    room.answer = { r ->
      val p = r.path ?: ""
      when {
        r.method == "POST" && p == "/api/groupchat" -> post(r)
        p == "/api/groupchat/me" -> json(ME_MEMBER)
        p.startsWith("/api/groupchat?limit=") -> json(pageJson(listOf(lineJson(100, "hello")), cursor = 100))
        p.startsWith("/api/groupchat?since=") -> json(pageJson(emptyList(), cursor = 100))
        else -> MockResponse().setResponseCode(599)
      }
    }
  }

  private suspend fun ready(scope: CoroutineScope): GroupChatRoom {
    val r = GroupChatRoom(api(), scope, now = { clock })
    r.pollNow()
    r.pullMe(force = true)
    assertTrue(r.state.value.me!!.member)
    return r
  }

  private suspend fun GroupChatRoom.sendAndWait(text: String, replyTo: Long? = null): SendResult {
    val done = CompletableDeferred<SendResult>()
    send(text, replyTo) { done.complete(it) }
    return withTimeout(10_000) { done.await() }
  }

  @Test fun aLineIsSentOnceWithItsOwnKeyAndSettles() = runBlocking {
    roomWith(::storeLine)
    val r = ready(this)
    assertEquals(SendResult.Sent, r.sendAndWait("  gm  ", replyTo = 100))
    val post = room.posts().single()
    val body = bodyOf(post)
    assertEquals("trimmed", "gm", body["body"]!!.jsonPrimitive.content)
    assertEquals(100L, body["replyTo"]!!.jsonPrimitive.content.toLong())
    val cid = body["clientId"]!!.jsonPrimitive.content
    assertTrue(cid, Regex("^[A-Za-z0-9_-]{8,64}$").matches(cid))
    val s = r.state.value
    assertTrue(s.pending.isEmpty())
    assertFalse(s.posting)
    val line = s.messages.single { it.body == "gm" }
    assertEquals(cid, s.keys[line.id])
  }

  @Test fun aLostAnswerIsUnconfirmedAndSendingAgainReusesTheKeySoItPostsOnce() = runBlocking {
    val attempt = AtomicInteger(0)
    roomWith { req ->
      val res = storeLine(req) // the room STORES the line…
      // …and the answer to the first attempt never arrives.
      if (attempt.getAndIncrement() == 0) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST) else res
    }
    val r = ready(this)
    val first = r.sendAndWait("gm")
    assertTrue("never reported as a failure", first is SendResult.Unconfirmed)
    var s = r.state.value
    val pending = s.pending.single()
    assertTrue(pending.unconfirmed)
    assertFalse("the line is not handed back as a draft to type again", s.posting)

    val again = CompletableDeferred<SendResult>()
    r.resend(pending.clientId) { again.complete(it) }
    assertEquals(SendResult.Sent, withTimeout(10_000) { again.await() })

    val posts = room.posts()
    assertEquals(2, posts.size)
    assertEquals(
      "the same key both times",
      bodyOf(posts[0])["clientId"]!!.jsonPrimitive.content,
      bodyOf(posts[1])["clientId"]!!.jsonPrimitive.content,
    )
    assertEquals("stored once", 1, stored.size)
    s = r.state.value
    assertEquals(1, s.messages.count { it.body == "gm" })
    assertTrue(s.pending.isEmpty())
  }

  @Test fun aProxys5xxIsAnUnknownOutcomeToo() = runBlocking {
    roomWith { MockResponse().setResponseCode(502).setBody("<html>Bad gateway</html>") }
    val r = ready(this)
    val res = r.sendAndWait("hello room")
    assertTrue(res is SendResult.Unconfirmed)
    assertTrue(r.state.value.pending.single().unconfirmed)
    // Discarding is local: nothing is sent to delete anything.
    r.discard(r.state.value.pending.single().clientId)
    assertTrue(r.state.value.pending.isEmpty())
    assertEquals(1, room.posts().size)
  }

  @Test fun aDoubleTapSendsOnce() = runBlocking {
    val release = CountDownLatch(1)
    roomWith { req ->
      release.await(5, TimeUnit.SECONDS)
      storeLine(req)
    }
    val r = ready(this)
    val a = CompletableDeferred<SendResult>()
    val b = CompletableDeferred<SendResult>()
    r.send("gm", null) { a.complete(it) }
    r.send("gm", null) { b.complete(it) } // the second tap, or a recomposition calling it again
    val second = withTimeout(5_000) { b.await() }
    assertTrue(second is SendResult.Refused)
    assertTrue((second as SendResult.Refused).error.contains("One message at a time"))
    release.countDown()
    assertEquals(SendResult.Sent, withTimeout(10_000) { a.await() })
    assertEquals(1, room.posts().size)
    assertEquals(1, r.state.value.messages.count { it.body == "gm" })
  }

  /**
   * A 429's Retry-After is honoured to the second — and SAID ONCE. The store
   * hands the words back with no sentence of its own, so the countdown under
   * the box (waitLine) is the one line about the wait; it used to sit beside a
   * static "try again in 7s" that still said so after the wait had passed.
   */
  @Test fun a429sRetryAfterIsHonouredToTheSecondAndSaidOnce() = runBlocking {
    var limited = true
    roomWith { req ->
      if (limited) {
        json("""{"error":"You're posting fast. Wait a few seconds and try again."}""", 429).setHeader("Retry-After", "7")
      } else {
        storeLine(req)
      }
    }
    val r = ready(this)
    val res = r.sendAndWait("gm")
    assertEquals(SendResult.Refused("", words = "gm"), res)
    assertEquals(clock + 7_000, r.state.value.sendableAtMs)
    assertTrue("a refused line leaves the screen", r.state.value.pending.isEmpty())
    val box = composerAfter(res, draft = "", error = "an older sentence", replyTo = null)
    assertEquals("the words come back", "gm", box.draft)
    assertNull("and no second sentence stands beside the countdown", box.error)
    fun line() = r.state.value.let { waitLine(it.sendableAtMs, it.waitWords, clock) }
    assertEquals("Slow down — try again in 7s.", line())

    // Three seconds later: refused here, nothing is sent, and the countdown says 4s.
    clock += 3_000
    assertEquals(SendResult.Refused("", words = "gm"), r.sendAndWait("gm"))
    assertEquals("Slow down — try again in 4s.", line())
    assertEquals(1, room.posts().size)

    clock += 4_000
    assertNull("the wait is over, and nothing still says wait", line())
    limited = false
    assertEquals(SendResult.Sent, r.sendAndWait("gm"))
    assertEquals(2, room.posts().size)
  }

  /**
   * THE DAY'S LIMIT runs to midnight UTC — a Retry-After near 86,400. Counted
   * in seconds it read "try again in 80000s"; it is said in the server's own
   * sentence, which is true for the whole wait, until the last two minutes.
   */
  @Test fun aLongWaitIsSaidInTheServersWordsNotASecondsCounter() = runBlocking {
    val daily = "That's the most you can post today. The count resets at midnight UTC."
    roomWith { json("""{"error":"$daily"}""", 429).setHeader("Retry-After", "80000") }
    val r = ready(this)
    assertEquals(SendResult.Refused("", words = "gm"), r.sendAndWait("gm"))
    val s = r.state.value
    assertEquals(clock + 80_000_000, s.sendableAtMs)
    assertEquals(daily, waitLine(s.sendableAtMs, s.waitWords, clock))
    assertEquals(daily, waitLine(s.sendableAtMs, s.waitWords, s.sendableAtMs - 1_000_000))
    assertEquals("Slow down — try again in 60s.", waitLine(s.sendableAtMs, s.waitWords, s.sendableAtMs - 60_000))
    // With no sentence from the server: minutes or hours, rounded up, never sooner than allowed.
    assertEquals("Slow down — you can post again in 23 h.", waitLine(clock + 80_000_000, null, clock))
    assertEquals("Slow down — you can post again in 5 min.", waitLine(clock + 4 * 60_000 + 1, null, clock))
  }

  @Test fun aRefusalCarriesTheGatesOwnWordsAndA401AsksAgainWhoYouAre() = runBlocking {
    var answer = json("""{"error":"Links can't be posted in the room."}""", 400)
    roomWith { answer }
    val r = ready(this)
    assertEquals(SendResult.Refused("Links can't be posted in the room.", words = "see example.com"), r.sendAndWait("see example.com"))

    answer = MockResponse().setResponseCode(413).setBody("Payload Too Large")
    assertEquals(
      SendResult.Refused("That's too long to post. Keep it under 500 characters.", words = "x"),
      r.sendAndWait("x"),
    )

    val meBefore = room.count("GET", "/api/groupchat/me")
    answer = json("""{"error":"Sign in to post."}""", 401)
    assertEquals(SendResult.Refused("Sign in to post.", words = "gm"), r.sendAndWait("gm"))
    withTimeout(5_000) { while (room.count("GET", "/api/groupchat/me") == meBefore) delay(10) }

    // Nothing is sent for an empty line or one past the limit.
    val posts = room.posts().size
    assertEquals(SendResult.Refused("Write something first.", words = "   "), r.sendAndWait("   "))
    assertEquals(SendResult.Refused("Keep it under 500 characters.", words = "x".repeat(501)), r.sendAndWait("x".repeat(501)))
    assertEquals(posts, room.posts().size)
  }

  @Test fun anEchoThatArrivesBeforeALostAnswerSettlesTheLine() = runBlocking {
    val posted = CountDownLatch(1)
    val release = CountDownLatch(1)
    var echo = ""
    room.answer = { req ->
      val p = req.path ?: ""
      when {
        req.method == "POST" && p == "/api/groupchat" -> {
          echo = lineJson(101, "gm", author = "owner", slug = MY_SLUG, name = "Robin's owner")
          posted.countDown()
          release.await(5, TimeUnit.SECONDS)
          MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
        }
        p == "/api/groupchat/me" -> json(ME_MEMBER)
        p.startsWith("/api/groupchat?limit=") -> json(pageJson(listOf(lineJson(100, "gm", author = "owner", slug = MY_SLUG)), cursor = 100))
        p.startsWith("/api/groupchat?since=") -> json(pageJson(if (echo.isEmpty()) emptyList() else listOf(echo), cursor = 101))
        else -> MockResponse().setResponseCode(599)
      }
    }
    val r = ready(this)
    val done = CompletableDeferred<SendResult>()
    r.send("gm", null) { done.complete(it) }
    // Waited for without blocking this thread: the send runs on it.
    withTimeout(5_000) { while (posted.count > 0) delay(10) }
    // The poll brings the room's copy while the send is still out. The older
    // "gm" (id 100, at or below the cursor when sent) is NOT taken for it.
    r.pollNow()
    var s = r.state.value
    assertTrue(s.pending.isEmpty())
    assertEquals(s.keys[101L], s.keys.values.single())
    release.countDown()
    assertEquals("the room already showed it", SendResult.Sent, withTimeout(10_000) { done.await() })
    s = r.state.value
    assertTrue(s.pending.isEmpty())
    assertEquals(listOf(100L, 101L), s.messages.map { it.id })
  }

  @Test fun onlyTheOwnersOwnLinesAreTakenBackAndOnlyWhenTheServerSaysSo() = runBlocking {
    var hideAnswer = json("""{"hidden":true}""")
    room.answer = { req ->
      val p = req.path ?: ""
      when {
        req.method == "DELETE" -> hideAnswer
        p == "/api/groupchat/me" -> json(ME_MEMBER)
        p.startsWith("/api/groupchat?") -> json(
          pageJson(
            listOf(
              lineJson(200, "mine", author = "owner", slug = MY_SLUG, name = "Robin's owner"),
              lineJson(201, "my agent", author = "agent", slug = MY_SLUG, name = "Robin"),
              lineJson(202, "another owner", author = "owner", slug = "other0000000001"),
            ),
            cursor = 202,
          ),
        )
        else -> MockResponse().setResponseCode(599)
      }
    }
    val r = GroupChatRoom(api(), this, now = { clock })
    r.pollNow()
    r.pullMe(force = true)

    suspend fun hide(id: Long): String? {
      val d = CompletableDeferred<String?>()
      r.hide(id) { d.complete(it) }
      return withTimeout(10_000) { d.await() }
    }

    // Not the owner's line: refused here, and no DELETE is sent. The agent's
    // own lines are a model's words, not the owner's.
    assertTrue(hide(201)!!.contains("Only your own"))
    assertTrue(hide(202)!!.contains("Only your own"))
    assertEquals(0, room.count("DELETE", "/api/groupchat"))

    // The server says it hid nothing: the line stays.
    hideAnswer = json("""{"hidden":false}""")
    assertTrue(hide(200) != null)
    assertTrue(r.state.value.messages.any { it.id == 200L })

    // No answer: it may or may not be hidden, so it stays until a poll says.
    hideAnswer = MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
    assertTrue(hide(200)!!.contains("couldn't confirm"))
    assertTrue(r.state.value.messages.any { it.id == 200L })

    hideAnswer = json("""{"hidden":true}""")
    assertNull(hide(200))
    assertFalse(r.state.value.messages.any { it.id == 200L })
    assertTrue(room.requests.any { it.method == "DELETE" && it.path == "/api/groupchat?id=200" })
    // The overlap window re-delivers it; it does not come back.
    r.pollNow()
    assertFalse(r.state.value.messages.any { it.id == 200L })
  }

  @Test fun muteAndZoneShowOnlyWhatTheServerAnswered() = runBlocking {
    var meAnswer: (RecordedRequest) -> MockResponse = { json(ME_MEMBER) }
    room.answer = { req ->
      val p = req.path ?: ""
      when {
        p == "/api/groupchat/me" -> meAnswer(req)
        p.startsWith("/api/groupchat?") -> json(pageJson(emptyList(), cursor = 0))
        else -> MockResponse().setResponseCode(599)
      }
    }
    val r = GroupChatRoom(api(), this, now = { clock })
    r.pollNow()

    suspend fun write(f: (GroupChatRoom, (String?) -> Unit) -> Unit): String? {
      val d = CompletableDeferred<String?>()
      f(r) { d.complete(it) }
      return withTimeout(10_000) { d.await() }
    }

    // Not known to be a member yet: nothing is sent.
    assertTrue(write { g, done -> g.setMuted(true, done) }!!.contains("Only owners"))
    assertEquals(0, room.count("POST", "/api/groupchat/me"))

    r.pullMe(force = true)
    meAnswer = { req ->
      if (req.method == "POST") {
        val b = Json.parseToJsonElement(req.body.clone().readUtf8()).jsonObject
        assertEquals(setOf("muted"), b.keys)
        json(ME_MEMBER.replace("\"muted\":false", "\"muted\":true"))
      } else {
        json(ME_MEMBER)
      }
    }
    assertNull(write { g, done -> g.setMuted(true, done) })
    assertTrue(r.state.value.me!!.muted)

    // A failed write leaves the switch where the server last put it.
    meAnswer = { req -> if (req.method == "POST") MockResponse().setResponseCode(503) else json(ME_MEMBER) }
    assertEquals("That didn't save. Try again.", write { g, done -> g.setMuted(false, done) })
    assertTrue(r.state.value.me!!.muted)

    meAnswer = { req ->
      if (req.method == "POST") {
        val b = Json.parseToJsonElement(req.body.clone().readUtf8()).jsonObject
        assertEquals("Europe/London", b["tz"]!!.jsonPrimitive.content)
        assertEquals("the owner's pick, which no browser capture overwrites", "owner", b["source"]!!.jsonPrimitive.content)
        json(ME_MEMBER.replace("\"tz\":null", "\"tz\":\"Europe/London\"").replace("\"sleep\":null", "\"sleep\":{\"from\":\"23:10\",\"to\":\"07:10\"}"))
      } else {
        json(ME_MEMBER)
      }
    }
    assertNull(write { g, done -> g.setZone("Europe/London", done) })
    assertEquals("Europe/London", r.state.value.me!!.tz)
    assertEquals("23:10", r.state.value.me!!.sleepFrom)
  }

  /**
   * ONE CALL IS ONE ATTEMPT, EVEN ON THE APP'S OWN CLIENT. Http.client lets
   * OkHttp send a POST again on its own when a pooled connection drops after
   * the request went out, and a second copy racing the first can be answered
   * 429 while the first commits — which read as a refusal of a line that is in
   * the room. The room's post goes out with that resend off: the lost answer
   * is an unknown outcome, and Send again is the owner's to press.
   */
  @Test fun theRoomsPostIsOneAttemptEvenOnTheAppsOwnClient() = runBlocking {
    val attempt = AtomicInteger(0)
    roomWith { req ->
      val res = storeLine(req)
      if (attempt.getAndIncrement() == 0) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST) else res
    }
    val store = MemoryStore(server.origin())
    val http = Http.client(PersistentCookieJar(store), debug = false)
    val r = GroupChatRoom(MerrymenApi(http, store), this, now = { clock })
    // Read first, so the post goes out on a pooled connection: the case the transport resends.
    r.pollNow()
    r.pullMe(force = true)
    val first = r.sendAndWait("gm")
    assertTrue("$first", first is SendResult.Unconfirmed)
    assertEquals("nothing sent behind the store's back", 1, room.posts().size)

    val again = CompletableDeferred<SendResult>()
    r.resend(r.state.value.pending.single().clientId) { again.complete(it) }
    assertEquals(SendResult.Sent, withTimeout(10_000) { again.await() })
    assertEquals(1, room.posts().map { bodyOf(it)["clientId"]!!.jsonPrimitive.content }.distinct().size)
    assertEquals(1, stored.size)
    assertEquals(1, r.state.value.messages.count { it.body == "gm" })
  }

  /**
   * A RESEND IS REFUSED BEFORE ITS KEY IS LOOKED UP. The route checks the
   * session, the agent and the limits first, so a resend answered 429 or 401
   * says nothing about the first attempt, which may be in the room or still
   * committing. The line stays unconfirmed under its one key — never handed
   * back to be typed again, which mints a new key and posts it twice.
   */
  @Test fun aResendRefusedBeforeItsKeyIsLookedUpStaysUnconfirmed() = runBlocking {
    var answer: (RecordedRequest) -> MockResponse = { MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST) }
    roomWith { req -> answer(req) }
    val r = ready(this)
    assertTrue(r.sendAndWait("gm") is SendResult.Unconfirmed)
    val key = r.state.value.pending.single().clientId

    suspend fun resend(): SendResult {
      val d = CompletableDeferred<SendResult>()
      r.resend(key) { d.complete(it) }
      return withTimeout(10_000) { d.await() }
    }

    answer = { json("""{"error":"One message at a time. Try again in a second."}""", 429).setHeader("Retry-After", "1") }
    val limited = resend()
    assertTrue("$limited", limited is SendResult.Unconfirmed)
    assertTrue((limited as SendResult.Unconfirmed).error, limited.error.contains("can't say whether your first try was posted"))
    var s = r.state.value
    assertEquals("still on screen, under the same key", key, s.pending.single().clientId)
    assertTrue(s.pending.single().unconfirmed)
    assertEquals("the wait is kept all the same", clock + 1_000, s.sendableAtMs)

    clock += 1_000
    answer = { json("""{"error":"Sign in to post."}""", 401) }
    val signedOut = resend()
    assertTrue("$signedOut", signedOut is SendResult.Unconfirmed)
    assertTrue(r.state.value.pending.single().unconfirmed)

    answer = ::storeLine
    assertEquals(SendResult.Sent, resend())
    s = r.state.value
    assertTrue(s.pending.isEmpty())
    assertEquals(1, stored.size)
    assertEquals(1, s.messages.count { it.body == "gm" })
  }

  /**
   * A RESEND THE GATE REFUSES hands the words back. The gate judges the words
   * themselves, which the first attempt carried too, so the line comes off the
   * screen — and what the owner typed goes back in the box, where a refused
   * Send again used to drop it.
   */
  @Test fun aResendTheGateRefusesHandsTheWordsBack() = runBlocking {
    var answer: (RecordedRequest) -> MockResponse = { MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST) }
    roomWith { req -> answer(req) }
    val r = ready(this)
    assertTrue(r.sendAndWait("see example.com", replyTo = 100) is SendResult.Unconfirmed)
    val key = r.state.value.pending.single().clientId

    answer = { json("""{"error":"Links can't be posted in the room."}""", 400) }
    val d = CompletableDeferred<SendResult>()
    r.resend(key) { d.complete(it) }
    val res = withTimeout(10_000) { d.await() }
    assertEquals(SendResult.Refused("Links can't be posted in the room.", words = "see example.com", replyTo = 100), res)
    assertTrue("the line leaves the screen", r.state.value.pending.isEmpty())

    assertEquals(
      ComposerAfter("see example.com", "Links can't be posted in the room.", 100),
      composerAfter(res, draft = "", error = null, replyTo = null),
    )
    // Typed again meanwhile: the refused words go above, and neither is lost.
    assertEquals("see example.com" + "\n" + "gm", composerAfter(res, draft = "gm", error = null, replyTo = null).draft)
  }

  /**
   * AN ANSWER THAT CAME IS NOT "CAN'T REACH". A 2xx with no line in it, or one
   * this app cannot read, is still an unknown outcome — the line stays,
   * marked — but merrymen DID answer, and the sentence says so. The same for
   * taking a line back and for the owner's settings.
   */
  @Test fun anAnswerThatCameButCouldNotBeReadIsNeverCalledUnreachable() = runBlocking {
    val html = { MockResponse().setResponseCode(200).setHeader("content-type", "text/html").setBody("<html>ok</html>") }
    var post: () -> MockResponse = html
    room.answer = { req ->
      val p = req.path ?: ""
      when {
        req.method == "POST" && p == "/api/groupchat" -> post()
        req.method == "POST" && p == "/api/groupchat/me" -> html()
        req.method == "DELETE" -> html()
        p == "/api/groupchat/me" -> json(ME_MEMBER)
        p.startsWith("/api/groupchat?") ->
          json(pageJson(listOf(lineJson(200, "mine", author = "owner", slug = MY_SLUG, name = "Robin's owner")), cursor = 200))
        else -> MockResponse().setResponseCode(599)
      }
    }
    val r = GroupChatRoom(api(), this, now = { clock })
    r.pollNow()
    r.pullMe(force = true)

    val sent = r.sendAndWait("gm")
    assertTrue("$sent", sent is SendResult.Unconfirmed)
    val said = (sent as SendResult.Unconfirmed).error
    assertTrue(said, said.startsWith("merrymen answered, but not in a form this app can read"))
    assertFalse(said, said.contains("Can't reach"))
    assertTrue(r.state.value.pending.single().unconfirmed)

    // JSON with no line in it is the same unknown.
    r.discard(r.state.value.pending.single().clientId)
    post = { json("{}") }
    val empty = r.sendAndWait("gm again")
    assertTrue("$empty", empty is SendResult.Unconfirmed && empty.error.startsWith("merrymen answered"))

    val hid = CompletableDeferred<String?>()
    r.hide(200) { hid.complete(it) }
    val h = withTimeout(10_000) { hid.await() }!!
    assertTrue(h, h.contains("not in a form this app can read"))
    assertFalse("nobody said it was not hidden", h.contains("only your own"))
    assertTrue("it stays until a poll settles it", r.state.value.messages.any { it.id == 200L })

    val muted = CompletableDeferred<String?>()
    r.setMuted(true) { muted.complete(it) }
    assertEquals(
      "merrymen answered, but not in a form this app can read, so we can't say whether that saved.",
      withTimeout(10_000) { muted.await() },
    )
  }
}
