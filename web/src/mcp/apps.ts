/**
 * MCP Apps views: optional rich rendering for the answers owners read most
 * (portfolio, "why hasn't it traded?", a token, a trade proposal).
 *
 * Every tool already answers in text and structured JSON; a host that speaks
 * the MCP Apps extension (io.modelcontextprotocol/ui, spec 2026-01-26) can
 * instead show one of these pages in a sandboxed iframe and hand it the tool
 * result over postMessage. Hosts that do not speak it ignore the `_meta` and
 * nothing changes.
 *
 * What the pages are and are not allowed to be:
 *  - Pure presentation. The HTML holds no data and needs no capability; the
 *    data arrives from the host as the tool result the owner's own call
 *    produced. That is why the resources declare `capability: null`.
 *  - Self-contained: inline CSS and JS only, no network, fonts, images or
 *    frames. The resource `_meta` declares an empty CSP (every domain list
 *    empty) and each page carries its own CSP meta tag as well.
 *  - Every value from a tool result is untrusted: it is rendered with
 *    textContent and createElement only, never parsed as markup, and text a
 *    third party wrote (token names, stored explanations, notes) is visibly
 *    marked as such.
 *  - Read-only. A view sends only the handshake, its size and — when the owner
 *    clicks the approval link — a request to open it. It never calls a tool,
 *    even though the protocol would let it, so no view can place, cancel or
 *    approve anything.
 *
 * The handshake is written by hand against the spec (the SDK's App class
 * would pull a bundler and zod into the page): the view sends `ui/initialize`,
 * the host answers with its capabilities and context, the view sends
 * `ui/notifications/initialized`, and the host then delivers
 * `ui/notifications/tool-input` and `ui/notifications/tool-result`.
 */
import { mcpConfig } from "./config";
import type { ResourceDef } from "./resources";
import type { ToolDef } from "./tool";

/** MIME type the extension defines for a view (RESOURCE_MIME_TYPE in @modelcontextprotocol/ext-apps). */
export const MCP_APP_MIME = "text/html;profile=mcp-app";
/** The extension's id, as clients advertise it under capabilities.extensions. */
export const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";
/** Pre-`_meta.ui` key some hosts still read (RESOURCE_URI_META_KEY); the SDK's registerAppTool sets both. */
export const LEGACY_RESOURCE_URI_META_KEY = "ui/resourceUri";
/** The Apps protocol version the views announce in ui/initialize. */
export const APPS_PROTOCOL_VERSION = "2026-01-26";

export type AppView = "portfolio" | "decision" | "token" | "proposal";

export const APP_VIEW_URI: Readonly<Record<AppView, string>> = {
  portfolio: "ui://merrymen/portfolio.html",
  decision: "ui://merrymen/decision.html",
  token: "ui://merrymen/token.html",
  proposal: "ui://merrymen/proposal.html",
};

/** Which view renders which tool's result. */
export const APP_VIEW_OF_TOOL: Readonly<Record<string, AppView>> = {
  get_portfolio: "portfolio",
  get_performance: "portfolio",
  explain_agent_inactivity: "decision",
  get_decision: "decision",
  get_token: "token",
  check_token_eligibility: "token",
  search_tokens: "token",
  quote_trade: "proposal",
  propose_trade: "proposal",
  get_proposal: "proposal",
};

/**
 * Who may call a tool that has a view (McpUiToolMeta.visibility). The spec's
 * default is ["model", "app"], which would let a view ask the host to call the
 * tool. No view here ever calls a tool, so the tools declare the model only:
 * a host then refuses a tools/call that comes from a view.
 */
export const APP_TOOL_VISIBILITY: readonly ("model" | "app")[] = Object.freeze(["model"] as const);

function toolMeta(view: AppView): Record<string, unknown> {
  const uri = APP_VIEW_URI[view];
  return { ui: { resourceUri: uri, visibility: [...APP_TOOL_VISIBILITY] }, [LEGACY_RESOURCE_URI_META_KEY]: uri };
}

/**
 * The `_meta` each tool needs for a host to attach its view: the current
 * `ui.resourceUri` and the legacy flat key, and model-only visibility. CSP
 * belongs on the resource, not the tool.
 */
export const APP_TOOL_META: Readonly<Record<string, Record<string, unknown>>> = Object.fromEntries(
  Object.entries(APP_VIEW_OF_TOOL).map(([tool, view]) => [tool, toolMeta(view)]),
);

/**
 * Resource `_meta` (McpUiResourceMeta): every CSP list empty, which the spec
 * maps to no connect, resource, frame or base-uri origins at all. Hosts read
 * it from the resources/read content item, with the resources/list entry as
 * fallback. `prefersBorder` because the cards are designed to sit in a frame.
 */
export const APP_RESOURCE_META: Readonly<Record<string, unknown>> = {
  ui: {
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
    prefersBorder: true,
  },
};

/**
 * The tools with their view attached. Returns new objects; existing `_meta`
 * (and any other `ui` keys) are kept, and a visibility the tool declares
 * itself wins over the model-only default. Tools without a view are returned
 * as is.
 */
export function withAppMeta<T extends ToolDef>(tools: readonly T[]): T[] {
  return tools.map((t) => {
    // Own keys only: a tool named like an Object.prototype member gets no view.
    if (!Object.prototype.hasOwnProperty.call(APP_TOOL_META, t.name)) return t;
    const add = APP_TOOL_META[t.name]!;
    const addUi = add.ui as { resourceUri: string; visibility: string[] };
    const current = t.meta ?? {};
    const currentUi = current.ui && typeof current.ui === "object" && !Array.isArray(current.ui) ? current.ui as Record<string, unknown> : {};
    const ui = { visibility: [...addUi.visibility], ...currentUi, resourceUri: addUi.resourceUri };
    return { ...t, meta: { ...current, [LEGACY_RESOURCE_URI_META_KEY]: addUi.resourceUri, ui } };
  });
}

// ── styles ──────────────────────────────────────────────────────────────────

// Host variables (McpUiStyleVariableKey) win when the host sends them; the
// fallbacks follow prefers-color-scheme unless the host names a theme.
const LIGHT = `--mm-bg:var(--color-background-primary,#ffffff);--mm-bg2:var(--color-background-secondary,#f4f5f7);
--mm-fg:var(--color-text-primary,#16181c);--mm-fg2:var(--color-text-secondary,#5a606b);--mm-border:var(--color-border-primary,#dcdfe5);
--mm-ok:var(--color-text-success,#17692f);--mm-ok-bg:var(--color-background-success,#e3f3e8);
--mm-warn:var(--color-text-warning,#8a5a00);--mm-warn-bg:var(--color-background-warning,#fff3d1);
--mm-bad:var(--color-text-danger,#a8221a);--mm-bad-bg:var(--color-background-danger,#fde8e6);
--mm-info:var(--color-text-info,#1d56ad);--mm-info-bg:var(--color-background-info,#e6eefb);
--mm-live:#a84600;--mm-live-bg:#fff0e3;--mm-paper:#3949ab;--mm-paper-bg:#eceffb;--mm-ut-bg:#f7f3ff;--mm-ut:#5b3fa6;`;
const DARK = `--mm-bg:var(--color-background-primary,#15171b);--mm-bg2:var(--color-background-secondary,#1d2026);
--mm-fg:var(--color-text-primary,#e9ebef);--mm-fg2:var(--color-text-secondary,#a2a8b3);--mm-border:var(--color-border-primary,#343944);
--mm-ok:var(--color-text-success,#6fd08c);--mm-ok-bg:var(--color-background-success,#173222);
--mm-warn:var(--color-text-warning,#f2c14e);--mm-warn-bg:var(--color-background-warning,#3a2e10);
--mm-bad:var(--color-text-danger,#ff8a80);--mm-bad-bg:var(--color-background-danger,#3d1a18);
--mm-info:var(--color-text-info,#8ab4ff);--mm-info-bg:var(--color-background-info,#17264a);
--mm-live:#ffab66;--mm-live-bg:#3a2412;--mm-paper:#9fa8ff;--mm-paper-bg:#1f2447;--mm-ut-bg:#241d36;--mm-ut:#c3b0ff;`;

