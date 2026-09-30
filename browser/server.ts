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
 */

import { createServer } from "node:http";
import { chromium } from "playwright";
import { safeFetchUrl } from "../packages/core/src/safe-url";
import { createPublicProxy } from "../packages/core/src/server/public-proxy";

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.MERRYMEN_BROWSER_TOKEN ?? "";

/** One page at a time. A browser is the most expensive thing in the fleet. */
const NAV_TIMEOUT_MS = 15_000;
const MAX_TEXT = 20_000;
const MAX_LINKS = 40;
const VIEWPORT = { width: 1280, height: 900 };

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
 * Read one page.
 *
 * `domcontentloaded`, not `networkidle`: a memecoin site is usually a landing
 * page with an animation loop or a live price widget, and networkidle on those
 * waits for the full timeout every time and then reports a timeout as a failure.
 */
async function read(url: URL) {
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
    const res = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    // Give a single-page app a beat to render, but never more than a beat.
    await page.waitForTimeout(1200);

    const data = await page.evaluate((maxLinks) => {
      const strip = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim();
      const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
        .map((a) => ({ text: strip((a as HTMLAnchorElement).textContent).slice(0, 80), href: (a as HTMLAnchorElement).href }))
        .filter((l) => l.href.startsWith("http"))
        .slice(0, maxLinks);
      // Prefer the main content, fall back to the body — the same order the
      // dashboard's own text extraction uses.
      const root = document.querySelector("main") || document.querySelector("article") || document.body;
      return {
        title: strip(document.title),
        description: strip(document.querySelector('meta[name="description"]')?.getAttribute("content")),
        text: strip(root?.innerText),
        links,
        finalUrl: location.href,
      };
    }, MAX_LINKS);

    const shot = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
    return {
      ok: true,
      status: res?.status() ?? 0,
      title: data.title,
      description: data.description,
      text: data.text.slice(0, MAX_TEXT),
      truncated: data.text.length > MAX_TEXT,
      links: data.links,
      finalUrl: data.finalUrl,
      screenshotJpegBase64: shot.toString("base64"),
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

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, busy });
  if (req.method !== "POST" || !req.url?.startsWith("/read")) return send(res, 404, { error: "not found" });

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

  if (busy) return send(res, 429, { error: "busy" });
  busy = true;
  try {
    send(res, 200, await read(url));
  } catch (e) {
    send(res, 502, { error: `could not read the page: ${String((e as Error)?.message ?? e).slice(0, 200)}` });
  } finally {
    busy = false;
  }
}).listen(PORT, "::", () => {
  console.log(`[browser] listening on ${PORT}`);
});
