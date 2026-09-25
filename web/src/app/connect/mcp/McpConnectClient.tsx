"use client";

/**
 * The connect hub: the shortest way from "I use Claude" to "Claude can see my
 * agent", for owners who have never heard of MCP.
 *
 * One big button for Claude, because it is the assistant most owners have and
 * its link opens claude.ai's own Add connector dialog already filled in (then
 * Continue, Connect, Allow). Every other assistant gets one row with one
 * obvious action: its own install link where it has one, a command with a Copy
 * button where it lives in a terminal.
 *
 * NOTHING HERE GRANTS ACCESS. A link only puts the address into the assistant;
 * the assistant then sends the owner to the consent page, and nothing is
 * allowed until they click Allow there. The page needs no sign-in. Its one
 * signed-in read (which assistants are already connected) is best-effort: a
 * signed-out visitor, an error or a slow answer shows nothing, never an error.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronDown, Copy, Plug } from "lucide-react";
import { claudeCodePluginCommands, installCommands, installLinks } from "@/mcp/install-links";
import { BrandLockup } from "../BrandLockup";

/** The fields of a GET /api/mcp/connections row that the status line reads. */
interface ConnectionLite { clientName: string | null; clientHost: string | null; lastUsedAt: number | null }

/** How long the status read may take before the page stops waiting for it. */
const STATUS_TIMEOUT_MS = 10_000;

/**
 * merrymen.dev's static copy of the production setup text, the one a search
 * finds (assistant-setup.test.ts pins it to llmsTxt()). Any other server
 * serves its own at <app>/llms.txt.
 */
const SITE_LLMS_TXT = "https://merrymen.dev/llms.txt";

/** "last used 5 min ago", from epoch seconds. */
export function lastUsedWords(lastUsedAt: number | null, nowSec: number): string {
  if (!lastUsedAt) return "not used yet";
  const s = Math.max(0, nowSec - lastUsedAt);
  if (s < 60) return "last used just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `last used ${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `last used ${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.floor(h / 24);
  return `last used ${d} ${d === 1 ? "day" : "days"} ago`;
}

/**
 * The status line's words, or null when nothing is connected. Two Claude
 * connections read as one "Claude"; "last used" is the most recent use of any
 * of them. Rows are read defensively: this is a courtesy line, and a shape it
 * does not expect hides it rather than breaking the page.
 */
export function connectedSummary(rows: unknown, nowSec: number): { names: string; lastUsed: string; claude: boolean } | null {
  if (!Array.isArray(rows)) return null;
  const list = rows.filter((r): r is ConnectionLite => !!r && typeof r === "object");
  if (!list.length) return null;
  const names: string[] = [];
  for (const r of list) {
    const name = typeof r.clientName === "string" && r.clientName.trim() ? r.clientName.trim()
      : typeof r.clientHost === "string" && r.clientHost ? r.clientHost : "An assistant";
    if (!names.includes(name)) names.push(name);
  }
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
  const last = list.reduce<number | null>((max, r) => (typeof r.lastUsedAt === "number" && r.lastUsedAt > (max ?? 0) ? r.lastUsedAt : max), null);
  // Claude (web, desktop, mobile) connects as claude.ai; Claude Code also verifies at claude.ai, under its own name.
  const claude = list.some((r) => r.clientHost === "claude.ai" && !/\bcode\b/i.test(r.clientName ?? ""));
  return { names: shown, lastUsed: lastUsedWords(last, nowSec), claude };
}