const CSS = `:root{color-scheme:light dark;${LIGHT}
--mm-font:var(--font-sans,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);
--mm-mono:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);--mm-radius:var(--border-radius-md,8px)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}}
:root[data-theme=dark]{color-scheme:dark;${DARK}}
:root[data-theme=light]{color-scheme:light}
*{box-sizing:border-box}
html,body{margin:0;background:var(--mm-bg);color:var(--mm-fg);font:14px/1.45 var(--mm-font)}
main{padding:12px;max-width:980px}
h1{font-size:17px;margin:0 0 2px}h2{font-size:15px;margin:0 0 8px}h3{font-size:13px;margin:12px 0 6px;color:var(--mm-fg2);text-transform:uppercase;letter-spacing:.04em}
p{margin:6px 0}ul{margin:4px 0;padding-left:18px}
.hd{margin-bottom:10px}.small{font-size:12px}.muted{color:var(--mm-fg2)}
.mono{font-family:var(--mm-mono);font-size:12px;word-break:break-all}
.missing{color:var(--mm-fg2);font-style:italic}
.card{border:1px solid var(--mm-border);border-radius:var(--mm-radius);padding:12px;margin:0 0 10px;background:var(--mm-bg)}
.books{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}
.book{border-left-width:5px}.book.live{border-left-color:var(--mm-live);border-left-style:solid}
.book.paper{border-left-color:var(--mm-paper);border-left-style:dashed;background:var(--mm-bg2)}
.book-hd{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.big{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
dl.grid{display:grid;grid-template-columns:minmax(110px,max-content) 1fr;gap:3px 12px;margin:8px 0}
dl.grid dt{color:var(--mm-fg2)}dl.grid dd{margin:0;font-variant-numeric:tabular-nums;min-width:0;overflow-wrap:anywhere}
.chip{display:inline-block;border-radius:999px;padding:0 8px;font-size:11px;font-weight:600;line-height:18px;margin:0 4px 0 0;white-space:nowrap}
.chip.ok{color:var(--mm-ok);background:var(--mm-ok-bg)}.chip.warn{color:var(--mm-warn);background:var(--mm-warn-bg)}
.chip.bad{color:var(--mm-bad);background:var(--mm-bad-bg)}.chip.unk{color:var(--mm-fg2);background:var(--mm-bg2)}
.chip.info{color:var(--mm-info);background:var(--mm-info-bg)}.chip.live{color:var(--mm-live);background:var(--mm-live-bg)}
.chip.paper{color:var(--mm-paper);background:var(--mm-paper-bg)}
.banner{border-radius:var(--mm-radius);padding:8px 12px;margin:0 0 10px;font-size:13px}
.banner.live{background:var(--mm-live-bg);color:var(--mm-live);border:2px solid var(--mm-live)}
.banner.paper{background:var(--mm-paper-bg);color:var(--mm-paper);border:2px dashed var(--mm-paper)}
.banner.unk,.banner.info{background:var(--mm-bg2);color:var(--mm-fg);border:1px solid var(--mm-border)}
.warnbox{border:1px solid var(--mm-warn);background:var(--mm-warn-bg);color:var(--mm-fg);border-radius:var(--mm-radius);padding:8px 12px;margin:0 0 10px}
.wb-title{font-weight:600;color:var(--mm-warn)}
.errbox{border:1px solid var(--mm-bad);background:var(--mm-bad-bg);border-radius:var(--mm-radius);padding:8px 12px}
.warn-text{color:var(--mm-warn)}
.untrusted{border:1px dashed var(--mm-ut);background:var(--mm-ut-bg);border-radius:6px;padding:6px 8px;margin:6px 0}
.ut-label{font-size:11px;color:var(--mm-ut);font-weight:600}.ut-text{white-space:pre-wrap;overflow-wrap:anywhere}
.ut-inline{border-bottom:1px dotted var(--mm-ut)}.ut-inline::after{content:" (unverified)";font-size:10px;color:var(--mm-ut)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
th{text-align:left;font-weight:600;color:var(--mm-fg2);border-bottom:1px solid var(--mm-border);padding:4px 6px}
td{border-bottom:1px solid var(--mm-border);padding:4px 6px;vertical-align:top;overflow-wrap:anywhere}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.bars{display:flex;align-items:flex-end;gap:1px;height:44px;margin:8px 0 2px;background:var(--mm-bg2);border-radius:4px;padding:2px}
.bars i{flex:1;background:var(--mm-info);min-height:1px;border-radius:1px}
.check{border-top:1px solid var(--mm-border);padding:8px 0}.check:first-of-type{border-top:0}
.check-hd{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}
details summary{cursor:pointer;color:var(--mm-fg2);font-size:12px}
ol.timeline{list-style:none;padding:0;margin:8px 0;display:flex;flex-wrap:wrap;gap:6px}
.step{padding:4px 10px;border-radius:999px;font-size:12px;border:1px solid var(--mm-border);color:var(--mm-fg2)}
.step.done{color:var(--mm-ok);border-color:var(--mm-ok);background:var(--mm-ok-bg)}
.step.current{color:var(--mm-info);border-color:var(--mm-info);background:var(--mm-info-bg);font-weight:600}
.step.failed{color:var(--mm-bad);border-color:var(--mm-bad);background:var(--mm-bad-bg);font-weight:600}
a.cta{display:inline-block;padding:8px 14px;border-radius:var(--mm-radius);background:var(--mm-info);color:var(--mm-bg);font-weight:600;text-decoration:none}
a.cta:focus-visible{outline:2px solid var(--mm-fg);outline-offset:2px}
.notes{margin-top:12px;border-top:1px solid var(--mm-border);padding-top:6px}
.notice{color:var(--mm-fg2);padding:8px 0}`;

// ── the bridge and DOM helpers every view shares ────────────────────────────
//
// Written as plain browser JS inside String.raw so regex escapes survive.
// It must never contain a backtick or a dollar-brace (the template would eat
// them), nor a closing script tag.

