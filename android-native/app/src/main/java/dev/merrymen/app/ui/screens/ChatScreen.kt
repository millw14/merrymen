package dev.merrymen.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.ChatBody
import dev.merrymen.app.net.ChatCommand
import dev.merrymen.app.net.ChatTurnWire
import dev.merrymen.app.ui.Acted
import dev.merrymen.app.ui.Avatar
import dev.merrymen.app.ui.BottomInsetSpacer
import dev.merrymen.app.ui.COMMANDS
import dev.merrymen.app.ui.CommandSpec
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.Via
import dev.merrymen.app.ui.buildChatState
import dev.merrymen.app.ui.runCommand
import dev.merrymen.app.ui.sans
import kotlinx.coroutines.launch

/** lucide `ArrowUp`, 19px, stroke 1.8 — the composer's send glyph. */
@Composable
private fun ArrowUp(tint: Color, size: Dp = 19.dp) =
  StrokeGlyph("m5 12 7-7 7 7", "M12 19V5", tint = tint, size = size, stroke = 1.8f)

/** `.flow-error` — `terminal.css:373`: 12px `--down`, line-height 1.5, role=alert. */
@Composable
private fun FlowError(text: String, modifier: Modifier = Modifier) {
  Text(
    text = text,
    modifier = modifier.semantics { liveRegion = LiveRegionMode.Assertive },
    style = TextStyle(
      fontFamily = sans(12.sp),
      fontSize = 12.sp,
      fontWeight = FontWeight.W400,
      lineHeight = 18.sp,
    ),
    color = MerryColors.down,
  )
}

/**
 * CHAT — a fixed-height three-zone column, and only one side is a bubble.
 *
 * `polish.css:156-157`: the chat body is `padding-top: 12px; padding-bottom:
 * calc(92px + safe-area); gap: 10px`, and `.desk-page` itself runs at
 * `gap: 16px`. `terminal.css:3828-3847` makes the conversation the ONLY flexible
 * child, with a 220px floor pinned by desk-scroll.test.ts.
 *
 * THE AGENT SIDE HAS NO BUBBLE AT ALL (`polish.css:168-171`): a 36px face, a
 * 12px gap, the name at 17px/600, then the reply as 16px/1.55 `--tx-2` sitting
 * directly on `--bg`. Only the reader's own message is a raised pill, right
 * aligned, with the tail on the bottom RIGHT. Wrapping either side in a
 * Material Card would be the opposite of the design.
 *
 * WHAT THIS SCREEN DOES NOT HAVE AND WHY. The web's header is the agent's
 * identity — face, name, strategy and a status dot — and this screen fetches no
 * agent, so it carries a 20px label instead of inventing a name or adding a
 * read. The web's three suggestion chips send prepared prompts; adding them
 * would be adding sends, which is out of scope for a restyle. Both are in the
 * hand-off notes.
 */
