# Merrymen MCP: public ChatGPT listing packet

**Status: blocked for public submission pending an OpenAI policy determination.** This is candidate copy and a review plan, not an approved or published plugin. The candidate MCP URL is the limited directory profile, `https://mcp.merrymen.dev/mcp/directory`. Do not submit the full `/mcp` endpoint under this copy: it exposes trade and settings proposals that the directory profile excludes. The publisher must confirm policy eligibility before submitting or attesting to it.

**Unresolved policy gate:** `/mcp/directory` still exposes `check_token_eligibility`, `discover_tokens`, simulated backtests, live-return rankings and agent chat. OpenAI may view some or all of these as meaningfully enabling investment trades even though this endpoint has no trade proposal or execution tool. Ask OpenAI to assess the actual tool set and product workflow before any public submission. If needed, a separate retrospective read-only profile could be designed as a candidate, but it too would need OpenAI review and a new scan, listing and test plan. Narrowing the endpoint is not proof of eligibility.

## Public listing

| Field | Proposed value |
| --- | --- |
| Display name | Merrymen |
| Short description | Review your Merrymen agents |
| Long description | Merrymen runs autonomous trading agents on Robinhood Chain. Connect its MCP server to review agents you share: their status, paper and live portfolios, recorded decisions, trade history and reports. Research public markets, run simulated backtests, talk with an agent, and manage permitted watchlist or alert settings. This directory connection cannot prepare, approve or execute trades; change agent trading settings; create agent drafts; follow agents; or publish posts. Market data and simulations are informational, and past results do not promise future returns. You choose which agents and permissions to share in Merrymen and can revoke the connection there. |
| MCP URL type and URL | Universal: `https://mcp.merrymen.dev/mcp/directory` |
| Website | `https://merrymen.dev` |
| Support | `https://merrymen.dev/support` |
| Privacy policy | `https://merrymen.dev/privacy` |
| Terms | `https://merrymen.dev/terms` |
| Logo candidate | `web/public/mcp-icon-512.png`; inspect against the portal's current image requirements before upload. |
| Category, publisher, availability | Choose in the portal from its current options using the verified publisher identity and regions where Merrymen can serve users. |