const RUNTIME = String.raw`
var root = document.getElementById("app");
var parentWin = window.parent;
var embedded = !!parentWin && parentWin !== window;
var UNKNOWN = "not known";
var nextId = 1;
var pending = Object.create(null);
var hostCaps = {};
var hostCtx = Object.create(null);
var initialized = false;
var rendered = false;
var sizeQueued = false;
var lastW = -1;
var lastH = -1;
var observer = null;
var locale = undefined;
var timeZone = undefined;
// Every Unicode control (Cc, C1 included) and format character (Cf: bidi
// marks and isolates, zero-width characters, tags) and lone surrogates (Cs)
// but tab and line feed, the
// same classes the server's untrusted() strips. Any spelling of a line break
// becomes a line feed first.
var LINE_BREAKS = /\r\n?|[\p{Zl}\p{Zp}]/gu;
var CTRL = /(?![\t\n])[\p{Cc}\p{Cf}\p{Cs}]/gu;

function has(map, key) { return typeof key === "string" && Object.prototype.hasOwnProperty.call(map, key); }
function pick(map, key, fallback) { return has(map, key) ? map[key] : fallback; }
function obj(v) { return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null; }
function arr(v, max) { return Array.isArray(v) ? v.slice(0, max || 100) : []; }
function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }
function clean(v, max) {
  if (typeof v !== "string") return null;
  var s = v.replace(LINE_BREAKS, "\n").replace(CTRL, "").trim();
  if (!s) return null;
  var cap = max || 400;
  return s.length > cap ? s.slice(0, cap).replace(/\p{Cs}$/u, "") + "…" : s;
}
function str(v, max) { return clean(v, max); }
function human(v) { var s = clean(v, 80); return s ? s.replace(/_/g, " ") : null; }

// ── wire ──
function post(msg) { try { parentWin.postMessage(msg, "*"); } catch (e) { /* host gone */ } }
function request(method, params, cb) {
  var id = nextId++;
  pending[String(id)] = cb || null;
  post({ jsonrpc: "2.0", id: id, method: method, params: params });
}
function notify(method, params) {
  var m = { jsonrpc: "2.0", method: method };
  if (params !== undefined) m.params = params;
  post(m);
}
function reply(id, result) { post({ jsonrpc: "2.0", id: id, result: result }); }
function replyError(id, code, message) { post({ jsonrpc: "2.0", id: id, error: { code: code, message: message } }); }

function onMessage(ev) {
  // Only the host that framed us speaks; anything else is ignored unread.
  if (ev.source !== parentWin) return;
  var m = ev.data;
  if (!obj(m) || m.jsonrpc !== "2.0") return;
  if (typeof m.method === "string") {
    if (m.id !== undefined && m.id !== null) onRequest(m);
    else onNotification(m.method, m.params);
    return;
  }
  var key = typeof m.id === "number" || typeof m.id === "string" ? String(m.id) : null;
  if (key === null || !Object.prototype.hasOwnProperty.call(pending, key)) return;
  var cb = pending[key];
  delete pending[key];
  if (!cb) return;
  if (obj(m.error)) cb(m.error, null);
  else if (m.result !== undefined) cb(null, m.result);
  else cb({ code: -32603, message: "empty response" }, null);
}

function onRequest(m) {
  if (m.method === "ping") return reply(m.id, {});
  if (m.method === "ui/resource-teardown") { stopWatching(); return reply(m.id, {}); }
  // This view offers no tools and takes no other requests.
  replyError(m.id, -32601, "Method not found");
}

function onNotification(method, params) {
  if (method === "ui/notifications/tool-result") return onResult(params);
  if (method === "ui/notifications/tool-input") { if (!rendered) notice("Waiting for the result…"); return; }
  if (method === "ui/notifications/tool-cancelled") { if (!rendered) notice("The call was cancelled, so there is nothing to show."); return; }
  if (method === "ui/notifications/host-context-changed") return mergeContext(params);
}

// ── host context: theme, style variables, locale ──
function mergeContext(ctx) {
  var c = obj(ctx);
  if (!c) return;
  for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k) && k !== "__proto__") hostCtx[k] = c[k];
  var de = document.documentElement;
  if (hostCtx.theme === "dark" || hostCtx.theme === "light") {
    de.setAttribute("data-theme", hostCtx.theme);
    de.style.colorScheme = hostCtx.theme;
  }
  var styles = obj(hostCtx.styles);
  var vars = styles ? obj(styles.variables) : null;
  if (vars) {
    for (var name in vars) {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) continue;
      var val = vars[name];
      if (!/^--[a-z0-9-]{1,64}$/.test(name) || typeof val !== "string" || val.length > 200) continue;
      // Values only: nothing that could load a resource or open a new rule.
      if (/url\s*\(|src\s*\(|image\s*\(|image-set|expression|[@;{}<>\\]/i.test(val)) continue;
      de.style.setProperty(name, val);
    }
  }
  if (typeof hostCtx.locale === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,4}$/.test(hostCtx.locale)) locale = hostCtx.locale;
  if (typeof hostCtx.timeZone === "string" && /^[A-Za-z0-9_+\-\/]{1,64}$/.test(hostCtx.timeZone)) timeZone = hostCtx.timeZone;
}

// ── size ──
// lastW === -2 marks a torn-down view: it reports nothing more.
function queueSize() {
  if (!initialized || sizeQueued || lastW === -2) return;
  sizeQueued = true;
  var run = function () { sizeQueued = false; sendSize(); };
  if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(run); else setTimeout(run, 16);
}
function sendSize() {
  if (lastW === -2) return;
  var de = document.documentElement;
  var prev = de.style.height;
  de.style.height = "max-content";
  var height = Math.ceil(de.getBoundingClientRect().height);
  de.style.height = prev;
  var width = Math.ceil(window.innerWidth);
  if (width === lastW && height === lastH) return;
  lastW = width;
  lastH = height;
  notify("ui/notifications/size-changed", { width: width, height: height });
}
function watchSize() {
  queueSize();
  if (typeof ResizeObserver === "function") {
    observer = new ResizeObserver(queueSize);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
  } else {
    window.addEventListener("resize", queueSize);
  }
  root.addEventListener("toggle", queueSize, true);
}
function stopWatching() {
  if (observer) observer.disconnect();
  observer = null;
  window.removeEventListener("resize", queueSize);
  lastW = -2;
}

// ── results ──
function textOf(content) {
  var items = arr(content, 20);
  for (var i = 0; i < items.length; i++) {
    var c = obj(items[i]);
    if (c && c.type === "text" && typeof c.text === "string") return c.text;
  }
  return null;
}
function parseText(content) {
  // Our text fallback is "summary\n\n{json}" or bare JSON.
  var t = textOf(content);
  if (t === null || t.length > 2000000) return null;
  var at = t.charAt(0) === "{" ? 0 : t.indexOf("\n\n{");
  if (at < 0) return null;
  try { return obj(JSON.parse(at === 0 ? t : t.slice(at + 2))); } catch (e) { return null; }
}
function onResult(params) {
  var r = obj(params);
  if (!r) return notice("No result arrived.");
  if (r.isError === true) return showError(r);
  var data = obj(r.structuredContent) || parseText(r.content);
  if (!data) return notice("This result has nothing this view can show; the text answer has it.");
  clear(root);
  var ok = false;
  try { ok = render(data) !== false; } catch (e) { ok = false; }
  if (!ok) {
    clear(root);
    notice("This view does not recognise the result; the text answer has it.");
  } else {
    rendered = true;
  }
  queueSize();
}
function showError(r) {
  clear(root);
  var box = put(root, "div", "errbox");
  put(box, "strong", null, "The tool returned an error.");
  var sc = obj(r.structuredContent);
  var err = sc ? obj(sc.error) : null;
  var msg = (err && clean(err.message, 400)) || clean(textOf(r.content), 400);
  if (msg) put(box, "p", null, msg);
  var code = err ? clean(err.code, 40) : null;
  if (code) put(box, "p", "small muted", "Code: " + code);
  rendered = true;
  queueSize();
}

// ── DOM ──
function h(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}
function put(parent, tag, cls, text) { var e = h(tag, cls, text); parent.appendChild(e); return e; }
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function notice(text) { clear(root); put(root, "p", "notice", text); queueSize(); }
function header(title, sub) {
  var hd = put(root, "header", "hd");
  put(hd, "h1", null, title);
  if (sub) put(hd, "div", "small muted", sub);
  return hd;
}
function section(parent, title, cls) {
  var s = put(parent, "section", cls ? "card " + cls : "card");
  if (title) put(s, "h2", null, title);
  return s;
}
var TONES = { ok: 1, warn: 1, bad: 1, unk: 1, info: 1, live: 1, paper: 1 };
function chip(text, tone) { return h("span", "chip " + (has(TONES, tone) ? tone : "unk"), text); }
function mono(text) { return h("span", "mono", text === null || text === undefined ? UNKNOWN : text); }
function grid(parent) { return put(parent, "dl", "grid"); }
function cellInto(target, value) {
  if (value === null || value === undefined || value === "") put(target, "span", "missing", UNKNOWN);
  else if (typeof value === "object" && value.nodeType) target.appendChild(value);
  else target.appendChild(document.createTextNode(String(value)));
}
function row(dl, label, value, extra) {
  put(dl, "dt", null, label);
  var dd = put(dl, "dd");
  cellInto(dd, value);
  if (extra && typeof extra === "object" && extra.nodeType) { dd.appendChild(document.createTextNode(" ")); dd.appendChild(extra); }
  else if (typeof extra === "string" && extra) put(dd, "div", "small muted", extra);
  return dd;
}
function bullets(parent, list, max, cls) {
  var items = arr(list, max || 20).map(function (x) { return clean(x, 600); }).filter(Boolean);
  if (!items.length) return null;
  var ul = put(parent, "ul", cls || null);
  items.forEach(function (t) { put(ul, "li", null, t); });
  return ul;
}
function warnings(parent, list, title) {
  var items = arr(list, 20).map(function (x) { return clean(x, 600); }).filter(Boolean);
  if (!items.length) return;
  var box = put(parent, "div", "warnbox");
  put(box, "div", "wb-title", title || "Warnings");
  var ul = put(box, "ul");
  items.forEach(function (t) { put(ul, "li", null, t); });
}
function table(parent, headers, rows, more) {
  var wrap = put(parent, "div", "scroll");
  var t = put(wrap, "table");
  var tr = put(put(t, "thead"), "tr");
  headers.forEach(function (x) { put(tr, "th", x.num ? "num" : null, x.label); });
  var tb = put(t, "tbody");
  rows.forEach(function (r) {
    var line = put(tb, "tr");
    r.forEach(function (cell, i) { cellInto(put(line, "td", headers[i] && headers[i].num ? "num" : null), cell); });
  });
  if (more > 0) put(parent, "p", "small muted", "+" + more + " more not shown.");
  return t;
}
function untrustedBox(parent, label, text, max) {
  var box = put(parent, "div", "untrusted");
  put(box, "div", "ut-label", (label ? label + " · " : "") + "third-party text, shown as data");
  var t = clean(text, max || 1200);
  if (t) put(box, "div", "ut-text", t); else put(box, "div", "missing", "none recorded");
  return box;
}
function utInline(text, trusted) {
  var t = clean(text, 64);
  if (t === null) return h("span", "missing", "no label");
  var s = h("span", trusted ? null : "ut-inline", t);
  if (!trusted) s.setAttribute("title", "Written by a third party (e.g. the token's creator); not verified");
  return s;
}
function nodes() {
  var span = h("span");
  for (var i = 0; i < arguments.length; i++) {
    var n = arguments[i];
    if (n === null || n === undefined) continue;
    if (span.firstChild) span.appendChild(document.createTextNode(" "));
    if (typeof n === "object" && n.nodeType) span.appendChild(n); else span.appendChild(document.createTextNode(String(n)));
  }
  return span;
}
function notes(list) {
  var items = list.map(function (x) { return clean(x, 900); }).filter(Boolean);
  if (!items.length) return;
  var f = put(root, "footer", "notes small muted");
  items.forEach(function (t) { put(f, "p", null, t); });
}

// ── formatting: a missing figure reads "not known", never 0 ──
function fmtNum(n, opts) {
  try { return new Intl.NumberFormat(locale, opts).format(n); } catch (e) { return String(n); }
}
function fmt(v, dp) {
  var n = num(v);
  if (n === null) return null;
  n = n + 0; // -0 reads as 0
  var d = dp === undefined ? 2 : dp;
  // A non-zero figure smaller than the decimals shown keeps two significant
  // digits: 0.004 USDG of gas is not "0 USDG".
  if (n !== 0 && Math.abs(n) < Math.pow(10, -d)) return fmtNum(n, { maximumSignificantDigits: 2 });
  return fmtNum(n, { maximumFractionDigits: d });
}
function money(v) { var s = fmt(v, 2); return s === null ? null : s + " USDG"; }
function signedMoney(v) { var n = num(v); if (n === null) return null; return (n > 0 ? "+" : "") + money(n); }
function usdPrice(v) {
  var n = num(v);
  if (n === null) return null;
  return "$" + fmtNum(n + 0, { maximumSignificantDigits: 6 });
}
function usd(v) { var s = fmt(v, 0); return s === null ? null : "$" + s; }
function pct(v, signed) { var n = num(v); if (n === null) return null; return (signed && n > 0 ? "+" : "") + fmt(n, 2) + "%"; }
function bps(v) { var s = fmt(v, 0); return s === null ? null : s + " bps"; }
function count(v) { var s = fmt(v, 0); return s === null ? UNKNOWN : s; }
function yesNo(v) { return v === true ? "yes" : v === false ? "no" : null; }
function dur(s) {
  if (s < 90) return s + " s";
  if (s < 5400) return Math.round(s / 60) + " min";
  if (s < 172800) return Math.round(s / 3600) + " h";
  return Math.round(s / 86400) + " d";
}
function when(v) {
  if (typeof v !== "string") return null;
  var t = Date.parse(v);
  if (!isFinite(t)) return null;
  var text;
  try { text = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: timeZone }).format(new Date(t)); }
  catch (e) { text = new Date(t).toISOString(); }
  var s = Math.round((Date.now() - t) / 1000);
  return text + (s >= 0 ? " (" + dur(s) + " ago)" : " (in " + dur(-s) + ")");
}
function shortAddr(v) {
  var s = clean(v, 80);
  if (!s) return null;
  if (!/^0x[0-9a-fA-F]{40,64}$/.test(s)) return s;
  var e = mono(s.slice(0, 6) + "…" + s.slice(-4));
  e.setAttribute("title", s);
  return e;
}

function boot() {
  if (!root) return;
  if (!embedded) { notice("This page shows Merrymen tool results inside an app that supports MCP Apps. There is nothing to show here."); return; }
  window.addEventListener("message", onMessage);
  request("ui/initialize", {
    appInfo: { name: "merrymen-" + VIEW, version: "1.0.0" },
    appCapabilities: {},
    protocolVersion: "__PROTOCOL__"
  }, function (err, result) {
    if (err || !obj(result)) { if (!rendered) notice("The app did not start this view. The text answer has the same information."); return; }
    hostCaps = obj(result.hostCapabilities) || {};
    mergeContext(result.hostContext);
    initialized = true;
    notify("ui/notifications/initialized");
    watchSize();
  });
  setTimeout(function () { if (!initialized && !rendered) notice("Waiting for the app to start this view…"); }, 10000);
}
`;

// ── portfolio.html: get_portfolio and get_performance ──────────────────────

