import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { confirmKeyboard, mintNonce, parseConfirmData } from "./buttons";
import { appliedText, proposeSettingChange, resolveSettingName, settingsListText, type ProposalContext } from "./settings-chat";

const ctx: ProposalContext = {
  current: { buyPerTickUsdg: 25, strategistStopLossBps: 0, telegramNotifyEnabled: true, strategy: "trencher", assetMode: "all", basketSymbols: ["QQQ"] },
  allowedSymbols: ["QQQ", "NVDA"],
  strategies: ["steady-basket", "trencher", "llm-strategist"],
  hosted: true,
  signedPerTradeUsdg: 10,
  agentName: "Shogun",
};

describe("proposeSettingChange — a question, never a change", () => {
  it("asks before changing, in plain words, with before and after", () => {
    const p = proposeSettingChange("buyPerTickUsdg", "$20", ctx);
    assert.equal(p.kind, "ask");
    if (p.kind !== "ask") return;
    assert.equal(p.key, "buyPerTickUsdg");
    assert.equal(p.value, 20);
    assert.match(p.text, /amount per buy/);
    assert.match(p.text, /\$25\.00/);
    assert.match(p.text, /\$20\.00/);
  });

  it("says when the signed per-trade limit will still hold a bigger size back", () => {
    const p = proposeSettingChange("buyPerTickUsdg", "50", ctx);
    assert.equal(p.kind, "ask");
    assert.match((p as { text: string }).text, /signed per-trade limit is \$10\.00/);
  });

  it("a sealed limit gets the Sign button, never a patch", () => {
    for (const k of ["perTradeCap", "dailyCap", "expiry", "drawdownBreaker", "tokens"]) {
      const p = proposeSettingChange(k, "50", ctx);
      assert.equal(p.kind, "reply", k);
      assert.equal((p as { button?: string }).button, "sign", k);
    }
  });

  it("the step to real money is dashboard-only, with a Settings button", () => {
    const p = proposeSettingChange("liveTrading", "on", ctx);
    assert.equal(p.kind, "reply");
    assert.equal((p as { button?: string }).button, "dashboard");
    assert.match((p as { text: string }).text, /dashboard/);
  });

  it("posting on X is dashboard-only: the warning naming the X account is shown there, never in a chat", () => {
    const text =
      "I can't turn posting on X on or off from chat. That's done only in Settings → Posting on X, on the dashboard or in the app, where you can also skip a post before it goes out. On the dashboard you can also choose what it posts there: the coins it buys, passing thoughts, and how many a day.";
    for (const [setting, value] of [["xPosting", "on"], ["post on X", "yes"], ["twitter", "on"], ["tweets", "off"], ["posting on x", "off"], ["posting on x", ""], ["X settings", "change"]] as const) {
      const p = proposeSettingChange(setting, value, ctx);
      assert.deepEqual(p, { kind: "reply", text, button: "dashboard", anchor: "x-posting" }, setting);
    }
  });

  it("the X reply answers an owner trying to STOP posting too: off as well as on, the app as well as the dashboard", () => {
    // The owner most likely to type "tweets off" is one whose Merryman just
    // posted something they did not like; a reply that only says how posting
    // is switched ON reads as if the command worked, or as if it was off.
    const p = proposeSettingChange("tweets", "off", ctx) as { kind: string; text: string };
    assert.equal(p.kind, "reply");
    assert.match(p.text, /\bon or off\b/);
    assert.match(p.text, /can't .* from chat/);
    assert.match(p.text, /dashboard/);
    assert.match(p.text, /\bapp\b/);
  });

  it("Telegram groups are dashboard-only: every way of naming them gets the Settings button, never a question", () => {
    // A group is a chat anyone in it can type into, and "look at coins people
    // post" is the switch a group's coin nominations come through — so none of
    // the three is changed by text (docs/tg-groups.md "Settings").
    const text =
      "Telegram groups are switched in Settings → Telegram on the dashboard (or Settings in the app): whether I hang out in groups, whether I look at coins people post there, and how chatty I am. Anyone in a group can talk to me, so none of that changes by text.";
    for (const [setting, value] of [
      ["telegramGroups", "off"],
      ["group chats", "off"],
      ["Group chat", "on"],
      ["groups", "off"],
      ["GC", "quiet"],
      ["telegram groups", "on"],
      ["telegram-groups", ""],
      ["chattiness", "chatty"],
      ["group coins", "off"],
      // The real keys too: `/set telegramGroupsChattiness chatty` must not
      // fall through to the generic list, which reads as "no such setting".
      ["telegramGroupsEnabled", "off"],
      ["telegramGroupCoinsEnabled", "on"],
      ["telegramGroupsChattiness", "chatty"],
    ] as const) {
      const p = proposeSettingChange(setting, value, ctx);
      assert.deepEqual(p, { kind: "reply", text, button: "dashboard", anchor: "telegram-groups" }, `${setting} ${value}`);
    }
  });

  it("the Telegram groups reply names all three dials, and says why it is not a text change", () => {
    const p = proposeSettingChange("groups", "less chatty", ctx) as { kind: string; text: string };
    assert.equal(p.kind, "reply");
    assert.match(p.text, /Settings → Telegram/);
    assert.match(p.text, /hang out in groups/);
    assert.match(p.text, /coins people post/);
    assert.match(p.text, /how chatty/);
    assert.match(p.text, /\bapp\b/);
    assert.match(p.text, /Anyone in a group can talk to me/);
    // No web-room name in the reply: "Telegram groups" is the product term.
    assert.doesNotMatch(p.text, /group ?chat/i);
  });

  it("an out-of-range value is refused with the reason, and nothing is parked", () => {
    const p = proposeSettingChange("strategistStopLossBps", "250%", ctx);
    assert.equal(p.kind, "reply");
    assert.match((p as { text: string }).text, /can't go above/);
  });

  it("no change when it already has that value", () => {
    const p = proposeSettingChange("buyPerTickUsdg", "25", ctx);
    assert.equal(p.kind, "reply");
    assert.match((p as { text: string }).text, /already/);
  });

  it("hosted, only a strategy that exists", () => {
    assert.equal(proposeSettingChange("strategy", "moonshot", ctx).kind, "reply");
    assert.equal(proposeSettingChange("strategy", "steady basket", ctx).kind, "ask");
  });

  it("an unknown setting gets the list of what CAN change, not a guess", () => {
    const p = proposeSettingChange("unknown", "5", ctx);
    assert.equal(p.kind, "reply");
    assert.match((p as { text: string }).text, /amount per buy/);
  });

  it("with no value, it says what it is now and asks", () => {
    const p = proposeSettingChange("strategistStopLossBps", "", ctx);
    assert.equal(p.kind, "reply");
    assert.match((p as { text: string }).text, /off \(0%\) right now/);
  });

  it("escapes the owner's words — they go back out as HTML", () => {
    const p = proposeSettingChange("strategy", "<b>", ctx);
    assert.doesNotMatch((p as { text: string }).text, /<b>(?!.*<\/b>)/);
  });
});

describe("resolveSettingName — /set takes words, not keys", () => {
  it("matches keys, labels and the words owners use", () => {
    assert.equal(resolveSettingName("stop loss"), "strategistStopLossBps");
    assert.equal(resolveSettingName("Amount per buy"), "buyPerTickUsdg");
    assert.equal(resolveSettingName("notifications"), "telegram", "all notifications is dashboard-only");
    assert.equal(resolveSettingName("trade messages"), "telegramNotifyEveryMin", "fewer trade pings is batching");
    assert.equal(resolveSettingName("liveTrading"), "liveTrading");
    assert.equal(resolveSettingName("Post on X"), "xPosting");
    assert.equal(resolveSettingName("x-posting"), "xPosting");
    assert.equal(resolveSettingName("Twitter"), "xPosting");
    for (const words of ["group chats", "groups", "gc", "telegram groups", "Telegram Groups", "telegramGroups", "telegramGroupsChattiness"]) {
      assert.equal(resolveSettingName(words), "telegramGroups", words);
    }
    // The broader Telegram words keep their own meanings.
    assert.equal(resolveSettingName("telegram"), "telegram");
    assert.equal(resolveSettingName("colour of the sky"), null);
  });

  it("/set stop loss 8% reaches the same question the classifier would", () => {
    const p = proposeSettingChange("stop loss", "8%", ctx);
    assert.equal(p.kind, "ask");
    assert.equal((p as { value: unknown }).value, 800);
  });
});

describe("launchpad buying — where it is, by every name it goes by", () => {
  // An owner told launchpad buying was "on the dashboard" answered "I don't
  // see launchpad setting anywhere?": the page called it "class route", inside
  // a closed group, and the agent guessed at where it was.
  it("every name for it reaches the dashboard reply, never a question or the generic list", () => {
    for (const [setting, value] of [
      ["launchSniping", "on"],
      ["launchpad buying", "on"],
      ["Launchpad buying", ""],
      ["launchpad sniping", "on"],
      ["launch buying", "off"],
      ["launchpad", "on"],
      ["class route", "on"],
      ["Class sniping", "on"],
      ["classSnipeEnabled", "true"],
    ] as const) {
      const p = proposeSettingChange(setting, value, ctx) as { kind: string; button?: string; anchor?: string; text: string };
      assert.equal(p.kind, "reply", setting);
      assert.equal(p.button, "dashboard", setting);
      assert.equal(p.anchor, "launchpad-buying", setting);
    }
  });

  it("names the place on the page, the switch's own label, and what else must be set", () => {
    const p = proposeSettingChange("launchpad buying", "on", ctx) as { text: string };
    assert.match(p.text, /Settings → Custom tokens &amp; discovery/, "escaped for Telegram HTML");
    assert.doesNotMatch(p.text, /& /, "no bare ampersand, which Telegram refuses");
    assert.match(p.text, /"launchpad buying \(class route\)"/);
    assert.match(p.text, /button below opens it/);
    assert.match(p.text, /scout mode on/);
    assert.match(p.text, /max per token/);
    assert.match(p.text, /live trading on/);
    assert.match(p.text, /Class vault factory contract/);
    assert.match(p.text, /Advanced settings → Connections/);
    assert.match(p.text, /re-signed/);
  });

  it("each dashboard-only reply whose control has an id on the page links straight to it", () => {
    const anchor = (k: string) => (proposeSettingChange(k, "on", ctx) as { anchor?: string }).anchor;
    assert.equal(anchor("memecoinLive"), "trencher-mode");
    assert.equal(anchor("telegram"), "telegram");
    // No id for these on the page: the button opens Settings at the top, and
    // the reply carries no anchor field at all.
    assert.equal("anchor" in proposeSettingChange("liveTrading", "on", ctx), false);
    assert.equal("anchor" in proposeSettingChange("aiProvider", "x", ctx), false);
  });

  it("the page has every id an anchor names", () => {
    const page = readFileSync(new URL("../../../web/src/terminal/screens/Settings.tsx", import.meta.url), "utf8");
    for (const k of ["launchSniping", "memecoinLive", "telegram", "telegramGroups", "xPosting"]) {
      const id = (proposeSettingChange(k, "on", ctx) as { anchor?: string }).anchor;
      assert.ok(id, k);
      assert.match(page, new RegExp(`id="${id}"`), `${k} → #${id}`);
    }
  });
});

describe("a value asked for is remembered", () => {
  it("'What should it be?' marks the setting so a bare reply answers it", () => {
    const p = proposeSettingChange("strategistStopLossBps", "", ctx);
    assert.equal((p as { awaitKey?: string }).awaitKey, "strategistStopLossBps");
  });

  it("turning ALL notifications off answers with the dashboard button", () => {
    const p = proposeSettingChange("telegram", "off", ctx);
    assert.equal((p as { button?: string }).button, "dashboard");
    assert.match((p as { text: string }).text, /batch/);
  });
});

describe("the list and the done message", () => {
  it("/settings shows every changeable setting with its value", () => {
    const t = settingsListText(ctx.current);
    assert.match(t, /amount per buy: <b>\$25\.00<\/b>/);
    assert.doesNotMatch(t, /trade messages: /, "the master notification switch is not listed");
  });

  it("says when it takes effect", () => {
    assert.match(appliedText("buyPerTickUsdg", 20, true), /\$20\.00.*within a minute/);
  });
});

describe("confirm buttons carry a nonce, never the action", () => {
  it("round-trips its own data and nothing else", () => {
    const n = mintNonce();
    assert.match(n, /^[a-z2-7]{10}$/);
    const [[yes, no]] = confirmKeyboard(n) as unknown as [[{ callbackData: string }, { callbackData: string }]];
    assert.deepEqual(parseConfirmData(yes.callbackData), { yes: true, nonce: n });
    assert.deepEqual(parseConfirmData(no.callbackData), { yes: false, nonce: n });
    assert.ok(Buffer.byteLength(yes.callbackData) <= 64, "Telegram's limit");
    for (const forged of ["mm:y:", "mm:x:abcdefghij", "mm:y:ABCDEFGHIJ", "transfer:0xabc", "mm:y:abcdefghij;kill"]) {
      assert.equal(parseConfirmData(forged), null, forged);
    }
  });

  it("two nonces differ", () => {
    assert.notEqual(mintNonce(), mintNonce());
  });
});

describe("INVARIANT: a press answers only the question parked for the presser", () => {
  const src = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("const handleCallback = async"), src.indexOf("const pollOnce = async"));

  it("keys the lookup by the PRESSER, and checks nonce and action identity before confirming", () => {
    assert.match(body, /const key = `\$\{cb\.chatId\}:\$\{cb\.fromId\}`/);
    assert.match(body, /meta\.nonce !== parsed\.nonce/);
    assert.match(body, /parked !== meta\.action/);
    assert.ok(body.indexOf("parked !== meta.action") < body.indexOf("executeCommand("), "checked before anything runs");
  });

  it("applies the allowlist and the group rule to presses", () => {
    assert.match(body, /telegramAllowlist\.includes\(cb\.chatId\) \|\| cfg\.telegramAllowlist\.includes\(cb\.fromId\)/);
    assert.match(body, /cb\.chatId !== cb\.fromId && !cfg\.telegramAllowlist\.includes\(cb\.fromId\)/);
  });

  it("answers every press, so no button spins for ever", () => {
    const returns = body.split("return;").length - 1;
    const answers = body.split("answerCallbackQuery(").length - 1;
    assert.ok(answers >= returns + 1, `${answers} answers for ${returns} early returns plus the normal path`);
  });

  it("typed yes/no only ever confirms a SETTINGS question", () => {
    const i = src.indexOf('"YES" ANSWERS A SETTINGS QUESTION');
    const shortcut = src.slice(i, i + 1200);
    assert.match(shortcut, /parked\?\.kind === "setting" && answerableNow/);
    assert.match(src, /typedAnswerable\.delete\(senderKey\)/, "every new message uses up the eligibility");
    assert.match(src, /if \(meta\?\.action\.kind === "setting"\) typedAnswerable\.add\(pendingKey\)/);
  });

  it("a press never wipes another member's live question", () => {
    assert.match(body, /!\[\.\.\.pendingMeta\.values\(\)\]\.some\(\(m\) => m\.nonce === parsed\.nonce\)/);
  });
});