/** Select an element's text, so an owner whose browser refused the clipboard can copy it by hand. */
function selectText(id: string): void {
  const el = document.getElementById(id);
  const selection = window.getSelection();
  if (!el || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
  // The text may sit in another section (the ChatGPT row copies the address box).
  el.scrollIntoView({ block: "nearest" });
}

/**
 * A Copy button with a way out. The clipboard is missing on plain http and can
 * be refused (permissions, an embedded browser); then the text is selected
 * instead and the button says so. "Copied" shows for two seconds and is
 * announced to screen readers. The timer dies with the component: a stray
 * timeout outliving its component once broke CI.
 */
function CopyButton({ text, target, label, children = "Copy" }: { text: string; target: string; label: string; children?: ReactNode }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  async function copy() {
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      selectText(target);
    }
    // The clipboard answers asynchronously; the page may have gone meanwhile.
    if (!alive.current) return;
    setState(copied ? "copied" : "manual");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setState("idle");
    }, copied ? 2000 : 8000);
  }

  return (
    <>
      <button type="button" className="mcp-hub-copy" aria-label={label} onClick={() => void copy()}>
        {state === "copied" ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        {state === "copied" ? "Copied" : children}
      </button>
      <span className={state === "manual" ? "mcp-hub-copy-note" : "sr-only"} role="status" aria-live="polite">
        {state === "copied" ? "Copied" : state === "manual" ? "Couldn’t copy automatically. It’s selected, so copy it from there." : ""}
      </span>
    </>
  );
}

/** A link that opens in a new tab and says so to screen readers. */
function Out({ href, className, label, children }: { href: string; className?: string; label?: string; children: ReactNode }) {
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer" aria-label={label ? `${label} (opens in a new tab)` : undefined}>
      {children}
      {!label && <span className="sr-only"> (opens in a new tab)</span>}
    </a>
  );
}

/** Commands shown as they will be pasted (wrapped on a phone, never cut), with one Copy for all of them. */
function Command({ lines, label }: { lines: string[]; label: string }) {
  const id = useId();
  const text = lines.join("\n");
  return (
    <div className="mcp-hub-command">
      <pre id={id}><code>{text}</code></pre>
      <CopyButton text={text} target={id} label={label} />
    </div>
  );
}

function Row({ name, children }: { name: string; children: ReactNode }) {
  return <li className="mcp-hub-row"><h3>{name}</h3>{children}</li>;
}