const PORTFOLIO_JS = String.raw`
var BOOK_ORDER = ["live", "paper"];
var BOOK_LABEL = { live: "Live · real funds", paper: "Paper · simulated money" };

function render(d) {
  var books = obj(d.books);
  if (!books) return false;
  if (typeof d.period === "string" || typeof d.window_start === "string") renderPerformance(d, books);
  else renderPortfolio(d, books);
  return true;
}

function bookHead(card, key, isCurrent) {
  var hd = put(card, "div", "book-hd");
  put(hd, "h2", null, BOOK_LABEL[key]);
  if (isCurrent) hd.appendChild(chip("current book", key));
}

function renderPortfolio(d, books) {
  var agent = str(d.agent, 40);
  header("Portfolio", agent ? "Agent " + agent : null);
  var cur = pick({ live: "live", paper: "paper" }, d.current_book, null);
  var top = put(root, "div");
  var p = put(top, "p");
  p.appendChild(cur ? chip(cur === "live" ? "Current book: live" : "Current book: paper", cur) : chip("Current book: not known", "unk"));
  var mode = str(d.agent_mode, 20);
  if (mode) p.appendChild(document.createTextNode(" Worker reports: " + mode + "."));
  var why = str(d.current_book_why, 400);
  if (why) put(top, "p", "small muted", why);
  warnings(root, d.warnings);
  var wrap = put(root, "div", "books");
  BOOK_ORDER.forEach(function (key) { bookCard(wrap, key, obj(books[key]), cur === key); });
  notes([d.books_note, d.custody_note, d.untrusted_note, d.observed_at ? "Observed " + (when(d.observed_at) || UNKNOWN) + "." : null]);
}

function bookCard(parent, key, b, isCurrent) {
  var card = section(parent, null, "book " + key);
  bookHead(card, key, isCurrent);
  if (!b) { put(card, "p", "missing", "No data for this book."); return; }
  var v = obj(b.valuation);
  if (!v) {
    put(card, "p", "missing", str(b.positions_note, 300) || "This book has never been valued.");
  } else {
    put(card, "div", "big", money(v.equity_usdg) || UNKNOWN);
    put(card, "div", "small muted", "Equity");
    var g = grid(card);
    var fresh = v.fresh === true ? chip("fresh", "ok") : v.fresh === false ? chip("stale", "warn") : chip("freshness not known", "unk");
    row(g, "Valued", when(v.valuation_time), fresh);
    row(g, "Cash", money(v.cash_usdg));
    row(g, "Savings", money(v.savings_usdg), "Morpho savings vault");
    row(g, "Positions", money(v.positions_usdg));
    row(g, "Other", money(v.other_usdg), str(v.other_explained, 300));
    var gas = obj(v.gas_balance);
    row(g, "Gas ETH", gas && num(gas.eth) !== null ? fmt(gas.eth, 6) + " ETH" : null, gas ? str(gas.note, 200) : null);
    row(g, "Account", shortAddr(v.account));
  }
  put(card, "h3", null, "Holdings");
  if (!Array.isArray(b.positions)) {
    put(card, "p", "small muted", str(b.positions_note, 400) || "Holdings are not listed for this book.");
  } else if (!b.positions.length) {
    put(card, "p", "small muted", "No holdings.");
  } else {
    var ps = arr(b.positions, 100);
    table(card, [
      { label: "Token" }, { label: "Value", num: true }, { label: "Price", num: true }, { label: "Cost", num: true }, { label: "Unrealized P&L", num: true },
    ], ps.map(function (x) {
      var q = obj(x) || {};
      var price = usdPrice(q.price_usd);
      var priceCell = price === null ? h("span", "missing", "no price") : q.price_stale === true ? nodes(price, chip("stale", "warn")) : price;
      var pnl = signedMoney(q.unrealized_pnl_usdg);
      var pnlCell = pnl === null ? h("span", "missing", str(q.pnl_missing_why, 140) || UNKNOWN) : nodes(pnl, pct(q.unrealized_pnl_pct, true));
      return [nodes(utInline(q.symbol, false), shortAddr(q.token)), money(q.value_usdg), priceCell, money(q.cost_usdg), pnlCell];
    }), b.positions.length - ps.length);
  }
  var cv = arr(b.class_vault_positions, 50);
  if (cv.length) {
    put(card, "h3", null, "Class-vault launch tokens (carried at cost)");
    table(card, [{ label: "Token" }, { label: "State" }, { label: "Cost", num: true }, { label: "Opened" }], cv.map(function (x) {
      var c = obj(x) || {};
      return [nodes(utInline(c.symbol, false), shortAddr(c.token)), human(c.state), money(c.cost_usdg), when(c.opened_at)];
    }), (b.class_vault_positions.length || 0) - cv.length);
  }
  var t = obj(b.totals);
  if (t) {
    put(card, "h3", null, "Totals");
    var tg = grid(card);
    row(tg, "Holdings value", money(t.positions_value_usdg));
    row(tg, "Cost", money(t.cost_usdg));
    row(tg, "Unrealized P&L", signedMoney(t.unrealized_pnl_usdg), "Only holdings with a fresh price and a known cost");
    if (num(t.holdings_without_pnl)) row(tg, "Without P&L", count(t.holdings_without_pnl), "holding(s) whose P&L is not known");
  }
}

function bars(parent, series) {
  var pts = arr(series, 200).map(function (p) { var o = obj(p); return o ? num(o.equity_usdg) : null; }).filter(function (v) { return v !== null; });
  if (pts.length < 2) return;
  // The low and high are of every point, not of the thinned bars, so the
  // stated figures are never those of a sample.
  var lo = Math.min.apply(null, pts);
  var hi = Math.max.apply(null, pts);
  var step = Math.ceil(pts.length / 60);
  var s = [];
  for (var i = 0; i < pts.length; i += step) s.push(pts[i]);
  if ((pts.length - 1) % step !== 0) s.push(pts[pts.length - 1]);
  var span = hi - lo;
  var box = put(parent, "div", "bars");
  box.setAttribute("role", "img");
  box.setAttribute("aria-label", "Equity over the window, from " + money(s[0]) + " to " + money(s[s.length - 1]));
  s.forEach(function (v) {
    var b = put(box, "i");
    b.style.height = (span > 0 ? Math.round(6 + 94 * (v - lo) / span) : 50) + "%";
  });
  put(parent, "div", "small muted", "Equity: low " + money(lo) + ", high " + money(hi));
}

function renderPerformance(d, books) {
  var bits = [str(d.agent, 40) ? "Agent " + str(d.agent, 40) : null, human(d.period)].filter(Boolean);
  header("Performance", bits.join(" · ") || null);
  put(root, "p", "small muted", "Window: " + (when(d.window_start) || UNKNOWN) + " to " + (when(d.window_end) || UNKNOWN));
  var wrap = put(root, "div", "books");
  BOOK_ORDER.forEach(function (key) {
    var card = section(wrap, null, "book " + key);
    bookHead(card, key, false);
    var b = obj(books[key]);
    if (!b) { put(card, "p", "missing", "No data for this book."); return; }
    if (b.has_valuation === false) put(card, "p", "missing", "This book has never been valued.");
    else if (b.valued_in_window === false) put(card, "p", "missing", "No valuation of this book in the window.");
    put(card, "div", "big", signedMoney(b.change_usdg) || UNKNOWN);
    put(card, "div", "small muted", "Change over the window");
    bars(card, b.series);
    var g = grid(card);
    var st = obj(b.start);
    var en = obj(b.end);
    var run = obj(b.measured_run);
    if (run) row(g, "Measured run", shortAddr(run.account), num(run.epoch) !== null ? "accounting epoch " + count(run.epoch) : null);
    row(g, "Start equity", st ? money(st.equity_usdg) : null, st ? when(st.at) : null);
    row(g, "End equity", en ? money(en.equity_usdg) : null, en ? when(en.at) : null);
    row(g, "Net deposits", signedMoney(b.net_flows_usdg), key === "paper" ? "The paper book has no deposits." : null);
    row(g, "Excluding flows", signedMoney(b.change_excluding_flows_usdg));
    row(g, "Return", pct(b.return_pct, true));
    row(g, "Max drawdown", pct(b.max_drawdown_pct));
    var rs = num(b.realized_sells_counted);
    row(g, "Realized P&L", signedMoney(b.realized_pnl_usdg), rs !== null ? count(rs) + " sell(s) counted, " + count(b.realized_sells_excluded) + " excluded (unevidenced)" : null);
    row(g, "Fees accrued", money(b.fees_accrued_usdg));
    // A total that leaves operations out is a floor, and says so; null is "not known", never 0.
    var gasVal = money(b.gas_usdg);
    var gasNotes = [];
    if (num(b.gas_unpriced_ops)) gasNotes.push(count(b.gas_unpriced_ops) + " operation(s) with unpriced gas");
    if (num(b.gas_unrecorded_ops)) gasNotes.push(count(b.gas_unrecorded_ops) + " operation(s) with no gas record");
    row(g, "Gas", gasVal !== null && b.gas_complete === false ? "at least " + gasVal : gasVal, gasNotes.length ? gasNotes.join("; ") : null);
    var at = obj(b.attribution);
    if (at) {
      put(card, "h3", null, "What explains the change");
      if (at.available === true) {
        var ag = grid(card);
        row(ag, "Trading", signedMoney(at.trading_usdg));
        row(ag, "Flows", signedMoney(at.flows_usdg));
        row(ag, "Unexplained", signedMoney(at.unattributed_usdg), "Never counted as trading");
      } else {
        put(card, "p", "small muted", str(at.why_unavailable, 300) || "Not available for this window.");
      }
    }
    var ops = obj(b.ops);
    if (ops) {
      put(card, "h3", null, "Operations");
      put(card, "p", "small", key === "live"
        ? count(ops.confirmed) + " confirmed, " + count(ops.submitted) + " submitted (not confirmed), " + count(ops.failed) + " failed, " + count(ops.landed_without_tx_hash) + " landed without a hash"
        : count(ops.paper_fills) + " paper fill(s), " + count(ops.paper_refused) + " refused");
    }
    var cv = arr(b.caveats, 12);
    if (cv.length) { put(card, "h3", null, "Caveats"); bullets(card, cv, 12, "small"); }
  });
  var refused = num(d.refused_ops);
  notes([refused !== null ? count(refused) + " refused operation(s) in the window; they filled nothing in either book." : null, d.books_note,
    d.observed_at ? "Observed " + (when(d.observed_at) || UNKNOWN) + "." : null]);
}
`;

// ── decision.html: explain_agent_inactivity and get_decision ───────────────

