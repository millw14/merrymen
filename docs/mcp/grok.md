# Merrymen with Grok and Grok Bot

Use Merrymen's existing hosted MCP server to inspect your Merryman, prepare
setup for your approval, and follow its actual running state. You do not need
an xAI API key or another trading worker.

Start at [Merrymen's connection page](https://app.merrymen.dev/connect/mcp).
Server address: `https://mcp.merrymen.dev/mcp`.

## Choose the right Grok product

| Product | Connection route | What is established |
|---|---|---|
| Grok chat | Custom remote MCP connector | Officially supported on Grok web; connectors also ship on iOS and Android. |
| Grok Bot | MCP/plugin connection in its own app | Officially supports Cursor-compatible MCP servers, plugins and skills. Merrymen's native-client acceptance test is still pending. |
| Grok Build | Developer CLI with `grok mcp` | Separate from Grok chat and Grok Bot. |

These are product capabilities, not claims that Merrymen is in a public
marketplace or has completed sign-in testing in every client.

## Grok chat

1. In Grok, open **Plugins → Connectors**, or open
   [Grok Connectors](https://grok.com/connectors).
2. Select **New Connector → Custom**, name it **Merrymen**, and enter the
   server address above. Select **Add Connector** to start authentication.
3. Complete Merrymen OAuth in your own browser. Sign in, select the shared
   agent and permissions, and approve the connection.
4. Return to Grok and ask, “Set up my Merryman” or “How is my Merryman doing?”

This is a one-time manual connection. Asking Grok to connect Merrymen by name
can search only its available catalog and report that Merrymen is unavailable;
that does not establish whether the **Custom** option supports the server.
The custom route above completed OAuth in a signed-in Grok web session on
2026-10-15. Grok called `get_merryman_setup`, rendered its interactive setup
card, and prepared a draft. After owner review and signing, **Check activation**
reported paper mode with a fresh worker report. This establishes the tested
practice flow; it does not establish live trading or native Grok Bot behavior.

Grok Business and Enterprise require an admin to provision the connector
first. The MCP endpoint must be public; your laptop's localhost address will
not work. These steps follow the [official connector guide](https://docs.x.ai/grok/connectors)
and [network requirements](https://docs.x.ai/grok/connectors/custom-mcp-tunneling).
Mobile connector availability is documented in the
[web, iOS and Android announcement](https://x.ai/news/grok-connectors); the
web setup route above is the documented custom-MCP entry point.

## Grok Bot

Grok Bot is an agent with a persistent cloud computer. It supports the same
MCP servers, plugins and skills as Cursor. Use a supported remote-MCP or
plugin connection for the server above, then authenticate it on your own
device. [Official Grok Bot guide](https://x.ai/bot/guides/grok-bot-101)

For installed plugins, the documented route is **Connect apps → select a
plugin → add → Authorize/Authenticate**, then confirm **Installed**.
[Grok Bot plugin setup](https://cursor.com/help/grok-bot/connect-plugins)
This repository does not promise that a Merrymen entry appears there.
See [distribution and listing materials](grok-distribution.md) for the current
vendor submission process, team rollout option and outstanding acceptance checks.

The [Merrymen Grok package](../../plugins/merrymen-grok/README.md) provides a
Cursor-format manifest, [remote configuration](../../plugins/merrymen-grok/mcp.json),
and setup and monitoring skills. Its README gives Cursor's supported local
development install. A Grok Bot custom-package import path and direct install
deep link have not been verified; do not rename a Cursor link or claim an
archive upload will install it. A public marketplace release requires the
vendor's separate review and in-app testing.

An alternative available now is to use Grok chat's custom connector above
while Grok Bot installation is validated. The underlying Merrymen service
and account permissions are the same.

## Setup, wallet and activation

Ask, “Set up my Merryman in practice mode.” The assistant starts with
`get_merryman_setup` and reuses the existing agent or matching draft. It uses
preferences already supplied. For a new setup with no strategy/assets chosen,
the shared host instructions and Bot skill disclose a starter: My Merryman,
Steady Basket, stocks, careful risk, with Merrymen's default basket shown at
owner review. They ask only about an ambiguous target or a conflicting or
required missing choice. Existing agents are never reset to these defaults.

When drafting is granted, `create_merryman` prepares the supported choices
and returns one owner review link. Practice mode and signed limits are owner
choices, not draft-tool arguments. Open the link on your own device, approve,
and continue to wallet setup. After signing, return to the same chat; the
assistant checks fresh setup/status before reporting practice active. Missing
optional drafting access can use the owner creation link without automatically
expanding the connection's permissions.

Owner sign-in, consent, funding, approval and wallet signing stay in your own
device browser. Never import a signing wallet or use an owner session in
Grok Bot's shared cloud computer. Its browser sessions and credentials are
shared across your Bots; a separate Bot is not an account isolation boundary.
[Grok Bot computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)

Merrymen enforces the connection's scopes and shared agents on every call.
The plugin cannot activate live trading, sign, reveal private keys or loosen
signed limits. A draft or approval is not a running worker. Once activated,
the hosted worker continues when the chat closes, subject to permission
expiry, funding, service health and trading rules.

## Optional monitoring

The package's `merrymen-monitor` skill can inspect the agent once, or describe
a routine when you explicitly request one. Nothing enables a schedule during
installation or setup. A monitoring routine uses only `agents:read`,
`portfolio:read` and `decisions:read` and the skill's read-tool allowlist.
It does not create drafts, propose trades, edit settings or configure alerts.
The allowlist guides the workflow; server scopes remain the enforcement.

Specify the agent, interval, time zone and what merits a notification. The
routine reports meaningful changes, failures, recovery or owner action and
stays quiet while nothing changes, unless you requested regular reports.
Grok Bot routines are separate from Merrymen's already-running worker.

## Grok Build CLI

For the developer CLI only:

```bash
grok mcp add --transport http merrymen https://mcp.merrymen.dev/mcp
grok mcp doctor merrymen
```

Complete the OAuth browser flow when requested. These are
[Grok Build's documented commands](https://docs.x.ai/build/features/mcp-servers),
not Grok Bot installation commands.

## Authentication compatibility

The package carries only the public server URL; OAuth discovery supplies the
sign-in flow. Merrymen retains PKCE, exact registered redirect matching, token
audience checks, scoped grants and owner consent. No Grok-specific callback
exception is added.

Cursor documents hosted and loopback callback URLs for its own clients and
supports dynamic registration. Grok Bot uses Cursor's connector backend, but
the researched docs do not establish a distinct Grok Bot redirect contract.
Do not guess or broadly allow callbacks to work around a failed connection.
[Cursor MCP authentication](https://cursor.com/docs/mcp),
[Grok Bot plugin architecture](https://cursor.com/docs/grok-bot/work)

The xAI API also supports remote MCP, but it is not needed for this native
connection. Its `require_approval` parameter is unsupported; neither an API
option nor an assistant prompt replaces Merrymen's owner approvals.
[xAI remote MCP tools](https://docs.x.ai/developers/tools/remote-mcp)

## Verification

Research checked against the linked official documentation on 2026-10-15.

| Check | Status |
|---|---|
| Plugin manifest, endpoint and packaged skill integrity | Local package tests passed on 2026-10-15; both skills passed the skill validator. |
| Monitor tools still exist, remain read-only and fit the scope allowlist | Passed against the actual server catalog in `web/src/mcp/grok-plugin.test.ts` on 2026-10-15. |
| Generic text-only MCP onboarding, without MCP Apps | Passed over the production HTTP/SDK handler with fixture storage in both protocol versions: pending/idempotent drafts, scope denial, owner isolation and rejection of wallet/live authority. These are compatibility tests, not a native Grok session. |
| Public production server discovery | Health reported ready at commit `67fdaa624222`; protected-resource/OAuth metadata returned 200 and unauthenticated initialization returned the expected 401 discovery challenge on 2026-10-15. |
| Local setup pages and copy controls | Rendered in a browser; Bot prompt copy showed success and configured local URLs appeared in the prompt. MCP/connection-page suite: 606 tests passed; app and marketing production builds passed. After a clean install, the full local repository typecheck and 27 targeted handoff/recovery/HTTP onboarding tests passed. The PR's clean GitHub CI typecheck also passed. Completion guidance returns owners to their connected assistant. |
| Grok chat custom connector discovery and OAuth handoff | Verified in signed-in Grok web on Chrome on 2026-10-15: Plugins → Connectors → New Connector → Custom accepted the production URL, checked authentication and opened Merrymen consent with client name Grok and a grok.com return destination. No callback exception was needed. After fresh-account signup and owner consent, Grok showed Merrymen as Connected and listed its authorized tools. |
| Grok chat authorized tool calls | `get_merryman_setup` succeeded for the new shared account: `permission_required`, no trading account or permission expiry, one shared agent and `can_create_draft:true`. The in-chat card submitted a careful Steady Basket draft with a stock basket and received an awaiting-approval proposal. |
| Grok Bot package installation, OAuth and tool calls | Not yet tested in the native client. |
| Grok Build CLI installation and OAuth | Commands researched; not executed. |
| Fresh owner sign-up, wallet signing, activation and return to Grok | Completed on 2026-10-15: fresh signup and consent, Grok Scout draft through the MCP App, owner review, wallet setup and signed paper limits on the owner's device. The handoff preserved name, strategy, risk and basket. Returning to Grok and selecting Check activation reported paper mode with a fresh worker report. This verifies practice activation, not live trading. The sign-in improvements preserve wallet ownership proof and now offer explicit email/X choices and account switching. |
| Grok rendering Merrymen's MCP App view | Verified on Grok web in Chrome: Your Merryman rendered its name/strategy/risk/assets/basket form in Grok's MCP App sandbox. Submitting the form displayed the proposal and its owner-review link. This establishes the tested setup card, not all clients or every app action; text/link fallback remains available. |
| Shorter owner review and sign-in | The combined draft/limits screen and single completion panel are branch changes, checked with rendered-component tests and a local browser preview using a synthetic account and mocked wallet calls. They have not been deployed or acceptance-tested with another real wallet signature. |
| Branding and guided installation | Added the current PNG and SVG marks plus description to MCP server identity, and packaged the same PNG as the portable plugin logo. 49 protocol/onboarding tests and four plugin integrity tests passed. The branded quick-start rendered at desktop and 390px mobile widths without horizontal overflow; its address copy control showed success, and two DOM tests covered copying and manual fallback. Grok's display of the new icon metadata remains unverified until deployment and refresh. |

The native Grok web practice flow above passed. Grok Bot acceptance remains
pending: verify its connection, authorized tools, reuse of existing setup,
owner handoff and fresh worker status in the original conversation. Record
the client/version, endpoint, date and evidence. Native revocation/scope-denial
checks and requested read-only monitoring still need testing, including that
unchanged state stays quiet.