@Composable
fun ChatScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val turns = remember { mutableStateListOf<ChatTurnWire>() }
  var draft by remember { mutableStateOf("") }
  var sending by remember { mutableStateOf(false) }
  var error by remember { mutableStateOf<String?>(null) }
  /**
   * THE ONE THING THE AGENT HAS ASKED PERMISSION TO DO.
   *
   * Deliberately NOT part of a turn: turns are a transcript, and a confirmation
   * card restored from one would be an offer to act, made by nobody, about a
   * decision taken minutes ago. It lives as long as it is on screen.
   */
  var pending by remember { mutableStateOf<ChatCommand?>(null) }
  var acting by remember { mutableStateOf(false) }
  var outcome by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()

  Column(
    Modifier
      .fillMaxSize()
      // The web gets this from the browser; here the composer has to ride the
      // keyboard or it is typed into blind.
      .imePadding()
      .padding(horizontal = PagePadH)
      .padding(top = 12.dp),
  ) {
    // `.desk-header h1` — polish.css:159: 20px, weight 600, tracking -0.02em.
    // Deliberately not the 34px page title: on the web this slot is the agent's
    // NAME, and a 34px "Chat" would be a heading the terminal does not have.
    Text(
      text = "Chat",
      modifier = Modifier.padding(bottom = 16.dp),
      style = TextStyle(
        fontFamily = sans(20.sp, FontWeight.W600),
        fontSize = 20.sp,
        fontWeight = FontWeight.W600,
        letterSpacing = (-0.02).em,
      ),
      color = MerryColors.tx,
    )

    LazyColumn(
      modifier = Modifier.weight(1f).heightIn(min = 220.dp),
      contentPadding = PaddingValues(bottom = 8.dp),
    ) {
      itemsIndexed(turns) { i, turn ->
        // `terminal.css:4573` — 30px above each turn; 22px between a question
        // and the reply to it (terminal.css:3473).
        val top = if (i == 0) 0.dp else if (turn.role == "user") 30.dp else 22.dp
        if (turn.role == "user") {
          // AN EMPTY QUESTION DRAWS NO BUBBLE. `followOrder` writes turns with
          // `question: ""` and the web renders the element unconditionally,
          // which floats a 32px empty pill on the right for turns whose whole
          // content is the outcome sentence. Not reproduced.
          if (turn.content.isNotBlank()) UserBubble(turn.content, Modifier.padding(top = top))
        } else {
          AgentReply(turn.content, Modifier.padding(top = top))
        }
      }
    }

    // ---- the dock: in flow, not floating -----------------------------------
    // `terminal.css:3878-3888` un-fixes the base sheet's `position: fixed` for a
    // phone, so this is simply the last row of the column: no elevation, no
    // scrim, no blur.
    outcome?.let {
      Notice("Your agent", it, modifier = Modifier.padding(bottom = 10.dp))
    }
    pending?.let { cmd -> ConfirmCard(
      cmd = cmd,
      acting = acting,
      onDismiss = { pending = null; outcome = null },
    ) { spec, args ->
      acting = true
      scope.launch {
        val (result, path) = runCommand(c.repo, spec, args)
        acting = false
        pending = null
        when (result) {
          is Acted.Ok -> {
            // THE SECOND VALUE IS ONLY A WEB PATH FOR A NAVIGATE COMMAND. For an
            // ORDER or a SNIPE runCommand returns the placed order's ID there,
            // not a path — so navigating on `path != null` sent a confirmed buy
            // off to a WebView instead of showing "placed". Gate the handoff on
            // the command's own kind; the order id is not needed here.
            if (spec.via == Via.NAVIGATE && path != null) nav.navigate(Routes.web(path, spec.id))
            else outcome = result.line.ifBlank { "Done." }
          }
          is Acted.Failed -> outcome = result.line
          is Acted.Ambiguous -> outcome = result.line + " — " + result.candidates.joinToString(", ")
          is Acted.NeedsSignature -> outcome = result.line
        }
      }
    } }

    // A PLAIN LINE, NEVER AN ANIMATION. The reply is not streamed — the web
    // shows one static sentence and swaps it for the whole answer. Dots or a
    // shimmering skeleton would imply tokens are arriving that are not, and
    // would make a 45-second timeout look like progress.
    if (sending) {
      Prose(
        text = "Your agent is thinking…",
        size = 15.sp,
        lineHeight = 20.25.sp,
        color = MerryColors.tx,
        modifier = Modifier.padding(vertical = 15.dp),
      )
    }

    // `.flow-error` — 12px `--down`. The four sentences the send path already
    // distinguishes (a 401, an unconfigured provider, an empty reply, an
    // unreachable server) are untouched; only their rendering changed, from a
    // titled notice at the top of the screen to the web's line above the
    // composer.
    error?.let { FlowError(it, Modifier.padding(vertical = 12.dp)) }

    Composer(
      draft = draft,
      onDraft = { draft = it },
      sending = sending,
      onSend = {
        val msg = draft.trim()
        draft = ""
        sending = true
        error = null
        // HISTORY IS THE CONVERSATION BEFORE THIS MESSAGE. Snapshot it first,
        // then add the turn for display — capturing after the add sent the
        // current message twice (as `message` and as the last history turn),
        // which the model reads as the user repeating themselves.
        val history = turns.toList()
        turns.add(ChatTurnWire("user", msg))
        scope.launch {
          // Give the agent the state its prompt is built around — above all the
          // basket, so it stops guessing that an unread basket is empty. Null on
          // a failed read, which degrades to the no-state path rather than a lie.
          val state = buildChatState(c.repo)
          when (val r = c.api.chat(ChatBody(message = msg, state = state, history = history)).toLoaded()) {
            is Loaded.Value -> {
              // `reply: null` with a `why` is the server declining to speak,
              // not an empty answer. Say which.
              val text = r.value.reply
              if (text.isNullOrBlank()) {
                error = listOfNotNull(r.value.why, r.value.detail).joinToString(" — ")
                  .ifBlank { "no reply" }
              } else {
                turns.add(ChatTurnWire("assistant", text))
              }
              // THE PROPOSAL, WHICH THIS CLIENT USED TO PARSE AND DISCARD.
              pending = r.value.command
              outcome = null
            }
            is Loaded.Refused -> error = r.message
            is Loaded.Unreachable -> error = "couldn't reach merrymen: " + r.cause
            else -> Unit
          }
          sending = false
        }
      },
    )
    BottomInsetSpacer()
  }
}

