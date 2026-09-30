package dev.merrymen.app.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.net.AgentImageKind
import dev.merrymen.app.net.ImageAnswer
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.agentImage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.Locale

/**
 * AN AGENT'S OWN PICTURE, where the owner uploaded one — and the seeded
 * gradient with its initials where they did not.
 *
 * The picture comes from OUR route, /api/agent-image/{slug}/{avatar|banner},
 * which answers 404 when nothing was uploaded (a feature: a cached placeholder
 * would be indistinguishable from a real picture) and an ETag otherwise, so an
 * unchanged face costs a 304.
 *
 * THE CACHE HAS TWO JOBS AND TWO RULES.
 *  - It must never serve one agent's face for another. Every entry is keyed by
 *    the server, the slug, the kind and the upload version together, and a 304
 *    only ever reuses the bytes held under the key whose ETag was sent.
 *  - It must not grow without bound. It holds a fixed number of entries and a
 *    fixed number of bitmap bytes, and evicts the least recently used.
 */
enum class FaceKind(val path: String, val image: AgentImageKind) {
  AVATAR("avatar", AgentImageKind.Avatar),
  BANNER("banner", AgentImageKind.Banner),
}

/** Which picture, from which server, at which upload. [id] is the whole cache key. */
data class FaceKey(val origin: String, val slug: String, val kind: FaceKind, val version: String?) {
  val id: String get() = "$origin|${slug.lowercase(Locale.ROOT)}|${kind.path}|${version.orEmpty()}"
}

/**
 * THE BOUNDED CACHE, with no Android in it so a JVM test can run it.
 *
 * Three answers a lookup can give: a picture checked within [freshMs] (use it,
 * ask nobody — the route's own `max-age=60`); a picture older than that (show
 * it, and revalidate with its ETag); or a 404 remembered for [missingMs], so a
 * feed of faceless agents does not ask about each one on every scroll.
 */
class FaceCache<T : Any>(
  private val maxEntries: Int,
  private val maxWeight: Long,
  private val weigh: (T) -> Int,
  private val now: () -> Long = System::currentTimeMillis,
  private val freshMs: Long = 60_000L,
  private val missingMs: Long = 10 * 60_000L,
) {
  sealed interface Lookup<out T> {
    data class Fresh<T>(val value: T) : Lookup<T>
    data class Stale<T>(val value: T, val etag: String?) : Lookup<T>
    data object KnownMissing : Lookup<Nothing>
    data object Unknown : Lookup<Nothing>
  }

  private class Held<T>(val etag: String?, val value: T?, val at: Long, val weight: Int)

  /** Access-ordered, so iteration starts at the least recently used. */
  private val map = LinkedHashMap<String, Held<T>>(16, 0.75f, true)
  private var weightNow = 0L

  @Synchronized
  fun lookup(key: String): Lookup<T> {
    val h = map[key] ?: return Lookup.Unknown
    val v = h.value
    if (v == null) {
      if (now() - h.at < missingMs) return Lookup.KnownMissing
      remove(key)
      return Lookup.Unknown
    }
    return if (now() - h.at < freshMs) Lookup.Fresh(v) else Lookup.Stale(v, h.etag)
  }

  /** The picture held under [key], however old, without touching the network. */
  @Synchronized
  fun peek(key: String): T? = map[key]?.value

  @Synchronized
  fun putImage(key: String, etag: String?, value: T) = put(key, Held(etag, value, now(), weigh(value)))

  /** A 304: the held picture is current as of now. */
  @Synchronized
  fun confirm(key: String) {
    val h = map[key] ?: return
    if (h.value != null) map[key] = Held(h.etag, h.value, now(), h.weight)
  }

  @Synchronized
  fun putMissing(key: String) = put(key, Held(null, null, now(), 0))

  @get:Synchronized
  val size: Int get() = map.size

  @get:Synchronized
  val weight: Long get() = weightNow

  private fun put(key: String, held: Held<T>) {
    remove(key)
    map[key] = held
    weightNow += held.weight
    val it = map.entries.iterator()
    while ((map.size > maxEntries || weightNow > maxWeight) && it.hasNext()) {
      val eldest = it.next()
      if (eldest.key == key && map.size == 1) break
      weightNow -= eldest.value.weight
      it.remove()
    }
  }

  private fun remove(key: String) {
    map.remove(key)?.let { weightNow -= it.weight }
  }
}

