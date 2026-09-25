package dev.merrymen.app.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.io.InterruptedIOException

/**
 * THE CHAT REPLY, A PIECE AT A TIME — and the one rule that makes that safe.
 *
 * /api/chat streams its reply over SSE when asked, so the agent's words appear
 * as they are written instead of after a long "thinking…". The danger is
 * specific to this chat: a reply may END with a proposal, `<<CMD id {args}>>`,
 * and a proposal is read only when it is the very last thing the reply does —
 * that end anchor is a security control, and a stream is by definition a reply
 * that has not ended yet. So, exactly as the web's lib/chat-stream.ts:
 *
 *   - everything from the FIRST `<<` is held back until the reply is complete,
 *     and only `done`'s reply — which the server ran through splitCommand on
 *     the whole text — is ever final, or may raise a confirm card;
 *   - no partial marker reaches the screen, not even the `<` that might become
 *     one;
 *   - reasoning a model leaks inline (`<think>…</think>`) never shows either.
 *
 * The server sends only the safe prefix and this applies the same rule again
 * to whatever arrives: two gates, neither relying on the other.
 */

private val THINK_BLOCK = Regex("""<\|?think\|?>[\s\S]*?</\|?think\|?>""", RegexOption.IGNORE_CASE)
private val THINK_OPEN = Regex("""<\|?think\|?>""", RegexOption.IGNORE_CASE)

/**
 * The part of a reply-so-far that may be shown. It grows only by appending as
 * the reply grows, so what is on screen is never rewritten; when the reply
 * completes, `done`'s text replaces it whole.
 */
fun streamSafe(raw: String): String {
  var s = THINK_BLOCK.replace(raw, "")
  val open = THINK_OPEN.find(s)
  if (open != null) s = s.substring(0, open.range.first)
  // From the first `<<` on, nothing shows until the end: it may be a proposal
  // still being written, or a quoted marker that the complete reply scrubs.
  val marker = s.indexOf("<<")
  if (marker >= 0) s = s.substring(0, marker)
  // A `<` with no `>` after it may become `<<` — or a reasoning tag — on the
  // very next character. Held until it cannot.
  val lt = s.lastIndexOf('<')
  if (lt >= 0 && s.indexOf('>', lt) < 0) s = s.substring(0, lt)
  return s.trimStart()
}

/** What a finished stream said: the same shape the unstreamed route answers with. */
data class StreamedReply(
  val reply: String?,
  val command: ChatCommand? = null,
  /** "cut-off" when the stream ended with no `done` — half an answer is not an answer. */
  val why: String? = null,
  val kind: String? = null,
  val provider: String? = null,
  /** The provider's redacted debug line. Carried so nothing downstream mistakes its absence; NEVER rendered. */
  val detail: String? = null,
)

/**
 * READS /api/chat's EVENT STREAM FROM BYTES, however they are cut.
 *
 * The network hands over whatever bytes it has, which can end in the middle of
 * an event, in the middle of `<<CMD`, or in the middle of a multi-byte
 * character. Events end at a blank line, and a blank line is ASCII, which never
 * occurs inside a UTF-8 sequence — so the bytes are split there and each whole
 * event is decoded on its own, and no character is ever cut in two.
 *
 * NOTHING HERE CAN THROW ON WHAT ARRIVES: a block that is not JSON is a
 * keep-alive or noise and is ignored, as the web ignores it. And after the
 * first `done` or `error` it reads nothing more, so a stray event behind the
 * answer cannot add to it.
 */
class SseReplyReader(private val onText: (String) -> Unit) {
  private var pending = ByteArray(0)
  private val text = StringBuilder()
  private var shown = ""
  private var result: StreamedReply? = null

  /** Take [len] more bytes; the finished reply once `done` or `error` has arrived, else null. */
  fun feed(bytes: ByteArray, len: Int = bytes.size): StreamedReply? {
    if (result != null) return null
    pending += bytes.copyOf(len)
    while (true) {
      val (start, width) = blankLine(pending) ?: return null
      val block = String(pending, 0, start, Charsets.UTF_8)
      pending = pending.copyOfRange(start + width, pending.size)
      val out = handle(block)
      if (out != null) {
        result = out
        pending = ByteArray(0)
        return out
      }
    }
  }