const DECISION_JS = String.raw`
var STATUS_TONE = { ok: "ok", warning: "warn", blocking: "bad", unknown: "unk" };
var STATUS_WORD = { ok: "ok", warning: "warning", blocking: "blocking", unknown: "unknown" };
var CATEGORY = {
  permission: "Permission", worker_liveness: "Worker running", live_rail: "Live trading rail", funding: "Funding",
  settings_consent: "Settings and consent", paused: "Pause", market_data: "Market data", provider: "Model provider",
  model_holds: "Model holds", policy_refusals: "Policy refusals", quote_failures: "Quote failures",
  execution_failures: "Execution failures", data_freshness: "Data freshness", none: "Nothing blocking", unknown: "Unknown"
};
var OUTCOME_TONE = {
  confirmed: "ok", paper_fill: "paper", landed_without_tx_hash: "warn", submitted_unconfirmed: "warn", reverted: "bad",
  rejected: "bad", dropped: "warn", hold: "unk", view: "unk", no_trade_recorded: "unk"
};

function render(d) {
  if (obj(d.primary_cause) && Array.isArray(d.checks)) { renderInactivity(d); return true; }
  if (obj(d.decision)) { renderDecision(d); return true; }
  return false;
}

function category(v) { return pick(CATEGORY, v, human(v) || UNKNOWN); }

function scalars(parent, label, rec) {
  var o = obj(rec);
  if (!o) return;
  var keys = Object.keys(o).slice(0, 12);
  if (!keys.length) return;
  var line = put(parent, "div", "small");
  put(line, "span", "muted", label + ": ");
  line.appendChild(document.createTextNode(keys.map(function (k) {
    var v = o[k];
    var shown = typeof v === "string" ? clean(v, 80) : typeof v === "number" ? fmt(v, 4) : typeof v === "boolean" ? String(v) : null;
    return (human(k) || "?") + " " + (shown === null ? UNKNOWN : shown);
  }).join(" · ")));
}

function renderInactivity(d) {
  var agent = str(d.agent, 40);
  var hours = num(d.window_hours);
  header("Why hasn't it traded?", [agent ? "Agent " + agent : null, hours !== null ? "last " + count(hours) + " h" : null].filter(Boolean).join(" · ") || null);
  var checks = arr(d.checks, 30).map(obj).filter(Boolean);
  var p = obj(d.primary_cause) || {};
  var primaryCheck = checks.filter(function (c) { return c.category === p.category; })[0];
  var tone = p.kind === "trading" || p.category === "none" ? "ok" : primaryCheck ? pick(STATUS_TONE, primaryCheck.status, "warn") : "warn";
  var card = section(root, null, "primary");
  var hd = put(card, "div", "check-hd");
  hd.appendChild(chip(category(p.category), tone));
  put(hd, "strong", null, human(p.kind) || UNKNOWN);
  put(card, "p", null, str(p.summary, 600) || "No summary recorded.");
  if (p.since) put(card, "p", "small muted", "Since " + (when(p.since) || UNKNOWN));
  bullets(card, p.evidence, 10, "small");

  var todo = arr(d.what_owner_can_do, 12);
  if (todo.length) { var t = section(root, "What you can do"); bullets(t, todo, 12); }

  var cs = section(root, "Checks");
  checks.forEach(function (c) {
    var box = put(cs, "div", "check");
    var line = put(box, "div", "check-hd");
    line.appendChild(chip(pick(STATUS_WORD, c.status, "unknown"), pick(STATUS_TONE, c.status, "unk")));
    put(line, "strong", null, category(c.category));
    if (c.kind) put(line, "span", "small muted", human(c.kind));
    put(box, "div", null, str(c.summary, 500) || "");
    var ev = arr(c.evidence, 8);
    var cando = arr(c.what_owner_can_do, 6);
    var o = obj(c.observed);
    if (ev.length || cando.length || (o && Object.keys(o).length) || c.recorded_at) {
      var det = put(box, "details");
      put(det, "summary", null, "Evidence");
      scalars(det, "Observed", c.observed);
      scalars(det, "Threshold", c.threshold);
      if (c.recorded_at) put(det, "div", "small muted", "Recorded " + (when(c.recorded_at) || UNKNOWN));
      if (c.since) put(det, "div", "small muted", "Since " + (when(c.since) || UNKNOWN));
      bullets(det, ev, 8, "small");
      if (cando.length) { put(det, "div", "small", "What you can do:"); bullets(det, cando, 6, "small"); }
    }
  });

  var dw = obj(d.decisions_in_window);
  var fw = obj(d.fills_in_window);
  var act = section(root, "Activity in the window");
  var g = grid(act);
  if (dw) {
    row(g, "Decisions", count(dw.total), count(dw.buys) + " buy, " + count(dw.sells) + " sell, " + count(dw.model_holds) + " model hold, " + count(dw.gate_forced_holds) + " gate-forced hold, " + count(dw.proposals_dropped) + " dropped");
    if (num(dw.brain_shadow_decisions)) row(g, "Shadow runs", count(dw.brain_shadow_decisions), "Watched only, never sent as orders");
    row(g, "Last decision", when(dw.last_at));
  }
  if (fw) row(g, "Fills", count(fw.live_confirmed) + " live confirmed, " + count(fw.paper) + " paper", num(fw.submitted_unresolved) ? count(fw.submitted_unresolved) + " submitted and not yet resolved" : null);
  var lt = obj(d.last_trade);
  if (lt) {
    var live = obj(lt.live);
    row(g, "Last live trade", live ? when(live.at) : "none on record", live ? (live.confirmed === true ? chip("confirmed", "ok") : chip("not confirmed", "warn")) : null);
    var paper = obj(lt.paper);
    row(g, "Last paper fill", paper ? when(paper.at) : "none on record");
  }
  var cyc = obj(d.last_successful_cycle);
  if (cyc) {
    var cb = cyc.book === "live" || cyc.book === "paper" ? chip(cyc.book === "live" ? "live book" : "paper book", cyc.book) : chip("book not known", "unk");
    row(g, "Last valuation", when(cyc.at), cb);
    var meaning = str(cyc.meaning, 300);
    if (meaning) put(act, "p", "small muted", meaning);
  }
  var refusals = arr(d.refusals_in_window, 12).map(obj).filter(Boolean);
  if (refusals.length) {
    put(act, "h3", null, "Refused or reverted");
    table(act, [{ label: "Rule" }, { label: "Count", num: true }, { label: "What you can do" }, { label: "Last" }], refusals.map(function (r) {
      return [str(r.label, 160) || str(r.rule, 60), count(r.count), str(r.remedy, 300), when(r.last_at)];
    }), 0);
  }
  var lv = obj(d.latest_view);
  if (lv && lv.stored_explanation) {
    put(act, "h3", null, "The agent's latest stored explanation");
    untrustedBox(act, "Stored by the agent " + (when(lv.at) || ""), lv.stored_explanation, 600);
  }
  var unknown = arr(d.unknown_from_shared_records, 10);
  if (unknown.length) { var u = section(root, "Only the agent's own machine knows"); bullets(u, unknown, 10, "small"); }
  var tr = obj(d.truncated);
  var cut = tr && (tr.trades === true || tr.events === true) ? "Some records were beyond the scan limit; counts are lower bounds." : null;
  notes([cut, d.data_source, d.untrusted_note, d.observed_at ? "Observed " + (when(d.observed_at) || UNKNOWN) + "." : null]);
}

function ruleBlock(parent, r) {
  var rule = obj(r);
  if (!rule) return;
  var g = grid(parent);
  row(g, "Rule", str(rule.label, 200) || str(rule.key, 60), human(rule.family));
  if (rule.remedy) row(g, "What you can do", str(rule.remedy, 400));
  if (rule.detail_untrusted) untrustedBox(parent, "Rule detail", rule.detail_untrusted, 200);
  if (rule.detail_withheld === true) put(parent, "p", "small muted", "Raw error detail is withheld here.");
}

function renderDecision(d) {
  var x = obj(d.decision) || {};
  var agent = str(d.agent, 40);
  header("Decision " + (human(x.action) || "view"), [agent ? "Agent " + agent : null, when(x.at)].filter(Boolean).join(" · ") || null);
  var o = obj(x.outcome) || {};
  var oc = section(root, "What happened");
  var hd = put(oc, "div", "check-hd");
  hd.appendChild(chip(human(o.category) || UNKNOWN, pick(OUTCOME_TONE, o.category, "unk")));
  if (o.book === "live" || o.book === "paper") hd.appendChild(chip(o.book === "live" ? "live · real funds" : "paper · simulated", o.book));
  put(oc, "p", null, str(o.explained, 400) || "");
  var g = grid(oc);
  row(g, "Confirmed", yesNo(o.confirmed), "Only a landed trade with a transaction hash counts");
  if (o.status) row(g, "Ledger status", human(o.status));
  if (o.tx_hash) row(g, "Transaction", mono(str(o.tx_hash, 80)));
  if (o.at) row(g, "At", when(o.at));
  ruleBlock(oc, o.rule);

  var dc = section(root, "The decision");
  var dg = grid(dc);
  row(dg, "Token", x.symbol || x.display_name ? nodes(utInline(x.symbol, false), x.display_name ? utInline(x.display_name, false) : null) : null);
  row(dg, "Proposed size", money(x.size_usdg), "What the decision proposed, not a fill");
  row(dg, "Mark", usdPrice(x.mark_usd));
  row(dg, "Market cap", usd(x.mcap_usd));
  row(dg, "Source", str(x.source, 80) || str(x.strategy, 80), [str(x.provider, 60), str(x.model, 80)].filter(Boolean).join(" · ") || null);
  var hold = obj(x.hold);
  if (hold) row(dg, "Hold", human(hold.kind), str(hold.explained, 300));
  var drop = obj(x.dropped);
  if (drop) {
    row(dg, "Dropped", str(drop.label, 200) || human(drop.kind));
    if (drop.rule_text_untrusted) untrustedBox(dc, "Rule text", drop.rule_text_untrusted, 200);
  }
  put(dc, "h3", null, "Stored explanation");
  untrustedBox(dc, "Written by the model or strategy when it decided", x.stored_explanation, 800);
  if (x.stored_explanation_withheld) put(dc, "p", "small muted", str(x.stored_explanation_withheld, 300));

  var ev = obj(x.evidence);
  if (ev) {
    var es = section(root, "Evidence");
    [["Stored evidence", ev.evidence], ["Inputs it decided on", ev.signals_subset]].forEach(function (pair) {
      var view = obj(pair[1]);
      if (!view) return;
      put(es, "h3", null, pair[0]);
      if (view.state !== "ok") { put(es, "p", "small muted", "Not available (" + (human(view.state) || UNKNOWN) + ")."); return; }
      var entries = arr(view.entries, 60).map(obj).filter(Boolean);
      if (!entries.length) { put(es, "p", "small muted", "None recorded."); return; }
      table(es, [{ label: "Key" }, { label: "Value" }], entries.map(function (e) {
        var v = e.value;
        var cell = typeof v === "string" ? utInline(v, false) : typeof v === "number" ? fmt(v, 6) : typeof v === "boolean" ? String(v) : null;
        return [str(e.key, 80), cell];
      }), 0);
      if (view.truncated === true) put(es, "p", "small muted", "Truncated.");
    });
  }

  var lc = obj(d.lifecycle);
  var trades = lc ? arr(lc.trades, 30).map(obj).filter(Boolean) : [];
  if (trades.length) {
    var ls = section(root, "Trades attached to this decision");
    table(ls, [{ label: "At" }, { label: "Status" }, { label: "Book" }, { label: "Amount", num: true }, { label: "Fill", num: true }, { label: "Realized P&L", num: true }], trades.map(function (t) {
      var book = t.book === "live" || t.book === "paper" ? chip(t.book, t.book) : h("span", "missing", "no book");
      var status = nodes(human(t.status) || UNKNOWN, t.confirmed === true ? chip("confirmed", "ok") : null);
      var pnl = signedMoney(t.realized_pnl_usdg);
      return [when(t.at), status, book, money(t.amount_usdg), money(t.fill_cash_usdg), pnl === null ? null : nodes(pnl, t.realized_pnl_measured === true ? null : chip("estimate", "warn"))];
    }), 0);
  }
  var post = lc ? obj(lc.post) : null;
  if (post) { var ps = section(root, "What the agent posted"); untrustedBox(ps, when(post.at) || "", post.body_untrusted, 400); }
  notes([d.figures_note, d.explanation_note, d.data_source, d.observed_at ? "Observed " + (when(d.observed_at) || UNKNOWN) + "." : null]);
}
`;

