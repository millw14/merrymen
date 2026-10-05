/**
 * THE OPERATOR'S SERVICE NOTICE — one fleet-wide banner, written by a person,
 * set from the web env var `MERRYMEN_SERVICE_NOTICE`.
 *
 * ── WHY AN ENV VAR AND NOT A TABLE ───────────────────────────────────────
 *
 * Every change to it is a web redeploy, so every change is an audited event
 * with an author and a time on the Railway side. Nothing a tenant can do, and
 * nothing the worker writes, reaches it. During an incident that is the point:
 * the one sentence every visitor reads is the one sentence nobody can change
 * by accident.
 *
 * ── WHAT IT IS ALLOWED TO CONTAIN ────────────────────────────────────────
 *
 * Plain text, and links to a short list of OUR OWN hosts. Nothing else:
 *
 *   - Unknown fields are refused, not dropped. A typo such as `tradingpaused`
 *     must leave the banner off and say why in the log, not render a notice
 *     whose author believes a flag is set that is not.
 *   - Text is rendered as React text nodes, so `<script>` in a title is shown
 *     as the characters `<script>`. The validator does not try to strip markup
 *     — stripping is how markup gets through — it only refuses control and
 *     bidi-override characters, which can make a rendered line read
 *     differently from the bytes the operator reviewed.
 *   - A link is `https:` on an exact host from SERVICE_NOTICE_LINK_HOSTS, with
 *     no userinfo and no port. `http:`, `javascript:`, `data:`, a look-alike
 *     suffix (`app.merrymen.dev.example`) and a trailing-dot host are all
 *     refused. Adding a host is a reviewed code change, deliberately: the env
 *     var is the notice, so it cannot also be the policy about the notice.
 *
 * ── WHAT `tradingPaused` DOES ────────────────────────────────────────────
 *
 * It changes the banner's wording, and nothing else. It is not a halt, not a
 * signal the inactivity diagnosis may read, and not evidence about any one
 * tenant — the real hold lives in the orchestrator and in
 * `fleet_recovery_health`. service-notice.test.ts pins that only the route
 * and the banner import this module, so a reader cannot quietly start
 * treating an operator's sentence as a fact about somebody's agent.
 *
 * ── WHY THIS FILE HAS NO NODE IMPORTS ────────────────────────────────────
 *
 * The banner re-validates what the route sends with the same function the
 * route used on the env var, so the browser never renders a link this file
 * would have refused — whatever sits between the two. That only works while
 * this module is safe to bundle for the client.
 */

/**
 * The hosts a notice may link to. Exact matches on the parsed hostname.
 *
 * First-party only. A notice is read by owners whose money is held, during an
 * incident; a link out of the product is a link we cannot vouch for.
 */
export const SERVICE_NOTICE_LINK_HOSTS: readonly string[] = ["merrymen.dev", "app.merrymen.dev"];

/**
 * Sizes, in UTF-16 units. A banner is a few sentences; anything larger is a
 * mistake in the env var, not a longer notice.
 */
const MAX = { raw: 8192, title: 120, body: 1000, label: 60, links: 3 } as const;

/** One link under the notice. `href` is the URL as parsed and re-serialised. */
export interface ServiceNoticeLink {
  label: string;
  href: string;
}

/** A validated notice. Every field is normalised, so equal notices are equal strings. */
export interface ServiceNotice {
  /** One line. */
  title: string;
  /** A few sentences. May contain line breaks, which the banner keeps. */
  body: string;
  /** When the operator last edited it, as `Date#toISOString`. Shown as "Updated …". */
  updatedAt: string;
  /** Changes the wording of the banner's label. Consumed by nothing else. */
  tradingPaused: boolean;
  links: ServiceNoticeLink[];
}

/** What the env var said: nothing, a notice, or something we refused and why. */
export type ServiceNoticeRead =
  | { ok: true; notice: ServiceNotice | null }
  | { ok: false; why: string };

const FIELDS = new Set(["title", "body", "updatedAt", "tradingPaused", "links"]);
const LINK_FIELDS = new Set(["label", "href"]);

/**
 * C0 and C1 controls, DEL, and the bidi embedding/override/isolate marks.
 * The body may carry a line feed; nothing else in this set is ever text.
 */
const FORBIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

