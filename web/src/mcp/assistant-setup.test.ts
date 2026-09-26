/**
 * The setup text a fresh AI assistant follows for "set up merrymen mcp on my
 * claude". Seen on 2026-09-25: a fresh Claude that searched for it tripped on
 * an old address, a server address that looked like a web page and two setup
 * routes that clash. These pin the facts it must get right, on production and
 * on any other server, and that every copy (the app's /llms.txt on both hosts,
 * the static one on merrymen.dev) is this one text.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { PRODUCTION_DIRECTORY_URL, assistantSetupMarkdown, llmsTxt } from "./assistant-setup";
import { DIRECTORY_ROUTE_PATH } from "./config";
import { PLUGIN_ID, PLUGIN_MARKETPLACE_URL, PLUGIN_SERVER_URL, installCommands, installLinks } from "./install-links";
import { dedicatedMcpHost, mcpHostLanding } from "./landing";

const PRODUCTION = { server: PLUGIN_SERVER_URL, app: "https://app.merrymen.dev", directory: PRODUCTION_DIRECTORY_URL };
const STAGING = { server: "https://mcp.example.test/mcp", app: "https://app.example.test", directory: "https://mcp.example.test/mcp/directory" };
const RETIRED = "https://app.merrymen.dev/mcp";
const REGENERATE = "node_modules/.bin/tsx scripts/llms-txt.ts > site/public/llms.txt";

/** Every absolute URL in a text, minus the sentence punctuation after it. Markdown's ( ) and ` ` are never part of one. */
function urlsIn(text: string): string[] {
  return (text.match(/\b[a-z][a-z0-9+.-]*:\/\/[^\s`()<>"]+/gi) ?? []).map((u) => u.replace(/[.,;:]+$/, ""));
}

describe("the production text", () => {
  const text = llmsTxt(PRODUCTION);
  const lines = text.split("\n");

  it("gives the exact server address, and says to use exactly it", () => {
    assert.ok(text.includes("- Server address: https://mcp.merrymen.dev/mcp (remote, Streamable HTTP, OAuth 2.1). Use exactly this address."));
  });

  it("names the retired address only as one not to use, or one to remove", () => {
    const at = lines.filter((l) => l.includes(RETIRED));
    assert.equal(at.length, 2, "the do-not-use line and the remove-it step");
    assert.ok(at[0]!.includes(`Do not use ${RETIRED}, an older address.`), at[0]);
    assert.ok(at[1]!.startsWith("2. ") && at[1]!.includes(`(for example ${RETIRED}), remove it first`), at[1]);
    assert.equal(text.split(RETIRED).length - 1, 2, "never as an address to add or sign in to");
  });

  it("gives the claude.ai link exactly as the connect page builds it, on a line of its own", () => {
    const links = installLinks(PLUGIN_SERVER_URL);
    assert.ok(lines.includes(links.claude), "the Add custom connector link");
    assert.equal(new URL(links.claude).searchParams.get("connectorUrl"), PLUGIN_SERVER_URL);
    assert.ok(text.includes(links.claudeOrg), "the organisation owner's link");
    assert.match(text, /You cannot add a connector from a chat\. Give the user this link:/);
  });

  it("has the Claude Code command, the sign-in step the user must do, and nothing that needs a key", () => {
    assert.ok(lines.some((l) => l.startsWith("3. Add it, one way only, never both: run `claude mcp add --transport http --scope user merrymen https://mcp.merrymen.dev/mcp`;")));
    assert.equal(installCommands(PLUGIN_SERVER_URL).claudeCode[0], "claude mcp add --transport http --scope user merrymen https://mcp.merrymen.dev/mcp");
    assert.match(text, /Tell the user to type `\/mcp`.*choose Authenticate.*click Allow\. You cannot do this step for them,/);
    assert.match(text, /No API key, token or password is needed, and never ask the user for one/);
    assert.ok(text.includes("codex mcp add merrymen --url https://mcp.merrymen.dev/mcp"));
  });

  it("offers the plugin only as the other half of one add step, never as well as it", () => {
    const at = lines.filter((l) => l.includes("claude plugin"));
    assert.equal(at.length, 1, "the plugin commands sit in one step");
    const step = at[0]!;
    assert.match(step, /^3\. Add it, one way only, never both: run `claude mcp add /);
    assert.ok(step.includes(`\`claude plugin marketplace add ${PLUGIN_MARKETPLACE_URL}\``), "the HTTPS marketplace URL, never the SSH shorthand");
    assert.ok(step.includes(`\`claude plugin install ${PLUGIN_ID}\``), step);
  });

  it("counts a server as set up by its address, and replaces an entry left at an old one", () => {
    // Anyone who followed stale text has `merrymen -> https://app.merrymen.dev/mcp`; a name match alone sent them to sign in there.
    const check = lines.find((l) => l.startsWith("1. "))!;
    assert.ok(check.includes("an entry whose address is exactly https://mcp.merrymen.dev/mcp or exactly https://mcp.merrymen.dev/mcp/directory, whatever it is called"), check);
    const replace = lines.find((l) => l.startsWith("2. "))!;
    assert.ok(replace.includes("points anywhere else (for example https://app.merrymen.dev/mcp)") && replace.includes("`claude mcp remove merrymen -s user`"), replace);
  });

  it("counts a connector at the directory address as set up, and never adds the full server on top of it", () => {
    assert.equal(PRODUCTION_DIRECTORY_URL, "https://mcp.merrymen.dev/mcp/directory");
    assert.equal(PRODUCTION_DIRECTORY_URL, `${new URL(PLUGIN_SERVER_URL).origin}${DIRECTORY_ROUTE_PATH}`, "the path the directory route serves");
    const check = lines.find((l) => l.startsWith("1. "))!;
    assert.ok(check.includes("an entry whose address is exactly https://mcp.merrymen.dev/mcp or exactly https://mcp.merrymen.dev/mcp/directory, whatever it is called"), check);
    assert.ok(check.includes("If there is one, it is already set up"), check);
    assert.ok(check.includes("An entry at https://mcp.merrymen.dev/mcp/directory is Merrymen from Anthropic's connector directory") && check.includes("do not add https://mcp.merrymen.dev/mcp on top of it."), check);
    // Only step 1 names it: it is never an address to add.
    assert.equal(lines.filter((l) => l.includes(PRODUCTION_DIRECTORY_URL)).length, 1);
    assert.ok(!lines.some((l) => l.includes(`merrymen ${PRODUCTION_DIRECTORY_URL}`)), "no add command for the directory address");
    assert.ok(text.includes("If the user already added Merrymen from Anthropic's connector directory, it is set up; do not add the link below on top of it."));
  });

  it("says the connection can never loosen the owner's signed limits", () => {
    assert.ok(text.includes("It can never move funds, see keys, turn on live trading or loosen the owner's signed limits."));
  });

  it("leaves the sign-in to the user, and says what to do when the new entry is not listed yet", () => {
    const signIn = lines.find((l) => l.startsWith("4. "))!;
    assert.ok(signIn.includes("You cannot do this step for them, and do not run `claude mcp login` yourself."), signIn);
    assert.ok(signIn.includes("`/reload-plugins`") && signIn.includes("`claude --continue`"), signIn);
  });

  it("says it is for hosted Merrymen, why the address opens a help page, and where to check it is up", () => {
    assert.ok(text.includes("It is part of hosted Merrymen (https://app.merrymen.dev)."));
    assert.ok(text.includes("a request without a token gets 401 unauthorized; both are expected"));
    // The health route answers JSON.stringify output: no space after the colon.
    assert.ok(text.includes(`https://mcp.merrymen.dev/api/mcp/health returns JSON with "ready":true.`));
    assert.ok(text.includes("and in Claude Code when Claude Code is signed in with the same claude.ai account"), "a claude.ai connector reaches Claude Code only on that login");
  });

  it("says which limits it can never loosen: the signed ones (a settings proposal the owner approves can still change others)", () => {
    assert.ok(text.includes("It can never move funds, see keys, turn on live trading or loosen the owner's signed limits."));
  });

  it("is llms.txt-shaped: one H1 title, a blockquote summary, the setup, then links", () => {
    assert.equal(lines[0], "# Merrymen");
    assert.equal(lines.filter((l) => l.startsWith("# ")).length, 1);
    assert.ok(lines[2]!.startsWith("> "));
    assert.ok(text.includes(assistantSetupMarkdown(PRODUCTION)));
    assert.ok(text.includes("- [Connect an AI assistant](https://app.merrymen.dev/connect/mcp)"));
    assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"), "one trailing newline");
  });
});