/**
 * THE READER'S OWN MESSAGE — `.desk-question`, terminal.css:3764-3768 and 4500.
 *
 * Right aligned, `width: fit-content`, `max-width: 88%`, ground `--raised`, no
 * border, radii 16 / 16 / 4 / 16 — the tail is on the bottom RIGHT — with
 * `padding: 12px 16px` and text at 14px/1.5 in full `--tx`.
 *
 * NOTE THE ASYMMETRY WITH THE REPLY: the question stays 14px while polish.css
 * raises the agent's answer to 16px. That is not a mistake to normalise; the
 * thing worth reading is the reply.
 */
@Composable
private fun UserBubble(text: String, modifier: Modifier = Modifier) {
  BoxWithConstraints(modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
    val cap = maxWidth * 0.88f
    Box(
      Modifier
        .widthIn(max = cap)
        .clip(
          RoundedCornerShape(
            topStart = 16.dp,
            topEnd = 16.dp,
            bottomEnd = 4.dp,
            bottomStart = 16.dp,
          ),
        )
        .background(MerryColors.raised)
        .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
      Text(
        text = text,
        style = TextStyle(
          fontFamily = sans(14.sp),
          fontSize = 14.sp,
          fontWeight = FontWeight.W400,
          lineHeight = 21.sp,
        ),
        color = MerryColors.tx,
      )
    }
  }
}

/**
 * THE AGENT'S ANSWER — a face, a name and prose on the page ground.
 *
 * `polish.css:168-171`: the row is a flex row with a 36px face and a 12px gap
 * (the `grid-template-columns` declaration on the same selector is INERT,
 * because `display` is still `flex` from terminal.css:3466 and polish never
 * changes it). The name is 17px/600 `--tx`; the paragraph is 16px/1.55 `--tx-2`.
 *
 * A QUIRK KEPT ON PURPOSE: the web's reply avatars inherit `.face.sm`'s 7px
 * initials into a 36px circle, because polish.css:169 overrides only the box.
 * That is almost certainly unintended and it is illegible, so [Avatar]'s own
 * ratio is used instead — an explicit departure, not an oversight.
 */
@Composable
private fun AgentReply(text: String, modifier: Modifier = Modifier) {
  Row(
    modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalAlignment = Alignment.Top,
  ) {
    Avatar(name = "Your agent", size = 36.dp)
    Column(Modifier.weight(1f)) {
      Text(
        text = "Your agent",
        style = TextStyle(
          fontFamily = sans(17.sp, FontWeight.W600),
          fontSize = 17.sp,
          fontWeight = FontWeight.W600,
        ),
        color = MerryColors.tx,
      )
      Prose(
        text = text,
        size = 16.sp,
        lineHeight = 24.8.sp,
        color = MerryColors.tx2,
        modifier = Modifier.padding(top = 4.dp),
      )
    }
  }
}

/**
 * THE COMPOSER — `polish.css:174-176` over terminal.css:3780-3796, 4506-4535.
 *
 * A rounded field: `min-height: 58px; border: 1px solid var(--line);
 * border-radius: 16px; padding: 10px 12px; background: var(--card)`, contents
 * BOTTOM aligned with a 10px gap, the field at 16px/1.5 and the button 40x40 at
 * radius 10.
 *
 * THE SEND BUTTON IS NOT LIME. It is `--tx` (near-white) on `--ink`, and
 * disabled it is `--raised` with a `--faint` glyph (terminal.css:3481 beats
 * 3789 on specificity, so a blank draft shows a dark grey square rather than a
 * white one). Lime on this screen is reserved for the two controls that
 * AUTHORISE something — the confirm card's YES and the blocker's re-sign. A
 * harmonised accent-coloured send button would make sending a message look like
 * confirming an action.
 *
 * THERE IS EFFECTIVELY NO FOCUS HIGHLIGHT either: terminal.css:4531-4537 puts the
 * border back to `--line` on `:focus-within`, overriding the lime at 3478. So
 * nothing changes colour here when the field is focused.
 */
