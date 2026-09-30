package dev.merrymen.app.orders

import dev.merrymen.app.chat.ChatRig
import dev.merrymen.app.chat.ChatRig.Companion.json
import dev.merrymen.app.chat.Seen
import dev.merrymen.app.chat.waitFor
import dev.merrymen.app.data.ChatThread
import dev.merrymen.app.data.FileThreadStore
import dev.merrymen.app.data.Repository
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.Asked
import dev.merrymen.app.net.ChatBody
import dev.merrymen.app.net.Http
import dev.merrymen.app.net.MemoryCookies
import dev.merrymen.app.net.MemoryStore
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.NOT_SENT
import dev.merrymen.app.net.PersistentCookieJar
import dev.merrymen.app.net.SERVER_CHANGED
import dev.merrymen.app.net.SERVER_CHANGED_READ
import dev.merrymen.app.net.SERVER_CHANGED_SENTENCE
import dev.merrymen.app.net.ServerBound
import dev.merrymen.app.net.SessionStore
import dev.merrymen.app.net.askAgent
import dev.merrymen.app.net.origin
import dev.merrymen.app.ui.Placed
import dev.merrymen.app.ui.SERVER_CHANGED_LOCAL
import dev.merrymen.app.ui.TradeDesk
import dev.merrymen.app.ui.TradeOpen
import dev.merrymen.app.ui.TradeStep
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Dns
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * NOTHING ASKED FOR ON ONE SERVER IS SENT TO ANOTHER.
 *
 * Two self-hosted servers — the case with no owner in an order's body for the
 * wrong server to refuse. Settings used to store the new address first and end
 * the old server's turn after, so a confirmed order that had passed its owner
 * check could read the new address in between and be placed there. These run
 * the real Repository, API, client, cookie jar and chat thread against two
 * MockWebServers, and hold the stored address still at the exact moment a
 * request reads it, so the Server can be changed underneath it.
 */
class ServerChangeTest {
  /** One self-hosted merrymen: every request seen, routes by "METHOD /path". */
  private class Box : AutoCloseable {
    val server = MockWebServer()
    val seen = CopyOnWriteArrayList<Seen>()
    /** Counted down by the first request of any kind: waited on to show that none came. */
    val asked = CountDownLatch(1)
    val routes = ConcurrentHashMap<String, (Seen) -> MockResponse>()