/**
 * An instant with its zone written out. `2026-10-05 18:00` is refused: the
 * same string is a different moment in every reader's browser, and the one
 * thing "Updated …" must not be is ambiguous about when.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

class Refused extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function onlyFields(value: Record<string, unknown>, allowed: Set<string>, where: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Refused(`${where} has an unknown field "${key}"`);
  }
}

function text(value: unknown, field: string, max: number, multiline = false): string {
  if (typeof value !== "string") throw new Refused(`${field} must be a string`);
  // A pasted CRLF is still one line break, not a control character.
  const normalised = (multiline ? value.replace(/\r\n?/g, "\n") : value).trim();
  if (!normalised) throw new Refused(`${field} is empty`);
  if (normalised.length > max) throw new Refused(`${field} is longer than ${max} characters`);
  if (FORBIDDEN.test(normalised) || (!multiline && normalised.includes("\n"))) {
    throw new Refused(`${field} contains a control character`);
  }
  return normalised;
}

function instant(value: unknown): string {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) {
    throw new Refused("updatedAt must be an ISO-8601 time with a zone, e.g. 2026-10-05T18:00:00Z");
  }
  const ms = Date.parse(value);
  // V8 rolls "02-31" over into March rather than refusing it, so the calendar
  // date is checked on its own: a day the month does not have is a typo, and
  // showing the reader a different day from the one written is worse.
  const [y, m, d] = value.slice(0, 10).split("-").map(Number) as [number, number, number];
  const real = new Date(Date.UTC(y, m - 1, d));
  if (!Number.isFinite(ms) || real.getUTCMonth() !== m - 1 || real.getUTCDate() !== d) {
    throw new Refused("updatedAt is not a real time");
  }
  return new Date(ms).toISOString();
}

function link(value: unknown, i: number): ServiceNoticeLink {
  const where = `links[${i}]`;
  if (!isRecord(value)) throw new Refused(`${where} must be an object`);
  onlyFields(value, LINK_FIELDS, where);
  const label = text(value.label, `${where}.label`, MAX.label);
  const raw = value.href;
  // No trimming here: the URL parser forgives surrounding whitespace and
  // embedded tabs and newlines, and a link should be exactly what was written.
  if (typeof raw !== "string" || !raw || /[\s\u0000-\u001f\u007f]/.test(raw)) {
    throw new Refused(`${where}.href must be a URL with no spaces`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Refused(`${where}.href is not an absolute URL`);
  }
  if (url.protocol !== "https:") throw new Refused(`${where}.href must use https`);
  if (url.username || url.password) throw new Refused(`${where}.href must not carry a username or password`);
  if (url.port) throw new Refused(`${where}.href must not name a port`);
  if (!SERVICE_NOTICE_LINK_HOSTS.includes(url.hostname)) {
    throw new Refused(`${where}.href must point at ${SERVICE_NOTICE_LINK_HOSTS.join(" or ")}`);
  }
  return { label, href: url.href };
}

/**
 * Validate a notice-shaped value: the env var once parsed, or the route's
 * answer in the browser. Throws nothing; the reason is returned.
 */
export function checkServiceNotice(value: unknown): { ok: true; notice: ServiceNotice } | { ok: false; why: string } {
  try {
    if (!isRecord(value)) throw new Refused("the notice must be a JSON object");
    onlyFields(value, FIELDS, "the notice");
    if (value.tradingPaused !== undefined && typeof value.tradingPaused !== "boolean") {
      throw new Refused("tradingPaused must be true or false");
    }
    if (value.links !== undefined && !Array.isArray(value.links)) throw new Refused("links must be a list");
    const links = (value.links ?? []) as unknown[];
    if (links.length > MAX.links) throw new Refused(`at most ${MAX.links} links`);
    return {
      ok: true,
      notice: {
        title: text(value.title, "title", MAX.title),
        body: text(value.body, "body", MAX.body, true),
        updatedAt: instant(value.updatedAt),
        tradingPaused: value.tradingPaused === true,
        links: links.map(link),
      },
    };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, why: error.message };
    throw error;
  }
}

/**
 * The env var, read. Unset or blank is no notice — the normal state, and the
 * one the banner renders nothing for. Anything else must validate whole.
 */
export function parseServiceNotice(raw: string | undefined): ServiceNoticeRead {
  if (raw === undefined || !raw.trim()) return { ok: true, notice: null };
  if (raw.length > MAX.raw) return { ok: false, why: `longer than ${MAX.raw} characters` };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, why: "not valid JSON" };
  }
  return checkServiceNotice(value);
}

/**
 * The route's answer, as the browser should trust it: a notice that passes
 * the same check, or nothing. Never throws, so a bad answer hides the banner
 * rather than the screen under it.
 */
export function serviceNoticeFromWire(value: unknown): ServiceNotice | null {
  if (value === null || value === undefined) return null;
  const checked = checkServiceNotice(value);
  return checked.ok ? checked.notice : null;
}

/**
 * WHAT A DISMISSAL IS BOUND TO: every field of the notice, not its time.
 *
 * Keyed on `updatedAt` alone, an operator who corrected a sentence and forgot
 * the timestamp would have the correction hidden from everyone who dismissed
 * the mistake. The string itself rather than a hash of it, so "any edit" is
 * exact rather than very probable — it is a few hundred bytes of public text.
 */
export function noticeRevision(notice: ServiceNotice): string {
  return JSON.stringify([
    notice.title,
    notice.body,
    notice.updatedAt,
    notice.tradingPaused,
    notice.links.map((l) => [l.label, l.href]),
  ]);
}

/**
 * The banner's label — the whole of what `tradingPaused` means. It names the
 * state the operator says the fleet is in; it does not tell any one owner
 * what their agent did.
 */
export function noticeLabel(notice: ServiceNotice): string {
  return notice.tradingPaused ? "Trading paused" : "Service notice";
}