/**
 * ONE REQUEST PER PICTURE, however many rows want it. A feed of ten rows by one
 * agent asks once; the others wait for that answer.
 *
 * THE ROW THAT ASKED FIRST CAN LEAVE BEFORE ITS ANSWER COMES — a fast scroll
 * takes it out of the LazyColumn and cancels its load. That is not an answer:
 * handing the rows still waiting its null drew initials on every one of them
 * for an agent that has a picture, until each was composed afresh. So a
 * cancelled first asker hands its waiters NOTHING ([Turn.abandoned]), and they
 * go round again — one of them becomes the asker.
 */
class FaceLoader<T : Any>(private val cache: FaceCache<T>, private val decode: suspend (FaceKey, ByteArray) -> T?) {
  /** An asker's outcome. [abandoned] means it was cancelled and answered nobody. */
  private class Turn<T>(val value: T?, val abandoned: Boolean)

  private val inFlight = HashMap<String, CompletableDeferred<Turn<T>>>()

  suspend fun load(key: FaceKey, fetch: suspend (etag: String?) -> ImageAnswer): T? {
    val id = key.id
    while (true) {
      val held = when (val l = cache.lookup(id)) {
        is FaceCache.Lookup.Fresh -> return l.value
        FaceCache.Lookup.KnownMissing -> return null
        is FaceCache.Lookup.Stale -> l
        FaceCache.Lookup.Unknown -> null
      }
      val (mine, turn) = synchronized(inFlight) {
        inFlight[id]?.let { false to it } ?: (true to CompletableDeferred<Turn<T>>().also { inFlight[id] = it })
      }
      if (!mine) {
        val answered = turn.await()
        if (answered.abandoned) continue
        return answered.value
      }
      return ask(key, id, held, fetch, turn)
    }
  }

  private suspend fun ask(
    key: FaceKey,
    id: String,
    held: FaceCache.Lookup.Stale<T>?,
    fetch: suspend (etag: String?) -> ImageAnswer,
    turn: CompletableDeferred<Turn<T>>,
  ): T? {
    var outcome = Turn<T>(null, abandoned = true)
    try {
      val result = try {
        when (val a = fetch(held?.etag)) {
          is ImageAnswer.Fresh -> decode(key, a.bytes)?.also { cache.putImage(id, a.etag, it) }
          // Only ever the bytes held under THIS key — the ETag sent was theirs.
          ImageAnswer.NotModified -> held?.value?.also { cache.confirm(id) }
          ImageAnswer.Missing -> {
            cache.putMissing(id)
            null
          }
          // No answer says nothing about the agent: keep showing its own last
          // picture if there is one, and ask again next time.
          is ImageAnswer.Failed -> held?.value
        }
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        // A picture that would not decode is no picture; the face keeps its
        // initials rather than taking the screen down with it.
        held?.value
      }
      outcome = Turn(result, abandoned = false)
      return result
    } finally {
      synchronized(inFlight) { inFlight.remove(id) }
      turn.complete(outcome)
    }
  }
}

/**
 * THE APP'S ONE PICTURE CACHE. Process-wide on purpose: the feed, the board and
 * a profile all show the same faces, and three caches would be three copies and
 * three requests.
 */
object AgentFaces {
  /** 12 MB of bitmaps at most, and 160 entries — misses included. */
  private val cache = FaceCache<ImageBitmap>(
    maxEntries = 160,
    maxWeight = 12L * 1024 * 1024,
    weigh = { it.width * it.height * 4 },
  )
  private val loader = FaceLoader(cache) { key, bytes -> decodeScaled(key.kind, bytes) }

  @Volatile
  private var lastOrigin: String? = null

  @Volatile
  private var targetPx = mapOf(FaceKind.AVATAR to 144, FaceKind.BANNER to 1080)

  /**
   * WHICH PICTURE, BY THE ONE RULE THE WHOLE APP USES ([faceSourceOf] over
   * [AgentImageRevisions]): a picture the You tab just uploaded is asked for at
   * its new version, so an HTTP cache's copy of the old one is never it; one
   * it just removed is not asked for at all; anything else is read as the
   * server has it. The You tab publishes there on every write the server
   * confirmed, so there is one list of versions, not one per screen.
   */
  private fun keyFor(origin: String, slug: String, kind: FaceKind): FaceKey? =
    when (val face = faceSourceOf(slug, AgentImageRevisions.versions.value, kind.image)) {
      FaceSource.Initials -> null
      is FaceSource.Picture -> FaceKey(origin, face.slug, kind, face.version)
    }

  /** What is already held for this face, with no request — the first frame. */
  fun peek(slug: String?, kind: FaceKind): ImageBitmap? {
    if (slug == null || !FACE_SLUG.matches(slug)) return null
    val origin = lastOrigin ?: return null
    return keyFor(origin, slug, kind)?.let { cache.peek(it.id) }
  }

