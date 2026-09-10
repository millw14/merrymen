package dev.merrymen.app.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.CircleTier
import dev.merrymen.app.net.CircleView
import dev.merrymen.app.net.LeaderRow
import dev.merrymen.app.net.Leaderboard
import dev.merrymen.app.net.unrankedShort
import dev.merrymen.app.net.SearchResults
import dev.merrymen.app.net.SettingsEnvelope
import dev.merrymen.app.net.TelegramStatus
import dev.merrymen.app.net.ThesesPage
import dev.merrymen.app.net.TokensPage
import dev.merrymen.app.net.WebAuth
import dev.merrymen.app.net.WebFlow
import dev.merrymen.app.ui.Avatar
import dev.merrymen.app.ui.Bps
import dev.merrymen.app.ui.Coin
import dev.merrymen.app.ui.Empty
import dev.merrymen.app.ui.EmptyKind
import dev.merrymen.app.ui.LikeButton
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.LocalBottomInset
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Money
import dev.merrymen.app.ui.NameBlock
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.PageGap
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PagePadTop
import dev.merrymen.app.ui.PageTitle
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.SectionCard
import dev.merrymen.app.ui.WireButton
import dev.merrymen.app.ui.numerals
import dev.merrymen.app.ui.sans
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import java.util.Locale

// ---------------------------------------------------------------------------
// TYPE, from the two sheets that actually decide it on a phone
// ---------------------------------------------------------------------------

/**
 * THE FORM PAGE'S ACCENT IS NOT LIME, and this is the single easiest thing to
 * get wrong on this screen.
 *
 * `forms.css:6` redefines the token on the scope itself:
 * `.terminal-host .terminal-form-page { … --lime: var(--tx); }`
 *
 * So on Settings — and on the wallet/grant page — every rule that reads
 * `var(--lime)` resolves to the off-white `--tx` #ECECE4. A hardcoded
 * `MerryColors.lime` here would give the settings screen an accent the web does
 * not have anywhere, and would spend the one colour this product reserves for
 * "the owner must act before the agent can move" on a Save button.
 *
 * Named rather than inlined so the reason travels with the value.
 */
private val FormAccent = MerryColors.tx

/** `.terminal-form-page` body copy: `font: inherit` at the host's 15px/1.35. */
private val BodyText = TextStyle(
  fontFamily = sans(15.sp),
  fontSize = 15.sp,
  fontWeight = FontWeight.W400,
  lineHeight = 20.25.sp,
)

/** `.meta` — terminal.css:705: `margin: 2px 0 0; color: var(--tx-2); font-size: 12px`. */
private val MetaText = TextStyle(
  fontFamily = sans(12.sp),
  fontSize = 12.sp,
  fontWeight = FontWeight.W400,
  lineHeight = 16.2.sp,
)

/**
 * `.terminal-form-heading h1`, AS IT RESOLVES ON A PHONE — 26px, not 34px.
 *
 * `forms.css:10` says 30px and `forms.css:96` (inside `@media(max-width:650px)`)
 * cuts it to 26px, with `font-weight: 600; line-height: 1.2; letter-spacing: -.04em`.
 *
 * DELIBERATELY NOT [PageTitle]. `polish.css:109` sets `.top-title` to 34px, but
 * Settings does not render a `.top-title` at all — `screens/Settings.tsx:398`
 * renders `<FormHeading title="Settings" />`, which is `.terminal-form-heading h1`
 * (FormPage.tsx:6-8). The two headings are different sizes in the web and the
 * difference is what tells a reader a form page from a browsing page.
 */
private val FormHeadingText = TextStyle(
  fontFamily = sans(26.sp, FontWeight.W600),
  fontSize = 26.sp,
  fontWeight = FontWeight.W600,
  lineHeight = 31.2.sp,
  letterSpacing = (-0.04).em,
)

/** `.mm-section` — forms.css:23: `font-size: 18px; font-weight: 600; letter-spacing: -.02em`. */
private val SectionHeadingText = TextStyle(
  fontFamily = sans(18.sp, FontWeight.W600),
  fontSize = 18.sp,
  fontWeight = FontWeight.W600,
  letterSpacing = (-0.02).em,
)

/**
 * `.mm-label` — forms.css:36: `font-size: 14px; font-weight: 500; line-height: 1.5`.
 *
 * ABOVE the control, never floating in it. The web has no placeholder-as-label
 * anywhere in this vocabulary, which is why these screens use [BasicTextField]
 * and a separate label rather than an `OutlinedTextField`.
 */
private val FieldLabelText = TextStyle(
  fontFamily = sans(14.sp, FontWeight.W500),
  fontSize = 14.sp,
  fontWeight = FontWeight.W500,
  lineHeight = 21.sp,
)

/** `.mm-hint` — forms.css:21, 37: `font-size: 12px; line-height: 1.65`, `--tx-2`. */
private val HintText = TextStyle(
  fontFamily = sans(12.sp),
  fontSize = 12.sp,
  fontWeight = FontWeight.W400,
  lineHeight = 19.8.sp,
)

/** `.mm-note` — forms.css:20-22: `font-size: 14px; line-height: 1.65`, `--tx-2`. */
private val NoteText = TextStyle(
  fontFamily = sans(14.sp),
  fontSize = 14.sp,
  fontWeight = FontWeight.W400,
  lineHeight = 23.1.sp,
)

/** `.mm-danger` — forms.css:57: `color: var(--down); font-size: 13px; line-height: 1.6`. */
private val DangerText = TextStyle(
  fontFamily = sans(13.sp),
  fontSize = 13.sp,
  fontWeight = FontWeight.W400,
  lineHeight = 20.8.sp,
)

/** The box's own text — forms.css:40: `font-size: 14px`, colour `--tx`. */
private val InputText = TextStyle(
  fontFamily = sans(14.sp),
  fontSize = 14.sp,
  fontWeight = FontWeight.W400,
  color = MerryColors.tx,
)

/** `.search` — terminal.css:2206: the one input in the terminal set to 16px. */
private val SearchText = TextStyle(
  fontFamily = sans(16.sp),
  fontSize = 16.sp,
  fontWeight = FontWeight.W400,
  color = MerryColors.tx,
)

/** `.mm-btn.primary` / `.grant-btn` — forms.css:53: `font-size: 14px; font-weight: 600`. */
private val ButtonText = TextStyle(
  fontFamily = sans(14.sp, FontWeight.W600),
  fontSize = 14.sp,
  fontWeight = FontWeight.W600,
)

/** `.mm-chips button` / `.mm-btn` — forms.css:51: `font-size: 13px`, inherited weight. */
private val ChipText = TextStyle(
  fontFamily = sans(13.sp),
  fontSize = 13.sp,
  fontWeight = FontWeight.W400,
)

/** `.rk` — forms.css:84: `color: var(--tx-2); font-size: 12px; margin-bottom: 6px`. */
private val KeyText = TextStyle(
  fontFamily = sans(12.sp),
  fontSize = 12.sp,
  fontWeight = FontWeight.W400,
)

/** `.rv` — forms.css:85: `font-size: 14px; overflow-wrap: anywhere`. */
private val ValueText = TextStyle(
  fontFamily = sans(14.sp),
  fontSize = 14.sp,
  fontWeight = FontWeight.W400,
  lineHeight = 20.sp,
)

