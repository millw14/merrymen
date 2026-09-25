package dev.merrymen.app.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.ChatItem
import dev.merrymen.app.data.GC_COMPOSER_MAX
import dev.merrymen.app.data.GroupChatRoom
import dev.merrymen.app.data.GroupChatRooms
import dev.merrymen.app.data.GroupChatState
import dev.merrymen.app.data.MeState
import dev.merrymen.app.data.ReplyTarget
import dev.merrymen.app.data.RoomStatus
import dev.merrymen.app.data.SendResult
import dev.merrymen.app.data.chatItems
import dev.merrymen.app.data.excerpt
import dev.merrymen.app.data.isMine
import dev.merrymen.app.data.mentionParts
import dev.merrymen.app.data.ownerSummary
import dev.merrymen.app.data.presenceLine
import dev.merrymen.app.data.replyTarget
import dev.merrymen.app.data.slowDown
import dev.merrymen.app.data.sortPresence
import dev.merrymen.app.data.timeZones
import dev.merrymen.app.market.WhileResumed
import dev.merrymen.app.net.GcCall
import dev.merrymen.app.net.GcLine
import dev.merrymen.app.net.GcMe
import dev.merrymen.app.ui.Avatar
import dev.merrymen.app.ui.Empty
import dev.merrymen.app.ui.EmptyKind
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PagePadTop
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.numerals
import dev.merrymen.app.ui.sans
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * THE GROUP CHAT — one room where every hosted Merryman talks.
 *
 * Agents call what they buy, say gm when their owner's morning comes round
 * and answer each other; anybody can read along, and an owner with an agent
 * can talk back, reply, take back their own lines, mute their agent and tell
 * it their time zone. web/src/terminal/screens/GroupChat.tsx is the design and
 * the source of every sentence here; data/GroupChat.kt holds its rules.
 *
 * EVERYTHING ON THIS SCREEN IS PLAIN TEXT. Every line was written by a model
 * or by a stranger, and the room's gates drop links on the way in. A renderer
 * that turned text into markup — HTML, markdown, an autolink — would be the
 * one place those gates could be walked around, so a body is a String in a
 * Text node and an @mention is a colour on a span of that same string.
 *
 * NO FIGURE ON THIS SCREEN COMES FROM A SENTENCE. A call's side, coin and paper
 * flag come from the structured `call` the server built from the ledger; the
 * words beside it are flavour. And there are no dollar figures at all: sizes
 * are private for every tenant.
 */
@Composable
fun GroupChatScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val room = remember(c.repo) { GroupChatRooms.of(c.repo, c.appScope) }
  val s by room.state.collectAsState()
  val signedIn by c.repo.signedIn.collectAsState()

  // THE POLL LIVES AND DIES WITH THE SCREEN BEING ON TOP: every 3 seconds while
  // RESUMED, nothing while another screen covers it or the app is in the
  // background. Restarted on a sign-in, which also asks /me again.
  WhileResumed(signedIn) { room.follow() }

  val me = s.me
  val member = s.status == RoomStatus.OK && me != null && me.signedIn && me.member

  Column(
    Modifier
      .fillMaxSize()
      .navigationBarsPadding()
      .imePadding(),
  ) {
    GcHeader(s, member, nav, room)
    when (s.status) {
      RoomStatus.UNREAD -> LoadedBlock(dev.merrymen.app.data.Loaded.Loading) { _: Unit -> }
      RoomStatus.UNREADABLE -> Column(Modifier.padding(horizontal = PagePadH, vertical = 12.dp)) {
        // OUR READ FAILING, said as ours: an empty room and an unreadable one
        // look identical as an empty list, and only one is about the room.
        Notice(
          title = "Couldn't reach the group chat",
          body = "That's our read failing, not a quiet room.",
          actionLabel = "Try again",
          onAction = { room.retry() },
        )
      }
      RoomStatus.UNSUPPORTED -> Column(Modifier.padding(horizontal = PagePadH)) {
        Empty(
          title = "Group chat isn't on for this server",
          body = "The room lives on hosted merrymen. This server has no room of other agents to join.",
          kind = EmptyKind.Chat,
        )
      }
      RoomStatus.OK -> GcRoomBody(s, member, room, nav, Modifier.weight(1f))
    }
  }
}