// ── token.html: get_token, search_tokens and check_token_eligibility ────────

const TOKEN_JS = String.raw`
var VERDICT_TONE = { yes: "ok", no: "bad", unknown: "unk" };
var CHECK_TONE = { pass: "ok", fail: "bad", unknown: "unk", not_applicable: "unk" };
var FLAG_TEXT = {
  impersonates_trusted_ticker: "This label copies a trusted ticker, but at a different address. It is not that asset.",
  duplicate_symbol: "Another address uses the same ticker. Identify this token by its address."
};

function render(d) {
  if (Array.isArray(d.results)) { renderSearch(d); return true; }
  if (obj(d.settings_used) && Array.isArray(d.checks)) { renderEligibility(d); return true; }
  if (typeof d.address === "string" && (obj(d.price) || obj(d.discoverable))) { renderToken(d); return true; }
  return false;
}

function identity(parent, d) {
  var line = put(parent, "div", "check-hd");
  line.appendChild(utInline(d.symbol, d.symbol_trusted === true));
  if (d.name !== undefined) line.appendChild(utInline(d.name, d.name_trusted === true));
  if (d.kind) line.appendChild(chip(human(d.kind), "info"));
  if (d.stock_kind) line.appendChild(chip(human(d.stock_kind), "info"));
  put(parent, "div", "mono", str(d.address, 80) || UNKNOWN);
  flags(parent, d.flags);
}

function flags(parent, list) {
  var fs = arr(list, 4).filter(function (f) { return has(FLAG_TEXT, f); });
  if (fs.length) warnings(parent, fs.map(function (f) { return FLAG_TEXT[f]; }), "Identity warning");
}

function verdicts(parent, d, keys) {
  var g = grid(parent);
  keys.forEach(function (k) {
    var v = obj(d[k[0]]);
    var state = v ? v.state : null;
    var dd = row(g, k[1], chip(pick({ yes: "yes", no: "no", unknown: "unknown" }, state, "unknown"), pick(VERDICT_TONE, state, "unk")));
    if (v) bullets(dd, v.reasons, 4, "small");
  });
}
var THREE = [["discoverable", "Discoverable"], ["priceable", "Priceable"], ["executable", "Executable"]];

function factRow(g, label, f, format) {
  var o = obj(f);
  if (!o) return row(g, label, null);
  var shown = format(o.value);
  if (shown === null) return row(g, label, h("span", "missing", UNKNOWN + (o.missing_reason ? " — " + clean(o.missing_reason, 160) : "")));
  return row(g, label, shown, str(o.source, 60));
}

function renderToken(d) {
  header("Token", null);
  var id = section(root, null);
  identity(id, d);
  var vc = section(root, "Can it be found, priced and traded?");
  verdicts(vc, d, THREE);
  var pr = obj(d.price) || {};
  var mk = section(root, "Market");
  var g = grid(mk);
  var p = usdPrice(pr.value);
  if (p === null) row(g, "Price", h("span", "missing", UNKNOWN + (pr.missing_reason ? " — " + clean(pr.missing_reason, 200) : "")));
  else row(g, "Price", p, [str(pr.source, 60), pr.observed_at ? "observed " + when(pr.observed_at) : null, pr.updated_at ? "round " + when(pr.updated_at) : null].filter(Boolean).join(" · "));
  factRow(g, "Liquidity", d.liquidity_usd, usd);
  factRow(g, "Volume 24h", d.volume_24h_usd, usd);
  factRow(g, "Change 24h", d.change_24h_pct, function (v) { return pct(v, true); });
  factRow(g, "Holders", d.holders, function (v) { return fmt(v, 0); });
  factRow(g, "Buyers 24h", d.buyers_24h, function (v) { return fmt(v, 0); });
  factRow(g, "FDV", d.fdv_usd, usd);
  factRow(g, "Age", d.age_days, function (v) { var s = fmt(v, 1); return s === null ? null : s + " days"; });
  var tape = arr(d.tape, 8).map(obj).filter(Boolean);
  if (tape.length) {
    put(mk, "h3", null, "Tape");
    table(mk, [{ label: "Window" }, { label: "Change", num: true }, { label: "Volume", num: true }, { label: "Buys", num: true }, { label: "Sells", num: true }], tape.map(function (t) {
      return [str(t.window, 12), pct(t.change_pct, true), usd(t.volume_usd), fmt(t.buys, 0), fmt(t.sells, 0)];
    }), 0);
  }
  var pool = obj(d.pool);
  if (pool) {
    put(mk, "h3", null, "Pool");
    var pg = grid(mk);
    row(pg, "Venue", str(pool.venue, 64), pool.on_curve === true ? "on the launch curve" : pool.graduated === true ? "graduated" : null);
    row(pg, "Pool id", shortAddr(pool.pool_id));
    if (pool.label) row(pg, "Label", utInline(pool.label, false));
    if (pool.note) put(mk, "p", "small muted", str(pool.note, 300));
  }
  var st = obj(d.stock);
  if (st) {
    put(mk, "h3", null, "Stock token");
    var sg = grid(mk);
    row(sg, "Price feed", yesNo(st.has_feed));
    row(sg, "Halted", yesNo(st.paused));
  }
  warnings(root, d.warnings);
  notes([d.untrusted_note, d.served_at ? "Served " + (when(d.served_at) || UNKNOWN) + "." : null]);
}

function renderSearch(d) {
  var total = num(d.total_matches);
  header("Token search", total !== null ? count(total) + " match(es)" : null);
  warnings(root, d.warnings);
  var idx = obj(d.index);
  if (idx && idx.reachable === false) put(root, "p", "warn-text", "The market index could not be read; only the registry and your own tokens were searched.");
  var results = arr(d.results, 25).map(obj).filter(Boolean);
  if (!results.length) put(root, "p", "notice", "No token matched.");
  results.forEach(function (r) {
    var card = section(root, null);
    identity(card, r);
    var g = grid(card);
    row(g, "Price", usdPrice(r.price_usd));
    row(g, "Liquidity", usd(r.reserve_usd));
    row(g, "Volume 24h", usd(r.volume_24h_usd));
    var src = arr(r.sources, 4).map(human).filter(Boolean);
    row(g, "Listed by", src.length ? src.join(", ") : null, r.matched_on ? "matched on " + human(r.matched_on) : null);
    if (r.watchlist_label) row(g, "Your label", utInline(r.watchlist_label, false));
    verdicts(card, r, THREE.slice(0, 2));
  });
  var dup = arr(d.symbol_groups, 20).map(obj).filter(function (x) { return x && x.duplicate === true; });
  if (dup.length) {
    var s = section(root, "Tickers shared by several addresses");
    dup.forEach(function (x) {
      var line = put(s, "div", "check");
      line.appendChild(utInline(x.symbol_key, false));
      put(line, "div", "small", count(arr(x.addresses, 50).length) + " address(es), " + count(arr(x.trusted_addresses, 50).length) + " vouched for by Merrymen or you");
    });
  }
  notes([d.next_cursor ? "More results exist: ask for the next page." : null, d.untrusted_note]);
}

function renderEligibility(d) {
  var agent = str(d.agent, 40);
  header("Could the agent trade it?", agent ? "Agent " + agent : null);
  var book = pick({ live: "live", paper: "paper" }, d.book, "unk");
  var b = put(root, "div", "banner " + book);
  put(b, "strong", null, book === "live" ? "Live book: a buy would use real funds." : book === "paper" ? "Paper book: a buy would be a simulated fill." : "The agent's current book is " + (human(d.book) || UNKNOWN) + ".");
  var id = section(root, null);
  identity(id, d);
  var vc = section(root, "Verdict");
  verdicts(vc, d, THREE);
  var checks = arr(d.checks, 40).map(obj).filter(Boolean);
  if (checks.length) {
    var cs = section(root, "Checks");
    table(cs, [{ label: "Check" }, { label: "Result" }, { label: "Detail" }], checks.map(function (c) {
      return [human(c.check), chip(pick({ pass: "pass", fail: "fail", unknown: "unknown", not_applicable: "n/a" }, c.result, "unknown"), pick(CHECK_TONE, c.result, "unk")), str(c.detail, 400)];
    }), 0);
  }
  var s = obj(d.settings_used);
  if (s) {
    var ss = section(root, "Settings it used");
    var g = grid(ss);
    row(g, "Asset mode", human(s.asset_mode), s.asset_mode_defaulted === true ? "default" : null);
    row(g, "Basket", count(arr(s.basket, 200).length) + " token(s)", s.basket_defaulted === true ? "default" : null);
    row(g, "Min liquidity", money(s.min_pool_liquidity_usdg));
    row(g, "Max divergence", bps(s.max_price_divergence_bps));
    row(g, "Scout", s.scout_enabled === true ? "on" : s.scout_enabled === false ? "off" : null, money(s.scout_budget_usdg));
    row(g, "Launch buying", s.launch_buying_enabled === true ? "on" : s.launch_buying_enabled === false ? "off" : null);
    row(g, "Permission covers", human(s.grant_tradable_set));
  }
  bullets(root, d.notes, 10, "small muted");
  notes([d.untrusted_note, d.observed_at ? "Observed " + (when(d.observed_at) || UNKNOWN) + "." : null]);
}
`;