// ---------------------------------------------------------------------------
// SMALL SHARED PIECES — private per the one-file-per-agent rule, and every one
// of them wants lifting into Components.kt. See the report.
// ---------------------------------------------------------------------------

/** en-US grouping, which is the format every figure in this product is written in. */
private fun grouped(n: Int): String = String.format(Locale.US, "%,d", n)

/**
 * A HEX STRING THAT WILL ACTUALLY WRAP.
 *
 * `forms.css:60, 82, 85` set `overflow-wrap: anywhere` on addresses, keys and
 * boxed notices so a 42-character run breaks inside the 430px column. Compose
 * will not break inside a word at all, so the break opportunities are put in by
 * hand as zero-width spaces.
 *
 * NEVER `TextOverflow.Ellipsis` HERE. A truncated contract address is a wrong
 * contract address, and this app has an entire screen about telling one token
 * from another.
 */
private fun breakable(text: String): String = text.chunked(4).joinToString("\u200B")

/**
 * `overflow-wrap: anywhere` FOR PROSE \u2014 which is not the same thing as [breakable].
 *
 * A zero-width space is a FIRST-CLASS break opportunity, ranked with a real
 * space, so a greedy line breaker takes the last one that fits in preference to
 * the space before the word. Running whole sentences through [breakable]
 * therefore wrapped every refusal message mid-word ("The server rejec / ted
 * some values") \u2014 on exactly the copy that has to stay legible. CSS's
 * `anywhere` is a LAST RESORT that only breaks inside a word when the word
 * cannot fit a line on its own, and this is that: only runs long enough to
 * overflow by themselves get the treatment.
 */
private fun breakLongRuns(text: String): String =
  Regex("\\S{25,}").replace(text) { breakable(it.value) }

/**
 * A FOCUS RING DRAWN OUTSIDE THE BOX, which `Modifier.border` cannot do.
 *
 * `forms.css:43`: `outline: 2px solid var(--tx-2); outline-offset: 2px`. A CSS
 * outline is painted outside the border box and takes NO layout space, so the
 * field does not move when it gains focus. The caller reserves 4dp around the
 * control and this paints into that reserve: stroke centre 1dp in from the
 * outer edge — which is `offset 2px + half of a 2px stroke` measured from the
 * control — and a corner radius of the control's radius plus that 3px.
 *
 * The ring is GREY, not lime. `forms.css:43` (0,2,1) beats the app-wide lime
 * `button:focus-visible` at `terminal.css:661` (0,1,1), so on a form page the
 * inputs focus grey while the buttons focus lime — except that on this page
 * lime is itself redefined to `--tx`. See [FormAccent].
 */
private fun Modifier.outlineRing(show: Boolean, color: Color, radius: Dp): Modifier =
  this.drawBehind {
    if (!show) return@drawBehind
    val w = 2.dp.toPx()
    drawRoundRect(
      color = color,
      topLeft = Offset(w / 2f, w / 2f),
      size = Size(size.width - w, size.height - w),
      cornerRadius = CornerRadius(radius.toPx() + 3.dp.toPx()),
      style = Stroke(width = w),
    )
  }

/**
 * THE BACK CONTROL, and it is a literal arrow character.
 *
 * `screens/Search.tsx:41` and `screens/Token.tsx:146` both render
 * `<button class="back" aria-label="Back">←</button>` — the visible content is
 * U+2190, not an icon. `terminal.css:1124`:
 * `color: var(--tx-2); font-size: 15px; font-weight: 600; line-height: 1`.
 *
 * The 44dp box is Android's, not the web's: `polish.css:17` and the rules
 * around it hold every tappable thing in this shell at 44px, and a 15px glyph
 * on its own is a 15px target. The glyph is drawn at the web's size inside it.
 * `contentDescription` carries the `aria-label` — TalkBack reads a bare "←" as
 * "left arrow", which is a shape, not a destination.
 */
@Composable
private fun BackControl(onBack: () -> Unit, modifier: Modifier = Modifier) {
  Box(
    modifier
      .size(44.dp)
      .clickable(onClick = onBack)
      .semantics { contentDescription = "Back" },
    contentAlignment = Alignment.CenterStart,
  ) {
    Text(
      text = "←",
      style = TextStyle(
        fontFamily = sans(15.sp, FontWeight.W600),
        fontSize = 15.sp,
        fontWeight = FontWeight.W600,
        lineHeight = 15.sp,
      ),
      color = MerryColors.tx2,
    )
  }
}

/**
 * lucide `ArrowLeft` at `size={18} strokeWidth={1.8}` — the glyph
 * `screens/Profile.tsx:63-70` puts in `.profile-back`.
 *
 * Two subpaths on a 24-unit viewBox, copied rather than redrawn, and stroked
 * the way `Icons.kt` strokes the tab glyphs. Material's `ArrowBack` is a filled,
 * heavier drawing and reads as a different icon set beside these.
 */
@Composable
private fun ArrowLeftIcon(tint: Color, size: Dp = 18.dp) {
  val shaft = PathParser().parsePathString("M19 12H5").toPath()
  val head = PathParser().parsePathString("m12 19-7-7 7-7").toPath()
  Canvas(Modifier.size(size)) {
    val s = this.size.minDimension / 24f
    scale(s, s, pivot = Offset.Zero) {
      val stroke = Stroke(width = 1.8f, cap = StrokeCap.Round, join = StrokeJoin.Round)
      drawPath(shaft, tint, style = stroke)
      drawPath(head, tint, style = stroke)
    }
  }
}

/**
 * THE PAGE HEADER FOR EVERY PUSHED SCREEN — back above, title below.
 *
 * There is no app bar anywhere in the mobile shell: `App.tsx:310` gates
 * `<DesktopHeader>` behind `desktop &&`, and every screen writes its own header
 * as the first child of the scrolling content, so the title scrolls away with
 * the page. This composable is that header.
 *
 * BACK COMES FIRST AND IT IS ITS OWN ROW. `Search.tsx:41` and `Token.tsx:146`
 * both put `.back` as the LEADING control, and `terminal.css:2326`
 * (`.sheet .back { margin-bottom: 28px }`) gives it a 28px gap before what
 * follows. The version this replaced put a "Back" word on the RIGHT of the
 * title as a trailing action, which is neither the position nor the affordance
 * the web uses.
 *
 * The 28px is spent partly by the 44dp touch target: the 15px glyph sits
 * centred in it, so roughly 14.5dp of the gap is already inside the control and
 * the explicit margin makes up the rest.
 *
 * THE TITLE IS 34sp. `polish.css:109-110` inside `@media (max-width: 1099px)`:
 * `font-size: 34px; line-height: 1.15; font-weight: 700; letter-spacing: -.04em`.
 * The base sheet's 22px is the desktop size. See [PageTitle].
 *
 * Kept `internal` and kept at this exact signature because `screens/Token.kt`
 * calls it. It carries the page gutter itself so a caller can drop it at the
 * top of an unpadded scroller.
 */
@Composable
internal fun Header(title: String, nav: NavHostController) {
  Column(
    Modifier
      .fillMaxWidth()
      .padding(start = PagePadH, end = PagePadH, top = PagePadTop),
  ) {
    BackControl({ nav.popBackStack() }, Modifier.padding(bottom = 14.dp))
    PageTitle(title)
  }
}