    init {
      server.dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
          val s = Seen(request.method.orEmpty(), request.path.orEmpty(), request.body.readUtf8())
          seen += s
          asked.countDown()
          val path = s.path.substringBefore("?")
          if (path == "/api/auth/session") return json("""{"hosted":false,"address":null}""")
          return routes["${s.method} $path"]?.invoke(s) ?: json("""{"error":"no route in this test"}""", 404)
        }
      }
      server.start(LOOPBACK, 0)
      routes["GET /api/grants"] = { json("""{"exists":true,"mode":"live","grant":{"caps":{"perTradeUsdg":20,"dailyUsdg":100}}}""") }
      routes["GET /api/settings"] = { json("""{"values":{"liveTradingEnabled":true},"defaults":{}}""") }
      routes["GET /api/orders/ceiling"] = { json("""{"ceilingUsdg":25}""") }
      routes["GET /api/feed"] = { json(ChatRig.FEED) }
      routes["GET /api/version"] = { json("""{"version":"test"}""") }
      routes["POST /api/orders"] = { json("""{"id":"${"c".repeat(32)}","queued":true,"expiresInMs":495000}""") }
      routes["PUT /api/settings"] = { json("""{"ok":true}""") }
    }

    fun origin() = server.origin()
    fun writes() = seen.filter { it.method != "GET" }

    override fun close() = server.shutdown()
  }

  /**
   * THE DEVICE'S STORED ADDRESS, with one read of it that can be held: armed,
   * the next request to read it stops there — after its owner check, before it
   * knows where it is going — until the test lets it go.
   */
  private class HeldStore(val inner: MemoryStore) : SessionStore by inner {
    private val gate = AtomicReference<CompletableDeferred<Unit>?>(null)
    val reached = CompletableDeferred<Unit>()

    fun holdNextRead(): CompletableDeferred<Unit> = CompletableDeferred<Unit>().also { gate.set(it) }

    override suspend fun originNow(): String {
      gate.getAndSet(null)?.let { held ->
        reached.complete(Unit)
        held.await()
      }
      return inner.originNow()
    }
  }

  private val a = Box()
  private val b = Box()
  private val failures = CopyOnWriteArrayList<Throwable>()
  private val dir: File = Files.createTempDirectory("server-change").toFile()
  private val memory = MemoryStore(a.origin())
  private val store = HeldStore(memory)
  private val jar = PersistentCookieJar(memory)
  private val api = MerrymenApi(
    Http.client(jar, debug = false).newBuilder()
      .dns(
        object : Dns {
          override fun lookup(hostname: String): List<InetAddress> =
            if (hostname == "localhost") listOf(LOOPBACK) else Dns.SYSTEM.lookup(hostname)
        },
      )
      .build(),
    store,
  )
  private val repo = Repository(api, store, MemoryCookies(jar))
  private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined + CoroutineExceptionHandler { _, e -> failures += e })

  @After fun stop() {
    a.close()
    b.close()
    dir.deleteRecursively()
    check(failures.isEmpty()) { "app-scoped work failed: " + failures.joinToString() }
  }

  /** The chat thread, on server A, self-hosted: its key is "self". */
  private fun threadOnA(): ChatThread {
    val chat = ChatThread(api, repo, appScope, FileThreadStore(dir), clock = { 1_000_000L }, pause = {}, io = Dispatchers.Unconfined)
    runBlocking { repo.refreshIdentity() }
    waitFor("the self-hosted thread") { chat.thread.value.key == "self" }
    return chat
  }

  private fun moveToB() = runBlocking { withTimeout(10_000) { repo.setOrigin(b.origin()) } }

  @Test fun aTradeConfirmThatPassedItsCheckIsNotSentWhenTheServerChangesUnderIt() {
    val chat = threadOnA()
    val desk = TradeDesk(api) { chat.cardScope() }
    val card = runBlocking { (desk.open("buy", "NVDA", 5.0) as TradeOpen.Card).card }
    val held = store.holdNextRead()
    val step = runBlocking {
      val confirming = async(Dispatchers.IO) { desk.confirm(card) }
      // The confirm has passed alive() and is reading where to send the order.
      withTimeout(5_000) { store.reached.await() }
      assertTrue("nothing has gone yet", a.writes().isEmpty() && b.writes().isEmpty())
      withTimeout(10_000) { repo.setOrigin(b.origin()) }
      held.complete(Unit)
      withTimeout(10_000) { confirming.await() }
    }
    assertEquals("the new server receives nothing", emptyList<Seen>(), b.seen.toList())
    assertTrue("and the old one no order either", a.writes().isEmpty())
    // The owner is told, on the screen that confirmed it, that nothing went.
    val placed = (step as TradeStep.Done).placed as Placed.Refused
    assertEquals("That didn't go through: $SERVER_CHANGED", placed.line)
  }

  @Test fun aChatConfirmThatPassedItsCheckIsNotSentWhenTheServerChangesUnderIt() {
    a.routes["POST /api/chat"] = { json("""{"reply":"I can do that.","command":{"id":"buy","args":{"symbol":"NVDA","usdgAmount":5}}}""") }
    val chat = threadOnA()
    runBlocking { chat.sendNow("buy $5 of nvda", null) }
    val carded = chat.card.value
    assertTrue("a card is up for A's answer", carded != null)
    val held = store.holdNextRead()
    // Carried out in the app's scope, as the Chat screen's Yes does.
    chat.confirm { _, _ -> }
    runBlocking { withTimeout(5_000) { store.reached.await() } }
    assertTrue("nothing has gone yet", a.writes().none { it.path == "/api/orders" })
    moveToB()
    held.complete(Unit)
    // The confirm ran on to its end as the read was let go (the app scope here
    // runs unconfined); a request it had sent would reach B within this wait.
    assertFalse("the new server receives nothing", b.asked.await(500, TimeUnit.MILLISECONDS))
    assertTrue("and the old one no order either", a.writes().none { it.path == "/api/orders" })
    // The new server's thread holds nothing of the old one's card.
    runBlocking { repo.refreshIdentity() }
    waitFor("B's thread") { chat.thread.value.key == "self" }
    assertTrue(chat.thread.value.messages.isEmpty())
    assertNull(chat.card.value)
  }

  @Test fun aCardShownOnTheServerTheOwnerLeftSaysTheServerChanged() {
    val chat = threadOnA()
    val desk = TradeDesk(api) { chat.cardScope() }
    val card = runBlocking { (desk.open("buy", "NVDA", 5.0) as TradeOpen.Card).card }
    moveToB()
    runBlocking { repo.refreshIdentity() }
    waitFor("B's thread") { chat.thread.value.key == "self" }
    val step = runBlocking { desk.confirm(card) } as TradeStep.Done
    assertEquals(SERVER_CHANGED_LOCAL, (step.placed as Placed.Refused).line)
    assertTrue(b.writes().isEmpty() && a.writes().isEmpty())
    // Said on the Trade screen, not in B's thread: self-hosted, both threads
    // have the key "self", and A's card is not B's conversation.
    assertTrue(chat.thread.value.messages.isEmpty())
  }

  @Test fun anOrderPlacedOnTheServerTheOwnerLeftIsNoLongerFollowedAndSaysNothing() {
    val id = "c".repeat(32)
    a.routes["POST /api/chat"] = { json("""{"reply":"I can do that.","command":{"id":"buy","args":{"symbol":"NVDA","usdgAmount":5}}}""") }
    a.routes["GET /api/orders"] = { json("""{"id":"$id","state":"queued"}""") }
    var now = 1_000_000L
    val waiting = java.util.concurrent.atomic.AtomicInteger(0)
    val tickets = kotlinx.coroutines.channels.Channel<Unit>(kotlinx.coroutines.channels.Channel.UNLIMITED)
    val chat = ChatThread(
      api, repo, appScope, FileThreadStore(dir),
      clock = { now },
      // Each wait of the follow holds until the test hands it a ticket.
      pause = { ms -> waiting.incrementAndGet(); tickets.receive(); now += ms },
      io = Dispatchers.Unconfined,
    )
    runBlocking { repo.refreshIdentity() }
    waitFor("the self-hosted thread") { chat.thread.value.key == "self" }
    runBlocking { chat.sendNow("buy $5 of nvda", null) }
    chat.confirm { _, _ -> }
    waitFor("the order placed on A, and its follow waiting") { waiting.get() == 1 }
    assertTrue(chat.thread.value.messages.any { it.order?.id == id })

    moveToB()
    runBlocking { repo.refreshIdentity() }
    waitFor("B's thread") { chat.thread.value.key == "self" }
    assertTrue("B's thread starts empty", chat.thread.value.messages.isEmpty())
    // Long past the order's window: a follow still running would ask once more
    // and then say it never heard back — into B's conversation, about A's order.
    now += 100_000_000L
    runBlocking { tickets.send(Unit) }
    Thread.sleep(500)
    assertTrue("nothing about A's order in B's thread", chat.thread.value.messages.isEmpty())
    assertEquals("B was never asked about A's order", emptyList<String>(), b.seen.map { it.path }.filter { it.startsWith("/api/orders") })
  }

  @Test fun theOldServersTurnEndsBeforeAnyRequestCanSeeTheNewOne() {
    runBlocking { repo.refreshIdentity() }
    val storedDuringHooks = AtomicReference<String?>(null)
    val readDuringHooks = AtomicReference<ApiResult<*>?>(null)
    val writeDuringHooks = AtomicReference<ApiResult<*>?>(null)
    repo.addForgetHook {
      storedDuringHooks.set(memory.originNow())
      readDuringHooks.set(api.version())
      writeDuringHooks.set(api.order("buy", "NVDA", 5.0))
    }
    val before = a.seen.size
    moveToB()
    assertEquals("the hooks ran while the old address was still the stored one", a.origin(), storedDuringHooks.get())
    assertEquals(ApiResult.Unreachable(SERVER_CHANGED_READ), readDuringHooks.get())
    assertEquals(ApiResult.Refused(NOT_SENT, SERVER_CHANGED_SENTENCE), writeDuringHooks.get())
    assertEquals("the old server heard nothing during the change", before, a.seen.size)
    assertEquals("nor did the new one", emptyList<Seen>(), b.seen.toList())
    // Once it is over, a request goes to the new server.
    assertTrue(runBlocking { api.version() } is ApiResult.Ok)
    assertEquals(listOf("/api/version"), b.seen.map { it.path })
  }

  @Test fun aWriteBoundToTheServerTheOwnerLeftIsNotSentAnywhere() {
    runBlocking { repo.refreshIdentity() }
    val tapped = api.boundHere()
    moveToB()
    val put = runBlocking {
      withContext(tapped) { api.patchSettings(JsonObject(mapOf("liveTradingEnabled" to JsonPrimitive(true)))) }
    }
    assertEquals(ApiResult.Refused(NOT_SENT, SERVER_CHANGED_SENTENCE), put)
    // Unbound, the same write goes where the Server points now.
    assertTrue(runBlocking { api.patchSettings(JsonObject(mapOf("liveTradingEnabled" to JsonPrimitive(true)))) } is ApiResult.Ok)
    assertEquals("only the unbound write reached B", 1, b.writes().size)
    assertTrue(a.writes().isEmpty())
  }

  @Test fun aChatQuestionPutToTheServerTheOwnerLeftIsNotSentAnywhere() {
    runBlocking { repo.refreshIdentity() }
    val asked = api.boundHere()
    moveToB()
    val out = runBlocking { withContext(asked) { api.askAgent(ChatBody(message = "hello", state = "{}", history = emptyList())) {} } }
    assertEquals(Asked.Failed("server-changed"), out)
    assertTrue(b.seen.isEmpty() && a.writes().isEmpty())
  }

  @Test fun aReadThatLandsAfterTheServerChangedIsNotHandedOn() {
    runBlocking { repo.refreshIdentity() }
    val answered = CountDownLatch(1)
    a.routes["GET /api/feed"] = {
      answered.await(5, TimeUnit.SECONDS)
      json("""{"source":"sqlite","agent":{"slug":"a-agent","name":"A's agent"}}""")
    }
    val read = runBlocking {
      val reading = async(Dispatchers.IO) { api.feed() }
      waitFor("A to be asked") { a.seen.any { it.path == "/api/feed" } }
      withTimeout(10_000) { repo.setOrigin(b.origin()) }
      answered.countDown()
      withTimeout(10_000) { reading.await() }
    }
    // A's book, handed on now, would be drawn as B's.
    assertEquals(ApiResult.Unreachable(SERVER_CHANGED_READ), read)
  }

  companion object {
    val LOOPBACK: InetAddress = InetAddress.getByName("127.0.0.1")
  }
}