describe("a staging or self-hosted server", () => {
  const text = llmsTxt(STAGING);

  it("gets commands and links with its own address", () => {
    assert.ok(text.includes("- Server address: https://mcp.example.test/mcp ("));
    assert.ok(text.includes("claude mcp add --transport http --scope user merrymen https://mcp.example.test/mcp"));
    assert.ok(text.includes("codex mcp add merrymen --url https://mcp.example.test/mcp"));
    assert.ok(text.split("\n").includes(installLinks(STAGING.server).claude));
    assert.ok(text.includes("https://mcp.example.test/api/mcp/health"));
    assert.ok(text.includes("https://app.example.test/connect/mcp"));
    assert.ok(text.includes("https://app.example.test/connect/apps"));
  });

  it("counts its own directory address, and says nothing of one when the directory profile is off", () => {
    assert.ok(text.includes("an entry whose address is exactly https://mcp.example.test/mcp or exactly https://mcp.example.test/mcp/directory, whatever it is called"));
    for (const off of [{ ...STAGING, directory: "" }, { server: STAGING.server, app: STAGING.app }]) {
      const t = llmsTxt(off);
      assert.ok(t.includes("an entry whose address is exactly https://mcp.example.test/mcp, whatever it is called"));
      assert.ok(!t.includes("/directory") && !t.includes("connector directory"), "no directory address or note");
    }
  });

  it("offers no plugin (it points at production) and no retired-address line", () => {
    // The plugin and a claude.ai connector point at production, so neither can count as this server.
    for (const s of ["claude plugin", "plugin:merrymen:merrymen", "claude.ai Merrymen", "/reload-plugins", PLUGIN_MARKETPLACE_URL, PLUGIN_ID, "/merrymen:status"]) {
      assert.ok(!text.includes(s), `no ${s}`);
    }
    assert.ok(!text.includes("Do not use"), "no old-address warning");
    assert.ok(!text.includes("mcp.merrymen.dev") && !text.includes("app.merrymen.dev"), "no production address at all");
  });
});