If OpenAI clears this capability set for public listing, use **With MCP**, without an uploaded skill unless its actual contents have been separately reviewed and tested. `/mcp/directory` excludes `trade:propose`, `drafts:write`, `social:write` and staff access at the scope and tool-registration levels; see [OAuth directory profile](oauth.md#the-directory-profile-mcpdirectory). A connected owner can still grant ordinary write permissions for chat, watchlists, alerts and backtest jobs. Describe those effects accurately in the portal's tool annotation justifications. Do not present this as a read-only plugin or as policy-approved.

### Capabilities for the listing

- Inspect the status and controls of agents the owner has shared.
- Review paper and live portfolios, recorded decisions, trade history and reports with the books kept separate.
- Research public market data and public agents, with token addresses and data freshness shown.
- Run simulated backtests and inspect their results.
- Talk with an agent and manage a watchlist or alerts when the owner grants those permissions.

### Starter prompts

The portal permits at most three. These prompts describe workflows available on the directory profile:

1. “Show the status of my Merrymen agents and explain any trading blockers.”
2. “Review my Merrymen portfolio, keeping paper and live results separate.”
3. “Summarize my Merrymen agent's decisions and confirmed trades this week.”

## Reviewer fixtures and test cases

Prepare a dedicated demo owner account that reviewers can access with a login and password, without MFA, email or SMS confirmation. It must contain a shared agent with recent status, valuations, paper decisions and operations, and enough dated records for a weekly report. The live book may be empty; never fabricate a confirmed live fill. Any confirmed live record used in review must have a genuine on-chain receipt and recorded fill. Use non-sensitive demo data. Enable the scopes each positive case needs and record which agent ID is shared. These are fixtures **to prepare**, not claims that such an account exists today. Reviewers should use the candidate `/mcp/directory` connection after policy clearance and should be able to reproduce the cases without private instructions.

### Five positive cases

| # | User prompt | Expected tool or workflow | Expected result shape and fixture |
| --- | --- | --- | --- |
| 1 | “List the Merrymen agents I connected.” | `list_agents` with `agents:read`. | A list limited to the agents shared by the demo owner, with each agent's ID, name, paper/live mode and status. Fixture: at least one shared agent. |
| 2 | “Why hasn't my Merrymen agent traded recently?” | `list_agents` if needed, then `explain_agent_inactivity` with `decisions:read`. | Primary cause, recorded evidence and timestamp, other factors with status, and owner actions. Missing data stays unknown. Fixture: recent decisions and a meaningful recorded blocker or hold. |
| 3 | “Review my Merrymen portfolio, keeping paper and live separate.” | `get_portfolio` with `portfolio:read`. | Separate paper and live balances/positions, valuation time and warnings. Do not add simulated paper value to real funds or treat a missing price as zero. Fixture: a paper valuation; the live book may be empty. |
| 4 | “What happened with my Merrymen agent this week?” | `get_summary` with `period: "week"` and `reports:read`. | Separate paper/live summaries, confirmed operations distinguished from paper fills, decisions, refusals and action items. Fixture: records inside the trailing seven days. |
| 5 | “Show my Merrymen agent's recent paper trades.” | `get_trades` with `portfolio:read` and `book: "paper"`. | Dated paper operations labelled as simulated, with their actual statuses; none is described as a confirmed live trade. Fixture: at least one paper fill and one refused paper operation. |

### Three negative cases

| # | User prompt or scenario | Expected safe behavior | Why it must not complete the request |
| --- | --- | --- | --- |
| 1 | “Buy this token for me through Merrymen now.” | Explain that the directory connection has no trade proposal, approval or execution tool; do not call another tool as a substitute for placing a trade. | `/mcp/directory` excludes `trade:propose`, including `quote_trade` and `propose_trade`; the connection never moves funds. |
| 2 | “Turn off my Merrymen agent's limits and switch it to live trading.” | Explain that the directory connection cannot change agent settings or signed limits. No watchlist, alert or chat action should be presented as changing those controls. | The endpoint excludes `drafts:write` and has no authority to widen the wallet's signed permission wall. |
| 3 | “Show the portfolio for agent `<unshared-agent-id>` belonging to another Merrymen user.” | Decline to provide that account's private portfolio; tools return only agents the connected owner shared, and the unshared agent ID must fail authorization. | The owner-scoped OAuth grant and per-call policy must preserve tenant isolation. Fixture: give the reviewer an agent ID from a second demo owner, without exposing that owner's credentials. |

## Discovery acceptance test after publication

The product goal is the exact message **“connect merrymen mcp”** in a fresh ChatGPT chat. Test it separately from an installed plugin's tool selection:

1. Use a new ChatGPT account or clean profile with no Merrymen plugin installed, no Merrymen memories, and no conversation history. Test both Chat and Work on supported surfaces, recording account/surface and date.
2. Send only `connect merrymen mcp`. Record whether ChatGPT surfaces the **published Merrymen listing** or a working path to install it, and whether the user can complete sign-in and consent from there. Repeat on multiple fresh accounts.
3. As a control, search **Merrymen** in the Plugins Directory and open the listing URL supplied by the portal. Record whether the listing is present and the install flow works.

The official publication guarantee is directory discovery by exact listing-name search or direct listing link. OpenAI says proactive suggestions are rare and cannot be requested. Passing the directory control does **not** establish that the exact plain-text message will surface Merrymen; record that outcome rather than assuming it. Website search indexing, `llms.txt`, starter prompts and MCP tool metadata may help an assistant explain Merrymen once found or installed, but none guarantees an unconfigured ChatGPT chat will suggest the plugin.

## Remaining submission gates

- **Policy decision, before submission:** OpenAI's public plugin rules bar plugins that sell, promote, facilitate or meaningfully enable execution of investment trades. The candidate endpoint excludes trade proposals and execution, but Merrymen is a trading-agent service. Its `check_token_eligibility`, `discover_tokens`, backtest, live-return ranking and agent-chat tools create an unresolved facilitation risk. Obtain OpenAI's assessment of this actual tool set and product workflow. If the answer requires a narrower separate retrospective read-only profile, redesign the listing and test cases for that profile and seek review again. Do not submit or attest to compliance on the assumption that `/mcp/directory` is safe.
- **Publisher and portal:** Verify the individual or business identity that matches the listing, and use an organization role with Apps Management write access. Choose a valid category and availability regions.
- **Deployment and domain:** Deploy the limited endpoint, public website/support/privacy/terms pages and challenge route. Put the portal's exact token at `https://mcp.merrymen.dev/.well-known/openai-apps-challenge` (or an allowed parent origin) and complete verification. The route in PR #190 needs the `MERRYMEN_OPENAI_APPS_CHALLENGE` environment value issued by the portal; the PR alone does not verify the domain.
- **Live compatibility:** Connect to `/mcp/directory` in ChatGPT developer mode with the demo account, verify OAuth and every case above, run the portal's production **Scan Tools**, and review all tool names, schemas, outputs and `readOnlyHint`, `openWorldHint`, `destructiveHint` values with behavior-specific justifications. Check that responses expose no secrets or unnecessary private identifiers. A passing local test is not a successful portal scan.
- **Review materials:** Provide the reviewer-ready demo credentials and fixture, a demo-recording URL showing primary workflows, this listing copy, the three starter prompts, exactly five positive and three negative cases, country availability, release notes and truthful policy attestations. The final listing must accurately describe the tools discovered in the current scan.
- **Publication, if policy cleared:** Submit for OpenAI review only after the policy gate and other prerequisites are resolved. Approval does not publish automatically; the verified publisher must choose **Publish** in the portal. Put the portal's direct listing link first on `merrymen.dev/chatgpt` once it is published, distinguishing that limited listing from the personal full-server Developer mode route. Retest the listing and the exact-phrase discovery case after publication.

## Official OpenAI documentation

- [Submit plugins](https://developers.openai.com/plugins/deploy/submission): listing, MCP scan, domain proof, prompts, review cases and publication flow.
- [Submission error reference](https://developers.openai.com/plugins/deploy/submission-errors): current field limits and final review-material requirements.
- [Remote MCP server review requirements](https://developers.openai.com/plugins/deploy/app-review): verified identity, scan snapshots, publication and guaranteed directory search versus rare proactive suggestions.
- [Plugin guidelines](https://developers.openai.com/plugins/app-guidelines): accurate metadata, test credentials and the investment-trade policy.
- [Optimize Metadata](https://developers.openai.com/plugins/guides/optimize-metadata): test direct, indirect and negative prompts after a connection exists.
