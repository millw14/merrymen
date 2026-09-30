/**
 * WHICH LANGUAGE THIS READER IS IN, AND WHERE THAT ANSWER LIVES.
 *
 * ── WHY A COOKIE, AND NOT THE PLACES THAT LOOK MORE OBVIOUS ──────────────
 *
 * THE SETTINGS STORE CANNOT HOLD IT. Its PUT answers 401 without a signed-in
 * tenant, and the person this feature exists for is signed OUT — they have to
 * change language before they can read the sign-in screen. The first-visit tour
 * hit this exact wall and grew its own store because of it; see
 * `web/src/lib/tour-store.ts`.
 *
 * `localStorage` CANNOT HOLD IT EITHER, for a different reason: it is invisible
 * to the first paint. The font stack is keyed on `html[lang]`, so a locale the
 * page learns about only after hydration means a Russian or Thai reader watches
 * the page render in the wrong typeface and then reflow. A cookie is readable
 * synchronously from an inline script before the first paint.
 *
 * ── WHY NOT `cookies()` IN THE ROOT LAYOUT ───────────────────────────────
 *
 * Because `next/headers` is imported nowhere in this app today, and importing
 * it in the root layout is not a small edit: it makes the layout dynamic, and
 * every statically-rendered page under it becomes a per-request render. The
 * shell is identical for everybody apart from one attribute, so paying for a
 * dynamic render to set it is the wrong trade.
 *
 * Instead the attribute is set by a blocking inline script in `<head>`, the
 * same shape a no-flash theme switch uses. It runs before the first paint,
 * costs nothing on the server, and keeps the shell static.
 */

/**
 * The languages the product ships, in the order the picker lists them.
 *
 * A TAG PER ENTRY, not a bare language, where the region changes the answer:
 * `pt-BR` groups and punctuates differently from `pt-PT`, and `zh-CN` is
 * Simplified. Tags here are matched against `html[lang]` by the font stacks in
 * terminal.css, so adding one without a stack leaves that reader on the default
 * face — which is why `SUPPORTED` is the list both files are checked against.
 */
export const SUPPORTED = [
  { tag: "en", label: "English", endonym: "English" },
  { tag: "es", label: "Spanish", endonym: "Español" },
  { tag: "pt-BR", label: "Portuguese (Brazil)", endonym: "Português" },
  { tag: "id", label: "Indonesian", endonym: "Bahasa Indonesia" },
  { tag: "vi", label: "Vietnamese", endonym: "Tiếng Việt" },
  { tag: "tr", label: "Turkish", endonym: "Türkçe" },
  { tag: "ru", label: "Russian", endonym: "Русский" },
  { tag: "th", label: "Thai", endonym: "ไทย" },
  { tag: "zh-CN", label: "Chinese (Simplified)", endonym: "中文" },
  { tag: "ja", label: "Japanese", endonym: "日本語" },
  { tag: "ko", label: "Korean", endonym: "한국어" },
] as const;

export type LocaleTag = (typeof SUPPORTED)[number]["tag"];

export const DEFAULT_LOCALE: LocaleTag = "en";

/**
 * The cookie name. Not `__Host-` prefixed and not `HttpOnly`, deliberately:
 * the page sets this itself from script, and the server only ever reads it to
 * decide presentation. It carries no authority and identifies nobody.
 */
export const LOCALE_COOKIE = "mm_locale";

/** A year. A language preference is not a session. */
export const LOCALE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Resolve any tag a browser might offer to one we actually ship.
 *
 * MATCHES ON THE LANGUAGE SUBTAG, so `pt`, `pt-PT` and `pt-br` all reach
 * `pt-BR` — the alternative is a Brazilian reader whose browser says `pt-br`
 * falling through to English because of a capital letter. An exact match wins
 * first, so `zh-CN` beats a bare `zh` prefix rule.
 */
export function normalizeLocale(raw: string | null | undefined): LocaleTag | null {
  if (!raw) return null;
  const want = raw.trim().toLowerCase();
  if (!want) return null;
  const exact = SUPPORTED.find((l) => l.tag.toLowerCase() === want);
  if (exact) return exact.tag;
  const base = want.split("-")[0]!;
  const byLanguage = SUPPORTED.find((l) => l.tag.toLowerCase().split("-")[0] === base);
  return byLanguage?.tag ?? null;
}

