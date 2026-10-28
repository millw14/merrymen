/**
 * The research browser — a real Chromium, in its own service, behind one route.
 *
 * WHY A SEPARATE SERVICE. The main image is role-by-variable: one build runs
 * either the Next dashboard or the orchestrator (see Dockerfile). Chromium adds
 * roughly 400MB and an apt layer to whatever image carries it, so putting it
 * there would slow the web service down for something the web service never
 * does. Worse, the orchestrator SPAWNS ONE WORKER CHILD PER TENANT — a browser
 * inside the worker would be a browser per tenant, which does not fit on any
 * plan worth paying for. One browser, shared, reached over the private network.
 *
 * WHY IT IS NOT ON THE PUBLIC INTERNET. This is a URL-fetching machine with an
 * internal address. Exposed, it would be an open proxy that anyone could point
 * at `*.railway.internal` — at the orchestrator, at Postgres. It binds for
 * Railway's private network and requires a shared token, and the SSRF guard runs
 * on both sides of the wire rather than being trusted to one.
 *
 * WHAT IT RETURNS. Readable text, the page title, the links, and a screenshot.
 * All of it is DATA — content written by whoever launched a memecoin, chosen to
 * be read by an agent. It is never instructions, and the prompt that consumes it
 * says so in the same words the Telegram agent already uses.
 *
 * AND, ON POST /scan, WHAT THE PAGE IS MADE OF (an X agent's larp check,
 * 2026-10-13): every link and word on the page, its markup, the scripts it
 * loaded, read for the contracts and the GitHub it points at
 * (packages/core/src/site-scan.ts), and how many calls it made to its own
 * site. No screenshot: nobody looks at one. The findings are strings a
 * stranger's page contained; the caller decides what is worth a lookup.
 */

import { createServer } from "node:http";
import { chromium } from "playwright";
import { safeFetchUrl } from "../packages/core/src/safe-url";
import { createPublicProxy } from "../packages/core/src/server/public-proxy";
import { fetchPublicHttps } from "../packages/core/src/server/public-network";
import { findInSources, siteOf, type ScanSource } from "../packages/core/src/site-scan";

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.MERRYMEN_BROWSER_TOKEN ?? "";

/** One page at a time. A browser is the most expensive thing in the fleet. */
const NAV_TIMEOUT_MS = 15_000;
const MAX_TEXT = 20_000;
const MAX_LINKS = 40;
const VIEWPORT = { width: 1280, height: 900 };

/**
 * A SCAN (POST /scan) READS WHAT A READ DOES, AND WHAT THE PAGE IS MADE OF:
 * the scripts it loaded and the calls it made while it settled. That is where
 * a dapp keeps its contract addresses and its GitHub, and whether it talks to
 * a backend of its own at all is the difference between a product and a
 * landing page. Bounded on every axis, because the page decides how much it
 * sends: a few seconds more to settle, a dozen scripts, a few megabytes.
 *
 * NEVER A BODY THE PAGE SIZED (review of #333). Playwright's response.body()
 * hands Node the whole decoded body, of whatever size, for as many responses
 * as are in flight at once: a hostile page from an X tag could have the one
 * shared browser buffer it out of memory (chunked, or a compression bomb, so
 * no declared length bounds it). So the browser only notes which scripts the
 * page loaded, a dozen at most; their text is fetched again afterwards by
 * fetchPublicHttps, which pins a public address, refuses any compressed
 * body (so its byte cap also bounds what is decoded), and stops reading at
 * the cap. Three at a time, each slot's bytes reserved from the total before
 * its read starts, all of it inside a few seconds.
 */
const SCAN_SETTLE_MS = 2_500;
const SCAN_SCRIPTS_MAX = 12;
const SCAN_SCRIPT_BYTES = 3_000_000;
const SCAN_TOTAL_BYTES = 8_000_000;
const SCAN_FETCH_PARALLEL = 3;
const SCAN_FETCH_MS = 5_000;
/** The whole of the bundle reads, waits included. */
const SCAN_FETCHES_MS = 8_000;
/** The page's own markup, read for addresses in attributes and inline data. */
const SCAN_HTML_MAX = 800_000;
/** Every link on the page is read for findings; only MAX_LINKS go back. */
const SCAN_LINKS_READ = 400;
/** How long a scan waits for the one browser before it is told "busy". A tag is waiting; a read is not. */
const SCAN_SLOT_WAIT_MS = 20_000;

let browser: import("playwright").Browser | null = null;
let outboundProxy: Awaited<ReturnType<typeof createPublicProxy>> | null = null;
let busy = false;