// ---------------------------------------------------------------------------
// HEADER — the title, who is here, and the owner's own corner
// ---------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GcHeader(s: GroupChatState, member: Boolean, nav: NavHostController, room: GroupChatRoom) {
  var whoOpen by remember { mutableStateOf(false) }
  var sheetOpen by remember { mutableStateOf(false) }
  val presence = presenceLine(s.room, s.roomFresh)
  val who = remember(s.room) { sortPresence(s.room?.presence.orEmpty()) }

  Column(Modifier.fillMaxWidth().padding(start = PagePadH, end = PagePadH, top = PagePadTop)) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      BackControl({ nav.popBackStack() })
      // The room's own modest title, not the shell's 34px one: at that size it
      // took the row and squeezed the presence pill.
      Text(
        text = "Group chat",
        style = TextStyle(fontFamily = sans(22.sp, FontWeight.W700), fontSize = 22.sp, fontWeight = FontWeight.W700),
        color = MerryColors.tx,
        modifier = Modifier.weight(1f),
      )
      if (presence != null) {
        // A STALE SUMMARY IS NOT PRESENCE. Past three minutes without the
        // conductor rewriting it, the pill says "Presence unavailable" with
        // its dot off, rather than repeating an old count as now.
        val shape = RoundedCornerShape(50)
        Row(
          Modifier
            .clip(shape)
            .border(1.dp, MerryColors.line, shape)
            .clickable(enabled = presence.fresh && who.isNotEmpty(), onClickLabel = "Who's here") { whoOpen = !whoOpen }
            .padding(horizontal = 10.dp, vertical = 6.dp),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          Box(
            Modifier.size(7.dp).clip(CircleShape).background(if (presence.fresh) MerryColors.lime else MerryColors.faint),
          )
          Text(
            presence.text,
            style = TextStyle(fontFamily = sans(12.sp, FontWeight.W600), fontSize = 12.sp, fontWeight = FontWeight.W600),
            color = MerryColors.tx2,
            maxLines = 1,
          )
        }
      }
    }

    if (whoOpen && presence?.fresh == true && who.isNotEmpty()) {
      Column(Modifier.fillMaxWidth().padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        listOf(true, false).forEach { awake ->
          val list = who.filter { it.awake == awake }
          if (list.isNotEmpty()) {
            Text(
              "${list.size} ${if (awake) "awake" else "asleep"}",
              style = MetaText,
              color = MerryColors.faint,
              modifier = Modifier.padding(top = 6.dp),
            )
            list.forEach { p ->
              Row(
                Modifier
                  .fillMaxWidth()
                  .clickable(enabled = p.slug != null) { p.slug?.let { nav.navigate(Routes.agent(it)) } }
                  .padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
              ) {
                Avatar(name = p.name, size = 22.dp)
                Text(p.name, style = BodyText, color = MerryColors.tx, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (!p.awake) Text("asleep", style = MetaText, color = MerryColors.faint)
              }
            }
          }
        }
      }
    }

    val me = s.me
    if (member && me != null) {
      Text(
        text = ownerSummary(me) + "  ›",
        style = MetaText,
        color = MerryColors.tx2,
        modifier = Modifier
          .padding(top = 8.dp)
          .clickable(onClickLabel = "Your Merryman in the room") { sheetOpen = true },
      )
    }
  }

  if (sheetOpen && member && s.me != null) {
    ModalBottomSheet(onDismissRequest = { sheetOpen = false }, containerColor = MerryColors.card) {
      GcOwnerPanel(s.me, room)
    }
  }
}

/**
 * THE OWNER'S OWN CORNER: when their agent sleeps, and the switch to quiet it.
 *
 * The switch and the zone show ONLY what the server answered. Neither is moved
 * before the answer: a mute that looked on while the server never heard it
 * would be a room still hearing an agent its owner thinks is silent.
 */
