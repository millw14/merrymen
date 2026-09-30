package dev.merrymen.app.groupchat

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import java.util.concurrent.CopyOnWriteArrayList

/**
 * THE ROOM, AS A SERVER A TEST CAN SCRIPT. Every request is recorded, and
 * [answer] decides each reply, so a test can hold a POST, drop a connection
 * or say 429 exactly where it needs to.
 */
class RoomServer : Dispatcher() {
  val requests = CopyOnWriteArrayList<RecordedRequest>()

  @Volatile var answer: (RecordedRequest) -> MockResponse = { MockResponse().setResponseCode(404) }

  override fun dispatch(request: RecordedRequest): MockResponse {
    requests += request
    return answer(request)
  }

  fun count(method: String, pathPrefix: String): Int =
    requests.count { it.method == method && (it.path ?: "").startsWith(pathPrefix) }

  fun posts(): List<RecordedRequest> = requests.filter { it.method == "POST" && it.path == "/api/groupchat" }
}

fun json(body: String, code: Int = 200): MockResponse =
  MockResponse().setResponseCode(code).setHeader("content-type", "application/json").setBody(body)

/** /me for a signed-in owner whose agent is in the room. */
const val ME_MEMBER =
  """{"signedIn":true,"member":true,"slug":"mine000000000001","name":"Robin","tz":null,"tzSource":null,"muted":false,"sleep":null}"""

const val MY_SLUG = "mine000000000001"

/** One public line, as the GET and the POST return it. */
fun lineJson(id: Long, body: String, author: String = "agent", slug: String? = "s$id", name: String = "Agent $id", at: Long = 1_790_294_000_000L + id, replyTo: Long? = null): String {
  val s = if (slug == null) "null" else "\"$slug\""
  val r = replyTo?.toString() ?: "null"
  val b = body.replace("\\", "\\\\").replace("\"", "\\\"")
  return """{"id":$id,"at":$at,"author":"$author","slug":$s,"name":"$name","body":"$b","replyTo":$r,"kind":"chat","call":null}"""
}

/** A page of the room around [lines], with a presence summary written at [updatedAtMs]. */
fun pageJson(lines: List<String>, cursor: Long, start: Boolean? = false, updatedAtMs: Long = 1_790_294_820_062L, gone: List<Long>? = null): String {
  val st = if (start == null) "" else ""","start":$start"""
  val g = if (gone == null) "" else ""","gone":[${gone.joinToString(",")}]"""
  val room = """{"members":3,"awake":2,"asleep":1,"presence":[{"slug":"a","name":"Ann","state":"awake"},{"slug":"b","name":"Bo","state":"awake"},{"slug":"c","name":"Cy","state":"asleep"}],"updatedAtMs":$updatedAtMs}"""
  return """{"source":"db","messages":[${lines.joinToString(",")}],"cursor":$cursor$st,"room":$room$g}"""
}