async function getBrowser() {
  if (browser?.isConnected()) return browser;
  await outboundProxy?.close();
  outboundProxy = await createPublicProxy();
  try {
    browser = await chromium.launch({
      proxy: { server: outboundProxy.url, bypass: "<-loopback>" },
      args: [
        "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
        // All TCP destinations, including redirects and worker/subresource
        // requests, must pass the proxy's DNS validation and pinned dial.
        "--proxy-bypass-list=<-loopback>", "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    });
  } catch (error) {
    await outboundProxy.close();
    outboundProxy = null;
    throw error;
  }
  return browser;
}

/**
 * THE SCRIPTS' TEXT, BOUNDED BY US, NEVER BY THE PAGE: each URL read again
 * with fetchPublicHttps, at most SCAN_FETCH_PARALLEL at once. A slot's byte
 * cap is reserved from the total before its read starts and the unused part
 * given back after, so the total can never be overrun by reads in flight
 * together. A read that fails, is compressed or runs over its cap is no
 * script. Everything stops at SCAN_FETCHES_MS.
 */
async function readScripts(urls: readonly string[]): Promise<{ scripts: string[]; scriptBytes: number }> {
  const scripts: string[] = [];
  let reserved = 0, scriptBytes = 0, next = 0;
  const until = Date.now() + SCAN_FETCHES_MS;
  const worker = async (): Promise<void> => {
    while (next < urls.length) {
      const u = urls[next++]!;
      const cap = Math.min(SCAN_SCRIPT_BYTES, SCAN_TOTAL_BYTES - reserved);
      const ms = Math.min(SCAN_FETCH_MS, until - Date.now());
      if (cap < 1 || ms < 250) return;
      reserved += cap;
      try {
        const r = await fetchPublicHttps(u, { maxBytes: cap, timeoutMs: ms, maxRedirects: 2 });
        if (r.status === 200) {
          scripts.push(r.body.toString("utf8"));
          scriptBytes += r.body.length;
        }
        reserved -= cap - (r.status === 200 ? r.body.length : 0);
      } catch {
        reserved -= cap;
      }
    }
  };
  await Promise.all(Array.from({ length: SCAN_FETCH_PARALLEL }, worker));
  return { scripts, scriptBytes };
}

/**
 * Read one page; with `scan`, also what it is made of.
 *
 * `domcontentloaded`, not `networkidle`: a memecoin site is usually a landing
 * page with an animation loop or a live price widget, and networkidle on those
 * waits for the full timeout every time and then reports a timeout as a failure.
 */
async function visit(url: URL, scan: boolean) {
  const b = await getBrowser();
  const ctx = await b.newContext({
    viewport: VIEWPORT,
    // A plain desktop identity. Not a disguise — sites that block a real browser
    // are telling us something, and we should hear it rather than evade it.
    javaScriptEnabled: true,
    ignoreHTTPSErrors: false,
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  try {
    // Routing is a second gate, not the transport boundary: Chromium can
    // follow a redirect without invoking the same route handler again.
    await ctx.route("**/*", (route) => safeFetchUrl(route.request().url()) ? route.continue() : route.abort());
    await ctx.routeWebSocket("**/*", (socket) => socket.close());
    await ctx.addInitScript(() => {
      // Research needs no peer-to-peer sockets. Disabling the API also covers
      // same-origin frames; the launch policy blocks non-proxied UDP beneath it.
      for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
        Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false });
      }
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    // WHAT THE PAGE LOADED, ONLY ON A SCAN: which scripts (their URLs, a dozen
    // at most, read again later by readScripts and never by body()), and how
    // many calls it made to its own site (siteOf: a shared host's other
    // tenants are other sites).
    const scriptUrls: string[] = [];
    let ownCalls = 0;
    const callHosts = new Set<string>();
    if (scan) {
      const own = siteOf(url.hostname);
      page.on("response", (response) => {
        const kind = response.request().resourceType();
        let host = "";
        try {
          host = new URL(response.url()).hostname;
        } catch {
          return;
        }
        if (kind === "fetch" || kind === "xhr") {
          if (siteOf(host) === own) ownCalls++;
          if (callHosts.size < 12) callHosts.add(host.toLowerCase());
          return;
        }
        if (kind !== "script" || response.status() !== 200 || scriptUrls.length >= SCAN_SCRIPTS_MAX) return;
        const u = response.url();
        if (u.startsWith("https://") && !scriptUrls.includes(u)) scriptUrls.push(u);
      });
    }

    const res = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    // Give a single-page app a beat to render, but never more than a beat.
    // A scan waits a little longer, for the calls an app makes once it is up.
    await page.waitForTimeout(scan ? SCAN_SETTLE_MS : 1200);

    const data = await page.evaluate((o) => {
      // NO NAMED FUNCTION IN HERE, NOT EVEN AN ARROW IN A CONST. This body is
      // sent to the page as source, and tsx compiles this file with esbuild's
      // keepNames, which wraps every named function in a `__name(...)` call
      // that exists in Node and not in the page: `const strip = (s) => …`
      // here threw "__name is not defined" on every page, so every read failed
      // (found by running the service against live sites, 2026-10-13).
      const ws = /\s+/g;
      const all = [...document.querySelectorAll("a[href]")]
        .map((a) => ({ text: (a.textContent || "").replace(ws, " ").trim().slice(0, 80), href: (a as HTMLAnchorElement).href }))
        .filter((l) => l.href.startsWith("http"));
      // Prefer the main content, fall back to the body — the same order the
      // dashboard's own text extraction uses.
      const root = (document.querySelector("main") || document.querySelector("article") || document.body) as HTMLElement | null;
      return {
        title: (document.title || "").replace(ws, " ").trim(),
        description: (document.querySelector('meta[name="description"]')?.getAttribute("content") || "").replace(ws, " ").trim(),
        text: (root?.innerText || "").replace(ws, " ").trim(),
        // A scan reads every word on the page, not only the main column: a
        // contract is as often in the footer as in the hero.
        allText: o.scan ? (document.body?.innerText || "").replace(ws, " ").trim() : "",
        links: all.slice(0, o.maxLinks),
        allLinks: o.scan ? all.slice(0, o.linksRead).map((l) => l.href) : [],
        html: o.scan ? document.documentElement.outerHTML.slice(0, o.htmlMax) : "",
        finalUrl: location.href,
      };
    }, { maxLinks: MAX_LINKS, scan, linksRead: SCAN_LINKS_READ, htmlMax: SCAN_HTML_MAX });

    const base = {
      ok: true,
      status: res?.status() ?? 0,
      title: data.title,
      description: data.description,
      text: data.text.slice(0, MAX_TEXT),
      truncated: data.text.length > MAX_TEXT,
      links: data.links,
      finalUrl: data.finalUrl,
    };
    if (!scan) {
      const shot = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
      return { ...base, screenshotJpegBase64: shot.toString("base64") };
    }
    // The bundles' text, read again by us under our own caps (readScripts).
    const { scripts, scriptBytes } = await readScripts(scriptUrls);
    const sources: ScanSource[] = [
      { where: "link", text: data.allLinks.join("\n") },
      { where: "text", text: data.allText },
      { where: "html", text: data.html },
      ...scripts.map((text): ScanSource => ({ where: "script", text })),
    ];
    return {
      ...base,
      // Every word the page shows, for "does it name this contract", bounded as a read's text is.
      allText: data.allText.slice(0, MAX_TEXT * 2),
      findings: findInSources(sources),
      loaded: { scripts: scripts.length, scriptBytes, ownCalls, callHosts: [...callHosts] },
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

const send = (res: import("node:http").ServerResponse, code: number, body: unknown) => {
  const json = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
};

/** Waits up to `ms` for the one browser, or false. A read never waits; a scan has someone waiting on X. */
async function slot(ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (busy) {
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  busy = true;
  return true;
}

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, busy });
  const route = req.method === "POST" && req.url ? (req.url.startsWith("/read") ? "read" : req.url.startsWith("/scan") ? "scan" : null) : null;
  if (!route) return send(res, 404, { error: "not found" });

  // The token is not optional. Without it this is an open proxy with an address
  // on the same private network as the database.
  if (!TOKEN || req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(res, 401, { error: "unauthorized" });
  }

  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) return send(res, 413, { error: "body too large" });
  }
  let parsed: { url?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return send(res, 400, { error: "body is not JSON" });
  }

  // The guard runs HERE as well as at the caller. The caller checking is not
  // enough: this process is the one holding the browser and sitting on the
  // private network, so it must not depend on anyone else's diligence.
  const url = safeFetchUrl(String(parsed?.url ?? ""));
  if (!url) return send(res, 400, { error: "refused: not an https URL we will fetch" });

  if (!(await slot(route === "scan" ? SCAN_SLOT_WAIT_MS : 0))) return send(res, 429, { error: "busy" });
  try {
    send(res, 200, await visit(url, route === "scan"));
  } catch (e) {
    send(res, 502, { error: `could not read the page: ${String((e as Error)?.message ?? e).slice(0, 200)}` });
  } finally {
    busy = false;
  }
}).listen(PORT, "::", () => {
  console.log(`[browser] listening on ${PORT}`);
});