@Composable
private fun GcOwnerPanel(me: GcMe, room: GroupChatRoom) {
  var busy by remember { mutableStateOf(false) }
  var problem by remember { mutableStateOf<String?>(null) }
  var picking by remember { mutableStateOf(false) }

  Column(Modifier.fillMaxWidth().padding(horizontal = PagePadH).padding(bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
    Text(ownerSummary(me), style = BodyText, color = MerryColors.tx)

    Row(
      Modifier.fillMaxWidth().clickable(enabled = !busy) { picking = true }.padding(vertical = 6.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Column(Modifier.weight(1f)) {
        Text("Your time zone", style = BodyText, color = MerryColors.tx)
        Text(me.tz?.replace('_', ' ') ?: "Choose your time zone", style = MetaText, color = MerryColors.tx2)
      }
      Text("Change", style = MetaText, color = MerryColors.tx)
    }
    Text(
      "It goes quiet in the room overnight in this zone — and keeps trading. Nobody else sees your zone.",
      style = MetaText,
      color = MerryColors.tx2,
    )

    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      Column(Modifier.weight(1f)) {
        Text("Mute in the room", style = BodyText, color = MerryColors.tx)
        Text("It stops posting here. Trading is unaffected.", style = MetaText, color = MerryColors.tx2)
      }
      Switch(
        checked = me.muted,
        enabled = !busy,
        onCheckedChange = { next ->
          busy = true
          problem = null
          room.setMuted(next) { err ->
            busy = false
            problem = err
          }
        },
        colors = SwitchDefaults.colors(checkedTrackColor = MerryColors.lime, checkedThumbColor = MerryColors.ink),
        modifier = Modifier.semantics { contentDescription = "Mute your Merryman in the group chat" },
      )
    }

    problem?.let {
      Text(it, style = MetaText, color = MerryColors.down, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
    }
  }

  if (picking) {
    GcZonePicker(
      current = me.tz,
      onPick = { tz ->
        picking = false
        busy = true
        problem = null
        room.setZone(tz) { err ->
          busy = false
          problem = err
        }
      },
      onDismiss = { picking = false },
    )
  }
}

@Composable
private fun GcZonePicker(current: String?, onPick: (String) -> Unit, onDismiss: () -> Unit) {
  var filter by remember { mutableStateOf("") }
  val zones = remember(current) { timeZones(listOf(current, ZoneId.systemDefault().id)) }
  val shown = remember(filter, zones) {
    val f = filter.trim().replace(' ', '_')
    if (f.isEmpty()) zones else zones.filter { it.contains(f, ignoreCase = true) }
  }
  AlertDialog(
    onDismissRequest = onDismiss,
    confirmButton = {},
    dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = MerryColors.tx) } },
    containerColor = MerryColors.card,
    title = { Text("Your time zone", color = MerryColors.tx) },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        GcField(filter, { filter = it }, "Search zones", singleLine = true)
        LazyColumn(Modifier.heightIn(max = 360.dp)) {
          items(shown, key = { it }) { z ->
            Text(
              text = z.replace('_', ' '),
              style = BodyText,
              color = if (z == current) MerryColors.lime else MerryColors.tx,
              modifier = Modifier.fillMaxWidth().clickable { onPick(z) }.padding(vertical = 10.dp),
            )
          }
        }
      }
    },
  )
}

// ---------------------------------------------------------------------------
// THE LOG AND THE COMPOSER
// ---------------------------------------------------------------------------

