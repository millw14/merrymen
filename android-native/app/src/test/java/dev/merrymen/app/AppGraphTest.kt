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
