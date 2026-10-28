import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { AccountState } from "./HostedControls";
import type { CreateAgent as CreateAgentType } from "./screens/CreateAgent";
import type { fetchAccountForSession } from "./account-session";

type AccountRead = Awaited<ReturnType<typeof fetchAccountForSession>>;
type CreationProps = Parameters<typeof CreateAgentType>[0];
let SetupClient: typeof import("../app/connect/setup/[id]/SetupClient").SetupClient;
let testDom: typeof import("./test-dom").testDom;
let ui: ReturnType<typeof testDom>;
let answer: () => Promise<AccountRead>;
let props: CreationProps;
const id = `prp_${"f".repeat(32)}`;
const account = (letter: string): AccountState => ({
  session: { hosted: true, address: `0x${letter.repeat(40)}` },
  status: { exists: false, tenant: `0x${letter.repeat(40)}` },
});
const ready = (letter: string): AccountRead => ({ kind: "ready", account: account(letter) });

before(async () => {
  const boot = new JSDOM("<!doctype html><p></p>");
  Object.assign(globalThis, { window: boot.window, document: boot.window.document });
  ({ testDom } = await import("./test-dom"));
  Reflect.deleteProperty(globalThis, "window"); Reflect.deleteProperty(globalThis, "document"); boot.window.close();
  const file = fileURLToPath(new URL("../app/connect/setup/[id]/SetupClient.tsx", import.meta.url));
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const load = loader._load;
  const intercepted = mock.method(loader, "_load", function (this: typeof loader, name: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename === file) {
      if (name === "@/terminal/account-session") return { fetchAccountForSession: () => answer() };
      if (name === "@/terminal/screens/CreateAgent") return { CreateAgent: (incoming: CreationProps) => {
        const [finished,setFinished]=React.useState(false);
        props = incoming;
        return React.createElement("div", null,
          React.createElement("span", { "data-owner": incoming.account?.session.address ?? "" }, incoming.accountFailed ? "Account unavailable" : incoming.account?.session.address ?? "Waiting for account"),
          finished?React.createElement("p", { "data-completion": true }, "Creation screen completion")
            :React.createElement("button", { onClick: ()=>setFinished(true) }, "Finish test handoff"));
      } };
    }
    return load.call(this, name, parent, isMain);
  });
  try { SetupClient = createRequire(import.meta.url)(file).SetupClient; }
  finally { intercepted.mock.restore(); }
});
beforeEach(() => { ui = testDom(); answer = async () => ready("a"); });
afterEach(async () => { await ui.close(); });

it("the handoff keeps completion in the owner-bound creation screen without another completion step", async () => {
  await ui.render(React.createElement(SetupClient, { id }));
  assert.equal(props.assistantProposalId, id);
  assert.equal(props.account?.session.address, account("a").session.address);
  assert.doesNotMatch(ui.container.textContent!, /Back to your chat/);
  await ui.click("Finish test handoff");
  assert.match(ui.container.textContent!, /Creation screen completion/);
  assert.doesNotMatch(ui.container.textContent!, /Back to your chat|Done — return to chat/);
  assert.equal(props.account?.session.address,account("a").session.address);
  assert.equal(ui.container.querySelector('a[href^="https://"]'), null, "the handoff invents no chat callback or external return URL");
});

it("a late old-account read cannot replace a new signed-in owner", async () => {
  let old!: (value: AccountRead) => void;
  answer = () => new Promise(resolve => { old = resolve; });
  await ui.render(React.createElement(SetupClient, { id }));
  answer = async () => ready("b");
  await act(async () => { props.onSignedIn(); });
  assert.equal(props.account?.session.address, account("b").session.address);
  await act(async () => { old(ready("a")); });
  assert.equal(props.account?.session.address, account("b").session.address);
  assert.doesNotMatch(ui.container.textContent!, new RegExp(account("a").session.address!));
});

it("an unreadable account clears both the prior owner and the creation screen's completion state", async () => {
  await ui.render(React.createElement(SetupClient, { id }));
  const refresh = props.onRefresh;
  await ui.click("Finish test handoff");
  answer = async () => ({ kind: "unverified", error: new Error("tenant mismatch") });
  await act(async () => { refresh(); });
  assert.equal(props.account, null);
  assert.equal(props.accountFailed, true);
  assert.match(ui.container.textContent!, /Account unavailable/);
  assert.equal(ui.container.querySelector('[data-completion]'),null);
});