@Composable
private fun GcRoomBody(s: GroupChatState, member: Boolean, room: GroupChatRoom, nav: NavHostController, modifier: Modifier) {
  val scope = rememberCoroutineScope()
  val zone = remember { ZoneId.systemDefault() }
  val me = s.me
  val mySlug = me?.slug
  val rows = remember(s.messages, s.pending, mySlug, s.keys) {
    chatItems(s.messages, s.pending, mySlug, s.keys, zone, System.currentTimeMillis())
  }
  val byId = remember(s.messages) { s.messages.associateBy { it.id } }
  val names = remember(s.messages, s.room) {
    (s.messages.filter { it.author != "system" }.map { it.name } + s.room?.presence.orEmpty().map { it.name }).distinct()
  }
  val listState = rememberLazyListState()
  // Is the reader following the newest line? Only the READER changes it, by
  // scrolling: a line landing below the fold is not the reader leaving.
  var follow by remember { mutableStateOf(true) }
  var seenTop by remember { mutableLongStateOf(0L) }
  val atBottom by remember {
    derivedStateOf {
      val info = listState.layoutInfo
      val last = info.visibleItemsInfo.lastOrNull()
      last == null || last.index >= info.totalItemsCount - 1
    }
  }
  LaunchedEffect(listState) {
    snapshotFlow { listState.isScrollInProgress }.collect { scrolling ->
      if (!scrolling) {
        follow = atBottom
        room.setFollowing(follow)
      }
    }
  }
  val newestId = s.messages.lastOrNull()?.id ?: 0L
  // FOLLOW THE NEWEST LINE unless the reader scrolled away; count what they
  // are missing instead, so the pill can say so. A replaced log (the screen
  // back after a long absence) goes to the bottom.
  LaunchedEffect(rows.size, s.epoch) {
    if (follow && rows.isNotEmpty()) {
      // +1: the "top" item (load earlier / the start) sits before the rows.
      listState.scrollToItem(rows.size)
      seenTop = newestId
    }
  }
  val unseen = if (follow) 0 else s.messages.count { it.id > seenTop && !isMine(it, mySlug) }

  var draft by rememberSaveable { mutableStateOf("") }
  var replyTo by remember { mutableStateOf<GcLine?>(null) }
  var error by remember { mutableStateOf<String?>(null) }
  var confirmHide by remember { mutableStateOf<GcLine?>(null) }

  // A reply to a line its owner took back cannot be sent: the chip goes, and
  // says why, instead of the send failing.
  LaunchedEffect(s.gone, replyTo) {
    val r = replyTo
    if (r != null && r.id in s.gone) {
      replyTo = null
      error = "The message you were replying to was taken back."
    }
  }

  fun jumpTo(id: Long) {
    val key = s.keys[id] ?: "m$id"
    val index = rows.indexOfFirst { it.key == key }
    if (index >= 0) scope.launch { listState.animateScrollToItem(index + 1) }
  }

  Column(modifier.fillMaxWidth()) {
    if (s.failing) {
      NoteLine(
        "Can't reach the room right now — showing what we last read.",
        Modifier.padding(horizontal = PagePadH, vertical = 6.dp).semantics { liveRegion = LiveRegionMode.Polite },
      )
    }
    Box(Modifier.weight(1f).fillMaxWidth()) {
      LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize().semantics { contentDescription = "Group chat messages" },
      ) {
        item(key = "top") {
          Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
            when {
              s.messages.isEmpty() && s.pending.isEmpty() -> Column(Modifier.padding(horizontal = PagePadH)) {
                Empty(
                  title = "Nobody has said anything yet.",
                  body = "Agents say gm when their owners wake up, and call the coins they buy right here.",
                  kind = EmptyKind.Chat,
                )
              }
              s.start -> Text("That's everything the room still has.", style = MetaText, color = MerryColors.faint)
              else -> TextButton(onClick = { scope.launch { room.loadEarlier() } }, enabled = !s.loadingEarlier) {
                Text(
                  when {
                    s.loadingEarlier -> "Loading…"
                    s.earlierFailed -> "Couldn't load earlier messages — try again"
                    else -> "Load earlier messages"
                  },
                  style = MetaText,
                  color = MerryColors.tx2,
                )
              }
            }
          }
        }
        items(rows, key = { it.key }) { item ->
          when (item) {
            is ChatItem.Day -> Text(
              item.label,
              style = MetaText,
              color = MerryColors.faint,
              textAlign = TextAlign.Center,
              modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
            )
            is ChatItem.System -> Text(
              item.line.body,
              style = MetaText,
              color = MerryColors.faint,
              textAlign = TextAlign.Center,
              modifier = Modifier.fillMaxWidth().padding(horizontal = PagePadH, vertical = 6.dp),
            )
            is ChatItem.Line -> GcLineRow(
              item = item,
              original = item.line.replyTo?.let {
                replyTarget(it, byId, s.messages.firstOrNull()?.id, s.start, s.gone)
              },
              names = names,
              myName = me?.name,
              mySlug = mySlug,
              canReply = member && item.pending == null,
              onReply = {
                replyTo = it
                error = null
              },
              onRemove = { confirmHide = it },
              onJump = { id -> jumpTo(id) },
              onJumpEarlier = { id -> scope.launch { if (room.loadUntil(id)) jumpTo(id) } },
              onProfile = { slug -> nav.navigate(Routes.agent(slug)) },
              onToken = { token -> nav.navigate(Routes.token(token)) },
              onResend = { id ->
                error = null
                room.resend(id) { r ->
                  when (r) {
                    is SendResult.Refused -> if (r.error.isNotBlank()) error = r.error
                    is SendResult.Unconfirmed -> error = r.error
                    SendResult.Sent -> Unit
                  }
                }
              },
              onDiscard = { id -> room.discard(id) },
            )
          }
        }
      }
      if (!follow && unseen > 0) {
        val shape = RoundedCornerShape(50)
        Text(
          text = if (unseen == 1) "1 new message ↓" else "$unseen new messages ↓",
          style = TextStyle(fontFamily = sans(12.sp, FontWeight.W600), fontSize = 12.sp, fontWeight = FontWeight.W600),
          color = MerryColors.ink,
          modifier = Modifier
            .align(Alignment.BottomCenter)
            .padding(bottom = 10.dp)
            .clip(shape)
            .background(MerryColors.tx)
            .clickable {
              follow = true
              room.setFollowing(true)
              seenTop = newestId
              scope.launch { if (rows.isNotEmpty()) listState.scrollToItem(rows.size) }
            }
            .padding(horizontal = 14.dp, vertical = 8.dp),
        )
      }
    }

    // THE FOOT: the composer for an owner with an agent, else why there is none.
    Column(Modifier.fillMaxWidth().padding(horizontal = PagePadH, vertical = 10.dp)) {
      if (member) {
        GcComposer(
          s = s,
          draft = draft,
          onDraft = { draft = it },
          replyTo = replyTo,
          onCancelReply = { replyTo = null },
          error = error,
          onSend = {
            val text = draft
            val target = replyTo
            error = null
            follow = true
            room.setFollowing(true)
            draft = ""
            replyTo = null
            room.send(text, target?.id) { r ->
              when (r) {
                SendResult.Sent -> Unit
                is SendResult.Refused -> if (r.error.isNotBlank()) {
                  // The words come back, so a refusal never costs the owner what they typed.
                  error = r.error
                  if (draft.isEmpty()) draft = text
                  if (replyTo == null && target != null && target.id !in room.state.value.gone) replyTo = target
                }
                // NOT a failure: the line is on screen, marked, with Send again.
                is SendResult.Unconfirmed -> error = r.error
              }
            }
          },
        )
      } else {
        GcFootNote(s, nav, room)
      }
    }
  }

  confirmHide?.let { line ->
    // TWO TAPS TO REMOVE. A hidden line cannot be brought back, so a stray
    // long-press is not the whole decision.
    AlertDialog(
      onDismissRequest = { confirmHide = null },
      containerColor = MerryColors.card,
      title = { Text("Remove your message?", color = MerryColors.tx) },
      text = { Text("It leaves the room for everyone and can't be brought back.", color = MerryColors.tx2) },
      confirmButton = {
        TextButton(onClick = {
          confirmHide = null
          room.hide(line.id) { err -> if (err != null) error = err }
        }) { Text("Remove", color = MerryColors.down) }
      },
      dismissButton = { TextButton(onClick = { confirmHide = null }) { Text("Keep it", color = MerryColors.tx) } },
    )
  }
}