/**
 * The best supported language from an `Accept-Language` header or from
 * `navigator.languages`, honouring quality values.
 *
 * Returns null rather than the default when nothing matches, because "we could
 * not tell" and "they chose English" are different facts — the first should
 * leave the picker un-set so a later visit can still guess better.
 */
export function negotiateLocale(offered: readonly string[] | string | null): LocaleTag | null {
  if (!offered) return null;
  const list = typeof offered === "string"
    ? offered
        .split(",")
        .map((part) => {
          const [tag, ...params] = part.trim().split(";");
          const q = params.find((p) => p.trim().startsWith("q="));
          return { tag: tag!.trim(), q: q ? Number(q.split("=")[1]) : 1 };
        })
        .filter((e) => Number.isFinite(e.q) && e.q > 0)
        .sort((a, b) => b.q - a.q)
        .map((e) => e.tag)
    : [...offered];
  for (const tag of list) {
    const hit = normalizeLocale(tag);
    if (hit) return hit;
  }
  return null;
}

/**
 * The script that runs before the first paint.
 *
 * Kept here, beside the rules it implements, rather than inline in the layout —
 * a cookie name and a tag list written twice drift, and the direction they
 * drift in is a reader whose font never switches.
 *
 * It is deliberately tiny and total: any failure leaves the document exactly as
 * the server rendered it, which is English. Nothing here can break the page.
 */
export function localeBootScript(): string {
  const tags = SUPPORTED.map((l) => l.tag);
  return `(function(){try{
var S=${JSON.stringify(tags)};
var m=document.cookie.match(/(?:^|;\\s*)${LOCALE_COOKIE}=([^;]*)/);
var want=m?decodeURIComponent(m[1]):null;
if(!want){var n=(navigator.languages||[navigator.language||""]);for(var i=0;i<n.length&&!want;i++){
var c=String(n[i]).toLowerCase();for(var j=0;j<S.length;j++){
if(S[j].toLowerCase()===c||S[j].toLowerCase().split("-")[0]===c.split("-")[0]){want=S[j];break;}}}}
if(!want)return;
for(var k=0;k<S.length;k++){if(S[k].toLowerCase()===String(want).toLowerCase()){
document.documentElement.lang=S[k];return;}}
}catch(e){}})();`;
}

/** Read the current language on the client. Falls back to the default. */
export function currentLocale(): LocaleTag {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  return normalizeLocale(document.documentElement.lang) ?? DEFAULT_LOCALE;
}

/**
 * Choose a language.
 *
 * THE RELOAD IS THE POINT, not laziness. The font stack is CSS and switches the
 * instant the attribute moves, but the figures are not: `displayLocale()` is
 * read inside plain functions — `live.ts`, `status-line.ts`, `chat-commands.ts`
 * — that React has no way to re-run, and `Intl` formatters are memoised per
 * locale. Moving the attribute alone would give a page in one language with its
 * money still grouped in another, which is the exact confusion this whole piece
 * of work exists to remove.
 *
 * A language change is a deliberate, rare act, and nothing on this screen is
 * unsaved: state comes from the chain and the server. So the honest move is to
 * change it everywhere at once rather than in the half we can reach cheaply.
 *
 * The attribute is set first so the fonts are already right in the frame before
 * the navigation starts, and the cookie is written first of all so that a
 * blocked reload still leaves the choice recorded for the next visit.
 */
export function setLocale(tag: LocaleTag): void {
  if (typeof document === "undefined") return;
  const before = normalizeLocale(document.documentElement.lang);
  try {
    document.cookie =
      `${LOCALE_COOKIE}=${encodeURIComponent(tag)};path=/;max-age=${LOCALE_MAX_AGE};samesite=lax`;
  } catch {
    // A blocked cookie is not a reason to refuse the change for this page.
  }
  document.documentElement.lang = tag;
  // Nothing to re-render if they picked the language they were already in.
  if (before === tag) return;
  try {
    window.location.reload();
  } catch {
    // Left in the new language for this page either way.
  }
}