@Composable
private fun Composer(
  draft: String,
  onDraft: (String) -> Unit,
  sending: Boolean,
  onSend: () -> Unit,
) {
  val shape = RoundedCornerShape(16.dp)
  val enabled = draft.isNotBlank() && !sending
  Row(
    Modifier
      .fillMaxWidth()
      .heightIn(min = 58.dp)
      .clip(shape)
      .background(MerryColors.card)
      .border(1.dp, MerryColors.line, shape)
      .padding(horizontal = 12.dp, vertical = 10.dp),
    horizontalArrangement = Arrangement.spacedBy(10.dp),
    verticalAlignment = Alignment.Bottom,
  ) {
    Box(Modifier.weight(1f).heightIn(min = 38.dp, max = 120.dp), contentAlignment = Alignment.CenterStart) {
      if (draft.isEmpty()) {
        // COULD NOT BE MATCHED: there is no `::placeholder` rule in any loaded
        // sheet, so the web takes the browser's dark-scheme default (roughly the
        // text colour at 54%). `--faint` is the house-consistent choice and is a
        // decision rather than a match.
        Prose(
          text = "Message your agent…",
          size = 16.sp,
          lineHeight = 24.sp,
          color = MerryColors.faint,
          modifier = Modifier.padding(8.dp),
        )
      }
      BasicTextField(
        value = draft,
        onValueChange = onDraft,
        modifier = Modifier
          .fillMaxWidth()
          .padding(8.dp)
          .semantics { contentDescription = "Message your agent" },
        textStyle = TextStyle(
          fontFamily = sans(16.sp),
          fontSize = 16.sp,
          lineHeight = 24.sp,
          color = MerryColors.tx,
        ),
        cursorBrush = SolidColor(MerryColors.tx),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
        keyboardActions = KeyboardActions(onSend = { if (enabled) onSend() }),
      )
    }
    Box(
      Modifier
        .size(40.dp)
        .clip(RoundedCornerShape(10.dp))
        .background(if (enabled) MerryColors.tx else MerryColors.raised)
        .clickable(enabled = enabled, role = Role.Button, onClick = onSend)
        .semantics { contentDescription = "Send message" },
      contentAlignment = Alignment.Center,
    ) {
      ArrowUp(if (enabled) MerryColors.ink else MerryColors.faint)
    }
  }
}

/**
 * THE CONFIRMATION CARD — the human tap that is the whole security boundary.
 *
 * The model may PROPOSE; only this button acts. That asymmetry is why the chat
 * can be given a command vocabulary at all, and it is why nothing here runs
 * automatically, however confident the reply sounded.
 *
 * AN UNKNOWN ID IS SHOWN AND REFUSED, NOT HIDDEN. A newer server can propose a
 * command this build has never heard of; rendering nothing would make the agent
 * look like it had done something, and guessing at it would be acting on
 * something nobody reviewed. So it is named, and the button says no. THE WEB
 * DISAGREES HERE AND ANDROID IS RIGHT — `Agent.tsx:835` renders nothing at all
 * for an id it cannot describe, and a proposal that vanishes silently reads as
 * an action already taken. Kept, and dressed as the spec asks: ordinary
 * (non-weighty) chrome, the refusal line at 12px in `--down`, the YES disabled.
 *
 * THE SENTENCE COMES FROM THE LOCAL REGISTRY AND NEVER FROM THE WIRE. Model-
 * written text could describe one action and request another; `COMMANDS[id].say`
 * is the difference between a confirmation and a remote-execution hole.
 *
 * THE CARD IS GREEN-FAMILY, NOT RED — terminal.css:7509-7524: radius 16px,
 * `padding: 12px 14px`, border 1px lime at 45% alpha, ground lime at 8%. It is
 * an OFFER, not an alarm. `.is-weighty` (terminal.css:7526) changes exactly two
 * things: the border goes to 75% and an INSET 3px lime bar is drawn down the
 * left inside the rounded clip. `color-mix(in srgb, X n%, transparent)` is
 * exactly `Color.copy(alpha = n/100)` because the ground behind it is opaque.
 *
 * NO TITLE. The web card has no heading at all — the previous "Your agent wants
 * to" line was this client's own addition and it is gone.
 *
 * DECLINING IS NOT THE SMALLER TARGET. terminal.css:7557 states it: "Declining
 * is not a lesser button, it is the safe one — same size, same reach, so it is
 * never the harder thing to hit." Both buttons are the same pill, the same
 * padding and the same type; only the fill differs.
 */