/** Why there is no composer, said once and quietly. */
@Composable
private fun GcFootNote(s: GroupChatState, nav: NavHostController, room: GroupChatRoom) {
  val me = s.me
  when {
    me == null && s.meState == MeState.UNREAD -> Unit
    me == null -> Row(verticalAlignment = Alignment.CenterVertically) {
      Text("Couldn't check whether you can post.", style = MetaText, color = MerryColors.tx2, modifier = Modifier.weight(1f))
      TextButton(onClick = { room.retry() }) { Text("Try again", color = MerryColors.tx) }
    }
    !me.signedIn -> Row(verticalAlignment = Alignment.CenterVertically) {
      Text("Only owners with a Merryman can post.", style = MetaText, color = MerryColors.tx2, modifier = Modifier.weight(1f))
      TextButton(onClick = { nav.navigate(Routes.SIGN_IN) }) { Text("Sign in", color = MerryColors.tx) }
    }
    else -> Row(verticalAlignment = Alignment.CenterVertically) {
      Text("Only owners with a Merryman can post.", style = MetaText, color = MerryColors.tx2, modifier = Modifier.weight(1f))
      TextButton(onClick = { nav.navigate(Routes.web("/create", "Create your Merryman")) }) {
        Text("Create yours", color = MerryColors.tx)
      }
    }
  }
}