it("every URL in either text parses, and is https", () => {
  for (const input of [PRODUCTION, STAGING]) {
    const urls = urlsIn(llmsTxt(input));
    assert.ok(urls.length >= 8, `found ${urls.length}`);
    for (const u of urls) {
      const parsed = new URL(u);
      assert.equal(parsed.protocol, "https:", u);
      assert.ok(parsed.hostname.includes("."), u);
    }
  }
});

it("site/public/llms.txt (merrymen.dev's copy) is exactly the production text", () => {
  const file = new URL("../../../site/public/llms.txt", import.meta.url);
  let onDisk: string;
  try {
    onDisk = readFileSync(file, "utf8");
  } catch {
    assert.fail(`site/public/llms.txt is missing. Generate it from the repository root, in Git Bash (PowerShell's > writes UTF-16):\n  ${REGENERATE}`);
  }
  // Git may check it out with CRLF on Windows; the served bytes are what the repository holds.
  assert.equal(onDisk.replace(/\r\n/g, "\n"), llmsTxt(PRODUCTION),
    `site/public/llms.txt differs from llmsTxt() for production. Regenerate it from the repository root, in Git Bash (PowerShell's > writes UTF-16):\n  ${REGENERATE}`);
});

describe("GET /llms.txt on the app", () => {
  const KEYS = ["MERRYMEN_HOSTED", "DATABASE_URL", "MERRYMEN_PUBLIC_ORIGIN", "MERRYMEN_OAUTH_ISSUER", "MERRYMEN_MCP_RESOURCE_URL", "MERRYMEN_SESSION_SECRET", "MERRYMEN_MCP_ENABLED", "MERRYMEN_MCP_DIRECTORY", "MERRYMEN_MCP_DIRECTORY_RESOURCE_URL"] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  /** A hosted server whose MCP host is the staging address, configured the way production is. */
  function hosted(over: Partial<Record<(typeof KEYS)[number], string>> = {}) {
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, {
      MERRYMEN_HOSTED: "1",
      DATABASE_URL: "postgres://unused-in-tests",
      MERRYMEN_PUBLIC_ORIGIN: STAGING.app,
      MERRYMEN_MCP_RESOURCE_URL: STAGING.server,
      MERRYMEN_SESSION_SECRET: "s".repeat(48),
      ...over,
    });
  }

  it("serves the configured server's text, read at request time, as cacheable plain text", async () => {
    const route = await import("@/app/llms.txt/route");
    assert.equal(route.dynamic, "force-dynamic", "never prerendered in the image build, where the variables do not exist");
    hosted();
    const res = route.GET();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "public, max-age=300");
    const body = await res.text();
    assert.equal(body, llmsTxt(STAGING));
    assert.ok(body.includes("claude mcp add --transport http --scope user merrymen https://mcp.example.test/mcp"));
    assert.ok(body.includes("or exactly https://mcp.example.test/mcp/directory,"), "the configured directory address counts as set up");
  });

  it("takes the directory address from configuration, and drops it when the directory profile is off", async () => {
    const route = await import("@/app/llms.txt/route");
    hosted({ MERRYMEN_MCP_DIRECTORY_RESOURCE_URL: "https://dir.example.test/mcp/directory" });
    assert.equal(await route.GET().text(), llmsTxt({ ...STAGING, directory: "https://dir.example.test/mcp/directory" }));
    hosted({ MERRYMEN_MCP_DIRECTORY: "0" });
    const off = await route.GET().text();
    assert.equal(off, llmsTxt({ server: STAGING.server, app: STAGING.app }));
    assert.ok(!off.includes("/directory"));
  });

  it("says connections are off, and gives nothing to install, when they are", async () => {
    const route = await import("@/app/llms.txt/route");
    for (const [what, over] of [["self-hosted", { MERRYMEN_HOSTED: "" }], ["switched off", { MERRYMEN_MCP_ENABLED: "0" }], ["no origin", { MERRYMEN_PUBLIC_ORIGIN: "" }]] as const) {
      hosted(over);
      const res = route.GET();
      assert.equal(res.status, 200, what);
      assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8", what);
      const body = await res.text();
      assert.match(body, /Assistant connections are switched off on this server/, what);
      assert.match(body, /\nReason: .+\.\n$/, what);
      for (const s of ["claude mcp add", "claude.ai", "mcp.example.test", "Server address"]) assert.ok(!body.includes(s), `${what}: no ${s}`);
    }
  });
});