  suspend fun load(api: MerrymenApi, slug: String?, kind: FaceKind): ImageBitmap? {
    // A slug of any other shape is a 404 at the route; it is not asked about.
    if (slug == null || !FACE_SLUG.matches(slug)) return null
    val origin = api.originNow()
    lastOrigin = origin
    val key = keyFor(origin, slug, kind) ?: return null
    return loader.load(key) { etag -> api.agentImage(slug, kind.path, etag, key.version) }
  }

  internal fun setTargets(avatarPx: Int, bannerPx: Int) {
    targetPx = mapOf(FaceKind.AVATAR to avatarPx.coerceAtLeast(48), FaceKind.BANNER to bannerPx.coerceAtLeast(320))
  }

  /**
   * Decoded at the size it is drawn, not at the size it was uploaded: a 512px
   * avatar shown at 22dp is a quarter-megabyte bitmap for a thumbnail.
   * `inSampleSize` is the largest power of two that keeps the short side at or
   * above the target, so nothing is ever drawn blurred up.
   */
  private suspend fun decodeScaled(kind: FaceKind, bytes: ByteArray): ImageBitmap? = withContext(Dispatchers.Default) {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@withContext null
    // A banner is drawn across the screen, so its target is a width; an
    // avatar is square, so its target is its short side.
    val target = targetPx.getValue(kind)
    val side = if (kind == FaceKind.BANNER) bounds.outWidth else minOf(bounds.outWidth, bounds.outHeight)
    var sample = 1
    while (side / (sample * 2) >= target) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)?.asImageBitmap()
  }
}

/** identity-store.ts `SLUG_RE`: the only shape the image route answers for. */
private val FACE_SLUG = Regex("^[0-9a-hjkmnp-tv-z]{16}$")

/** `--wire` (terminal.css:8074): the ring on an agent your agent reads. */
val WireRing = Color(0xFF5CC8FF)

/**
 * `faceSeed` (lib/agent-avatar.ts): THE GRADIENT FOLLOWS THE SLUG, THE
 * INITIALS FOLLOW THE NAME. Seeded on the name, every "Robin" was one colour
 * and a feed of five Robins read as one agent talking to itself; the slug is
 * minted once and never changes.
 */
fun faceSeed(name: String, slug: String?): String = if (slug != null && FACE_SLUG.matches(slug)) slug else name

/** `hueOf` — the same fold as the web's, so a face is the same colour on both. */
private fun seedHue(seed: String): Int {
  var h = 0
  for (c in seed) h = (h * 31 + c.code) % 360
  return h
}

private fun seedBrush(seed: String, size: Size): Brush {
  val h = seedHue(seed).toFloat()
  return Brush.linearGradient(
    colors = listOf(Color.hsl(h, 0.62f, 0.62f), Color.hsl((h + 42f) % 360f, 0.58f, 0.44f)),
    start = Offset(size.width * 0.1005f, size.height * -0.0705f),
    end = Offset(size.width * 0.8995f, size.height * 1.0705f),
  )
}

private fun nameInitials(name: String): String {
  val words = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
  return when {
    words.isEmpty() -> "??"
    words.size == 1 -> words[0].take(2).uppercase(Locale.ROOT)
    else -> "${words[0][0]}${words[1][0]}".uppercase(Locale.ROOT)
  }
}

private fun initialsSize(box: Dp): TextUnit = when (box) {
  16.dp -> 7.sp
  22.dp -> 8.sp
  30.dp -> 11.sp
  40.dp -> 12.sp
  48.dp -> 16.sp
  else -> (box.value * 8f / 22f).sp
}

private val FaceGlyph = Color(0xFF0E0E10)

/**
 * AN AGENT'S FACE: the seeded gradient and initials, the uploaded picture over
 * them once it has loaded, and THE WIRE RING when your agent reads this one.
 *
 * The ring is two halos drawn OUTSIDE the box — `--bg` then `--wire`, as the
 * web's two box-shadows — so it changes no layout. It is read from Social's
 * wired set here, in the leaf, exactly as the web's Face does: an unknown
 * answer and an empty one both mean "no ring" ([dev.merrymen.app.data.WiredState.rings]: the list
 * outlives a lost answer, the ring must not), and a signed-out reader sees
 * none. [ring] overrides that only where a caller knows better.
 */