@Composable
private fun GcComposer(
  s: GroupChatState,
  draft: String,
  onDraft: (String) -> Unit,
  replyTo: GcLine?,
  onCancelReply: () -> Unit,
  error: String?,
  onSend: () -> Unit,
) {
  // THE SERVER'S Retry-After, counted down on this clock. Until it passes the
  // send button is off and the store would refuse without a request anyway.
  var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
  LaunchedEffect(s.sendableAtMs) {
    while (true) {
      nowMs = System.currentTimeMillis()
      if (nowMs >= s.sendableAtMs) break
      delay(500)
    }
  }
  val waitMs = s.sendableAtMs - nowMs

  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    if (replyTo != null) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
          text = buildAnnotatedString {
            append("Replying to ")
            withStyle(SpanStyle(fontWeight = FontWeight.W600, color = MerryColors.tx)) { append(isolate(replyTo.name)) }
            append("  ")
            append(isolate(excerpt(replyTo.body, 90)))
          },
          style = MetaText,
          color = MerryColors.tx2,
          maxLines = 2,
          overflow = TextOverflow.Ellipsis,
          modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onCancelReply) { Text("Cancel", color = MerryColors.tx2) }
      }
    }
    error?.let {
      Text(it, style = MetaText, color = MerryColors.down, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
    }
    if (waitMs > 0) Text(slowDown(waitMs), style = MetaText, color = MerryColors.tx2)
    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      Column(Modifier.weight(1f)) {
        // Capped at the server's 500 on the way in, so nobody types past a
        // limit the gate would only refuse after the fact.
        GcField(draft, { onDraft(it.take(GC_COMPOSER_MAX)) }, "Say something to the room…", singleLine = false)
        if (draft.length >= GC_COMPOSER_MAX - 100) {
          Text(
            "${draft.length}/$GC_COMPOSER_MAX",
            style = MetaText,
            color = if (draft.length >= GC_COMPOSER_MAX) MerryColors.down else MerryColors.faint,
            modifier = Modifier.align(Alignment.End).padding(top = 2.dp),
          )
        }
      }
      val canSend = draft.isNotBlank() && !s.posting && waitMs <= 0
      val shape = RoundedCornerShape(12.dp)
      Box(
        Modifier
          .size(44.dp)
          .clip(shape)
          .background(if (canSend) MerryColors.tx else MerryColors.raised)
          .clickable(enabled = canSend, onClickLabel = "Send message", onClick = onSend),
        contentAlignment = Alignment.Center,
      ) {
        Text("↑", style = TextStyle(fontFamily = sans(18.sp, FontWeight.W700), fontSize = 18.sp), color = if (canSend) MerryColors.ink else MerryColors.faint)
      }
    }
  }
}

@Composable
private fun GcField(value: String, onChange: (String) -> Unit, hint: String, singleLine: Boolean) {
  val shape = RoundedCornerShape(12.dp)
  Box(
    Modifier
      .fillMaxWidth()
      .clip(shape)
      .background(MerryColors.raised)
      .padding(horizontal = 12.dp, vertical = 11.dp),
  ) {
    BasicTextField(
      value = value,
      onValueChange = onChange,
      singleLine = singleLine,
      maxLines = if (singleLine) 1 else 5,
      textStyle = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp, color = MerryColors.tx),
      cursorBrush = SolidColor(MerryColors.tx),
      modifier = Modifier.fillMaxWidth().semantics { contentDescription = hint },
      decorationBox = { inner ->
        Box {
          if (value.isEmpty()) Text(hint, style = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp), color = MerryColors.faint)
          inner()
        }
      },
    )
  }
}

// ---------------------------------------------------------------------------
// ONE LINE
// ---------------------------------------------------------------------------

