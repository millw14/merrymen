# Fomo research, discovery and selective following

Status: in implementation on `claude/fomo-research-discovery-4ed31b`. Nothing here
is LIVE_AUTHORIZED. No provider key was available while it was written, so no route
is AUTHENTICATED_TESTED yet (see the capability report).

The provider is **fomoapi.io** ("FOMO API"), an independent, read-only data service for
fomo.family social-trading activity. It states it is **not affiliated with fomo.family**.
Merrymen does not claim any partnership with either. Fomo supplies information; Merrymen
keeps its own execution system. The provider's trading-account product
(`/v2/trading/*`, `/pay/create`) is never called. The client only uses an allowlist of
GET paths.

## The operating loop

Observe → identify → retrieve evidence → analyse → evaluate portfolio fit → act within
authorization → monitor → explain → measure outcomes.

A trader buying a coin is a reason to investigate, not an instruction to buy. A bullish
thesis is a claim to evaluate, not a fact.

## Integration map (real files)

| Concern | Where it lives today | How Fomo hooks in |
|---|---|---|
| Provider client | none. Templates: `worker/src/research/hey.ts`, `worker/src/venues/bitquery.ts`, `worker/src/bounded-read.ts` | `worker/src/fomo/provider.ts`, the only file that names the API host. Behaviour: Bearer header, GET allowlist, bounded reads, typed failures, credit headers, key scrub. |
| Contract types | none | `worker/src/fomo/types.ts` |
| Shared persistence | `Db` seam `worker/src/db.ts` (sqlite / Postgres); store template `worker/src/groupchat/store.ts` | `worker/src/fomo/store.ts`, using `ensureFomoSchema` under advisory lock `1_297_692_140`. Hosted: shared Postgres (web + orchestrator). Self-hosted: `fomo.sqlite` in `MERRYMEN_HOME`, shared by worker and web. |
| Key custody | vendor keys are orchestrator-only and removed from children (`CHILD_SECRET_STRIP`, `worker/src/orchestrator.ts:411`) | `MERRYMEN_FOMO_API_KEY` (alias `FOMO_API_KEY`) is read by the orchestrator, the web process and the self-hosted worker. Both names are removed from hosted children. |
| On-demand reads from a hosted child (Telegram) | children have no DB and no vendor keys; spawned with `stdio: ["ignore","pipe","pipe"]` (`orchestrator.ts:2608`) | Spawn adds an `ipc` channel. `worker/src/fomo/broker.ts`: the child sends `{op,args}` and the orchestrator answers with the tenant **stamped from which child sent it**. The child cannot choose a tenant. |
| App chat | `web/src/app/api/chat/route.ts` and `web/src/lib/agent-chat.ts`: one model call, no tool loop | `web/src/lib/fomo-chat.ts` detects Fomo intent on the server and invokes registered tools through the shared dispatcher. It answers factual questions from code and analytical ones from fenced evidence. Subject memory is server-side. |
| Telegram DM | `worker/src/telegram/chat-tools.ts` `CHAT_TOOLS`; loop in `worker/src/telegram/answer.ts` | Adds `fomo_*` `ChatTool`s backed by the broker, plus deterministic seeds and per-chat subject memory (`service.ts`). |
| Telegram groups | `worker/src/telegram/tg-groups/*` behind a port boundary (`boundary.test.ts`) | Adds `TgFomoPort` in `tg-groups/types.ts`. Coin-level aggregates only. Trader identities and private state stay in DMs (group rules 2/3). |
| MCP / agent tool interface | `web/src/mcp/tools/*`, `defineTool`, `runTool` | `web/src/mcp/tools/fomo.ts`: `market.read` for public reads, `agents.read` for tenant research status. |
| Shared ingestion | orchestrator fleet passes (`orchestrator.ts:8468-8493`) | `startFomoPass()` runs one stream connection per fleet under a singleton lease, plus targeted REST recovery. Events are persisted, deduped and checkpointed, then routed to opted-in tenants as `fomo.json` in the child home (the `research-files.ts` pattern). |
| Discovery funnel | `worker/src/trencher-brain.ts` (`TRENCH_VOLUME_MIN = 100_000`), `worker/src/trencher-discovery.ts` (`DISCOVERY_SLICE = 20`, nominations inherit the volume screen) | Adds a separate early-opportunity path. Fomo candidates are verified on chain against their own route-specific screen before the old volume ranking, and enter review with reserved capacity. Entry still needs every execution guard. |
| Brain | `services/brain/brain/schemas.py` `LENS_KEYS`, `graph.py` `_DESK` | Adds a new `trader-flow` lens (vendor-neutral). The rendered dossier carries no addresses. The worker sends it only when Brain advertises the lens. |
| Decisions and execution | `worker/src/index.ts` producers → `ensureDecision` → `processIntent` → `checkPolicy` → executor / paper arm | Follow assessments become **nominations, priority and a size ceiling** for the existing Trencher review. Brain decides, `take()` validates, and the strategy emits the ordinary intent. There is no second executor. |
| Publication | `worker/src/xpost/*` outbox (`xpost_posts`) and `thesis-policy.ts` `SOURCE_POLICY` | `worker/src/fomo/publish.ts` keeps a draft outbox with content revision, destination, consent scope, evidence ref, a fleet dedupe key and delivery state. Sending new kinds to X is **disabled pending policy review** (X rule 3 and provider redistribution terms). Confirmed buys keep using the existing pipeline. |
| Settings | `packages/core/src/settings.ts`, `settings-catalog.ts`, `web/src/app/api/settings/route.ts` | New settings: `fomoDataAccess`, `fomoMonitoringEnabled`, `fomoFollowEnabled`. Exploration reuses the owner's existing scout budget. |

## Stages

Each stage is labelled as one of: IMPLEMENTED, FIXTURE_TESTED, AUTHENTICATED_TESTED,
PAPER_TESTED, LIVE_AUTHORIZED, NOT_YET_VERIFIED.

- **A.** Repository inspection, funnel diagnosis, provider contract, identity, fixtures.
- **B.** Registered read-only tools on app chat, Telegram DM and groups, and MCP.
  Freshness, envelopes, dossiers.
- **C.** 150-trader cohort, shared ingestion, durable recovery, change detection,
  smaller-coin discovery.
- **D.** Selective-following paper decisions, exploration sizing, lifecycle monitoring,
  publication drafts.
- **E/F.** Named live canary and expansion. These need explicit owner approval and are
  **not part of this change**.

(Sections on capability status, cost, operations and rollback are filled in as the work
lands.)
