# Merrymen for Grok Bot

This source package connects to the hosted Merrymen MCP server and supplies
two skills:

- `merrymen-setup`: inspect readiness and prepare a requested setup for owner review.
- `merrymen-monitor`: read status, portfolio and decisions; schedule only when requested.

It contains a Cursor-format plugin manifest, a remote `mcp.json`, and skills.
There are no scripts, credentials, trading workers or automatically enabled
routines. The endpoint is production: `https://mcp.merrymen.dev/mcp`.

## Use the package

Grok Bot documents compatibility with Cursor MCP servers, plugins and skills.
Its documented installed-plugin flow is **Connect apps → add → Authorize or
Authenticate**. Merrymen is not claimed to be listed there. No Grok Bot ZIP
import or direct install link has been verified. See the
[Grok guide](../../docs/mcp/grok.md) for current setup and acceptance checks.

For a supported local development install in **Cursor**, copy this directory
to `~/.cursor/plugins/local/merrymen-grok`, reload Cursor, and inspect Customize
for the server and both skills. Local imports must be permitted by your team.
This is Cursor's documented development path; it is not a documented Grok Bot
installation path. [Cursor plugin development](https://cursor.com/docs/plugins#test-plugins-locally)

For a host's supported custom remote-MCP configuration, use [mcp.json](mcp.json).
Authenticate through the host's OAuth flow. Do not paste credentials into
chat or add tokens to this package. Reuse an existing connection to the same
server instead of installing a duplicate.

All Merrymen owner login, consent, approval and wallet signing happen in the
owner's device browser. Never use Grok Bot's shared cloud computer for those
steps. A setup proposal is not activation; the setup skill checks fresh
Merrymen status after the owner returns.

## Verification and distribution

Package integrity and tool compatibility are checked by
`web/src/mcp/grok-plugin.test.ts`. Native Grok Bot installation, OAuth, tool
invocation and owner signing have not yet been acceptance-tested. A passing
package test does not establish those client behaviors.

Publishing is separate. The [Grok Bot submission form](https://x.ai/bot/marketplace/submit-a-plugin)
accepts a public repository or MCP URL and asks publishers to confirm local
and in-app testing. This package has not been submitted or approved.