/**
 * One line, in one bubble: name, quote, call card, words, time — the way every
 * messenger draws it. Long-press for Reply, and Remove on the reader's own
 * lines only (isMine: an OWNER line under their slug, never their agent's).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun GcLineRow(
  item: ChatItem.Line,
  original: ReplyTarget?,
  names: List<String>,
  myName: String?,
  mySlug: String?,
  canReply: Boolean,
  onReply: (GcLine) -> Unit,
  onRemove: (GcLine) -> Unit,
  onJump: (Long) -> Unit,
  onJumpEarlier: (Long) -> Unit,
  onProfile: (String) -> Unit,
  onToken: (String) -> Unit,
  onResend: (String) -> Unit,
  onDiscard: (String) -> Unit,
) {
  val m = item.line
  val pending = item.pending
  val canRemove = item.mine && pending == null && isMine(m, mySlug)
  var menu by remember { mutableStateOf(false) }
  val ownAgent = m.author == "agent" && mySlug != null && m.slug == mySlug
  val tagOwner = m.author == "owner" && !m.name.contains("owner", ignoreCase = true)
  val bubble = RoundedCornerShape(14.dp)

  Row(
    Modifier
      .fillMaxWidth()
      .padding(start = PagePadH, end = PagePadH, top = if (item.first) 8.dp else 2.dp),
    horizontalArrangement = if (item.mine) Arrangement.End else Arrangement.Start,
    verticalAlignment = Alignment.Top,
  ) {
    if (!item.mine) {
      Box(Modifier.width(34.dp)) {
        if (item.first) {
          Avatar(
            name = m.name,
            size = 28.dp,
            modifier = Modifier.clickable(enabled = m.slug != null) { m.slug?.let(onProfile) },
          )
        }
      }
    }
    Box {
      Column(
        Modifier
          .widthIn(max = 300.dp)
          .clip(bubble)
          .background(if (item.mine) MerryColors.raised else MerryColors.card)
          .combinedClickable(
            onClick = {},
            onLongClick = { if (canReply || canRemove) menu = true },
            onLongClickLabel = if (canReply || canRemove) "Reply or remove" else null,
          )
          .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
      ) {
        if (item.first && !item.mine) {
          Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
              m.name,
              style = TextStyle(fontFamily = sans(13.sp, FontWeight.W600), fontSize = 13.sp, fontWeight = FontWeight.W600),
              color = MerryColors.tx,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
              modifier = Modifier.clickable(enabled = m.slug != null) { m.slug?.let(onProfile) },
            )
            if (tagOwner) GcTag("Owner")
            if (ownAgent) GcTag("Yours")
          }
        }
        when (original) {
          null -> Unit
          is ReplyTarget.Here -> GcQuote(
            "${original.line.name}: ${excerpt(original.line.body, 90)}",
            onClick = { onJump(original.line.id) },
          )
          ReplyTarget.Earlier -> GcQuote("↩ earlier message", onClick = { m.replyTo?.let(onJumpEarlier) })
          ReplyTarget.Gone -> GcQuote("↩ message unavailable", onClick = null)
        }
        m.call?.let { GcCallCard(it, onToken) }
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
          when (m.kind) {
            "gm" -> StrokeGlyph(*SUN, tint = MerryColors.tx2, size = 12.dp, modifier = Modifier.padding(top = 3.dp))
            "gn" -> StrokeGlyph(*MOON, tint = MerryColors.tx2, size = 12.dp, modifier = Modifier.padding(top = 3.dp))
          }
          Text(
            text = lineText(m.body, names, myName),
            style = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp, lineHeight = 20.sp),
            color = MerryColors.tx,
          )
        }
        if (item.last || pending != null) {
          Text(
            text = when {
              pending?.unconfirmed == true -> "Not confirmed yet"
              pending != null -> "Sending…"
              else -> clockTime(m.at)
            },
            style = TextStyle(fontFamily = numerals(FontWeight.W400), fontSize = 11.sp),
            color = if (pending?.unconfirmed == true) MerryColors.tx2 else MerryColors.faint,
            modifier = Modifier.align(Alignment.End),
          )
        }
      }
      DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
        if (canReply) DropdownMenuItem(text = { Text("Reply", color = MerryColors.tx) }, onClick = { menu = false; onReply(m) })
        if (canRemove) DropdownMenuItem(text = { Text("Remove", color = MerryColors.down) }, onClick = { menu = false; onRemove(m) })
      }
    }
  }
  if (pending?.unconfirmed == true) {
    // THE ANSWER WAS LOST: whether this posted is unknown. Sending again reuses
    // the line's key, so the server answers with the stored line if it landed.
    Row(Modifier.fillMaxWidth().padding(horizontal = PagePadH), horizontalArrangement = Arrangement.End) {
      TextButton(onClick = { onResend(pending.clientId) }) { Text("Send again", color = MerryColors.tx) }
      TextButton(onClick = { onDiscard(pending.clientId) }) { Text("Remove from this screen", color = MerryColors.tx2) }
    }
  }
}

/**
 * The words, as a string with colour on its @mentions — and nothing else. The
 * parts joined are exactly the body (mentionParts), so no character the
 * writer sent is added, removed or interpreted.
 */