@Composable
fun AgentFace(
  slug: String?,
  name: String,
  size: Dp = 22.dp,
  modifier: Modifier = Modifier,
  ring: Boolean? = null,
  badgeSymbol: String? = null,
) {
  val c = LocalContainer.current
  val wired by c.social.wired.collectAsState()
  val ringed = ring ?: (slug != null && wired.rings(slug))
  val density = LocalDensity.current
  val widthPx = with(density) { LocalConfiguration.current.screenWidthDp.dp.roundToPx() }
  // Decoded for the largest face this app draws (48dp), at this density. A
  // SideEffect, not a remember: it is done for its effect, and it runs after
  // composition and before the load below starts, so the first decode is at
  // the size it is drawn.
  SideEffect { AgentFaces.setTargets(with(density) { 48.dp.roundToPx() }, widthPx) }
  val versions by AgentImageRevisions.versions.collectAsState()
  // KEYED ON THE SLUG: a LazyColumn reuses a row's slot for another agent, and
  // the first frame for the new one is whatever is held for IT, never the
  // previous occupant's picture. produceState's own keys do not do that — its
  // state outlives a key change and holds the last agent's picture until the
  // new load lands — so the state itself is made fresh per slug, and per
  // upload, with key(). The upload is THIS agent's entry only, so a new
  // picture shows on the page it was uploaded from while every other face on
  // screen keeps what it drew.
  val picture by key(slug, faceSourceOf(slug, versions)) {
    produceState(AgentFaces.peek(slug, FaceKind.AVATAR), c.api) {
      value = AgentFaces.load(c.api, slug, FaceKind.AVATAR)
    }
  }
  Box(
    modifier
      .size(size)
      .drawBehind {
        if (!ringed) return@drawBehind
        val r = this.size.minDimension / 2f
        drawCircle(WireRing, radius = r + 4.dp.toPx())
        drawCircle(MerryColors.bg, radius = r + 2.dp.toPx())
      },
  ) {
    Box(
      Modifier
        .fillMaxSize()
        .clip(CircleShape)
        .drawBehind { drawRect(brush = seedBrush(faceSeed(name, slug), this.size)) },
      contentAlignment = Alignment.Center,
    ) {
      val glyph = initialsSize(size)
      Text(
        text = nameInitials(name),
        style = TextStyle(fontFamily = sans(glyph, FontWeight.W700), fontSize = glyph, fontWeight = FontWeight.W700, lineHeight = glyph),
        color = FaceGlyph,
      )
      picture?.let {
        Image(bitmap = it, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
      }
    }
    if (badgeSymbol != null && badgeSymbol.isNotEmpty()) FaceCoinBadge(badgeSymbol)
  }
}

/**
 * `.stack-badge .coin` — a 13px coin pinned bottom-right with a 2px `--bg`
 * ring. The coin's colour is its own symbol's, as the web's flat coin is
 * replaced by its seeded ground here too.
 */
@Composable
private fun BoxScope.FaceCoinBadge(symbol: String) {
  Box(
    Modifier
      .align(Alignment.BottomEnd)
      .offset(x = 5.dp, y = 5.dp)
      .size(17.dp)
      .background(MerryColors.bg, CircleShape)
      .padding(2.dp),
  ) {
    Box(
      Modifier
        .fillMaxSize()
        .clip(CircleShape)
        .drawBehind { drawRect(brush = seedBrush(symbol, this.size)) },
      contentAlignment = Alignment.Center,
    ) {
      Text(
        text = symbol.replace(Regex("[^A-Za-z0-9]"), "").take(2).uppercase(Locale.ROOT).ifEmpty { "?" },
        style = TextStyle(fontFamily = sans(6.sp, FontWeight.W700), fontSize = 6.sp, fontWeight = FontWeight.W700, lineHeight = 6.sp),
        color = FaceGlyph,
      )
    }
  }
}

/**
 * THE BANNER, ABOVE the header rather than behind it. Most agents have none,
 * and that is not a failure to report: the route answers 404 and nothing is
 * drawn at all — no placeholder, no empty band.
 */
@Composable
fun AgentBanner(slug: String?, modifier: Modifier = Modifier) {
  val c = LocalContainer.current
  val versions by AgentImageRevisions.versions.collectAsState()
  // Fresh state per agent and per upload, for the reason AgentFace's is.
  val picture by key(slug, faceSourceOf(slug, versions, AgentImageKind.Banner)) {
    produceState(AgentFaces.peek(slug, FaceKind.BANNER), c.api) {
      value = AgentFaces.load(c.api, slug, FaceKind.BANNER)
    }
  }
  picture?.let {
    Image(
      bitmap = it,
      contentDescription = null,
      contentScale = ContentScale.Crop,
      modifier = modifier.fillMaxWidth().aspectRatio(3f),
    )
  }
}
