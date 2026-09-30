/**
 * THE CONNECTION STRIP IS KEYED, AND DELIBERATELY NOT SHIPPED.
 *
 * ── WHY IT IS HELD BACK ──────────────────────────────────────────────────
 *
 * The strip was translated into all ten languages and then withdrawn, for the
 * reason i18n.tsx opens with: a half-translated SCREEN is worse than an English
 * one. The card sits on Home and in the desktop portfolio rail, and both are
 * still English around it — "Portfolio balance", "Deposit", "Leaderboard",
 * "Your agent", "Add funds". Shipping it produced a Spanish status card under
 * an English heading, which is the exact shape the namespace rule exists to
 * prevent: a reader cannot tell whether the English line is untranslated or a
 * term they do not know, and the second reads as their own failure.
 *
 * So this follows the precedent `settings.*` already set — the English keys
 * stay, because the screen renders from them today, and no locale file carries
 * a translation. The namespace is therefore incomplete everywhere and falls
 * back whole, which is the mechanism doing the work rather than any flag.
 *
 * ── WHERE THE TRANSLATIONS WENT ──────────────────────────────────────────
 *
 * Not lost, and not rewritten from scratch when this ships: all ten are in
 * commit 0cf6a485, and `git show 0cf6a485 -- web/src/lib/messages` restores
 * them verbatim. This test comes off in the same change that puts them back,
 * and not before — which is when Home and the desktop rail are extracted.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { translate, translatedNamespaces } from "@/lib/i18n";
import { EN, type MessageKey } from "@/lib/messages/en";
import { CATALOGUES } from "@/lib/messages";
import { DEFAULT_LOCALE, SUPPORTED } from "@/lib/locale";

const STRIP_KEYS = (Object.keys(EN) as MessageKey[]).filter((k) => k.startsWith("strip."));

describe("the strip is keyed in English", () => {
  it("has its keys, because the card renders from them", () => {
    assert.ok(STRIP_KEYS.length >= 20, `only ${STRIP_KEYS.length} strip keys`);
  });

  it("renders English for the default locale", () => {
    for (const key of STRIP_KEYS) {
      assert.equal(translate(DEFAULT_LOCALE, key), EN[key]);
    }
  });
});

describe("and deliberately does not ship", () => {
  it("IS WITHHELD FROM EVERY LOCALE FILE", () => {
    // The same assertion the Settings guard makes, for the same reason. If a
    // translation reappears here before Home and the rail are extracted, it
    // will render a Spanish card under an English heading.
    for (const [tag, table] of Object.entries(CATALOGUES)) {
      const shipped = Object.keys(table ?? {}).filter((k) => k.startsWith("strip."));
      assert.deepEqual(
        shipped,
        [],
        `${tag} ships ${shipped.length} strip key(s) while Home and the desktop rail are still English`,
      );
    }
  });

  it("so no locale claims the strip is translated", () => {
    // Asserted directly rather than inferred from the keys: a namespace can be
    // complete and still withdrawn by `REQUIRES`, so the conclusion a reader
    // actually gets is the thing worth pinning.
    for (const { tag } of SUPPORTED) {
      if (tag === DEFAULT_LOCALE) continue;
      assert.ok(
        !translatedNamespaces(tag).includes("strip"),
        `${tag} would render a Spanish-style card on an English screen`,
      );
    }
  });

  it("and every reader therefore gets the English words", () => {
    // The behaviour, not the bookkeeping. This is what the fallback is FOR.
    for (const { tag } of SUPPORTED) {
      for (const key of STRIP_KEYS) {
        assert.equal(translate(tag, key), EN[key], `${tag}/${key}`);
      }
    }
  });
});

describe("what the English words may not be", () => {
  it("never renders a raw key or an empty string", () => {
    for (const key of STRIP_KEYS) {
      const out = translate(DEFAULT_LOCALE, key, { bot: "x" });
      assert.notEqual(out.trim(), "", `${key} is empty`);
      assert.notEqual(out, key, `${key} rendered its own key`);
    }
  });

  it("keeps the {bot} placeholder, so the bot's name survives", () => {
    // A dropped placeholder renders a sentence with the name missing rather
    // than one that fails — the worst shape, because it reads as a product
    // that forgot who you connected.
    assert.match(translate(DEFAULT_LOCALE, "strip.tg.connectedAs", { bot: "merrybot" }), /merrybot/);
  });

  it("leaves the product names out of the catalogue entirely", () => {
    // `Telegram` and `Trencher` are identifiers a reader matches against a chat
    // app and a settings heading. A key for either would invite a translation,
    // and a translated product name is a product nobody can find.
    //
    // WIDENED TO `string` ON PURPOSE: `EN[key]` is a union of literal types, so
    // comparing it against a name no key currently holds is something
    // TypeScript can prove is always true and rejects (TS2367). The check is
    // about what a FUTURE key might contain, which is a runtime question.
    for (const key of STRIP_KEYS) {
      const english: string = EN[key];
      assert.ok(english !== "Telegram" && english !== "Trencher", `${key} keys a product name`);
    }
  });

  it("keeps the link command out of the copy", () => {
    // `/link CODE` is retyped verbatim into a chat. It renders as its own
    // element precisely so no message carries it — a message that did would put
    // an identifier where a translator can edit it.
    for (const key of STRIP_KEYS) {
      assert.ok(!EN[key].includes("/link"), `${key} embeds the link command in translatable copy`);
    }
  });
});
