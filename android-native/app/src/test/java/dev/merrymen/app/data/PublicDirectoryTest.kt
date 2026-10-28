package dev.merrymen.app.data

import dev.merrymen.app.AppGraph
import dev.merrymen.app.net.Http
import dev.merrymen.app.net.MemoryCookies
import dev.merrymen.app.net.MemoryStore
import dev.merrymen.app.net.PersistentCookieJar
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.net.origin
import dev.merrymen.app.newAppScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

class PublicDirectoryTest {
  private val fullBoard = """{"source":"sqlite","retired":2,"agents":[{
    "slug":"desk","name":"Desk","handle":"owner","handleVerified":true,"mode":"paper","notRunning":true,
    "performance":{"book":"paper","publicBook":true,"equityUsdg":999,"pnlBps":123},
    "pnlBps":123,"paperPnlBps":456,"maxDdBps":70,"landed":8,"filledPaper":9,"liveFills":7,"paperFills":6,"refused":5,"unrankedWhy":"paper"}],
    "retiredAgents":[{"name":"Retired","pnlBps":234}]}"""

  @Test fun revisitingTheDirectoryReusesOnlyPublicIdentitiesAndRetainsThemAfterFailure() = runBlocking {
    val server = MockWebServer().apply { start() }
    val clock = AtomicLong(1_000)
    try {
      val cache = PublicDirectory(apiFor(server), clock::get)
      val home = cache.forTurn(0)
      server.answer(fullBoard)
      assertTrue(home.loop.readNow(clock.get()))
      val agents = cache.forTurn(0)
      assertSame("Home and Agents retain the same list after composition ends", home, agents)
      val board = agents.board.value.body!!
      val row = board.agents.single()
      assertEquals("Desk", row.name)
      assertEquals("owner", row.handle)
      assertTrue(row.notRunning)
      assertTrue(board.directory)
      assertEquals(2, board.retired)
      assertTrue(board.retiredAgents.isEmpty())
      assertNull(row.performance)
      assertNull(row.pnlBps)
      assertNull(row.paperPnlBps)
      assertNull(row.maxDdBps)
      assertNull(row.landed)
      assertNull(row.filledPaper)
      assertNull(row.paperFills)
      assertNull(row.liveFills)
      assertNull(row.refused)
      assertNull(row.unrankedWhy)
      assertTrue(agents.loop.readNow(clock.get()))
      assertEquals("returning during the freshness window does not re-fetch", 1, server.requestCount)
      clock.addAndGet(60_001)
      server.enqueue(MockResponse().setResponseCode(503))
      assertFalse(agents.loop.readNow(clock.get()))
      assertEquals("Desk", agents.board.value.body!!.agents.single().name)
      assertNotNull(agents.board.value.failure)
      assertEquals(1_000L, agents.board.value.okAtMs)
      assertEquals(2, server.requestCount)
    } finally { server.shutdown() }
  }

  @Test fun twoScreensJoinOneInFlightDirectoryRead() = runBlocking {
    val server = MockWebServer().apply { start() }
    val entered = CompletableDeferred<Unit>()
    val release = CountDownLatch(1)
    try {
      server.dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
          entered.complete(Unit)
          release.await(5, TimeUnit.SECONDS)
          return MockResponse().setBody(fullBoard)
        }
      }
      val cache = PublicDirectory(apiFor(server))
      val home = async { cache.forTurn(0).loop.readNow(System.currentTimeMillis()) }
      withTimeout(2_000) { entered.await() }
      val agents = async(start = CoroutineStart.UNDISPATCHED) { cache.forTurn(0).loop.readNow(System.currentTimeMillis()) }
      release.countDown()
      assertTrue(home.await())
      assertTrue(agents.await())
      assertEquals(1, server.requestCount)
      assertEquals("Desk", cache.forTurn(0).board.value.body!!.agents.single().name)
    } finally { release.countDown(); server.shutdown() }
  }

  @Test fun switchingServersClearsTheSharedListAndDiscardsAnOldLateAnswer() = runBlocking {
    val first = MockWebServer().apply { start() }
    val second = MockWebServer().apply { start() }
    val entered = CompletableDeferred<Unit>()
    val release = CountDownLatch(1)
    val scope = newAppScope(Dispatchers.Default)
    try {
      val store = MemoryStore(first.origin())
      val jar = PersistentCookieJar(store)
      val app = AppGraph(Http.client(jar, debug = false), store, MemoryCookies(jar), scope)
      val old = app.publicDirectory.forTurn(app.repo.serverTurn.value)
      first.answer(fullBoard)
      assertTrue(old.loop.readNow(1))
      // Force an actual second request without waiting for the real freshness clock.
      val failing = old.board.value.body!!
      assertEquals("Desk", failing.agents.single().name)
      // A second cache gives us a deterministic blocked first read in the same
      // generation, while the graph's already-visible list tests the hook.
      val pending = PublicDirectory(app.api).forTurn(app.repo.serverTurn.value)
      first.dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
          entered.complete(Unit)
          release.await(5, TimeUnit.SECONDS)
          return MockResponse().setBody(fullBoard)
        }
      }
      val late = async { pending.loop.readNow(2) }
      withTimeout(2_000) { entered.await() }
      app.repo.setOrigin(second.origin())
      assertNull("the old graph-held list is cleared before the new origin appears", old.board.value.body)
      val fresh = app.publicDirectory.forTurn(app.repo.serverTurn.value)
      assertNotSame(old, fresh)
      assertNull(fresh.board.value.body)
      second.answer("""{"source":"sqlite","directory":true,"agents":[{"slug":"new","name":"New server"}]}""")
      assertTrue(fresh.loop.readNow(3))
      release.countDown()
      assertFalse(late.await())
      assertNull(pending.board.value.body)
      assertEquals("New server", fresh.board.value.body!!.agents.single().name)
    } finally { release.countDown(); scope.cancel(); first.shutdown(); second.shutdown() }
  }
}
