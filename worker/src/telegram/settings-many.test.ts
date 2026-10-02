/**
 * "TELL YOUR AGENT HOW YOU WANT IT TO WORK" — several changes, one approval.
 *
 * Asked for by an owner: describe how the agent should behave, have it
 * converted into settings, and approve with a button — from Telegram too — for
 * every setting. These pin who approves what: a chat ✅ only for what the chat
 * could always change; one dashboard button, with everything filled in, for
 * the rest; a signature for sealed limits; never a secret in a message.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { describe, it } from "node:test";

import { decodeProposalLink, RISK_PROFILES } from "../../../packages/core/src/index";
import { appliedManyText, chatMayApply, proposeManyChanges, proposeSettingChange, requestedChanges, singleChange, wantsManyPath, type ProposalContext } from "./settings-chat";

const ctx: ProposalContext = {
  current: { buyPerTickUsdg: 25, strategistStopLossBps: 0, takeProfitBps: 0, liveTradingEnabled: false, assetMode: "all", classMaxPositions: 3, strategy: "trencher" },
  allowedSymbols: ["QQQ", "NVDA"],
  strategies: ["steady-basket", "trencher", "llm-strategist"],
  hosted: true,
  signedPerTradeUsdg: 10,
  agentName: "Shogun",
};

describe("what the owner asked for", () => {
  it("reads the classifier's setting and every key=value it added", () => {
    assert.deepEqual(requestedChanges("buyPerTickUsdg", "$20", "strategistStopLossBps=8%; takeProfitBps=25%"), [
      { key: "buyPerTickUsdg", raw: "$20" },
      { key: "strategistStopLossBps", raw: "8%" },
      { key: "takeProfitBps", raw: "25%" },
    ]);
  });

  it("leaves a lone chat setting, and the dashboard pseudo-keys, on the path written for them", () => {
    assert.equal(wantsManyPath(requestedChanges("buyPerTickUsdg", "$20")), false);
    assert.equal(wantsManyPath(requestedChanges("liveTrading", "on")), false, "the pseudo-key keeps its own reply");
    assert.equal(wantsManyPath(requestedChanges("unknown", "", "liveTradingEnabled=on")), true, "a real dashboard key gets the approval link");
    assert.equal(wantsManyPath(requestedChanges("unknown", "", "buyPerTickUsdg=20; takeProfitBps=25%")), true);
  });
});

describe("one change, named only in `changes`", () => {
  it("is asked about like any single change, not answered with the list of what can change", () => {
    const requested = requestedChanges("unknown", "", "buyPerTickUsdg=$20");
    assert.equal(wantsManyPath(requested), false);
    const one = singleChange("unknown", "", requested);
    assert.deepEqual(one, { setting: "buyPerTickUsdg", value: "$20" });
    const p = proposeSettingChange(one.setting, one.value, ctx);
    assert.equal(p.kind, "ask");
    assert.match(p.text, /amount per buy/);
  });

  it("an intent's value reads back through the ordinary parser", () => {
    const requested = requestedChanges("unknown", "", "message me less");
    const one = singleChange("unknown", "", requested);
    assert.deepEqual(one, { setting: "telegramNotifyEveryMin", value: "60" });
    assert.equal(proposeSettingChange(one.setting, one.value, ctx).kind, "ask");
  });

  it("leaves a named setting exactly as the classifier gave it", () => {
    assert.deepEqual(singleChange("stop loss", "8%", requestedChanges("stop loss", "8%")), { setting: "stop loss", value: "8%" });
  });
});

describe("one approval in the chat, when every change is the chat's to make", () => {
  it("parks them together, with before and after for each", () => {
    const p = proposeManyChanges(requestedChanges("unknown", "", "buyPerTickUsdg=$20; strategistStopLossBps=8%"), ctx);
    assert.equal(p.kind, "ask-many");
    if (p.kind !== "ask-many") return;
    assert.deepEqual(p.changes, [{ key: "buyPerTickUsdg", value: 20 }, { key: "strategistStopLossBps", value: 800 }]);
    assert.match(p.text, /Here are the 2 changes:/);
    assert.match(p.text, /amount per buy<\/b>: \$25\.00 → <b>\$20\.00/);
    assert.match(p.text, /stop loss at<\/b>: off → <b>8%/);
    assert.match(p.text, /Nothing changes until you tap ✅/);
  });

  it("'be more careful' is the careful bundle — on the dashboard, because one of its six is a safety floor", () => {
    const p = proposeManyChanges(requestedChanges("unknown", "", "be more careful"), ctx);
    // maxImpactBps is a safety floor, so the whole bundle goes to the dashboard.
    assert.equal(p.kind, "reply");
    if (p.kind !== "reply") return;
    const carried = Object.fromEntries(decodeProposalLink(p.approve).map((c) => [c.key, c.value]));
    assert.deepEqual(carried, { ...RISK_PROFILES.careful.settings });
    assert.match(p.text, /only changed on the dashboard/);
  });

  it("says when the signed per-trade limit will still hold a bigger buy back", () => {
    const p = proposeManyChanges(requestedChanges("unknown", "", "buyPerTickUsdg=50; takeProfitBps=25%"), ctx);
    assert.match(p.text, /signed per-trade limit is \$10\.00/);
  });
});

describe("one dashboard button, when any change is the dashboard's", () => {
  it("carries every change, real money included, with the warning said in the chat too", () => {
    const p = proposeManyChanges(requestedChanges("unknown", "", "liveTradingEnabled=on; buyPerTickUsdg=$20"), ctx);
    assert.equal(p.kind, "reply");
    if (p.kind !== "reply") return;
    assert.deepEqual(decodeProposalLink(p.approve), [{ key: "liveTradingEnabled", value: true }, { key: "buyPerTickUsdg", value: 20 }]);
    assert.match(p.text, /⚠️ This lets the agent spend real money\./);
  });

  it("a value the chat's own spec refuses is sent to the dashboard, not dropped", () => {
    // 0 max launch coins means no limit; the chat may not lift a ceiling.
    const p = proposeManyChanges(requestedChanges("unknown", "", "classMaxPositions=no limit; buyPerTickUsdg=$20"), ctx);
    assert.equal(p.kind, "reply");
    if (p.kind !== "reply") return;
    assert.deepEqual(decodeProposalLink(p.approve).find((c) => c.key === "classMaxPositions"), { key: "classMaxPositions", value: 0 });
  });
});

describe("what is never approved here", () => {
  it("a sealed limit asks for a signature, and a key is never taken from a message", () => {
    const p = proposeManyChanges([{ key: "perTradeCap", raw: "100" }, { key: "llmApiKey", raw: "sk-ant-123456" }], ctx);
    assert.equal(p.kind, "reply");
    if (p.kind !== "reply") return;
    assert.equal(p.sign, true);
    assert.equal(p.approve, undefined);
    assert.match(p.text, /new signature/);
    assert.match(p.text, /never send AI provider key/);
    assert.doesNotMatch(p.text, /sk-ant/, "and the key is not echoed back");
  });

  it("nothing recognisable gets the one-line how-to", () => {
    const p = proposeManyChanges(requestedChanges("unknown", "", "make it nice"), ctx);
    assert.equal(p.kind, "reply");
    assert.match(p.text, /each buy \$20, stop loss 8%/);
  });
});

describe("the agent's name, among the changes or on its own", () => {
  const named: ProposalContext = { ...ctx, current: { ...ctx.current, agentName: "Shogun" } };

  it("is asked about with a ✅ — not answered with the list, and not sent to the dashboard", () => {
    const alone = requestedChanges("unknown", "", "agentName=Will Scarlet");
    assert.equal(wantsManyPath(alone), true, "the single path has no spec for the name");
    const p = proposeManyChanges(alone, named);
    assert.equal(p.kind, "ask-many");
    if (p.kind !== "ask-many") return;
    assert.deepEqual(p.changes, [{ key: "agentName", value: "Will Scarlet" }]);
    assert.match(p.text, /agent name<\/b>: Shogun → <b>Will Scarlet/);

    const both = proposeManyChanges(requestedChanges("unknown", "", "agentName=Marian; buyPerTickUsdg=$20"), named);
    assert.equal(both.kind, "ask-many", "a name and a chat setting are both the chat's to make");
  });

  it("is held to the rule /name applies, so a name it refuses is refused here too", () => {
    for (const bad of ["007", "a name far longer than twenty-four"]) {
      const p = proposeManyChanges(requestedChanges("unknown", "", `agentName=${bad}`), named);
      assert.equal(p.kind, "reply", bad);
      if (p.kind !== "reply") return;
      assert.equal(p.approve, undefined, `${bad} is not carried to the dashboard either`);
      assert.match(p.text, /isn't a usable agent name/);
    }
    assert.equal(chatMayApply("agentName", "  José  "), true);
    assert.equal(chatMayApply("agentName", "007"), false);
    assert.equal(chatMayApply("agentName", 7), false);
  });

  it("reads back by its label once applied", () => {
    assert.match(appliedManyText([{ key: "agentName", value: "Marian" }], true), /agent name: <b>Marian/);
  });
});

describe("the done message", () => {
  it("lists what changed", () => {
    const t = appliedManyText([{ key: "buyPerTickUsdg", value: 20 }, { key: "strategistStopLossBps", value: 800 }], true);
    assert.match(t, /2 settings changed/);
    assert.match(t, /amount per buy: <b>\$20\.00/);
    assert.match(t, /within a minute/);
  });
});

describe("the service wires it", () => {
  const src = require("node:fs").readFileSync(new URL("./service.ts", import.meta.url), "utf8") as string;

  it("the dashboard button opens Settings with the proposal, at the panel", () => {
    assert.match(src, /text: "✅ Review & approve", url: `\$\{dashboardBase\(\)\}\/settings\?\$\{PROPOSAL_PARAM\}=\$\{m\.approve\}#proposal`/);
  });

  it("applies several ALL OR NONE: every change is re-checked before anything is written", () => {
    const i = src.indexOf("applySettings: (changes) =>");
    const body = src.slice(i, i + 2600);
    const check = body.indexOf("chatMayApply(key, value)");
    const strategy = body.indexOf("deps.setStrategy(");
    const name = body.indexOf("applyName(");
    const write = body.indexOf("patchSettingsFile(");
    assert.ok(check > 0 && check < strategy, "validated before anything is written");
    assert.ok(strategy < name && name < write, "the strategy switch, the one write that can still refuse, goes first");
    assert.match(body, /rememberChatSetting\(stateRef, patch, now\(\)\)/, "and hosted, it survives the reconcile");
  });

  it("a name approved among several is written exactly as /name writes it", () => {
    assert.match(src, /setName: applyName,/);
  });
});
