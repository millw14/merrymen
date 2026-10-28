# Distributing Merrymen for Grok

Prepared on 2026-10-15. These are local submission materials, not a submitted
or approved listing. See the [connection guide](grok.md) for setup.

## Connect today

Send users to [Merrymen for Grok](https://merrymen.dev/grok). The documented
Grok chat route is [Connectors](https://grok.com/connectors) → **New Connector
→ Custom**, then enter `https://mcp.merrymen.dev/mcp` and authenticate.
Business and Enterprise users need their admin to provision the connector.
No official prefilled Grok custom-connector install URL has been verified.
[Official connector instructions](https://docs.x.ai/grok/connectors)

For an internal team, a Team Bot can share a Remote HTTPS custom MCP
configuration. Each teammate signs into their own account when OAuth is
used. Owners/managers manage the Bot's **Setup → Plugins** card; this is
team distribution, not a public catalog listing. Use each person's Merrymen
OAuth grant, never a shared owner token or wallet session.
[Official Team Bot documentation](https://docs.x.ai/grok-bot/team-bots)

## Vendor submission process

The official form is [Submit a plugin](https://x.ai/bot/marketplace/submit-a-plugin).
It accepts an MCP server URL or public GitHub repository for review. Its
listing choices currently include **Grok Bot** and **Cursor**, with **Grok
marked coming soon**. An approved Bot catalog entry can later be installed
when a user gives the Bot its connector link; this behavior requires a
matching catalog entry. [Grok Bot changelog](https://x.ai/changelog/bot)

The form requests publisher name/work email, organization name and unique
lowercase handle, optional website, a square SVG/PNG logotype with a
background plate, description, testing instructions, and confirmation of
local and in-app testing. Submitting requires accepting the linked Publisher
Terms. Supply publisher details privately when the owner submits; none are
included here. Do not check the testing confirmation while the gaps below
remain. [Submission requirements](https://x.ai/bot/marketplace/submit-a-plugin)

## Candidate listing materials

- **Name:** Merrymen
- **Website:** `https://merrymen.dev/grok`
- **MCP URL:** `https://mcp.merrymen.dev/mcp`
- **Logo URL:** `https://mcp.merrymen.dev/mcp-icon-512.png`
- **Package:** [merrymen-grok](../../plugins/merrymen-grok/README.md)

**Description:** Connect Merrymen to inspect your Merryman's setup, status,
portfolio and decisions, and prepare a new Merryman for owner review.
Account approval and wallet signing stay in Merrymen on your own device.
The optional monitoring skill uses read-only tools and runs on a schedule
only when requested.

The package's manifest references `assets/logo.png`, copied from the public
MCP icon. Relative logo assets are supported by the
[Cursor plugin format](https://cursor.com/docs/reference/plugins).
MCP server identity can also carry an icon, but custom-connector rendering
in Grok must be checked separately; catalog artwork and protocol metadata
are distinct. [MCP server identity schema](https://modelcontextprotocol.io/specification/2026-07-28/schema)

## Candidate acceptance test instructions

Run these in the actual selected host and record its version, date and
results. Local package tests alone do not complete this procedure.

1. Run `node --import tsx --test web/src/mcp/grok-plugin.test.ts` from the
   repository root. Install/connect using the host's supported route and
   confirm the production endpoint. For a package installation, check that
   both setup and monitoring skills are available.
2. Authenticate through OAuth on the owner's own device. Confirm the
   selected account, shared agent and scopes; do not use the Bot's cloud
   browser for owner login, approval or wallet signing.
3. Ask for setup status. Confirm `get_merryman_setup` returns the correct
   state and usable next steps; inspect the MCP App when available and the
   text fallback otherwise.
4. Explicitly request a new test Merryman. Review the draft on the owner's
   device, complete the intended wallet setup/signing, then return to the
   original chat. Refresh setup/status and verify actual worker state
   before claiming activation. An approved draft is not a running worker.
5. Reconnect with read-only scopes and verify drafting is denied. Revoke
   the connection and confirm subsequent authenticated calls fail.
6. If testing a requested monitor, use the packaged read-tool allowlist.
   Verify unchanged state stays quiet, meaningful changes notify, and no
   draft, trade or settings writes occur. Remove the test routine afterward.

## Verification and submission gaps

| Check | Evidence as of 2026-10-15 |
|---|---|
| Local package | Five package integrity tests passed, covering logo bytes/dimensions, production endpoint, current tools, the setup template's actual tool schema and the monitoring allowlist. All 17 targeted Grok prompt/package/HTTP onboarding tests passed. |
| Native Grok chat | Authenticated `get_merryman_setup` succeeded and an interactive Merrymen MCP App rendered. |
| Native setup handoff | Fresh-account consent and Grok Scout drafting through the MCP App completed; the approved secure wallet page preserved the chosen configuration on the owner's device. |
| Wallet signing and activation | The owner signed paper limits, returned to Grok and selected Check activation. Grok reported paper mode with a fresh worker report. The native practice flow passed; live trading was not tested. |
| Grok Bot | Package installation, OAuth, tool execution and setup/monitoring skill behavior remain unverified in the native Bot client. Grok chat success does not verify Grok Bot. |
| Branding and distribution | Public connector icon rendering, a marketplace listing and a catalog install link are not verified. The package logo is a local asset, not evidence of catalog approval. |
| Permissions and monitoring | Native-client revocation, scope-denial and scheduled monitoring acceptance checks above remain pending. |

The untested Grok Bot installation/behavior and outstanding permissions and
monitoring checks prevent an honest attestation that the full advertised
Bot workflow has been tested locally and in-app. Native Grok chat practice
activation does not replace those checks. Complete the chosen host's acceptance
checks and update this record before the owner submits. No external form has
been submitted.