  /** The stream ended. Without a `done` it was cut off — never the half that arrived. */
  fun finish(): StreamedReply = result ?: StreamedReply(reply = null, why = "cut-off")

  private fun handle(block: String): StreamedReply? {
    var name = "message"
    val data = mutableListOf<String>()
    for (raw in block.split('\n')) {
      val line = raw.removeSuffix("\r")
      if (line.isEmpty() || line.startsWith(":")) continue
      val colon = line.indexOf(':')
      val field = if (colon < 0) line else line.substring(0, colon)
      val value = if (colon < 0) "" else line.substring(colon + 1).removePrefix(" ")
      if (field == "event") name = value else if (field == "data") data += value
    }
    val payload = try {
      Json.parseToJsonElement(data.joinToString("\n")) as? JsonObject
    } catch (e: IllegalArgumentException) {
      null // a keep-alive, or noise — never rendered
    } ?: return null
    return when (name) {
      "text" -> {
        val piece = payload.text("t") ?: return null
        text.append(piece)
        val visible = streamSafe(text.toString())
        if (visible != shown) {
          shown = visible
          onText(visible)
        }
        null
      }
      "done" -> StreamedReply(
        reply = payload.text("reply")?.takeIf { it.isNotEmpty() },
        command = commandOf(payload["command"]),
      )
      "error" -> StreamedReply(
        reply = null,
        why = payload.text("why") ?: "llm-error",
        kind = payload.text("kind")?.takeIf { it.isNotEmpty() },
        provider = payload.text("provider")?.takeIf { it.isNotEmpty() },
        detail = payload.text("detail")?.takeIf { it.isNotEmpty() },
      )
      else -> null
    }
  }
}

/** Where the first blank line starts and how wide it is — `\r?\n\r?\n`, the web's split. */
private fun blankLine(b: ByteArray): Pair<Int, Int>? {
  val lf = '\n'.code.toByte()
  val cr = '\r'.code.toByte()
  for (i in b.indices) {
    if (b[i] != lf) continue
    val width = when {
      i + 1 < b.size && b[i + 1] == lf -> 2
      i + 2 < b.size && b[i + 1] == cr && b[i + 2] == lf -> 3
      else -> continue
    }
    return if (i > 0 && b[i - 1] == cr) (i - 1) to (width + 1) else i to width
  }
  return null
}

/** A proposal as the route sent it: an id and flat arguments, or nothing. */
private fun commandOf(v: JsonElement?): ChatCommand? {
  val o = v as? JsonObject ?: return null
  val id = o.text("id") ?: return null
  val args = (o["args"] as? JsonObject)?.filterValues { it is JsonPrimitive } ?: emptyMap()
  return ChatCommand(id, args)
}

/** A whole JSON answer (no-llm, an empty message, an older server), read into the same shape. */
private fun replyOf(o: JsonObject) = StreamedReply(
  reply = o.text("reply")?.takeIf { it.isNotBlank() },
  command = commandOf(o["command"]),
  why = o.text("why"),
  kind = o.text("kind"),
  provider = o.text("provider"),
  detail = o.text("detail"),
)

/**
 * WHAT ONE MESSAGE CAME BACK AS.
 *
 * [Failed.failure] is one of the web's ChatFailure kinds — signed-out, no-llm,
 * llm-error, unreadable, network, timeout, cut-off, server — plus "no-address"
 * for a stored Server that is not a web address, which only a phone can have.
 * The sentence for each is the thread's to choose (ui/Act.kt failureLine);
 * [Failed.kind] and [Failed.provider] are the route's classification of a
 * model failure, never the provider's own words.
 */
sealed interface Asked {
  data class Replied(val reply: String, val command: ChatCommand?) : Asked
  data class Failed(
    val failure: String,
    val status: Int? = null,
    val kind: String? = null,
    val provider: String? = null,
  ) : Asked
}