// ── proposal.html: quote_trade, propose_trade and get_proposal ─────────────

const PROPOSAL_JS = String.raw`
var STATUS_TEXT = {
  awaiting_approval: "Waiting for the owner to approve it in Merrymen.",
  approved: "Approved; being handed to the agent.",
  submitted: "Queued for the agent; it has not picked it up yet.",
  executing: "The agent picked it up and is executing (or waiting for the chain's receipt).",
  filled_awaiting_ledger: "The agent reported a fill; waiting for the ledger to record it before calling it confirmed.",
  confirmed: "Confirmed on chain: the receipt and the recorded fill agree.",
  paper_filled: "Filled in the practice (paper) book. No real money moved.",
  refused: "The agent's limits, policy or the on-chain permission refused it. Nothing was traded.",
  failed: "It did not complete, or its outcome could not be confirmed. See the result.",
  expired: "It expired without running. Nothing was sent.",
  cancelled: "Cancelled. Nothing was sent.",
  rejected: "The owner declined it.",
  applied: "Approved and applied."
};
var STATUS_TONE = {
  awaiting_approval: "info", approved: "info", submitted: "info", executing: "info", filled_awaiting_ledger: "info",
  confirmed: "ok", paper_filled: "paper", applied: "ok", refused: "bad", failed: "bad", expired: "unk", cancelled: "unk", rejected: "unk"
};
var FAIL_TEXT = { rejected: "Declined", cancelled: "Cancelled", expired: "Expired", refused: "Refused", failed: "Failed" };
var KIND_TEXT = { settings: "a change to the agent's settings", agent_draft: "a draft agent setup", post: "a post in the group chat" };
var KNOWN_SUMMARY = {
  action: 1, token: 1, book: 1, book_note: 1, expected_out: 1, min_out: 1, price_impact_bps: 1, assistant_note: 1, requested_by: 1,
  text: 1, diff: 1, settings: 1, after_approval: 1, risk_level: 1
};
// Keys resultBlock renders itself (or, worker_line, never: a raw worker line
// is no longer sent, and would not be shown if it were).
var RESULT_SKIP = {
  worker_line: 1, notes: 1, agent_said_untrusted: 1, outcome_unknown: 1, simulated_because: 1,
  rule: 1, rule_family: 1, rule_label: 1, rule_remedy: 1, rule_detail_withheld: 1
};

function render(d) {
  if (typeof d.proposal_id === "string") { renderProposal(d); return true; }
  if (typeof d.quoted === "boolean") { renderQuote(root, d, true); return true; }
  return false;
}

// An approval link is linked only when it is exactly this server's approval
// page for this proposal: same origin as the configured issuer, the fixed
// path, no credentials, query or fragment.
function approvalLink(raw, id) {
  if (!ISSUER || typeof raw !== "string" || raw.length > 400 || typeof id !== "string" || !/^prp_[0-9a-f]{32}$/.test(id)) return null;
  var u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.origin !== ISSUER || u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== "/connect/approve/" + id) return null;
  return { href: u.href, host: u.host };
}

function openViaHost(url, statusEl) {
  if (!initialized || !obj(hostCaps.openLinks)) return false;
  request("ui/open-link", { url: url }, function (err, res) {
    if (err || (obj(res) && res.isError === true)) statusEl.textContent = "Your app did not open the link. Copy the address below into a browser.";
  });
  return true;
}

function valueText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return clean(v, 300);
  if (typeof v === "number") return fmt(v, 6);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v) && v.every(function (x) { return typeof x === "string" || typeof x === "number"; })) {
    return clean(v.slice(0, 30).map(function (x) { return typeof x === "number" ? fmt(x, 6) : clean(x, 40); }).filter(Boolean).join(", "), 300);
  }
  try { return clean(JSON.stringify(v), 300); } catch (e) { return null; }
}

// The book a trade actually used, when its outcome proves it: a confirmation
// or a fill with a transaction hash went on chain (live); a paper fill moved
// no money. The book in the summary is only the agent's mode when proposed.
function outcomeBook(status, res) {
  if (status === "confirmed" || status === "filled_awaiting_ledger") return "live";
  if (status === "paper_filled") return "paper";
  if (status === "failed" && res && typeof res.tx_hash === "string" && res.tx_hash) return "live";
  return null;
}

// A reject rule as a result states it (services/proposals.ts ruleFields): the
// label, family and remedy are Merrymen's own words; the slug came through
// the agent's worker, so it stays marked as third-party text.
function ruleRows(g, r, title) {
  var slug = typeof r.rule === "string" ? utInline(r.rule, false) : null;
  var label = str(r.rule_label, 200);
  if (!label && !slug) return;
  row(g, title, label ? nodes(label, slug) : slug, human(r.rule_family));
  if (r.rule_remedy) row(g, "What you can do", str(r.rule_remedy, 400));
  if (r.rule_detail_withheld === true) row(g, "Rule detail", "withheld: it was provider text, which is never relayed");
}

function resultBlock(parent, res) {
  var g = grid(parent);
  // Not "it failed": no record that is clearly this order's arrived in time.
  if (res.outcome_unknown === true) row(g, "Outcome", "outcome not confirmed — check your trades");
  Object.keys(res).filter(function (k) { return !has(RESULT_SKIP, k); }).slice(0, 30).forEach(function (k) {
    var v = res[k];
    if (k === "tx_hash") row(g, "Transaction", v === null || v === undefined ? null : mono(str(v, 80)));
    else if (k === "usdg_actual") row(g, "USDG moved", money(v));
    else if (k === "fill_qty_raw") row(g, "Filled (raw token units)", v === null || v === undefined ? null : mono(str(v, 80)));
    else if (k === "order_expires_at") row(g, "Order window closes", whenSec(v));
    else if (k === "duplicate") row(g, "Already queued", yesNo(v));
    else row(g, human(k) || "?", valueText(v));
  });
  ruleRows(g, res, "Rule");
  var sim = obj(res.simulated_because);
  if (sim) ruleRows(g, sim, "Why it was simulated");
  // The agent's own sentence (cut of provider text, but still the agent's words).
  if (typeof res.agent_said_untrusted === "string") untrustedBox(parent, "The agent's own report", res.agent_said_untrusted, 300);
  if (Array.isArray(res.notes) && res.notes.length) { put(parent, "h3", null, "Checked at approval"); bullets(parent, res.notes, 10, "small"); }
}

function whenSec(v) {
  var n = num(v);
  if (n === null) return null;
  var t = new Date(n * 1000);
  return isFinite(t.getTime()) ? when(t.toISOString()) : null;
}

var DRAFT_LABEL = { agentName: "Agent name", strategy: "Strategy", basketSymbols: "Basket", assetMode: "Asset mode" };
function draftSettings(parent, rec) {
  var o = obj(rec);
  if (!o) return;
  put(parent, "h3", null, "Settings it would save");
  var g = grid(parent);
  Object.keys(o).slice(0, 30).forEach(function (k) {
    // The name is the assistant's suggestion; the rest are checked values.
    row(g, pick(DRAFT_LABEL, k, human(k) || "?"), k === "agentName" ? utInline(o[k], false) : valueText(o[k]));
  });
}

function generic(parent, rec, skip) {
  var o = obj(rec);
  if (!o) return;
  var keys = Object.keys(o).filter(function (k) { return !(skip && has(skip, k)); }).slice(0, 30);
  if (!keys.length) return;
  var g = grid(parent);
  keys.forEach(function (k) { row(g, human(k) || "?", valueText(o[k])); });
}

function timeline(parent, kind, status, decided, failLabel) {
  var steps = kind === "trade"
    ? [["awaiting_approval", "Awaiting approval"], ["approved", "Approved"], ["submitted", "Submitted to the agent"], ["executing", "Executing"], ["confirmed", "Confirmed on chain"]]
    : [["awaiting_approval", "Awaiting approval"], ["applied", "Applied"]];
  if (status === "paper_filled" && kind === "trade") steps[4] = ["paper_filled", "Filled on paper"];
  if (status === "filled_awaiting_ledger" && kind === "trade") steps.splice(4, 0, ["filled_awaiting_ledger", "Waiting for the ledger"]);
  var idx = -1;
  for (var i = 0; i < steps.length; i++) if (steps[i][0] === status) idx = i;
  var failAt = -1;
  if (idx === -1 && has(FAIL_TEXT, status)) {
    if (kind !== "trade" || status === "rejected") failAt = 1;
    else if (status === "cancelled" || status === "expired") failAt = decided ? 3 : 1;
    else failAt = 4;
  }
  var done = status === "confirmed" || status === "paper_filled" || status === "applied";
  var ol = put(parent, "ol", "timeline");
  for (var j = 0; j < steps.length; j++) {
    if (j === failAt) { put(ol, "li", "step failed", failLabel || FAIL_TEXT[status]); break; }
    var cls = failAt >= 0 ? (j < failAt ? "step done" : "step") : j < idx || (done && j === idx) ? "step done" : j === idx ? "step current" : "step";
    put(ol, "li", cls, steps[j][1]);
  }
  if (idx === -1 && failAt === -1) put(parent, "p", "small muted", "Status: " + (human(status) || UNKNOWN));
}

function renderProposal(d) {
  var s = obj(d.summary) || {};
  var kind = str(d.kind, 24) || "trade";
  var status = str(d.status, 40) || "";
  var res = obj(d.result);
  if (kind === "trade") {
    var proposed = pick({ live: "live", paper: "paper" }, s.book, null);
    var actual = outcomeBook(status, res);
    var book = actual || proposed || "unk";
    var b = put(root, "div", "banner " + book);
    put(b, "strong", null, book === "live" ? "LIVE · real funds" : book === "paper" ? "PAPER · practice book, simulated" : "Book not known");
    if (actual && proposed && actual !== proposed) {
      put(b, "div", null, "Proposed while the agent was in " + proposed + " mode, but " + (actual === "live" ? "it went on chain with real funds." : "it was filled on paper; no money moved."));
    } else {
      var bn = str(s.book_note, 300);
      if (bn) put(b, "div", null, bn);
    }
  } else {
    put(root, "div", "banner info", "Not a trade: " + pick(KIND_TEXT, kind, "a proposal") + ", for the owner to approve.");
  }
  header(str(s.action, 160) || "Proposal", str(d.proposal_id, 40));
  var st = section(root, "Status");
  var hd = put(st, "div", "check-hd");
  // "failed" with outcome_unknown is not a failure the evidence shows: the
  // order finished and no record that is clearly its own arrived in time.
  var unconfirmed = status === "failed" && !!res && res.outcome_unknown === true;
  hd.appendChild(unconfirmed ? chip("outcome not confirmed", "warn") : chip(human(status) || UNKNOWN, pick(STATUS_TONE, status, "unk")));
  put(st, "p", null, str(d.status_explained, 400) || pick(STATUS_TEXT, status, ""));
  timeline(st, kind, status, !!d.decided_at, unconfirmed ? "Outcome not confirmed" : null);
  var g = grid(st);
  if (d.created_at) row(g, "Created", when(d.created_at));
  row(g, status === "awaiting_approval" ? "Expires" : "Approval window", when(d.expires_at), status === "awaiting_approval" ? null : "Only matters while it waits for approval");
  if (d.decided_at) row(g, "Decided", when(d.decided_at));
  if (d.order_id) row(g, "Order", mono(str(d.order_id, 80)));

  if (status === "awaiting_approval") {
    var ap = section(root, "Approve in Merrymen");
    var exp = Date.parse(typeof d.expires_at === "string" ? d.expires_at : "");
    var link = approvalLink(d.approval_url, d.proposal_id);
    if (isFinite(exp) && exp <= Date.now()) {
      put(ap, "p", "warn-text", "This proposal has expired. Ask for a fresh one.");
    } else if (link) {
      put(ap, "p", null, (kind === "trade" ? "Nothing is traded" : "Nothing changes") + " until you open this page, sign in to Merrymen and approve.");
      var a = put(ap, "a", "cta", "Open the approval page");
      a.setAttribute("href", link.href);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      var note = put(ap, "p", "small muted", "Opens " + link.host + ".");
      a.addEventListener("click", function (ev) { if (openViaHost(link.href, note)) ev.preventDefault(); });
      put(ap, "div", "mono", link.href);
    } else if (typeof d.approval_url === "string") {
      put(ap, "p", "warn-text", "This approval address is not this Merrymen server's approval page, so it is not linked.");
      untrustedBox(ap, "Address as received", d.approval_url, 300);
    } else {
      put(ap, "p", "small muted", "No approval link in this result.");
    }
  }

  var ds = section(root, "What was proposed");
  var dg = grid(ds);
  if (s.token) row(dg, "Token", mono(str(s.token, 80)));
  if (s.expected_out !== undefined) row(dg, "Expected", fmt(s.expected_out, 6), "When it was proposed");
  if (s.min_out !== undefined) row(dg, "Minimum received", fmt(s.min_out, 6));
  if (s.price_impact_bps !== undefined) row(dg, "Price impact", bps(s.price_impact_bps));
  if (s.risk_level !== undefined) row(dg, "Risk level", human(s.risk_level));
  var by = s.requested_by !== undefined ? s.requested_by : d.requested_by;
  if (by !== undefined) row(dg, "Requested by", utInline(by, false));
  generic(ds, s, KNOWN_SUMMARY);
  var diff = arr(s.diff, 20).map(obj).filter(Boolean);
  if (diff.length) {
    put(ds, "h3", null, "Setting changes");
    table(ds, [{ label: "Setting" }, { label: "Now" }, { label: "Proposed" }], diff.map(function (x) {
      return [str(x.label, 80) || str(x.key, 40), str(x.current, 120), str(x.proposed, 120)];
    }), (Array.isArray(s.diff) ? s.diff.length : 0) - diff.length);
  }
  draftSettings(ds, s.settings);
  if (s.after_approval) put(ds, "p", "small muted", str(s.after_approval, 400));
  // A post is the assistant's own words, published under the owner's agent.
  if (kind === "post" || s.text !== undefined) untrustedBox(ds, "The post the assistant drafted", s.text, 500);
  if (s.assistant_note) untrustedBox(ds, "The assistant's note", s.assistant_note, 280);
  if (d.binding_hash) put(ds, "p", "small muted", "Binding " + str(d.binding_hash, 80) + " — an approval acts only on this exact binding.");

  if (res && Object.keys(res).length) { var rs = section(root, "Result"); resultBlock(rs, res); }
  var q = obj(d.quote);
  if (q) renderQuote(root, q, false);
  notes([d.next_steps]);
}

function renderQuote(parent, q, standalone) {
  if (standalone) put(parent, "div", "banner info", "Indicative quote only: nothing was placed.");
  var s = section(parent, standalone ? "Quote" : "Quote when it was proposed");
  if (q.quoted !== true) {
    put(s, "p", "warn-text", "No quote: " + (str(q.why_not, 400) || UNKNOWN));
    bullets(s, q.caveats, 8, "small");
    return;
  }
  var g = grid(s);
  row(g, "Side", human(q.side));
  row(g, "Token", mono(str(q.token, 80)));
  var ain = obj(q.amount_in);
  row(g, "Spend", ain ? fmt(ain.human, 6) : null, ain ? shortAddr(ain.token) : null);
  var eo = obj(q.expected_out);
  row(g, "Expected", eo ? fmt(eo.human, 6) : null);
  var mo = obj(q.min_out);
  row(g, "Minimum received", mo ? fmt(mo.human, 6) : null, mo && num(mo.slippage_bps) !== null ? "at " + bps(mo.slippage_bps) + " slippage" : null);
  row(g, "Implied price", usdPrice(q.implied_price_usd));
  var iv = obj(q.impact_verdict);
  row(g, "Price impact", bps(q.price_impact_bps), iv ? (iv.ok === true ? chip("within cap " + (bps(iv.cap_bps) || ""), "ok") : chip("over cap " + (bps(iv.cap_bps) || ""), "bad")) : null);
  if (iv && iv.ok !== true && iv.detail) put(s, "p", "warn-text", str(iv.detail, 300));
  var rt = obj(q.route);
  if (rt) row(g, "Route", str(rt.venue, 64), [num(rt.fee_tier_bps) !== null ? "fee tier " + bps(rt.fee_tier_bps) : null, count(arr(rt.hops, 8).length) + " hop(s)"].filter(Boolean).join(" · "));
  var gas = obj(q.gas);
  if (gas) row(g, "Gas", money(gas.expected_usdg), str(gas.note, 200));
  var fee = obj(q.merrymen_trade_fee);
  if (fee) row(g, "Merrymen fee", money(fee.usdg), [bps(fee.bps), str(fee.note, 200)].filter(Boolean).join(" · "));
  row(g, "Quoted", when(q.quoted_at), q.block_number ? "block " + str(q.block_number, 24) : null);
  bullets(s, q.caveats, 8, "small");
}
`;