export function McpConnectClient({ url, app, enabled, disabledWhy }: { url: string; app: string; enabled: boolean; disabledWhy: string | null }) {
  const links = installLinks(url);
  const commands = installCommands(url);
  // The Claude Code plugin, offered only where this page serves the address it points at.
  const plugin = claudeCodePluginCommands(url);
  // The setup text an assistant follows (mcp/assistant-setup.ts) for this server's address.
  const llms = plugin ? SITE_LLMS_TXT : `${app}/llms.txt`;
  const addressId = useId();
  const [connected, setConnected] = useState<ReturnType<typeof connectedSummary>>(null);

  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), STATUS_TIMEOUT_MS);
    void (async () => {
      try {
        const response = await fetch("/api/mcp/connections", { cache: "no-store", credentials: "same-origin", signal: abort.signal });
        if (!response.ok) return;
        const data = await response.json() as { connections?: unknown };
        if (!abort.signal.aborted) setConnected(connectedSummary(data.connections, Math.floor(Date.now() / 1000)));
      } catch {
        // Signed out, offline or slow: the line is simply not shown.
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      clearTimeout(timeout);
      abort.abort();
    };
  }, [enabled]);

  return (
    <div className="terminal-host partner-connect mcp-connect">
      <header className="connect-header">
        <BrandLockup />
        <span className="connect-header-label">Connect an AI assistant</span>
      </header>
      <main className="connect-main">
        <div className="connect-context">
          <span className="connect-eyebrow">YOUR AGENT, IN YOUR ASSISTANT</span>
          <h1>Your Merryman,<br />in Claude.</h1>
          <p>Ask about its trades, your portfolio and the market in plain words. Your assistant only gets what you allow, and it can never move your money.</p>
        </div>
        <div className="connect-panel mcp-hub">
          {!enabled ? <>
            <h2>Assistant connections are switched off on this server</h2>
            {disabledWhy && <p className="mcp-hub-fine">Reason: {disabledWhy}.</p>}
            <a className="connect-cancel" href="/">Back to Merrymen</a>
          </> : <>
            {connected && (
              <p className="mcp-hub-status">
                <Plug size={14} aria-hidden />
                <span>Connected: {connected.names} · {connected.lastUsed} · <a href="/connect/apps" aria-label="Manage connected apps">Manage</a></span>
              </p>
            )}

            <section className="mcp-hub-section" aria-labelledby="mcp-hub-claude">
              <h2 id="mcp-hub-claude">Add to Claude</h2>
              {connected?.claude && <p className="mcp-hub-fine">Claude is already connected. You only need this again for another Claude account.</p>}
              <Out className="flow-primary" href={links.claude}>Add to Claude <ArrowUpRight size={16} aria-hidden /></Out>
              <ol className="mcp-hub-steps">
                <li>Claude opens with Merrymen already filled in. Click <b>Continue</b>, then <b>Connect</b>.</li>
                <li>Merrymen opens. Sign in if asked, then click <b>Allow</b>.</li>
                <li>Back in Claude, ask “Why hasn’t my agent traded?”</li>
              </ol>
              <p className="mcp-hub-fine">Add it once and it works on claude.ai and in the Claude desktop and mobile apps. Claude Code signed in to the same account gets it too.</p>
              <p className="mcp-hub-fine">On a Team or Enterprise plan? Your organisation’s owner adds it once: <Out href={links.claudeOrg}>add Merrymen for your organisation</Out>. Everyone else then finds Merrymen in Claude under Customize → Connectors and clicks Connect. Claude’s free plan allows one custom connector.</p>
            </section>

            <section className="mcp-hub-section" aria-labelledby="mcp-hub-others">
              <h2 id="mcp-hub-others" className="mcp-hub-h2">Other assistants</h2>
              <ul className="mcp-hub-rows">
                <Row name="Claude Code">
                  {plugin ? <>
                    <p>In Claude Code, run these one at a time:</p>
                    <Command lines={[plugin[0]]} label="Copy the first Claude Code command" />
                    <Command lines={[plugin[1]]} label="Copy the second Claude Code command" />
                    <p>Then type <code>/mcp</code>, choose Merrymen and Authenticate. You get <code>/merrymen:status</code>, <code>/merrymen:why</code>, <code>/merrymen:portfolio</code> and more, or just ask.</p>
                    <p className="mcp-hub-fine">Added Merrymen to Claude already? Claude Code signed in to the same account has it too. Without the plugin, from a terminal:</p>
                  </> : <p>Added it to Claude already? It’s in Claude Code too. Otherwise:</p>}
                  <Command lines={commands.claudeCode} label="Copy both Claude Code terminal commands" />
                  <p className="mcp-hub-fine">Or just tell Claude Code:</p>
                  <Command lines={[`Set up the Merrymen MCP server. Instructions: ${llms}`]} label="Copy the sentence to tell Claude Code" />
                </Row>
                <Row name="ChatGPT">
                  <p>Turn on Developer mode (Settings → Security and login), then create an app with the address below.</p>
                  <div className="mcp-hub-actions">
                    <CopyButton text={url} target={addressId} label="Copy address for ChatGPT">Copy address</CopyButton>
                    <Out className="mcp-hub-action" href={links.chatgpt}>Open ChatGPT <ArrowUpRight size={14} aria-hidden /></Out>
                  </div>
                </Row>
                <Row name="Codex">
                  <Command lines={commands.codex} label="Copy the Codex command" />
                  <p>It opens Merrymen to sign in by itself. The Codex app and IDE extension pick it up too.</p>
                </Row>
                <Row name="Cursor">
                  <div className="mcp-hub-actions">
                    <Out className="mcp-hub-action" href={links.cursor}>Add to Cursor <ArrowUpRight size={14} aria-hidden /></Out>
                  </div>
                </Row>
                <Row name="VS Code">
                  <div className="mcp-hub-actions">
                    <Out className="mcp-hub-action" href={links.vscode}>Add to VS Code <ArrowUpRight size={14} aria-hidden /></Out>
                    <Out className="mcp-hub-minor" href={links.vscodeInsiders} label="Add to VS Code Insiders">Insiders</Out>
                  </div>
                </Row>
              </ul>
              <details className="mcp-hub-more">
                <summary>More apps <ChevronDown size={16} aria-hidden /></summary>
                <ul className="mcp-hub-rows">
                  <Row name="Gemini CLI">
                    <Command lines={commands.gemini} label="Copy the Gemini CLI command" />
                    <p>Then type <code>/mcp auth merrymen</code> inside Gemini CLI to sign in.</p>
                  </Row>
                  <Row name="Kiro">
                    <div className="mcp-hub-actions"><Out className="mcp-hub-action" href={links.kiro}>Add to Kiro <ArrowUpRight size={14} aria-hidden /></Out></div>
                  </Row>
                  {/* App links (lmstudio://, goose://) open the app itself, so no new tab. */}
                  <Row name="LM Studio">
                    <div className="mcp-hub-actions"><a className="mcp-hub-action" href={links.lmstudio}>Add to LM Studio</a></div>
                  </Row>
                  <Row name="Goose">
                    <div className="mcp-hub-actions"><a className="mcp-hub-action" href={links.goose}>Add to Goose</a></div>
                  </Row>
                  <Row name="Windsurf / Devin">
                    <Command lines={commands.devin} label="Copy both Windsurf and Devin commands" />
                  </Row>
                  <Row name="Anything else">
                    <p>Use the server address. It signs in with OAuth; apps that can’t can use a personal access token from <a href="/connect/apps">Connected apps</a>.</p>
                  </Row>
                </ul>
              </details>
            </section>

            <section className="mcp-hub-section mcp-hub-address" aria-labelledby="mcp-hub-address">
              <h2 id="mcp-hub-address" className="mcp-hub-h2">Server address</h2>
              <div className="mcp-hub-address-row">
                <code id={addressId}>{url}</code>
                <CopyButton text={url} target={addressId} label="Copy the server address" />
              </div>
            </section>

            <section className="mcp-hub-section mcp-hub-know" aria-labelledby="mcp-hub-know">
              <h2 id="mcp-hub-know" className="mcp-hub-h2">Good to know</h2>
              <ul>
                <li>Claude asks before each action. To stop it asking for read-only look-ups, open Claude → Customize → Connectors → Merrymen and set Read-only tools to Always allow.</li>
                <li>It only sees the agent and permissions you allow when you connect. Disconnect it any time on <a href="/connect/apps">Connected apps</a>.</li>
                <li>It can suggest trades or setting changes only if you allow that, and nothing happens until you approve them in Merrymen.</li>
                <li>It can never move your funds, see your keys, turn on live trading or loosen your limits.</li>
                <li>Paper (practice) results are always kept apart from real money.</li>
              </ul>
            </section>

            {/* Small print for an assistant that fetched this page while setting Merrymen up: llms.txt in brief. */}
            <section className="mcp-hub-section mcp-hub-ai" aria-labelledby="mcp-hub-ai">
              <h2 id="mcp-hub-ai">For AI assistants</h2>
              <ul>
                <li>Claude Code: run <code>claude mcp list</code> first; an entry at <code>{url}</code> means it is already set up. Otherwise run <code>{commands.claudeCode[0]}</code>, then ask the user to type <code>/mcp</code>, choose Merrymen and Authenticate (do not run <code>claude mcp login</code> yourself). No API key or token is needed; never ask for one.</li>
                <li>claude.ai, Claude Desktop or Claude mobile: you cannot add it from a chat. Give the user the <Out href={links.claude}>Add to Claude link</Out>.</li>
                <li>Full instructions: <a href={llms}>{llms}</a></li>
              </ul>
            </section>
          </>}
        </div>
      </main>
      <footer className="connect-footer">Merrymen · <a href="/connect/apps">Connected apps</a></footer>
    </div>
  );
}