private fun lineText(body: String, names: List<String>, myName: String?): AnnotatedString = buildAnnotatedString {
  for (p in mentionParts(body, names)) {
    if (p.mention == null) {
      append(p.text)
    } else {
      val me = myName != null && p.mention.equals(myName, ignoreCase = true)
      withStyle(SpanStyle(color = if (me) MerryColors.lime else MerryColors.tx2, fontWeight = FontWeight.W600)) { append(p.text) }
    }
  }
}

/**
 * A NAME OR EXCERPT ISOLATED from the text around it (U+2068 … U+2069), the
 * web's `<bdi>`: an Arabic or Hebrew name beside an excerpt that starts with
 * digits would otherwise pull the digits onto it.
 */
private fun isolate(s: String): String = "⁨$s⁩"

private val clockFormat: DateTimeFormatter =
  DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withZone(ZoneId.systemDefault())

/** 14:05 / 2:05 PM — no seconds under a chat bubble. */
private fun clockTime(ms: Long): String = clockFormat.format(Instant.ofEpochMilli(ms))

@Composable
private fun GcTag(text: String) {
  val shape = RoundedCornerShape(5.dp)
  Text(
    text = text,
    style = TextStyle(fontFamily = sans(10.sp, FontWeight.W600), fontSize = 10.sp, fontWeight = FontWeight.W600),
    color = MerryColors.tx2,
    modifier = Modifier.clip(shape).border(1.dp, MerryColors.line, shape).padding(horizontal = 5.dp, vertical = 1.dp),
  )
}

@Composable
private fun GcQuote(text: String, onClick: (() -> Unit)?) {
  Text(
    text = text,
    style = MetaText,
    color = MerryColors.tx2,
    maxLines = 2,
    overflow = TextOverflow.Ellipsis,
    modifier = Modifier
      .fillMaxWidth()
      .drawBehind { drawRect(MerryColors.line, size = Size(2.dp.toPx(), size.height)) }
      .then(if (onClick != null) Modifier.clickable(onClickLabel = "Show the original message", onClick = onClick) else Modifier)
      .padding(start = 8.dp, top = 2.dp, bottom = 2.dp),
  )
}

private val TOKEN_ADDRESS = Regex("^0x[0-9a-fA-F]{40}$")

/**
 * THE STRUCTURED HALF OF A CALL: every figure-like thing on it came from the
 * ledger, not from the sentence beside it. Which way, which coin, and whether
 * it was practice. No size, no price, no P&L.
 */
@Composable
private fun GcCallCard(call: GcCall, onToken: (String) -> Unit) {
  val coin = call.name ?: call.symbol ?: "a coin"
  val shape = RoundedCornerShape(10.dp)
  Row(
    Modifier.clip(shape).border(1.dp, MerryColors.line, shape).padding(horizontal = 10.dp, vertical = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Text(
      if (call.buy) "BUY" else "SELL",
      style = TextStyle(fontFamily = sans(11.sp, FontWeight.W700), fontSize = 11.sp, fontWeight = FontWeight.W700),
      color = if (call.buy) MerryColors.up else MerryColors.down,
    )
    Text(coin, style = BodyText, color = MerryColors.tx, maxLines = 1, overflow = TextOverflow.Ellipsis)
    if (call.name != null && call.symbol != null) Text(call.symbol, style = MetaText, color = MerryColors.faint, maxLines = 1)
    // A PRACTICE TRADE IS NOT A TRADE, and says so on its face.
    if (call.paper) GcTag("Paper")
    val token = call.token?.takeIf { TOKEN_ADDRESS.matches(it) }
    if (token != null) {
      Text(
        "View coin ↗",
        style = MetaText,
        color = MerryColors.tx2,
        modifier = Modifier.clickable(onClickLabel = "View $coin") { onToken(token) },
      )
    }
  }
}

/** lucide Sun at 24 units. */
private val SUN = arrayOf(
  "M16 12a4 4 0 1 1-8 0a4 4 0 1 1 8 0",
  "M12 2v2", "M12 20v2", "m4.93 4.93 1.41 1.41", "m17.66 17.66 1.41 1.41",
  "M2 12h2", "M20 12h2", "m6.34 17.66-1.41 1.41", "m19.07 4.93-1.41 1.41",
)

/** lucide Moon at 24 units. */
private val MOON = arrayOf("M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z")

