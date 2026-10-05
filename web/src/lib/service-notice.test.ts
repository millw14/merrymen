/**
 * AN OPERATOR'S SENTENCE, AND NOTHING THAT RIDES IN WITH IT.
 *
 * The service notice is the one string every visitor reads during an incident,
 * so the env var that carries it is held to a narrow shape: a few named fields
 * of plain text, and links to our own hosts over https. Anything outside that
 * shape turns the banner OFF and says why — a notice that half-renders, or
 * renders a flag its author mistyped, is worse than none.
 *
 * The last block pins the other half of the contract: `tradingPaused` is
 * wording. Nothing but the route and the banner may import this module, so no
 * diagnosis or worker path can start reading an operator's banner as a fact
 * about a tenant.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  noticeLabel,
  noticeRevision,
  parseServiceNotice,
  serviceNoticeFromWire,
  SERVICE_NOTICE_LINK_HOSTS,
  type ServiceNotice,
} from "./service-notice";

const BASE = {
  title: "Trading is paused while we finish a recovery",
  body: "We are finishing a recovery.\nWe will update this notice when trading resumes.",
  updatedAt: "2026-10-05T18:00:00Z",
};
const env = (over: Record<string, unknown> = {}) => JSON.stringify({ ...BASE, ...over });
const ok = (raw: string): ServiceNotice => {
  const read = parseServiceNotice(raw);
  assert.ok(read.ok, `expected a notice, got: ${read.ok ? "" : read.why}`);
  assert.ok(read.notice);
  return read.notice;
};
const refused = (raw: string, why: RegExp) => {
  const read = parseServiceNotice(raw);
  assert.equal(read.ok, false, `expected a refusal for ${raw}`);
  if (!read.ok) assert.match(read.why, why);
};

describe("absent is the normal state", () => {
  it("unset or blank is no notice, and not an error", () => {
    for (const raw of [undefined, "", "   ", "\n"]) {
      assert.deepEqual(parseServiceNotice(raw), { ok: true, notice: null });
    }
  });

  it("the route's null reads as no notice in the browser", () => {
    assert.equal(serviceNoticeFromWire(null), null);
    assert.equal(serviceNoticeFromWire(undefined), null);
  });
});

describe("a well-formed notice", () => {
  it("is read and normalised", () => {
    const notice = ok(env({
      title: "  Trading is paused  ",
      body: "Line one.\r\nLine two.",
      updatedAt: "2026-10-05T20:00+02:00",
      links: [{ label: "Your account", href: "https://app.merrymen.dev/you" }],
    }));
    assert.deepEqual(notice, {
      title: "Trading is paused",
      body: "Line one.\nLine two.",
      updatedAt: "2026-10-05T18:00:00.000Z",
      tradingPaused: false,
      links: [{ label: "Your account", href: "https://app.merrymen.dev/you" }],
    });
  });

  it("tradingPaused defaults to false and is only ever a boolean", () => {
    assert.equal(ok(env()).tradingPaused, false);
    assert.equal(ok(env({ tradingPaused: true })).tradingPaused, true);
    refused(env({ tradingPaused: "true" }), /tradingPaused must be true or false/);
    refused(env({ tradingPaused: 1 }), /tradingPaused must be true or false/);
  });

  it("allows each first-party host, and only those", () => {
    assert.deepEqual([...SERVICE_NOTICE_LINK_HOSTS].sort(), ["app.merrymen.dev", "merrymen.dev"]);
    for (const host of SERVICE_NOTICE_LINK_HOSTS) {
      assert.equal(ok(env({ links: [{ label: "More", href: `https://${host}/status` }] })).links[0]!.href, `https://${host}/status`);
    }
  });
});

describe("a bad field turns the banner off", () => {
  it("refuses a field it does not know, rather than dropping it", () => {
    // The typo this exists for: the author believes the flag is set.
    refused(env({ tradingpaused: true }), /unknown field "tradingpaused"/);
    refused(env({ html: "<b>hi</b>" }), /unknown field "html"/);
    refused(env({ links: [{ label: "More", href: "https://merrymen.dev/", target: "_blank" }] }), /links\[0\] has an unknown field "target"/);
  });

  it("refuses a missing, empty or mistyped field", () => {
    refused(JSON.stringify({ body: BASE.body, updatedAt: BASE.updatedAt }), /title must be a string/);
    refused(env({ title: "   " }), /title is empty/);
    refused(env({ body: 42 }), /body must be a string/);
    refused(env({ links: "https://merrymen.dev" }), /links must be a list/);
    refused(env({ links: ["https://merrymen.dev"] }), /links\[0\] must be an object/);
  });

  it("refuses JSON that is not an object", () => {
    refused("not json", /not valid JSON/);
    refused("[]", /must be a JSON object/);
    refused("null", /must be a JSON object/);
    refused('"Trading is paused"', /must be a JSON object/);
  });

  it("refuses an over-long notice", () => {
    refused(env({ title: "x".repeat(121) }), /title is longer than 120/);
    refused(env({ body: "x".repeat(1001) }), /body is longer than 1000/);
    refused(env({ links: Array.from({ length: 4 }, () => ({ label: "x", href: "https://merrymen.dev/" })) }), /at most 3 links/);
    refused(env({ body: "x".repeat(9000) }), /longer than 8192/);
  });

  it("refuses control and bidi-override characters, and a line break in a one-line field", () => {
    refused(env({ title: "Paused‮esumed" }), /title contains a control character/);
    refused(env({ body: "bell\u0007" }), /body contains a control character/);
    refused(env({ title: "two\nlines" }), /title contains a control character/);
    refused(env({ links: [{ label: "a\nb", href: "https://merrymen.dev/" }] }), /label contains a control character/);
  });

  it("refuses a time with no zone, or one that is not on the calendar", () => {
    refused(env({ updatedAt: "2026-10-05 18:00" }), /ISO-8601 time with a zone/);
    refused(env({ updatedAt: "2026-10-05T18:00:00" }), /ISO-8601 time with a zone/);
    refused(env({ updatedAt: 1791223200000 }), /ISO-8601 time with a zone/);
    refused(env({ updatedAt: "2026-02-31T00:00:00Z" }), /not a real time/);
    refused(env({ updatedAt: "2026-10-05T25:00:00Z" }), /not a real time/);
  });
});

describe("a link is https, on our host, and nothing more", () => {
  const href = (value: string) => env({ links: [{ label: "More", href: value }] });

  it("refuses a foreign host, including look-alikes", () => {
    refused(href("https://evil.example/"), /must point at merrymen\.dev or app\.merrymen\.dev/);
    refused(href("https://app.merrymen.dev.evil.example/"), /must point at/);
    refused(href("https://merrymen.dev.evil.example/"), /must point at/);
    refused(href("https://evilmerrymen.dev/"), /must point at/);
    refused(href("https://mcp.merrymen.dev/"), /must point at/);
    refused(href("https://app.merrymen.dev./"), /must point at/);
    // Userinfo that LOOKS like our host; the real host is the one after the @.
    refused(href("https://app.merrymen.dev@evil.example/"), /must not carry a username/);
  });

  it("refuses http", () => {
    refused(href("http://app.merrymen.dev/you"), /must use https/);
  });

  it("refuses javascript:, data: and other schemes", () => {
    refused(href("javascript:alert(1)"), /must use https/);
    refused(href("JavaScript:alert(document.cookie)"), /must use https/);
    refused(href("data:text/html,<script>alert(1)</script>"), /must use https/);
    refused(href("mailto:ops@merrymen.dev"), /must use https/);
  });

  it("refuses relative, credentialed, ported and whitespace-smuggled URLs", () => {
    refused(href("/you"), /not an absolute URL/);
    refused(href("//app.merrymen.dev/you"), /not an absolute URL/);
    refused(href("https://user:pw@app.merrymen.dev/"), /must not carry a username or password/);
    refused(href("https://app.merrymen.dev:8443/"), /must not name a port/);
    refused(href(" https://app.merrymen.dev/"), /no spaces/);
    refused(href("java\tscript:alert(1)"), /no spaces/);
  });
});

describe("the browser applies the same check", () => {
  it("drops a notice the route should never have sent", () => {
    // The banner validates again, so no layer in between can widen the rule.
    const evil = { ...BASE, tradingPaused: false, links: [{ label: "Claim", href: "javascript:alert(1)" }] };
    assert.equal(serviceNoticeFromWire(evil), null);
    assert.equal(serviceNoticeFromWire({ ...BASE, extra: 1 }), null);
    assert.equal(serviceNoticeFromWire("Trading is paused"), null);
  });

  it("accepts its own normalised output unchanged", () => {
    const notice = ok(env({ tradingPaused: true, links: [{ label: "You", href: "https://app.merrymen.dev/you" }] }));
    assert.deepEqual(serviceNoticeFromWire(JSON.parse(JSON.stringify(notice))), notice);
  });
});

describe("a dismissal is bound to every field", () => {
  const base = ok(env({ links: [{ label: "You", href: "https://app.merrymen.dev/you" }] }));

  it("is stable for the same notice, however it was written", () => {
    assert.equal(noticeRevision(base), noticeRevision(ok(env({
      title: ` ${BASE.title} `,
      updatedAt: "2026-10-05T18:00:00.000+00:00",
      links: [{ label: "You", href: "https://app.merrymen.dev/you" }],
    }))));
  });

  it("changes when any field is edited — not only the time", () => {
    const edits: Record<string, unknown>[] = [
      { title: "Trading is paused" },
      { body: "A corrected sentence." },
      { updatedAt: "2026-10-05T18:01:00Z" },
      { tradingPaused: true },
      { links: [] },
      { links: [{ label: "Account", href: "https://app.merrymen.dev/you" }] },
      { links: [{ label: "You", href: "https://app.merrymen.dev/home" }] },
    ];
    for (const edit of edits) {
      const edited = ok(env({ links: [{ label: "You", href: "https://app.merrymen.dev/you" }], ...edit }));
      assert.notEqual(noticeRevision(edited), noticeRevision(base), JSON.stringify(edit));
    }
  });
});

describe("tradingPaused is wording", () => {
  it("changes the label and nothing else about the notice", () => {
    const paused = ok(env({ tradingPaused: true }));
    const open = ok(env());
    assert.equal(noticeLabel(paused), "Trading paused");
    assert.equal(noticeLabel(open), "Service notice");
    assert.deepEqual({ ...paused, tradingPaused: false }, open);
  });

  it("is read by nothing but the route and the banner", () => {
    // Pinned by import rather than by name: `tradingPaused` is also a field of
    // FleetRecoveryView, which is the real hold. What must not happen is any
    // other module reading THIS one — the inactivity diagnosis, a chat fact,
    // the worker — and treating the operator's banner as tenant evidence.
    const root = process.cwd();
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|mjs|js)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) files.push(full);
      }
    };
    for (const dir of ["web/src", "worker/src", "packages", "sdk", "browser"]) {
      const full = path.join(root, dir);
      try { if (statSync(full).isDirectory()) walk(full); } catch { /* not in this checkout */ }
    }
    assert.ok(files.length > 100, `only ${files.length} source files found — the walk is broken`);
    const readers = files
      .filter((f) => /service-notice|MERRYMEN_SERVICE_NOTICE/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f))
      .sort();
    assert.deepEqual(readers, [
      "web/src/app/api/service-notice/route.ts",
      "web/src/lib/service-notice.ts",
    ]);
  });
});