/**
 * ONE MESSAGE TO /api/chat, streamed when the server will, and what became of it.
 *
 * Asks for a stream and accepts either answer, reading the CONTENT TYPE before
 * the body: an HTML page from a proxy is "unreadable", never parsed. An error
 * status is nobody's answer ("server", with its status), not a garbled one. A
 * stream that ends without `done` was cut off. [onText] is told what may be
 * shown so far, on a background thread; nothing of a marker is ever in it.
 *
 * On [MerrymenApi.chatHttp], whose 90s read timeout outlasts a slow model's
 * first byte and whose 120s call timeout still ends a dead connection.
 */
suspend fun MerrymenApi.askAgent(body: ChatBody, onText: (String) -> Unit): Asked = try {
  askAgentOnce(body, onText)
} catch (e: kotlinx.coroutines.CancellationException) {
  throw e
} catch (e: Exception) {
  // NOTHING THE WIRE SENDS MAY CRASH THE APP. Whatever this was, it is an
  // answer that could not be read, said as one.
  Asked.Failed("unreadable")
}

private suspend fun MerrymenApi.askAgentOnce(body: ChatBody, onText: (String) -> Unit): Asked {
  val u = urlFor("/api/chat") ?: return Asked.Failed("no-address")
  val req = Request.Builder()
    .url(u)
    .header("accept", "text/event-stream, application/json")
    .post(json.encodeToString(ChatBody.serializer(), body).toRequestBody(jsonType))
    .build()
  return withContext(Dispatchers.IO) {
    val call = chatHttp.newCall(req)
    // A thread that goes away takes its request with it; the server's own
    // abort then stops the model, since nobody is reading.
    val stop = coroutineContext[Job]?.invokeOnCompletion { call.cancel() }
    try {
      val response = try {
        call.execute()
      } catch (e: InterruptedIOException) {
        coroutineContext.ensureActive()
        return@withContext Asked.Failed("timeout")
      } catch (e: IOException) {
        coroutineContext.ensureActive()
        return@withContext Asked.Failed("network")
      }
      response.use { r ->
        if (r.code == 401) return@withContext Asked.Failed("signed-out")
        if (!r.isSuccessful) return@withContext Asked.Failed("server", status = r.code)
        val type = r.header("content-type").orEmpty()
        val out: StreamedReply = when {
          type.contains("text/event-stream", ignoreCase = true) -> {
            val reader = SseReplyReader(onText)
            val stream = r.body?.byteStream() ?: return@withContext Asked.Failed("unreadable")
            val buf = ByteArray(8 * 1024)
            try {
              var done: StreamedReply? = null
              while (done == null) {
                val n = stream.read(buf)
                if (n < 0) break
                if (n > 0) done = reader.feed(buf, n)
              }
              done ?: reader.finish()
            } catch (e: InterruptedIOException) {
              coroutineContext.ensureActive()
              return@withContext Asked.Failed("timeout")
            } catch (e: IOException) {
              coroutineContext.ensureActive()
              return@withContext Asked.Failed("cut-off")
            }
          }
          type.contains("application/json", ignoreCase = true) -> {
            val o = try {
              json.parseToJsonElement(r.body?.string().orEmpty()) as? JsonObject
            } catch (e: IllegalArgumentException) {
              null
            } catch (e: IOException) {
              coroutineContext.ensureActive()
              return@withContext Asked.Failed("unreadable")
            } ?: return@withContext Asked.Failed("unreadable")
            replyOf(o)
          }
          else -> return@withContext Asked.Failed("unreadable")
        }
        val reply = out.reply
        when {
          !reply.isNullOrBlank() -> Asked.Replied(reply, out.command)
          out.why == "no-llm" -> Asked.Failed("no-llm")
          out.why == "cut-off" -> Asked.Failed("cut-off")
          out.why == "llm-error" -> Asked.Failed("llm-error", kind = out.kind, provider = out.provider)
          else -> Asked.Failed("unreadable")
        }
      }
    } finally {
      stop?.dispose()
    }
  }
}