describe("/llms.txt on the dedicated MCP host", () => {
  const mcp = dedicatedMcpHost({ MERRYMEN_PUBLIC_ORIGIN: PRODUCTION.app, MERRYMEN_MCP_RESOURCE_URL: PRODUCTION.server }, true);
  const at = (pathname: string, headers: Record<string, string>) =>
    mcpHostLanding(mcp, { method: "GET", headers: new Headers({ host: "mcp.merrymen.dev", ...headers }), pathname, search: "" });
  const PAGE_LOAD = { accept: "text/html", "sec-fetch-dest": "document" };

  it("is served there untouched, to a browser and to a fetch tool alike", () => {
    assert.ok(mcp, "production has a dedicated MCP host");
    // The control: a page load of "/" there is sent to the connect page.
    assert.deepEqual(at("/", PAGE_LOAD), { status: 307, location: "https://app.merrymen.dev/connect/mcp" });
    for (const headers of [PAGE_LOAD, { accept: "text/plain, */*" }, {}] as Record<string, string>[]) assert.equal(at("/llms.txt", headers), null, JSON.stringify(headers));
  });

  it("never reaches the middleware at all (a file extension is outside its matcher)", async () => {
    // Next's own matcher compiler, as middleware.test.ts uses it.
    const nextRequire = createRequire(import.meta.url);
    const { getMiddlewareMatchers } = nextRequire("next/dist/build/analysis/get-page-static-info.js") as {
      getMiddlewareMatchers: (m: unknown, nextConfig: Record<string, unknown>) => unknown[];
    };
    const { getMiddlewareRouteMatcher } = nextRequire("next/dist/shared/lib/router/utils/middleware-route-matcher.js") as {
      getMiddlewareRouteMatcher: (m: unknown[]) => (pathname: string, req: { headers: Record<string, string> }, query: Record<string, string>) => boolean;
    };
    const { config } = await import("@/middleware");
    const runs = getMiddlewareRouteMatcher(getMiddlewareMatchers(config.matcher, {}));
    assert.equal(runs("/llms.txt", { headers: {} }, {}), false);
    assert.equal(runs("/connect/mcp", { headers: {} }, {}), true, "the control: pages do reach it");
  });
});