/**
 * The compact header for a screen whose body is the WEB APP ITSELF.
 *
 * A 34sp native title above a WebView that renders the same page's own heading
 * says the name twice in two different type scales. These screens exist only to
 * hold a signature ceremony (see [SignInScreen]), so the native chrome is a way
 * back and a label, at `.back`'s own 15px/600.
 */
@Composable
private fun WebHeader(title: String, nav: NavHostController) {
  Row(
    Modifier
      .fillMaxWidth()
      .padding(start = PagePadH, end = PagePadH, top = PagePadTop, bottom = 8.dp),
    horizontalArrangement = Arrangement.spacedBy(10.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    BackControl({ nav.popBackStack() })
    Text(
      text = title,
      style = TextStyle(
        fontFamily = sans(15.sp, FontWeight.W600),
        fontSize = 15.sp,
        fontWeight = FontWeight.W600,
      ),
      color = MerryColors.tx,
    )
  }
}

/**
 * `.mm-section` — forms.css:23:
 * `font-size: 18px; font-weight: 600; letter-spacing: -.02em; padding: 28px 0 16px; border-top: 1px solid var(--line); margin-top: 28px`
 *
 * The RULE IS THE SEPARATOR and it sits above the padding, so the order here is
 * 28dp of margin, the hairline, 28dp of padding, the words, 16dp. Drawing the
 * line under the heading instead — which is the instinct — puts the divider on
 * the wrong side of the thing it divides.
 */
@Composable
private fun SectionHeading(text: String) {
  Column(Modifier.fillMaxWidth()) {
    Spacer(Modifier.height(28.dp))
    Box(Modifier.fillMaxWidth().height(1.dp).background(MerryColors.line))
    Text(
      text = text,
      modifier = Modifier.padding(top = 28.dp, bottom = 16.dp),
      style = SectionHeadingText,
      color = MerryColors.tx,
    )
  }
}

/** `.mm-note` — a status line. Grey, because a failed READ is not a red thing here. */
@Composable
private fun NoteLine(text: String, modifier: Modifier = Modifier) {
  if (text.isBlank()) return
  Text(text, modifier, style = NoteText, color = MerryColors.tx2)
}

/** `.mm-hint` — the sentence under a control. */
@Composable
private fun HintLine(text: String, modifier: Modifier = Modifier) {
  if (text.isBlank()) return
  Text(text, modifier, style = HintText, color = MerryColors.tx2)
}

/**
 * `.mm-danger` — forms.css:57. Red 13px body text, no background, no icon.
 *
 * THIS IS NOT INTERCHANGEABLE WITH [NoteLine]. The settings screen says three
 * different things in this register and the web keeps two of them apart by
 * colour alone: "Loading settings…" and "Could not load your settings." are
 * both grey `.mm-note` (the second is distinguished by carrying a retry), while
 * a SAVE THAT FAILED is red. A save that did not happen must never read like a
 * save that did.
 */
@Composable
private fun DangerLine(text: String, modifier: Modifier = Modifier) {
  if (text.isBlank()) return
  Text(breakLongRuns(text), modifier, style = DangerText, color = MerryColors.down)
}

/**
 * THE ONE INPUT BOX — forms.css:39-41.
 *
 * `width: 100%; min-height: 46px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); color: var(--tx); font-size: 14px; box-sizing: border-box`
 *
 * `box-sizing: border-box` is why `heightIn(min = 46.dp)` sits on the OUTER box
 * that already carries the border and the padding: in CSS the 46 includes them,
 * and putting the floor on the inner text would inflate the control to ~72dp.
 *
 * PLACEHOLDERS ARE AT `--tx-2`, DELIBERATELY. The web authors no `::placeholder`
 * rule at all and rides Chromium's dark-scheme default, which is roughly 54%
 * white. On the settings screen a placeholder is the ONLY thing that says
 * whether a secret is stored — `saved ····ab12 — type to replace` against the
 * literal `not set` — so styling it as a generic dim hint at or below `--faint`
 * would make "we hold your key" and "we hold nothing" fade into each other.
 */
@Composable
private fun InputBox(
  value: String,
  onValueChange: (String) -> Unit,
  modifier: Modifier = Modifier,
  placeholder: String? = null,
  password: Boolean = false,
  keyboardType: KeyboardType = KeyboardType.Text,
  focusRequester: FocusRequester? = null,
) {
  val interaction = remember { MutableInteractionSource() }
  val focused by interaction.collectIsFocusedAsState()
  val shape = RoundedCornerShape(12.dp)
  Box(
    modifier
      .fillMaxWidth()
      .outlineRing(focused, MerryColors.tx2, 12.dp)
      .padding(4.dp),
  ) {
    Box(
      Modifier
        .fillMaxWidth()
        .heightIn(min = 46.dp)
        .clip(shape)
        .background(MerryColors.card)
        .border(1.dp, MerryColors.line, shape)
        .padding(horizontal = 14.dp, vertical = 12.dp),
      contentAlignment = Alignment.CenterStart,
    ) {
      var field = Modifier.fillMaxWidth()
      if (focusRequester != null) field = field.focusRequester(focusRequester)
      BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = field,
        singleLine = true,
        textStyle = InputText,
        cursorBrush = SolidColor(MerryColors.tx),
        visualTransformation =
          if (password) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        interactionSource = interaction,
        decorationBox = { inner ->
          Box(contentAlignment = Alignment.CenterStart) {
            if (value.isEmpty() && !placeholder.isNullOrBlank()) {
              Text(placeholder, style = InputText, color = MerryColors.tx2)
            }
            inner()
          }
        },
      )
    }
  }
}

/** `.mm-field` — forms.css:25: a column with a 9px gap between label, control and hint. */
@Composable
private fun FormField(
  label: String,
  value: String,
  onValueChange: (String) -> Unit,
  modifier: Modifier = Modifier,
  hint: String? = null,
  placeholder: String? = null,
  password: Boolean = false,
) {
  Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(9.dp)) {
    Text(label, style = FieldLabelText, color = MerryColors.tx)
    InputBox(
      value = value,
      onValueChange = onValueChange,
      placeholder = placeholder,
      password = password,
    )
    if (!hint.isNullOrBlank()) HintLine(hint)
  }
}

/**
 * `.mm-btn.primary` / `.grant-btn` — forms.css:53:
 * `padding: 14px 22px; border: 0; border-radius: 12px; background: var(--tx); color: var(--ink); font-size: 14px; font-weight: 600; min-height: 46px`
 *
 * NOT FULL WIDTH and not sticky — it sits in normal flow at the bottom of the
 * form. Its ground is `--tx` #ECECE4, which on this page is also what `--lime`
 * resolves to ([FormAccent]); the two are the same colour here and that is not
 * a coincidence to paper over with a literal.
 *
 * DISABLED IS `opacity: .45` AND NOTHING ELSE — forms.css:54. No colour change,
 * no container swap. Material's disabled container colour would repaint this in
 * a surface tone that appears nowhere in the sheet.
 */