// ── pages ───────────────────────────────────────────────────────────────────

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

const VIEWS: Record<AppView, { title: string; js: string; description: string }> = {
  portfolio: { title: "Merrymen portfolio", js: PORTFOLIO_JS, description: "Renders get_portfolio and get_performance: paper and live books side by side, never summed." },
  decision: { title: "Merrymen decision", js: DECISION_JS, description: "Renders explain_agent_inactivity and get_decision: the primary cause, each check's status, evidence and what the owner can do." },
  token: { title: "Merrymen token", js: TOKEN_JS, description: "Renders get_token, search_tokens and check_token_eligibility: discoverable, priceable and executable, with third-party text marked." },
  proposal: { title: "Merrymen proposal", js: PROPOSAL_JS, description: "Renders quote_trade, propose_trade and get_proposal: the paper or live banner, the status timeline and the approval link." },
};

/** An origin as JS source, safe inside a script element; anything but a plain origin becomes "". */
function issuerLiteral(issuer: string): string {
  const ok = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(issuer) ? issuer : "";
  return JSON.stringify(ok).replace(/</g, "\\u003c");
}

/**
 * The HTML of one view. The proposal view takes the configured issuer origin
 * so it links only this server's approval page; the others take nothing.
 */
export function appHtml(view: AppView, opts: { issuer?: string } = {}): string {
  const v = VIEWS[view];
  const config = view === "proposal" ? `var ISSUER = ${issuerLiteral(opts.issuer ?? "")};\n` : "";
  const script = `(function () {\n"use strict";\nvar VIEW = ${JSON.stringify(view)};\n${config}${RUNTIME.replace("__PROTOCOL__", APPS_PROTOCOL_VERSION)}\n${v.js}\nboot();\n})();`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${v.title}</title>
<style>${CSS}</style>
</head>
<body>
<main id="app" aria-live="polite"><p class="notice">Loading…</p></main>
<script>${script}</script>
</body>
</html>`;
}

/** A resource definition that also carries protocol `_meta` (the view's CSP). */
export interface AppResourceDef extends ResourceDef {
  meta: Readonly<Record<string, unknown>>;
}

function appResource(view: AppView): AppResourceDef {
  const v = VIEWS[view];
  return {
    name: `app_${view}_view`,
    title: v.title,
    description: `${v.description} Presentation only: it holds no data and makes no network requests.`,
    mimeType: MCP_APP_MIME,
    // Pure presentation: the page carries no owner data, so it needs no scope.
    capability: null,
    uri: APP_VIEW_URI[view],
    meta: APP_RESOURCE_META,
    async read() {
      return { mimeType: MCP_APP_MIME, text: appHtml(view, view === "proposal" ? { issuer: mcpConfig().issuer } : {}) };
    },
  };
}

export const APP_RESOURCES: AppResourceDef[] = (["portfolio", "decision", "token", "proposal"] as const).map(appResource);
