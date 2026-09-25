package dev.merrymen.app

import dev.merrymen.app.data.GroupChatState
import dev.merrymen.app.groupchat.lineJson
import dev.merrymen.app.groupchat.pageJson
import dev.merrymen.app.net.Http
import dev.merrymen.app.net.MemoryCookies
import dev.merrymen.app.net.MemoryStore
import dev.merrymen.app.net.PersistentCookieJar
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.origin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * THE GRAPH THE APP RUNS, and the lines in it whose absence hands one
 * wallet's state to the next: Social's forget hook and the group chat
 * room's.
 */
class AppGraphTest {
  private lateinit var server: MockWebServer
  private lateinit var graph: AppGraph

  @Before fun start() {
    server = MockWebServer()
    server.start()
    val store = MemoryStore(server.origin())
    val jar = PersistentCookieJar(store)
    graph = AppGraph(Http.client(jar, debug = false), store, MemoryCookies(jar))
  }

  @After fun stop() = server.shutdown()

  @Test fun signingOutEmptiesTheLastWalletsLikes() = runBlocking {
    server.answer("""{"hosted":true,"address":"0xAAA"}""")
    graph.repo.refreshIdentity()
    server.answer("""{"liked":["post-1"],"signedIn":true,"read":true}""")
    graph.social.refreshMine(force = true)
    assertEquals(setOf("post-1"), graph.social.likes.value.mine)

    server.answer("{}")
    graph.repo.signOut()

    assertTrue(graph.social.likes.value.mine.isEmpty())
    assertFalse(graph.social.likes.value.signedIn)
  }

  @Test fun anotherServerEmptiesThemToo() = runBlocking {
    server.answer("""{"hosted":true,"address":"0xAAA"}""")
    graph.repo.refreshIdentity()
    server.answer("""{"liked":["post-1"],"signedIn":true,"read":true}""")
    graph.social.refreshMine(force = true)

    graph.repo.setOrigin("https://staging.merrymen.dev")

    assertTrue(graph.social.likes.value.mine.isEmpty())
  }

  /**
   * The room is held by the graph, not by its screen, so its hook is
   * registered at construction: a wallet that signs out before ever opening
   * the room again still leaves nothing of the old reader's behind.
   */
  @Test fun signingOutEmptiesTheGroupChatRoom() = runBlocking {
    server.answer("""{"hosted":true,"address":"0xAAA"}""")
    graph.repo.refreshIdentity()
    server.answer(pageJson(listOf(lineJson(1, "gm")), cursor = 1))
    graph.groupChat.pollNow()
    assertEquals(listOf(1L), graph.groupChat.state.value.messages.map { it.id })

    server.answer("{}")
    graph.repo.signOut()

    assertEquals(GroupChatState(), graph.groupChat.state.value)
  }

  @Test fun anotherServerEmptiesTheRoomToo() = runBlocking {
    server.answer(pageJson(listOf(lineJson(1, "gm")), cursor = 1))
    graph.groupChat.pollNow()
    assertEquals(1, graph.groupChat.state.value.messages.size)

    graph.repo.setOrigin("https://staging.merrymen.dev")

    assertEquals(GroupChatState(), graph.groupChat.state.value)
  }

  /**
   * A ROTATION DOES NOT START THE APP AGAIN. The emulator pass logged GET
   * /api/version and GET /api/auth/session on every turn of the phone: Shell
   * asked for the start from a LaunchedEffect, and a rotation recreates it.
   * Played here as the recreated Shell asks: after the start answered, and
   * while it is still out.
   */
  @Test fun theStartIsAskedForOnceHoweverOftenShellAsks() = runBlocking {
    val gate = java.util.concurrent.CountDownLatch(1)
    server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
      override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): okhttp3.mockwebserver.MockResponse =
        when (request.path) {
          "/api/version" -> {
            gate.await(5, java.util.concurrent.TimeUnit.SECONDS)
            okhttp3.mockwebserver.MockResponse().setBody(dev.merrymen.app.net.Fixtures.text("probe-version.json"))
          }
          "/api/auth/session" -> okhttp3.mockwebserver.MockResponse().setBody("""{"hosted":true,"address":"0xAAA"}""")
          else -> okhttp3.mockwebserver.MockResponse().setResponseCode(404)
        }
    }
    val store = MemoryStore(server.origin())
    val jar = PersistentCookieJar(store)
    val app = AppGraph(Http.client(jar, debug = false), store, MemoryCookies(jar), newAppScope(Dispatchers.Unconfined))

    // The first Shell asks, and is gone (a rotation) before the start answers.
    val first = launch(Dispatchers.IO) { app.started() }
    kotlinx.coroutines.withTimeout(5_000) { while (server.requestCount == 0) kotlinx.coroutines.delay(10) }
    first.cancel()
    // The recreated Shell asks while it is still out, and again later.
    val second = async(Dispatchers.IO) { app.started() }
    gate.countDown()
    assertEquals(dev.merrymen.app.data.Loaded.Value(Unit), second.await())
    assertEquals(dev.merrymen.app.data.Loaded.Value(Unit), app.started())

    assertEquals("one version read, one session read", 2, server.requestCount)
    assertEquals("0xAAA", app.repo.signedIn.value)
  }

  @Test fun appScopedWorkThatThrowsIsALogLineAndItsSiblingsLive() = runBlocking {
    val failures = mutableListOf<Throwable>()
    val scope = newAppScope(Dispatchers.Unconfined) { failures += it }
    scope.launch { error("a malformed event in a chat stream") }
    var sibling = false
    scope.launch { sibling = true }
    assertEquals(listOf("a malformed event in a chat stream"), failures.map { it.message })
    assertTrue("a sibling still runs", sibling)
  }
}