@Composable
private fun PrimaryButton(
  label: String,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
  onClick: () -> Unit,
) {
  Box(
    modifier
      .alpha(if (enabled) 1f else 0.45f)
      .heightIn(min = 46.dp)
      .clip(RoundedCornerShape(12.dp))
      .background(FormAccent)
      .clickable(enabled = enabled, onClick = onClick)
      .padding(horizontal = 22.dp, vertical = 14.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(label, style = ButtonText, color = MerryColors.ink)
  }
}

/**
 * `.btn-kill` — forms.css:90:
 * `color: var(--down); border: 1px solid var(--line); border-radius: 12px; padding: 12px 16px`
 *
 * THE RED IS TEXT AND ONLY TEXT. There is no red ground and no red border: the
 * box is the same neutral hairline every other control wears, so the control
 * reads as consequential rather than as an alarm. That register is exactly
 * right for "restart the practice book" — it destroys a simulated history and
 * the worker refuses it outright on the live rail, so it is irreversible but it
 * is not money.
 *
 * `.btn-kill` sets no font-size, so the web inherits one; 14sp is chosen to sit
 * with the rest of the form vocabulary rather than derived.
 */
@Composable
private fun KillButton(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
  val shape = RoundedCornerShape(12.dp)
  Box(
    modifier
      .clip(shape)
      .border(1.dp, MerryColors.line, shape)
      .clickable(onClick = onClick)
      .padding(horizontal = 16.dp, vertical = 12.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = label,
      style = TextStyle(
        fontFamily = sans(14.sp, FontWeight.W500),
        fontSize = 14.sp,
        fontWeight = FontWeight.W500,
      ),
      color = MerryColors.down,
    )
  }
}

/**
 * `.mm-row` — forms.css:59:
 * `display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid var(--line); font-size: 13px`
 */
@Composable
private fun KeyValueRow(key: String, modifier: Modifier = Modifier, value: @Composable () -> Unit) {
  Column(modifier.fillMaxWidth()) {
    Row(
      Modifier.fillMaxWidth().padding(vertical = 12.dp),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(key, style = ChipText, color = MerryColors.tx2)
      value()
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(MerryColors.line))
  }
}

/**
 * `.preset-card` — forms.css:76-79:
 * `display: flex; flex-direction: column; gap: 10px; padding: 18px; border: 1px solid var(--line); border-radius: 14px; background: var(--card)`
 * with the label at 14px/600 and the blurb at 12px/1.6 `--tx-2`.
 *
 * WHY THIS SHAPE AND NOT AN INVENTED ONE. There is no `.circle-` or `.tier-`
 * selector anywhere in terminal.css, polish.css, forms.css or root.css — the
 * web has no Merry Circle screen at all, so this whole page has no design to
 * copy. `.preset-card` is the nearest PUBLISHED card vocabulary in the same
 * family of "here are your options, one per box", so it is borrowed openly
 * rather than a new card being drawn. Flagged for the owner in the report.
 */
@Composable
private fun PresetCard(
  title: String,
  modifier: Modifier = Modifier,
  content: @Composable ColumnScope.() -> Unit,
) {
  val shape = RoundedCornerShape(14.dp)
  Column(
    modifier
      .fillMaxWidth()
      .clip(shape)
      .background(MerryColors.card)
      .border(1.dp, MerryColors.line, shape)
      .padding(18.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Text(
      text = title,
      style = TextStyle(
        fontFamily = sans(14.sp, FontWeight.W600),
        fontSize = 14.sp,
        fontWeight = FontWeight.W600,
      ),
      color = MerryColors.tx,
    )
    content()
  }
}

/** `.chain-card-body` / `.preset-blurb` — forms.css:79: 12px, `--tx-2`, line-height 1.6. */
@Composable
private fun CardBlurb(text: String, modifier: Modifier = Modifier) {
  if (text.isBlank()) return
  Text(
    text = text,
    modifier = modifier,
    style = TextStyle(
      fontFamily = sans(12.sp),
      fontSize = 12.sp,
      fontWeight = FontWeight.W400,
      lineHeight = 19.2.sp,
    ),
    color = MerryColors.tx2,
  )
}

/**
 * `.halt` — terminal.css:2312:
 * `padding: 7px 11px; border: 1px solid var(--line); border-radius: 999px; color: var(--tx-2); font-size: 12px; font-weight: 600`
 *
 * A NEUTRAL PILL, not a red one. A halted market is a fact about the venue, not
 * a loss, and `--down` is spent on money going the wrong way. (The sheet keeps
 * one variant, `.halt.off`, which turns lime when trading is back ON — the
 * accent marks the good news, not the bad.)
 */
@Composable
private fun HaltChip(text: String, modifier: Modifier = Modifier) {
  val shape = RoundedCornerShape(50)
  Box(
    modifier
      .clip(shape)
      .border(1.dp, MerryColors.line, shape)
      .padding(horizontal = 11.dp, vertical = 7.dp),
  ) {
    Text(
      text = text,
      style = TextStyle(
        fontFamily = sans(12.sp, FontWeight.W600),
        fontSize = 12.sp,
        fontWeight = FontWeight.W600,
        lineHeight = 12.sp,
      ),
      color = MerryColors.tx2,
    )
  }
}

/**
 * `.tok` — terminal.css:979-1010. The list row this terminal uses for a token
 * or an agent, and it is NOT A CARD:
 *
 * `display: grid; grid-template-columns: 40px minmax(0,1fr) auto; gap: 12px; align-items: center; width: 100%; min-height: 64px; padding: 10px 0`
 *
 * with `.tok strong` clipped to one line, `.meta` at 12px `--tx-2` 2px under
 * it, and `.px` right-aligned at weight 600 with tabular figures.
 *
 * NO BORDER, NO GROUND, NO RADIUS. Wrapping each row in a `SectionCard` — which
 * is what these screens did — draws a box the web does not draw and turns a
 * scannable list into a stack of panels. `Components.kt`'s own note says the
 * same thing: reach for a card only where the screen's spec has one.
 */
@Composable
private fun TokRow(
  seed: String,
  title: String,
  sub: String?,
  modifier: Modifier = Modifier,
  under: (@Composable ColumnScope.() -> Unit)? = null,
  right: (@Composable ColumnScope.() -> Unit)? = null,
) {
  Row(
    modifier
      .fillMaxWidth()
      .heightIn(min = 64.dp)
      .padding(vertical = 10.dp),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    // A TOKEN, NOT AN AGENT. See Coin() — the web draws a flat #ecece4 disc
    // here, not the hue-gradient face it generates for a desk.
    Coin(seed, size = 40.dp)
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(
        text = title,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        style = BodyText,
        color = MerryColors.tx,
      )
      if (!sub.isNullOrBlank()) {
        Text(
          text = sub,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
          style = MetaText,
          color = MerryColors.tx2,
        )
      }
      under?.invoke(this)
    }
    if (right != null) {
      Column(
        horizontalAlignment = Alignment.End,
        verticalArrangement = Arrangement.spacedBy(3.dp),
        content = right,
      )
    }
  }
}

// ── MARKETS ─────────────────────────────────────────────────────────────────

@Composable
fun MarketsScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<TokensPage>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()
  suspend fun load() { state = c.api.market().toLoaded() }
  LaunchedEffect(Unit) { load() }

  // ONE SCROLLER, and the header scrolls with it. `App.tsx` renders no app bar
  // on a phone at all — `.body` is the single scroll region (polish.css:87) and
  // every screen's title is just its first child, so it leaves the screen as
  // the reader moves down. A fixed title here would be a different design.
  Column(
    Modifier
      .fillMaxSize()
      .verticalScroll(rememberScrollState()),
  ) {
    Header("Markets", nav)
    Spacer(Modifier.height(PageGap))
    Column(Modifier.fillMaxWidth().padding(horizontal = PagePadH)) {
      LoadedBlock(state, onRetry = { scope.launch { load() } }) { page ->
        if (page.tokens.isEmpty()) {
          Empty(
            "No tokens listed",
            "Nothing has been registered on this deployment yet.",
            kind = EmptyKind.Positions,
          )
        } else {
          page.tokens.forEach { t ->
            TokRow(
              seed = t.symbol,
              title = t.symbol,
              sub = t.name,
              modifier = Modifier.clickable(enabled = t.address != null) {
                t.address?.let { nav.navigate(Routes.token(it)) }
              },
              under = {
                // HALT IS NULLABLE ON PURPOSE: the server may only assert it
                // when the chain answered, so unknown stays quiet.
                if (t.paused == true) HaltChip("trading halted", Modifier.padding(top = 4.dp))
              },
              right = {
                Money(t.priceUsd, bold = true)
                // 24h VOLUME, NOT A 24h CHANGE. /api/market sends no change
                // figure, so the arrow that used to sit here was an em dash on
                // every row for every token, for ever. The label stays: an
                // unlabelled second figure under a price reads as a move.
                t.volume24hUsd?.let {
                  Text("24h vol", style = MetaText, color = MerryColors.faint)
                  Money(it, size = 12.sp, bold = true)
                }
              },
            )
          }
        }
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}

// ── SEARCH ──────────────────────────────────────────────────────────────────

/**
 * `.search` — terminal.css:2188-2196 and :2206:
 * `width: 100%; background: var(--card); border: 0; border-radius: 14px; padding: 13px 14px; font-size: 16px`
 *
 * BORDERLESS, and a bigger face than any other input in the app. It is not the
 * 46px/12px-radius/hairlined form field: that vocabulary belongs to
 * `.terminal-form-page`, which this screen is not on.
 */
@Composable
private fun SearchField(
  value: String,
  onValueChange: (String) -> Unit,
  modifier: Modifier = Modifier,
  focusRequester: FocusRequester? = null,
) {
  val shape = RoundedCornerShape(14.dp)
  Box(
    modifier
      .fillMaxWidth()
      .clip(shape)
      .background(MerryColors.card)
      .padding(horizontal = 14.dp, vertical = 13.dp),
    contentAlignment = Alignment.CenterStart,
  ) {
    var field = Modifier.fillMaxWidth()
    if (focusRequester != null) field = field.focusRequester(focusRequester)
    BasicTextField(
      value = value,
      onValueChange = onValueChange,
      modifier = field.semantics { contentDescription = "Search tokens or agents" },
      singleLine = true,
      textStyle = SearchText,
      cursorBrush = SolidColor(MerryColors.tx),
      decorationBox = { inner ->
        Box(contentAlignment = Alignment.CenterStart) {
          if (value.isEmpty()) {
            Text("Search tokens or agents", style = SearchText, color = MerryColors.tx2)
          }
          inner()
        }
      },
    )
  }
}

@Composable
fun SearchScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var q by remember { mutableStateOf("") }
  var state by remember { mutableStateOf<Loaded<SearchResults>>(Loaded.Idle) }
  val scope = rememberCoroutineScope()
  val focus = remember { FocusRequester() }

  // `autoFocus` on the input — Search.tsx:43. Somebody who opened search wants
  // to type; the web does not make them tap the field first.
  //
  // GUARDED, because `requestFocus` throws if the node is not attached yet and
  // the ordering of a LaunchedEffect against first layout is not something this
  // screen should bet on. Losing the keyboard is a small miss; crashing on the
  // way into search is not.
  LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    // `.find-bar` — terminal.css:2364: `display: flex; align-items: center; gap: 10px; margin-bottom: 8px`,
    // the back control then a field that flexes to fill. THERE IS NO TITLE ON
    // THIS SCREEN — Search.tsx:38-52 renders the bar and nothing above it.
    Row(
      Modifier
        .fillMaxWidth()
        .padding(start = PagePadH, end = PagePadH, top = PagePadTop, bottom = 8.dp),
      horizontalArrangement = Arrangement.spacedBy(10.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      BackControl({ nav.popBackStack() })
      SearchField(
        value = q,
        onValueChange = {
          q = it
          scope.launch {
            if (it.isBlank()) state = Loaded.Idle
            else {
              state = Loaded.Loading
              state = c.api.search(it).toLoaded()
            }
          }
        },
        modifier = Modifier.weight(1f),
        focusRequester = focus,
      )
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = PagePadH)) {
      LoadedBlock(state) { r ->
        if (r.hits.isEmpty()) {
          Empty("Nothing matched", "No token or agent by that name.", kind = EmptyKind.Search)
        } else {
          r.hits.forEach { h ->
            TokRow(
              seed = h.title.orEmpty(),
              title = h.title.orEmpty(),
              sub = h.sub,
              modifier = Modifier.clickable {
                // The server hands back its own web path; turn it into our route
                // rather than re-deriving the destination from the kind field.
                val href = h.href.orEmpty()
                when {
                  href.startsWith("/t/") -> nav.navigate(Routes.token(href.removePrefix("/t/")))
                  href.startsWith("/a/") -> nav.navigate(Routes.agent(href.removePrefix("/a/")))
                }
              },
            )
          }
        }
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}

// ── LEADERBOARD ─────────────────────────────────────────────────────────────

/**
 * `.rank` / `.rank-hit` — terminal.css:3027-3113. A race, drawn as a ruled list:
 *
 * `.rank { padding: 10px 0; border-bottom: 1px solid var(--line) }` with the
 * last row's rule removed, and inside it
 * `grid-template-columns: 20px auto minmax(0,1fr) auto; gap: 11px`:
 * the position at 13px `--faint` with tabular figures, the face, who, then the
 * figures column at 12px/600 with `letter-spacing: -0.02em`.
 *
 * THE POSITION IS AN EM DASH WHEN THE RETURN IS UNKNOWN — Board.tsx:138 renders
 * `row.ret == null ? "—" : row.rank`. An agent with no measurable return has no
 * position in the race, and printing one anyway would rank it on a number
 * nobody has.
 */
@Composable
private fun RankRow(
  row: LeaderRow,
  place: Int?,
  last: Boolean,
  modifier: Modifier = Modifier,
) {
  Column(modifier.fillMaxWidth()) {
    Row(
      Modifier.fillMaxWidth().padding(vertical = 10.dp),
      horizontalArrangement = Arrangement.spacedBy(11.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
        text = place?.toString() ?: "—",
        modifier = Modifier.width(20.dp),
        style = TextStyle(
          fontFamily = numerals(FontWeight.W400),
          fontSize = 13.sp,
          fontWeight = FontWeight.W400,
        ),
        color = MerryColors.faint,
      )
      // `.face` at its shared 30px default — terminal.css:1031. Board.tsx passes
      // no size, so this is not the 22px `.face.pin` the feed rail uses.
      Avatar(row.name ?: row.handle ?: "agent", size = 30.dp)
      Column(Modifier.weight(1f)) {
        NameBlock(
          title = row.name ?: row.handle ?: "agent",
          owner = row.handle,
          verified = row.handleVerified,
        )
        // `.rank-trades` — terminal.css:3088: 11px `--faint`, nowrap, 2px under
        // the name. Rendered only when the count is KNOWN: null is "we were not
        // told", which is not the same claim as "no trades yet".
        // THE WIRE FIELD IS `landed`, and `trades` never existed — so this line
        // decoded null on every row and rendered nowhere. Zero is also excluded
        // deliberately: an agent with 0 settled fills and a dozen paper ones has
        // traded, just not for real, and "0 trades" would deny it.
        row.landed?.takeIf { it > 0 }?.let { n ->
          Text(
            text = if (n == 1) "1 trade" else "$n trades",
            modifier = Modifier.padding(top = 2.dp),
            maxLines = 1,
            style = TextStyle(
              fontFamily = sans(11.sp),
              fontSize = 11.sp,
              fontWeight = FontWeight.W400,
            ),
            color = MerryColors.faint,
          )
        }
      }
      // `.rank .chg` at 12px/600 — but only for a row that HAS a return.
      //
      // A NULL HERE IS NOT AN UNREADABLE FIGURE. rank-pnl.ts guarantees exactly
      // one of `pnlBps` and `unrankedWhy` is ever set, so a null return always
      // means unranked for a STATED reason, and the web prints that reason.
      // Handing it to Bps rendered the app's em dash — which Components.kt
      // reserves for "we never got an answer" — so the phone asserted its own
      // ignorance in the one place the server had actually given an answer.
      // Eight rows on the live board carry a reason as I write this.
      if (row.pnlBps == null) {
        Text(
          text = unrankedShort(row.unrankedWhy),
          maxLines = 1,
          style = TextStyle(
            fontFamily = sans(12.sp, FontWeight.W600),
            fontSize = 12.sp,
            fontWeight = FontWeight.W600,
          ),
          color = MerryColors.faint,
        )
      } else {
        Bps(row.pnlBps, size = 12.sp)
      }
    }
    if (!last) Box(Modifier.fillMaxWidth().height(1.dp).background(MerryColors.line))
  }
}

@Composable
fun LeaderboardScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<Leaderboard>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()
  suspend fun load() { state = c.api.leaderboard().toLoaded() }
  LaunchedEffect(Unit) { load() }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Header("Leaderboard", nav)
    Spacer(Modifier.height(PageGap))
    Column(Modifier.fillMaxWidth().padding(horizontal = PagePadH)) {
      LoadedBlock(state, onRetry = { scope.launch { load() } }) { b ->
        if (b.agents.isEmpty()) {
          // "Nothing to rank" and "we could not rank" are different sentences.
          Empty(
            //  MEANS THE LEDGER COULD NOT BE READ. It is not
            // "nobody has traded", and the two must not share a sentence — the
            // web keeps them apart in ReadEmpty.
            if (b.source == "none") "Activity unavailable." else "Nothing to rank yet",
            if (b.source == "none") "We could not read the ledger for this deployment."
            else "No agent has a settled result on this deployment.",
            kind = EmptyKind.Board,
          )
        } else {
          // The position counts only rows that HAVE a return, so an unranked
          // agent does not push the agent below it down the table.
          var place = 0
          b.agents.forEachIndexed { i, a ->
            val p = if (a.pnlBps == null) null else ++place
            RankRow(
              row = a,
              place = p,
              last = i == b.agents.lastIndex,
              modifier = Modifier.clickable(enabled = a.slug != null) {
                a.slug?.let { nav.navigate(Routes.agent(it)) }
              },
            )
          }
        }
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}

// ── AGENT DETAIL ────────────────────────────────────────────────────────────

/**
 * `.public-agent-id` — the identity header of the public agent page, as the
 * LATER of the two rules that define it leaves it (terminal.css:4023-4051
 * supersedes terminal.css:30-49):
 *
 * `display: flex; align-items: center; gap: 10px; margin: 0 0 22px`, a
 * `.profile-back` cell holding a lucide `ArrowLeft` at 18/1.8 in `--tx-2`, a
 * 36x36 face, then the name and `@slug`.
 *
 * NOT THE 34sp PAGE TITLE. `Profile.tsx:73` renders an `h1` at 17px/600 with
 * `letter-spacing: -0.03em` — this screen is somebody else's desk, not one of
 * the reader's own tabs, and the web sizes it accordingly.
 *
 * The back cell is 22px wide in the web; here it is a 44dp target, because a
 * 22px hit area is under every tap-target rule Android has and this is the only
 * way off the screen.
 */
@Composable
private fun AgentIdHeader(
  nav: NavHostController,
  name: String,
  handle: String?,
  verified: Boolean,
  slug: String,
) {
  Row(
    Modifier
      .fillMaxWidth()
      .padding(start = PagePadH, end = PagePadH, top = PagePadTop, bottom = 22.dp),
    horizontalArrangement = Arrangement.spacedBy(10.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      Modifier
        .size(44.dp)
        .clickable { nav.popBackStack() }
        .semantics { contentDescription = "Back" },
      contentAlignment = Alignment.CenterStart,
    ) {
      ArrowLeftIcon(MerryColors.tx2)
    }
    Avatar(name, size = 36.dp)
    Column(Modifier.weight(1f)) {
      // NameBlock owns the three renderings of an owner line — proven handle as
      // a link, unproven handle or address as plain text, absent owner as no
      // line at all. It is not re-implemented here: that distinction is the
      // point of the component.
      NameBlock(title = name, owner = handle, verified = verified)
      // `.public-agent-id p` — terminal.css:4047: 11px `--faint`, 4px under.
      Text(
        text = "@$slug",
        modifier = Modifier.padding(top = 4.dp),
        style = TextStyle(
          fontFamily = sans(11.sp),
          fontSize = 11.sp,
          fontWeight = FontWeight.W400,
        ),
        color = MerryColors.faint,
      )
    }
  }
}

@Composable
fun AgentDetailScreen(nav: NavHostController, slug: String) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<ThesesPage>>(Loaded.Loading) }
  LaunchedEffect(slug) {
    state = c.api.theses().toLoaded()
    // What this owner's agent already reads, and this reader's own likes. Both
    // throttled — walking back and forth between desks does not re-poll.
    c.social.refreshWired()
    c.social.refresh()
  }

  // THE HEADER SITS OUTSIDE THE THREE-STATE BLOCK, and that is a correctness
  // point rather than a layout one: it carries the only way off this screen.
  // Nested inside LoadedBlock it disappears the moment the read is refused or
  // the server cannot be reached — leaving a reader stuck on a page with a
  // sentence and no back control, on a route the tab bar is currently hidden
  // from (Shell.kt wraps the bar in `if (onTab)`).
  //
  // The name as its own desk publishes it, with the owner underneath. Falls
  // back to the slug, which is all this screen has before the read lands.
  val first = when (val s = state) {
    is Loaded.Value -> s.value.theses.firstOrNull { it.slug == slug }
    else -> null
  }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    AgentIdHeader(
      nav = nav,
      name = first?.name ?: slug,
      handle = first?.handle,
      verified = first?.handleVerified ?: false,
      slug = slug,
    )
    Column(
      Modifier.fillMaxWidth().padding(horizontal = PagePadH),
      verticalArrangement = Arrangement.spacedBy(PageGap),
    ) {
      LoadedBlock(state) { page ->
        val mine = page.theses.filter { it.slug == slug }
        WireButton(slug, mine.firstOrNull()?.name ?: slug, onSignIn = { nav.navigate(Routes.SIGN_IN) })
        if (mine.isEmpty()) {
          Empty(
            "Nothing published",
            "This agent has not posted inside the current window.",
            kind = EmptyKind.Feed,
          )
        }
        mine.forEach { t ->
          SectionCard {
            Text(
              text = t.head.ifBlank { t.reason ?: "" },
              style = BodyText,
              color = MerryColors.tx,
            )
            // THE OUTCOME LINE STAYS NEUTRAL. `--up` and `--down` mean money
            // moved; a word describing what happened to a decision is not a
            // figure, and a refusal wearing the gain colour is the exact bug
            // `toneOf` exists to prevent.
            // A PRETEND FILL MUST NOT LOOK LIKE A REAL ONE. The web's public
            // agent page appends " · Paper" to this very line (Profile.tsx:255)
            // and the field was already decoded and dropped here — so a
            // simulated fill and a settled one rendered as the same card.
            val meta = listOfNotNull(t.outcome, if (t.paper) "Paper" else null)
            if (meta.isNotEmpty()) {
              Text(meta.joinToString(" · "), style = MetaText, color = MerryColors.tx2)
            }
            LikeButton(t.postId)
          }
        }
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}

// ── THE MERRY CIRCLE ────────────────────────────────────────────────────────

@Composable
fun CircleScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<CircleView>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()
  suspend fun load() { state = c.api.circle().toLoaded() }
  LaunchedEffect(Unit) { load() }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Header("The Merry Circle", nav)
    Spacer(Modifier.height(PageGap))
    Column(
      Modifier.fillMaxWidth().padding(horizontal = PagePadH),
      verticalArrangement = Arrangement.spacedBy(PageGap),
    ) {
      LoadedBlock(
        state,
        onSignIn = { nav.navigate(Routes.SIGN_IN) },
        onRetry = { scope.launch { load() } },
      ) { v ->
        // FOUR ANSWERS, FOUR SENTENCES. `balance` is null for three of them, and
        // rendering 0 for any would send somebody to buy tokens they may hold.
        when (v.why) {
          "sign-in" -> Notice(
            title = "Sign in",
            body = "Sign in to see where your wallet stands.",
            actionLabel = "Sign in",
            onAction = { nav.navigate(Routes.SIGN_IN) },
          )
          "no-wallet" -> Notice("No holder wallet linked", "Your login wallet is used unless you link another.")
          "unreadable" -> Notice(
            "Couldn't read your balance",
            "That's our chain read failing, not your wallet. " + (v.error ?: ""),
          )
          // AN UNKNOWN REASON IS NOT A SUCCESSFUL READ. `why` is a plain String
          // defaulting to "ok", so anything this build does not recognise —
          // including a reason the server adds later — used to fall through to
          // the panel below and render as a standing that had been read, with
          // "—" in Holding and `error` dropped on the floor. Four answers, four
          // sentences; the fifth gets its own.
          "ok" -> PresetCard("You") {
            Text(
              text = listOfNotNull(v.tier?.emoji, v.tier?.name).joinToString(" ").ifBlank { "—" },
              style = BodyText,
              color = MerryColors.tx,
            )
            KeyValueRow("Holding") {
              Text(
                text = v.balance?.let { grouped(it) } ?: "—",
                style = TextStyle(
                  fontFamily = numerals(FontWeight.W600),
                  fontSize = 13.sp,
                  fontWeight = FontWeight.W600,
                ),
                // The em dash is not a figure, so it does not get the figure's
                // colour — the same rule Money() follows.
                color = if (v.balance == null) MerryColors.faint else MerryColors.tx,
              )
            }
            // NO `?: 0` HERE, AND THAT IS THE POINT. This line used to read
            // "0 more to reach X" whenever the server did not send a distance,
            // which tells somebody they are already there. An unknown distance
            // means the line has nothing to say, so it does not appear.
            v.next?.let { n ->
              n.tokensToGo?.let { togo ->
                CardBlurb("${grouped(togo)} more to reach ${n.name}")
              }
            }
            v.holderAddress?.let {
              Text(
                text = breakable(it),
                style = KeyText,
                color = MerryColors.faint,
              )
            }
          }
          else -> Notice(
            "Couldn't read where you stand",
            v.error?.ifBlank { null }
              ?: "The server gave a reason this version of the app doesn't know yet (\"${v.why}\").",
          )
        }

        // The tier TABLE is public and renders in every arm — it is what makes
        // the signed-out answer useful rather than empty.
        v.tiers.forEach { t -> TierCard(t) }
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}

@Composable
private fun TierCard(t: CircleTier) {
  PresetCard(listOfNotNull(t.emoji, t.name).joinToString(" ")) {
    CardBlurb("${grouped(t.minTokens)} \$MERRYMEN")
    if (t.bonusStrategies) CardBlurb("Unlocks holder-only strategies")
    t.perks.forEach { CardBlurb("• $it") }
  }
}

// ── TELEGRAM ────────────────────────────────────────────────────────────────

/**
 * AN ANDROID-ONLY SCREEN, styled from the form vocabulary rather than invented.
 *
 * The web has no Telegram screen: `screens/Settings.tsx` exposes the bot as a
 * handful of fields inside the settings form and nothing else. So this page
 * borrows that page's furniture — `.mm-section` headings, `.rk`/`.rv` key and
 * value lines, `.mm-hint` for the caveat — instead of drawing a card style the
 * product does not have.
 */
@Composable
fun TelegramScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<TelegramStatus>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()
  suspend fun load() { state = c.api.telegram().toLoaded() }
  LaunchedEffect(Unit) { load() }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Header("Telegram", nav)
    Column(Modifier.fillMaxWidth().padding(horizontal = PagePadH)) {
      LoadedBlock(
        state,
        onSignIn = { nav.navigate(Routes.SIGN_IN) },
        onRetry = { scope.launch { load() } },
      ) { t ->
        SectionHeading("Connection")
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
          Text(
            text = when {
              !t.connected -> "Not connected"
              // "Connected as @null" states a username. "Connected" is the whole
              // truth when the server did not send one.
              t.botUsername.isNullOrBlank() -> "Connected"
              else -> "Connected as @${t.botUsername}"
            },
            style = ValueText,
            color = MerryColors.tx,
          )
          // The state sentence, kept verbatim. Every on/off control in the web's
          // settings carries one of these beside it (forms.css:45) precisely so
          // the reader never has to infer what the current position means.
          HintLine(if (t.enabled) "The bot is listening" else "Telegram is off")
          if (!t.control) HintLine("Control commands are turned off for this bot.")
        }

        SectionHeading("Claim your bot")
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
          if (t.linkCode != null) {
            Text("Send this to your bot:", style = KeyText, color = MerryColors.tx2)
            Text("/link ${t.linkCode}", style = ValueText, color = MerryColors.tx)
            HintLine(
              "The code rotates once it is used. Anyone who has it can command this agent, " +
                "so treat it like a password.",
            )
          } else if (!t.hasToken) {
            HintLine("Add a bot token first — create one with @BotFather.")
          } else {
            // Not "no code": the worker mints it on boot, so this is a wait.
            HintLine("No code yet. Your agent mints one when it next starts with this token set.")
          }
        }

        if (t.ownerId != null) {
          SectionHeading("Linked")
          Text("Owner chat ${t.ownerId}", style = ValueText, color = MerryColors.tx)
        }
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}

// ── SETTINGS ────────────────────────────────────────────────────────────────

@Composable
fun SettingsScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<SettingsEnvelope>>(Loaded.Loading) }
  var origin by remember { mutableStateOf("") }
  var gate by remember { mutableStateOf("") }
  var note by remember { mutableStateOf<String?>(null) }
  // WHETHER THE LAST THING THAT HAPPENED WENT WRONG. Purely a rendering fact:
  // it changes nothing about what is sent or decided, and exists because one
  // `note` string was carrying both "Saved." and "Couldn't reach merrymen" in
  // the same grey. forms.css keeps those two apart — `.mm-note` is `--tx-2`,
  // `.mm-danger` is `--down` — and a failure that reads like a confirmation is
  // the specific mistake this product keeps writing rules against.
  var noteBad by remember { mutableStateOf(false) }
  // Only what the owner actually touched. Starts empty and stays that way for
  // every control they do not move.
  val edits = remember { mutableStateMapOf<String, JsonElement>() }
  var dirty by remember { mutableStateOf(false) }
  var saving by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()

  LaunchedEffect(Unit) {
    origin = c.repo.originNow()
    state = c.api.settings().toLoaded()
  }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    // `.terminal-form-heading` — forms.css:9-10, at the ≤650px size. See
    // [FormHeadingText] for why this is 26sp and not the shell's 34sp.
    Column(
      Modifier
        .fillMaxWidth()
        .padding(start = PagePadH, end = PagePadH, top = PagePadTop),
    ) {
      BackControl({ nav.popBackStack() }, Modifier.padding(bottom = 14.dp))
      Text(
        text = "Settings",
        modifier = Modifier.padding(top = 8.dp, bottom = 28.dp),
        style = FormHeadingText,
        color = MerryColors.tx,
      )
    }

    Column(Modifier.fillMaxWidth().padding(horizontal = PagePadH)) {
      note?.let { if (noteBad) DangerLine(it) else NoteLine(it) }

      SectionHeading("This device")
      Column(verticalArrangement = Arrangement.spacedBy(24.dp)) {
        FormField(
          label = "Server",
          value = origin,
          onValueChange = { origin = it },
        )
        FormField(
          label = "Site password (beta)",
          value = gate,
          onValueChange = { gate = it },
          password = true,
        )
        PrimaryButton("Save and reconnect") {
          scope.launch {
            c.repo.setOrigin(origin)
            if (gate.isNotBlank()) c.repo.openGate(gate)
            note = "Saved. Reloading."
            noteBad = false
            state = c.api.settings().toLoaded()
          }
        }
      }

      LoadedBlock(state, onSignIn = { nav.navigate(Routes.SIGN_IN) }) { env ->
        SettingsForm(
          env = env,
          edits = edits,
          // Which strategies need the token, so the lock is stated where the
          // choice is made rather than discovered later.
          circleLocked = setOf("even-keel", "dip-hunter"),
          onChanged = { dirty = true },
        )
        if (env.errors.isNotEmpty()) {
          Spacer(Modifier.height(16.dp))
          Text(
            text = "The server rejected some values",
            style = FieldLabelText,
            color = MerryColors.tx,
          )
          Spacer(Modifier.height(9.dp))
          // ONE RED LINE PER ERROR, which is how the web renders them
          // (Settings.tsx:1388 — a `.mm-danger` div each, directly under Save).
          // Joining them into one paragraph loses which value was refused.
          Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            env.errors.forEach { DangerLine(it) }
          }
        }

        SectionHeading("Save")
        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
          HintLine(if (dirty) "Unsaved changes." else "Nothing changed yet.")
          PrimaryButton(
            label = if (saving) "Saving…" else "Save changes",
            enabled = dirty && !saving,
          ) {
            saving = true
            scope.launch {
              // ONLY WHAT WAS TOUCHED. Omitted fields are left alone by the
              // server; echoing a masked secret back would overwrite a key.
              when (val r = c.api.patchSettings(patchOf(edits)).toLoaded()) {
                is Loaded.Value -> {
                  if (r.value.errors.isEmpty()) {
                    edits.clear(); dirty = false; note = "Saved."; noteBad = false
                    state = c.api.settings().toLoaded()
                  } else {
                    // A rejection with nothing sayable in it is still a
                    // rejection. A blank note renders as no note at all, which
                    // looks identical to the save having never happened.
                    note = r.value.errors.filter { it.isNotBlank() }.joinToString("\n")
                      .ifBlank { "The server rejected that but did not say why." }
                    noteBad = true
                  }
                }
                is Loaded.Refused -> { note = r.message.ifBlank { "The server refused that (HTTP " + r.status + ")." }; noteBad = true }
                is Loaded.Unreachable -> {
                  note = ("Couldn't reach merrymen: " + r.cause).trim().ifBlank { "Couldn't reach merrymen." }; noteBad = true
                }
                else -> Unit
              }
              saving = false
            }
          }
        }
      }

      SectionHeading("Practice")
      Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        NoteLine(
          "Starting over restores the practice stake and clears simulated positions. " +
            "On the live rail the worker refuses it — real trades are never deleted.",
        )
        KillButton("Restart the practice book") {
          scope.launch {
            when (val r = c.api.paperReset().toLoaded()) {
              is Loaded.Value -> {
                note = "Queued. Your agent restarts the practice book on its next tick."
                noteBad = false
              }
              is Loaded.Refused -> { note = r.message.ifBlank { "The server refused that (HTTP " + r.status + ")." }; noteBad = true }
              is Loaded.Unreachable -> {
                note = ("Couldn't reach merrymen: " + r.cause).trim().ifBlank { "Couldn't reach merrymen." }; noteBad = true
              }
              else -> Unit
            }
          }
        }
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}

// ── SIGN IN ─────────────────────────────────────────────────────────────────

/**
 * Sign-in is the web app's own SIWE flow, in a WebView, because it ends in a
 * signature from the owner key — and this app deliberately does not hold one.
 * What crosses back is the session cookie and nothing else. See WebAuth.
 */
@Composable
fun SignInScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var origin by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()
  LaunchedEffect(Unit) { origin = c.repo.originNow() }

  Column(Modifier.fillMaxSize()) {
    WebHeader("Sign in", nav)
    val o = origin
    if (o == null) {
      // A LINE, NOT THE 264dp BLANK CARD. `.blank` is the designed empty state
      // for "we looked and there is nothing"; a momentary read of a local
      // setting is the web's `.hosted-note` register — a status line saying
      // which part of the page has not arrived yet.
      NoteLine(
        "Reading your server setting.",
        Modifier.padding(horizontal = PagePadH, vertical = 12.dp),
      )
    } else {
      WebFlow(
        url = WebAuth.signInUrl(o),
        origin = o,
        jar = c.cookieJar,
        onCookies = { scope.launch { c.repo.adoptWebSession() } },
        modifier = Modifier.fillMaxSize(),
      )
    }
  }
}

// ── DELEGATED SIGNATURE CEREMONIES ──────────────────────────────────────────

@Composable
fun WebFlowScreen(nav: NavHostController, path: String, title: String) {
  val c = LocalContainer.current
  var origin by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()
  LaunchedEffect(Unit) { origin = c.repo.originNow() }

  Column(Modifier.fillMaxSize()) {
    WebHeader(title.ifBlank { "merrymen" }, nav)
    val o = origin
    if (o != null) {
      WebFlow(
        url = o + path,
        origin = o,
        jar = c.cookieJar,
        onCookies = { scope.launch { c.repo.adoptWebSession() } },
        modifier = Modifier.fillMaxSize(),
      )
    }
  }
}
