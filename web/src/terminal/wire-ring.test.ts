/**
 * THE RING IS A CLASS ON A RENDERED ELEMENT, so this renders one.
 *
 * WHY THIS TEST EXISTS AT ALL. The wire feature shipped complete and invisible:
 * a store, a route, an orchestrator transport, a desk tool and a finished
 * button, with nothing on any screen. `mounted.test.ts` now catches the file
 * being unreachable. It cannot catch the next failure along — a file that IS
 * mounted and renders the wrong thing — because an import graph knows nothing
 * about output. So this asserts the output.
 *
 * WHY NOT .test.tsx. The runner globs `*.test.ts`; a `.tsx` test is not
 * collected and would pass by never running, which is the exact shape of
 * vacuous guard this suite already paid for once. Hence `createElement` rather
 * than JSX — the ugliness is the price of the file being executed.
 *
 * WHY THE CONTEXT IS SEEDED RATHER THAN THE PROVIDER DRIVEN. `WiredProvider`
 * fills itself from a `fetch` inside `useEffect`, and `useEffect` does not run
 * during static rendering. A test that wrapped `Face` in the real provider
 * would observe an empty `wired` set — which is what a DELETED feature also
 * produces. Seeding is what makes the positive case falsifiable.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WiredContext } from "@/components/WiredProvider";

/**
 * THE CLASSIC-RUNTIME SHIM, and why it is here rather than in a config.
 *
 * `web/tsconfig.json` sets `"jsx": "preserve"` — correct, because Next does the
 * JSX transform itself. `tsx`, running this test, sees `preserve` and falls
 * back to the CLASSIC transform, which compiles every tag to
 * `React.createElement(...)` against a global that ESM never defines. Importing
 * any `.tsx` module therefore dies with "React is not defined" — which is why
 * no test in this repo had imported one before, and why the components were
 * only ever checked by reading their source.
 *
 * Changing `jsx` to `react-jsx` would fix the test and change what ships, so it
 * is not on the table. The shim is set BEFORE the dynamic import below, since a
 * static import is hoisted above every statement and would run the module first.
 *
 * Loaded lazily inside the tests rather than at the top, because tsx emits CJS
 * here and top-level await is not available in that format.
 */
(globalThis as unknown as { React: typeof React }).React = React;

let mod: typeof import("./ui") | null = null;
async function faceComponent(): Promise<typeof import("./ui").Face> {
  mod ??= await import("./ui");
  return mod.Face;
}

const WIRED = "0123456789abcdef";
const OTHER = "fedcba9876543210";

/** Render one Face with the viewer reading exactly `wired`. */
async function face(props: { name: string; slug?: string | null; large?: boolean; small?: boolean }, wired: string[]): Promise<string> {
  const Face = await faceComponent();
  return renderToStaticMarkup(
    createElement(
      WiredContext.Provider,
      { value: { wired, max: 8, known: true, toggle: async () => {} } },
      createElement(Face, props),
    ),
  );
}

/** The class attribute of the outermost element, whatever order React emits. */
function classOf(markup: string): string {
  return /class="([^"]*)"/.exec(markup)?.[1] ?? "";
}

describe("the wire ring", () => {
  it("marks an agent the viewer's agent reads", async () => {
    const cls = classOf(await face({ name: "Shogun", slug: WIRED }, [WIRED]));
    assert.ok(
      cls.split(/\s+/).includes("wired"),
      `a wired agent's face must carry the ring class, got class="${cls}"`,
    );
  });

  it("leaves every other agent unmarked", async () => {
    // The half that fails loudly if `includes` is ever loosened to a truthy
    // check or a prefix match: OTHER is the same length and alphabet as WIRED.
    const cls = classOf(await face({ name: "SirSendIt", slug: OTHER }, [WIRED]));
    assert.ok(
      !cls.split(/\s+/).includes("wired"),
      `an unwired agent must carry no ring, got class="${cls}"`,
    );
  });

  it("draws nothing for a signed-out viewer", async () => {
    const cls = classOf(await face({ name: "Shogun", slug: WIRED }, []));
    assert.ok(!cls.split(/\s+/).includes("wired"), `empty set must draw no ring, got class="${cls}"`);
  });

  it("does not ring an agent that has no slug", async () => {
    // A NULL SLUG IS NOT A MATCH. `wired` is a string[]; a careless
    // `wired.includes(slug as string)` with slug null is false today by luck,
    // but the guard that makes it true by rule is the `slug != null` test —
    // and this is what fails if somebody removes it and the set ever contains
    // an empty string.
    const cls = classOf(await face({ name: "Anon", slug: null }, ["", WIRED]));
    assert.ok(!cls.split(/\s+/).includes("wired"), `a slugless face must never ring, got class="${cls}"`);
  });

  it("keeps the size variant it was given", async () => {
    // The ring is APPENDED to the size class, not substituted for it. Getting
    // this wrong shrinks every wired avatar in the feed to the default size,
    // which is the kind of bug that reads as a styling accident forever.
    const cls = classOf(await face({ name: "Shogun", slug: WIRED, large: true }, [WIRED]));
    const parts = cls.split(/\s+/);
    assert.ok(parts.includes("face") && parts.includes("lg"), `expected the lg variant, got class="${cls}"`);
    assert.ok(parts.includes("wired"), `expected the ring, got class="${cls}"`);
  });
});

/**
 * THE CONTROL'S FOUR STATES.
 *
 * WireButton has no props but `slug` and `name`; everything it renders comes
 * from context, so its four branches are four context values and nothing else.
 * They are worth pinning because each one is a different SENTENCE, and the
 * sentences are the feature — a follow is an input to a decision, never a
 * trigger for one, and the button says so before the click rather than after.
 */
describe("the wire control", () => {
  async function wireButton(wired: string[], known: boolean, max = 8): Promise<string> {
    const { WireButton } = await import("@/components/WireButton");
    return renderToStaticMarkup(
      createElement(
        WiredContext.Provider,
        { value: { wired, max, known, toggle: async () => {} } },
        createElement(WireButton, { slug: WIRED, name: "Shogun" }),
      ),
    );
  }

  it("asks a signed-out visitor to deploy an agent, and says why", async () => {
    // `known: false` is "we do not know yet", NOT "you follow nobody" — the
    // distinction WiredProvider's own comment insists on. It must not render a
    // toggle that would fail.
    const html = await wireButton([], false);
    assert.match(html, /Deploy an agent to wire this in/);
    assert.ok(!/wire in<\/button>/.test(html), "a signed-out visitor must get no toggle");
  });

  it("offers to wire an agent that is not yet wired, and shows the budget", async () => {
    const html = await wireButton([], true);
    assert.match(html, />wire in</);
    assert.match(html, /0 \/ 8/);
    assert.match(html, /Nothing here can make it trade/);
  });

  it("says so when the agent is already wired", async () => {
    const html = await wireButton([WIRED], true);
    assert.match(html, />wired</);
    assert.match(html, /1 \/ 8/);
    // THE LOAD-BEARING SENTENCE. It is the product's whole position on
    // following and it must survive every state, not just the invitation.
    assert.match(html, /Nothing here can make it trade/);
  });

  it("refuses at capacity without pretending it is an error", async () => {
    const full = Array.from({ length: 8 }, (_, i) => `aaaaaaaaaaaaaaa${i}`);
    const html = await wireButton(full, true);
    assert.match(html, /disabled/);
    assert.match(html, /Unwire one\s+to make room|Unwire one to make room/);
    assert.match(html, /8 \/ 8/);
  });
});