@Composable
private fun ConfirmCard(
  cmd: ChatCommand,
  acting: Boolean,
  onDismiss: () -> Unit,
  onConfirm: (CommandSpec, Map<String, String>) -> Unit,
) {
  val args = cmd.argText()
  val known = COMMANDS[cmd.id]
  val spec = known ?: CommandSpec(cmd.id, Via.UNKNOWN) { "" }
  val weighty = known?.weighty == true
  val shape = RoundedCornerShape(16.dp)

  Column(
    Modifier
      .fillMaxWidth()
      .padding(bottom = 10.dp)
      .clip(shape)
      .background(MerryColors.lime.copy(alpha = 0.08f))
      .drawBehind {
        // `box-shadow: inset 3px 0 0 var(--lime)` — Compose has no inset shadow,
        // so the bar is drawn inside the clip where the CSS puts it.
        if (weighty) drawRect(MerryColors.lime, size = Size(3.dp.toPx(), size.height))
      }
      .border(1.dp, MerryColors.lime.copy(alpha = if (weighty) 0.75f else 0.45f), shape)
      .padding(horizontal = 14.dp, vertical = 12.dp)
      .semantics(mergeDescendants = true) { contentDescription = "Confirm this action" },
  ) {
    // `.desk-confirm-say` — 13.5px, line-height 1.6, full `--tx`. Compose takes
    // fractional sp; do not round it to 14.
    Text(
      text = known?.say?.invoke(args)
        // The honest fallback: name the id and its arguments rather than
        // inventing a sentence for something we do not model.
        ?: "run \"${cmd.id}\"" + if (args.isEmpty()) "" else " with " +
          args.entries.joinToString(", ") { "${it.key}=${it.value}" },
      style = TextStyle(
        fontFamily = sans(13.5.sp),
        fontSize = 13.5.sp,
        fontWeight = FontWeight.W400,
        lineHeight = 21.6.sp,
      ),
      color = MerryColors.tx,
    )
    if (known == null) {
      FlowError(
        text = "This version of the app doesn't know that command, so it won't run it.",
        modifier = Modifier.padding(top = 6.dp),
      )
    }
    Row(
      Modifier.padding(top = 11.dp),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      ConfirmPill(
        label = if (acting) "Doing it…" else if (spec.via == Via.NAVIGATE) "Take me there" else "Yes, do it",
        enabled = known != null && !acting,
        ground = MerryColors.lime,
        ink = MerryColors.ink,
        border = null,
        onClick = { onConfirm(spec, args) },
      )
      // DECLINING IS NOT AN ERROR. It clears the offer and says nothing else: an
      // owner who says no has not hit a failure and must not be shown one.
      ConfirmPill(
        label = "Not now",
        enabled = !acting,
        ground = Color.Transparent,
        ink = MerryColors.tx,
        border = MerryColors.line,
        onClick = onDismiss,
      )
    }
  }
}

/**
 * `.desk-confirm-row button` — terminal.css:7545-7563: radius 999px,
 * `padding: 8px 15px`, 13px/600. Disabled is `opacity: .55` and NOTHING ELSE —
 * the terminal never expresses disabled with a colour, and there is no spinner
 * anywhere on this card.
 */
@Composable
private fun ConfirmPill(
  label: String,
  enabled: Boolean,
  ground: Color,
  ink: Color,
  border: Color?,
  onClick: () -> Unit,
) {
  val shape = RoundedCornerShape(50)
  Box(
    Modifier
      .alpha(if (enabled) 1f else 0.55f)
      .clip(shape)
      .background(ground)
      .then(if (border != null) Modifier.border(1.dp, border, shape) else Modifier)
      .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
      .padding(horizontal = 15.dp, vertical = 8.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = label,
      maxLines = 1,
      style = TextStyle(
        fontFamily = sans(13.sp, FontWeight.W600),
        fontSize = 13.sp,
        fontWeight = FontWeight.W600,
      ),
      color = ink,
    )
  }
}
