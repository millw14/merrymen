# Fomo research, discovery and selective following

Merrymen can look up Fomo trader and coin information when an owner asks. It can watch a
maintained cohort of traders, research coins those traders touch, including small ones
the old discovery screen deleted, and turn that research into bounded entry nominations
inside the owner's existing limits. It is not copy trading. A trader buying a coin is a
reason to investigate, not an instruction to buy. A bullish thesis is a claim to
evaluate, not a fact.

**Provider.** The data comes from **FOMO API (fomoapi.io)**, an independent, read-only
data service for fomo.family social-trading activity. It states it is *not affiliated with,
endorsed by, or in partnership with fomo.family*, and Merrymen claims no partnership with
either. Fomo supplies information; Merrymen keeps its own execution system. The provider's
trading-account and payment products (`/v2/trading/*`, `/pay/create`) are refused by the
client's GET-only path allowlist.

**Status of this change** (labels defined at the end):

**Hosted Fomo is opt-in.** Nothing here runs on a hosted deployment until
`MERRYMEN_FOMO_ENABLED=1` is set on the orchestrator and the web (see Operations). Off,
there is no Fomo pool, DDL, IPC channel, child file, Telegram research lane, chat
interception, Settings section, MCP tool or scout-budget charge. Self-hosted Fomo runs
only with the install's own key and unless it sets `MERRYMEN_FOMO_ENABLED=0`. Without a
key it behaves as before Fomo: no runtime, no `fomo.sqlite`, no interception. Adding a
key takes a worker restart.

**What still changes with hosted Fomo off.** These are deliberate, and all apply from the
next deploy of each service:

- **Brain** (deploys when this merges). A request without trader-flow material makes
  exactly the analyst calls it made before. Three changes do apply to every request:
  - case and spacing variants of `</untrusted>` are neutralised in every fenced block (a
    security fix);
  - each decision also carries `proposed_action` and `proposed_delta_usdg`, record only,
    which older workers ignore;
  - `/health` lists `lens_keys`;
  - the request schema accepts `trader-flow` material for every instrument class (it was
    a 422). Only the memecoin desk reads it, and only when it is sent.
- **Workers:**
  - Paused stock tokens are excluded from the Brain's focus and from the fast-Trencher
    candidate filter. Both looked the address set up by symbol, so a paused token was
    never excluded.
  - Instrumentation (it never throws; every call is guarded):
    - a per-coin decision funnel, with one aggregated log line per 10 minutes for
      fast-Trencher agents;
    - a superseded unused BUY or SELL is logged;
    - Brain gate fields are appended at the end of decision rows' `signals_json`;
    - refusal rows gain a `refusal_reason`;
    - the `[brain] gate` log line gains `proposed=`.
  - Log wording only: Brain non-decision log lines name their actual outcome (a
    portfolio-quality refusal, an unusable answer, an exhausted budget, an unreachable
    Brain) instead of all reading "Brain unavailable".
  - The regular Trencher candidate list is built by `regularEntryPools`. It is identical
    while no early or verify-only pool exists, which is always the case with Fomo off.
- **Orchestrator:**
  - children and hold processes receive `MERRYMEN_TENANT` (read only by Fomo code);
  - both Fomo key names are stripped from children;
  - the `fomo/*` modules are loaded at boot (imports only; nothing runs);
  - one boot line, printed at boot even under `FLEET_HALT`, says Fomo is off. An
    unexpected switch value is described by its length, never echoed.
- **Telegram:** the Sign now button follows only the two permission readers
  (`agent_status`, `permission_status`) at the start of a line. On main, any lookup's
  text could raise it, a coin's own description included; this is a fix.
- **Web:**
  - The chat route reads the recovery hold before anything else, which was already
    main's order.
  - Settings GET always includes a masked `fomoApiKey` field (`{set:false}` when nothing
    is stored) and the three Fomo defaults.
  - Settings PUT does not save the three Fomo booleans while Fomo is off; they are
    reported in `ignored`. Telegram `/set` and the Settings proposal box leave them out
    too, so no consent can be stored for a switch nobody can see.
  - A hosted PUT carrying `fomoApiKey` drops it, like every other house secret, and
    does not list it in `ignored`.
  - The page shows no Fomo section while Fomo is off. A chat change-settings card, and
    an agent's `?propose=` link, offer no Fomo switch either.
  - `/api/auth/session` adds a `fomo` flag.
  - The new `/api/fomo/status` route answers 401 when signed out and 404 "not enabled"
    otherwise.

| Area | Status |
|---|---|
| Provider adapter, identity, normalisation | IMPLEMENTED, FIXTURE_TESTED. AUTHENTICATED_TESTED on 6 routes (see "Live verification"); normalisers reconciled with live response shapes. |
| On-demand tools: app chat, Telegram DM and groups, MCP | IMPLEMENTED, FIXTURE_TESTED. The shared chat pipeline was run end to end against the live API; the surfaces themselves were exercised with fixtures. |
| Shared ingestion, 150-trader cohort, research queue, child files | IMPLEMENTED, FIXTURE_TESTED. The alerts stream connects and runs realtime on the live key; the fleet pass itself has not run against the live API. |
| Early-opportunity discovery path | IMPLEMENTED, FIXTURE_TESTED |
| Selective-following assessments into the Trencher review | IMPLEMENTED, FIXTURE_TESTED. PAPER_TESTED only at module level (no live paper agent was run). |
| Publication drafts | IMPLEMENTED, FIXTURE_TESTED. Delivery to X is disabled pending policy review. |
| Live canary (Stage E) and fleet expansion (Stage F) | NOT part of this change. Needs explicit owner approval. |

## The operating loop

```
Observe → identify → retrieve evidence → analyse → evaluate portfolio fit
        → act within authorization → monitor → explain → measure outcomes
```

Each step is a separate module with its own tests. The model proposes; deterministic code
disposes. Execution is the existing intent → policy → executor path.

## Integration map (real files)

| Concern | Existing system | Fomo integration |
|---|---|---|
| Contract types | none | `worker/src/fomo/types.ts` (data meaning, envelopes, statuses), `worker/src/fomo/contract.ts` (service, broker, IPC wire format, child file) |
| Provider | templates `research/hey.ts`, `venues/bitquery.ts` | `worker/src/fomo/provider.ts`. The only code that names the host. GET allowlist, one Bearer header, bounded reads, the provider's documented retry policy, credit headers, key scrubbing, runtime normalisers. `capabilities.ts` holds the capability report. |
| Identity | lowercased 0x address on chain 4663 | `worker/src/fomo/identity.ts`: (namespace, network id as returned, address). EVM lowercased per network; Solana mints keep case. Never routed through `chainForId`. |
| Event identity | none | `worker/src/fomo/events.ts`: provider event id, then fill id, then tx hash + log index, then an explicitly ambiguous fingerprint |
| Persistence | `Db` seam (`worker/src/db.ts`) | `worker/src/fomo/store.ts`: 29 `fomo_*` tables under advisory lock `1_297_692_140`. Hosted: shared Postgres. Self-hosted: `fomo.sqlite` (`fomo/local-db.ts`), shared by worker and dashboard. |
| Research service | none | `worker/src/fomo/service.ts` and `tools.ts`: one dispatcher, 9 registered read tools plus 4 owner-only mutations (watch, unwatch, tail, untail) |
| Natural language | `telegram/question-context.ts`, `chat-ledger-facts.ts` | `worker/src/fomo/intent.ts` (deterministic planner) and `subject-memory.ts` (per-conversation subject) |
| Rendering and chat | none shared | `worker/src/fomo/render.ts` (answer-first text, model evidence block, runtime rules) and `chat.ts` (the one pipeline every chat surface calls) |
| Key custody and processes | vendor keys orchestrator-only (`CHILD_SECRET_STRIP`) | Key held by the orchestrator, the web process and the self-hosted worker. Stripped from hosted children under both names. Hosted children ask the orchestrator over a new IPC channel (`fomo/broker.ts`), and the orchestrator stamps the tenant from which child asked. |
| App chat | `web/src/app/api/chat/route.ts`, `web/src/lib/agent-chat.ts` | `web/src/lib/fomo-chat.ts` and `fomo-runtime.ts`. Factual questions are answered by code from tool results; analytical ones get a fenced evidence block and runtime rules. |
| Telegram | `telegram/service.ts`, `answer.ts`, `chat-tools.ts`, `tg-groups/*` | DM: the planner runs first, and read tools are registered in the model loop. Groups: `TgFomoPort` (`worker/src/tg-fomo-port.ts`) returns coin-level aggregates and Fomo's public leaderboard, and deflects questions about one trader to DMs. |
| MCP | `web/src/mcp/tools/*` | `web/src/mcp/tools/fomo.ts` |
| Fleet ingestion | orchestrator passes | `worker/src/orchestrator-fomo.ts`: one singleton-lease leader runs the alerts stream, cohort refresh, research queue, jobs, publication drafts and retention. Every replica writes `fomo.json` for its own children (`fomo/child-file.ts`). |
| Discovery funnel | `trencher-brain.ts` `TRENCH_VOLUME_MIN = 100_000`, `trencher-discovery.ts` `DISCOVERY_SLICE = 20` | `worker/src/early-candidates.ts`: an early path ahead of both, with every execution guard kept. `worker/src/decision-funnel.ts` instruments every stage. |
| Following | Trencher review (`TrenchBrainReview`), `NominationBook` | `worker/src/fomo/following.ts`, `sizing.ts`, `lifecycle.ts`, wired by `worker/src/fomo-child.ts` |
| Brain | `services/brain` `LENS_KEYS`, `_DESK` | New vendor-neutral `trader-flow` lens (`fomo/lens.ts` renders it), a pulse reservation, a selective-following instruction and the pre-gate `proposed_action` |
| Publication | `worker/src/xpost/*` | `worker/src/fomo/publish.ts`: draft outbox with status-matched wording, consent scope, fleet dedupe and reconcile-before-retry. X delivery is off. |
| Settings | `packages/core/src/settings.ts` | `fomoDataAccess` (on), `fomoMonitoringEnabled` (off), `fomoFollowEnabled` (off). Dashboard-only; the chat refuses them. |

## Permissions — kept separate

| Permission | Default | What it allows | Where |
|---|---|---|---|
| `fomoDataAccess` | on | answer Fomo questions, read-only | Settings → Fomo research |
| `fomoMonitoringEnabled` | off | let the cohort and watched coins route research to this agent (hosted only) | Settings → Fomo research |
| `fomoFollowEnabled` | off | let research **nominate** coins into the existing memecoin review, sized inside the scout budget (hosted only) | Settings → Fomo research |
| live follow | nobody | live execution of follow nominations | operator allowlist `MERRYMEN_FOMO_FOLLOW_LIVE`. Also requires `liveTradingEnabled`, `trencherLiveEnabled`, a signed grant and the vault. |
| X posting | existing | publication of confirmed fills only, through the existing pipeline | Settings → Posting on X |

Revoked data access is enforced in the service before any cache read or provider call, on
every surface, even while monitoring is off, the watchlist is empty or trading is paused.
Hosted, Fomo research is for owners with an agent: a signed-in wallet with no stored grant
is refused, so throwaway wallets cannot spend the fleet's shared credits. Monitoring and
following need the hosted fleet pass; a self-hosted install answers questions only, and
its settings page and chat say so. An information request never creates a trade, a post
or a recurring watch. "Watch this
coin" is an explicit owner-only mutation, capped at 25 per owner and expiring after at
most 30 days. "Should we follow this?" is analysis, not permission.

## On-demand retrieval

`Question → authenticate → resolve subject and intent → invoke tool → check cache freshness
→ retrieve → validate → answer`

- **Registered tools:** `fomo_resolve_subject`, `fomo_get_trader_context`, `fomo_get_trader_activity`,
  `fomo_get_token_theses`, `fomo_get_token_activity`, `fomo_get_rankings`, `fomo_find_opportunities`,
  `fomo_research_coin`, `fomo_get_research_status` (owner only), plus the mutations
  `fomo_watch_coin`, `fomo_unwatch_coin`, `fomo_tail_trader` and `fomo_untail_trader`
  (owner only, never offered to a model loop; see "Tailing a trader").
- **Strict arguments:** each tool has an `additionalProperties:false` schema. Tenant,
  credentials, host, path and URL can never be arguments.
- **Trusted context only:** the session cookie (web, MCP); the orchestrator's record of which
  child asked (hosted Telegram); the fixed `self` tenant (self-hosted).
- **The tool is always called.** Trusted code decides whether a cached copy satisfies the
  freshness policy:

  | Class | Max age | Oldest copy served |
  |---|---|---|
  | activity | 60 s | 30 min |
  | holdings | 5 min | 6 h |
  | rankings | 15 min | 24 h |
  | theses | 30 min | 7 d |
  | token-stats | 5 min | 2 h |
  | profile | 1 h | 7 d |
  | boards | 5 min | 2 h |

  "refresh", "latest", "check now" and "right now" force an upstream attempt. Identical
  concurrent refreshes share one in-flight call and never substitute an older result.
- **Envelopes:** every result carries a request id, resolved subject, requested versus
  achieved scope, status, evidence refs, five separate clocks (`retrievedAt`,
  `providerAsOf`, `sourceEventAt`, `lastRefreshAttemptAt`, `cacheAgeMs`), coverage, usage
  and dossier revision. Statuses `ok / empty / partial / capped / stale / failed /
  unavailable / not-authorized / budget-limited / needs-clarification / not-found` are
  never collapsed. "No matching records returned" is not "nobody traded".
- **Answers:** the subject comes first, then the answer, then attribution ("Source: Fomo
  via FOMO API (independent; not affiliated with fomo.family)"), then material freshness
  and coverage limits. Provider-reported, independently verified and Merrymen
  interpretation are labelled differently. No Fomo permalink is ever invented.
- **Follow-ups:** the resolved coin, chain, trader, window and dossier revision carry
  across turns per conversation, for 30 minutes. A correction replaces the subject before
  the next lookup. A same-ticker coin on another chain triggers one focused clarification;
  it is never silently chosen.
- **One call, one clock:** every provider read of one tool call runs inside a 40 s
  deadline (below the broker's 50 s ceiling) and stops when the caller aborts: each
  attempt is clamped to the time left, the fetch itself is aborted, and a read that cannot
  start with 2 s left is skipped and named as missing (the answer is `partial`), never
  begun. Background refreshes get 80 s (the research pass allows 90); a deep job uses its
  own deadline.
- **Deep research** registers a bounded job (10-minute deadline, 15,000-credit allowance)
  before later delivery is promised. Telegram delivers one consolidated result to the same
  DM after re-checking the recipient and the data-access permission.

## The 150-trader cohort

`worker/src/fomo/cohort.ts`, run by the leader every 6 hours.

**Identity.** Members are keyed by provider `userId` (UUID), not handle. Handle history is
kept, so a rename does not break history. Duplicate leaderboard rows merge.

**Scoring.** Explainable components:
- consistency across 24h/7d/30d/all
- relevant-chain share
- early discovery
- holding period against Merrymen's latency
- exit behaviour
- concentration
- execution capacity
- thesis usefulness
- data completeness

Dollar P&L enters only as a damped, capped rank percentile. **Followers are ignored.**
Small samples shrink toward a prior. Missing history is unknown: it carries no weight and
is never negative or invented.

**Gradual refresh.** At most 10 changes per refresh. Hysteresis and a minimum tenure apply.
Every addition and removal records its reason. Versions persist with inclusion times.

**No padding.** When evidence is insufficient the cohort is smaller and carries a
`shortfallReason`.

**Narrative-only traders.** A trader whose holds are shorter than Merrymen can act on stays
useful for narrative discovery but is `followable:false`.

**Position dependencies.** Traders an open position depends on are tracked separately: at
most 30 per owner and 300 overall, expiring, and never counted in the 150.

## Shared ingestion

`worker/src/fomo/stream.ts` and `ingest.ts`, run by the leader.

- **One stream for the fleet.** A single `/ws/alerts` connection, filtered to Robinhood
  Chain because only Robinhood tokens can become entries. On-demand lookups still cover
  every chain. There are never 150 sockets per agent.
- **Persist first.** Every normalised event is inserted, deduplicated by event key, before
  anything is routed. Live, replayed, REST-recovered and post-restart copies route exactly
  once.
- **Recovery.** Reconnects use exponential backoff with full jitter, plus a heartbeat
  watchdog. The bounded inbound queue applies backpressure: a full queue closes the socket
  and records a gap rather than dropping. Oversized or garbage frames go to dead letters.
  REST recovery runs from the monotonic checkpoint (strictly newer cursor), up to 10 pages.
  A gap that cannot be recovered stays visible and is never reported as complete.
- **Research tasks.** Bursts coalesce into one research task per (coin, evidence revision).
  Priority order: held positions, then explicitly watched coins, then discovery.
- **Tenant isolation.** Public cohort activity is shared. Per-owner data (watches, held
  coins, assessments) never crosses owners. Each child's `fomo.json` contains public
  activity plus that owner's own state only.

## What the data means

Kept apart by name in the types:
- actual fill size (`fillUsd`, only when the provider matched an exact on-chain fill)
- the post-fill position mark (`positionValueUsd`)
- position-level cumulative realised P&L (never summed)
- current quantity
- holdings valuation, which is a floor when truncated
- transfers and airdrops, which are never purchases

Provider-reported, provider-verified and independently verified observations are labelled
separately.

The app feed has an upstream size floor near $3,000, so small fills are invisible. Every
answer that relies on the feed says so.

## Shogun's inactivity: diagnosis

Diagnosis from code (no production data was read). The funnel instrumentation now records
where each coin stops, so the dominant cause can be measured instead of guessed.

| Stage | Where | What stops coins | Kind |
|---|---|---|---|
| Rail | `index.ts` | live agent without `trencherLiveEnabled` | permission (announced) |
| Tape screen | `trencher-brain.ts:9` | 24h volume < **$100,000**, < 20 buyers, one-sided, no 5m volume | discovery screen (was silent; now `DISCOVERY_SCREENED_OUT`) |
| Discovery slice | `trencher-discovery.ts:11` | only the busiest **20** v3 pools, canonical factory, USDG/WETH quote; nominations inherit the volume screen | discovery screen |
| Candidate builder | `index.ts` | missing `createdAt` or FDV skipped **silently**; a failed vault-budget read skipped **every** autonomous coin silently | accidental silent exits (now recorded) |
| Entry screen | `strategies/trencher.ts` | liquidity < $25k, FDV < $50k, age < 10 min, unpriced | execution guard (kept) |
| Review guard | `index.ts` | one unknown-cost holding sets `bookIncomplete` and disables **every** review | likely permanent-hold accident |
| Brain gate | `gate.py` | 3 or more caveats force a hold; process caveats (audit never run, gas basis, no position history on paper) can make that permanent | likely permanent-hold accident |
| Model | `trencher-brain.ts` persona | "hold if evidence or edge is insufficient"; one coin per 30 s | judgement |
| `take()` | `trencher-brain.ts` | review older than 60 s (tick may be 60 s), price moved more than 2%, superseded decision; console-only | silent drops (now recorded) |
| Strategy | `strategies/trencher.ts:555` | an approved BUY over headroom or the cap is discarded silently | silent drop (counted as "approval without outcome") |

Fixed in this change:
- The paused-token filter compared symbols against an address set. This made it too
  permissive, not too strict.
- A portfolio-quality refusal was reported as "Brain unavailable".
- Gate verdict, reasons, caveat count, schema version and the model's pre-gate
  `proposed_action` are now persisted.

Deliberately **not** changed, because they need owner review:
- the $100k screen and 20-pool slice for the regular tape
- the entry floors
- the three-caveat rule
- the vault caps

Smaller coins now reach review through the separate early path below, without loosening
any of these.

## Smaller-coin discovery

`worker/src/early-candidates.ts`: the early-opportunity path. Its sources:
- a first observed purchase by a useful cohort trader
- several distinct watched traders buying
- a new thesis on an unseen token
- trending and graduated boards
- explicit owner nominations

These get a **route-specific early screen** instead of the volume screen: a v3 pool on the
vault's route, two-sided trading (an exit has been observed), fresh activity and a known
reserve. They are verified on chain without the top-20 slice. A bounded book holds them:
8 active, 24 new per day, cooldowns. One review slot in four is reserved for them;
capital is never guaranteed. A missing market cap is unknown, not zero, and a new pool for
an old token is not a launch.

To let a small coin's route be verified before it can be nominated, the child may ask
discovery to verify up to 3 Robinhood coins with recent cohort buying. It asks only when a
follow nomination could actually act: paper, or live with the operator allowlist; scout
enabled; not paused; a vault present. A coin verified this way is marked early. The regular
autonomous list (`regularEntryPools`) leaves early pools out, and the paper list leaves out
coins that are on the tape only because of an ask. So such a coin reaches candidates only
through a follow nomination and the follow gate.

The three questions stay separate. Is it worth investigating? That is the dossier. Does
the setup justify risk? That is the Brain review. Is this exact trade permitted and
executable? That is the unchanged `shouldEnter` entry floors, pool price guards, vault
caps, policy, energy and rail.

## Dossiers and feed intelligence

`worker/src/fomo/dossier.ts` keeps one versioned dossier per canonical token, shared by
chat, background research and triggered reviews.

- **Building.** Fetches are staged: one thesis page, expanding only when contested or
  thin, and never "all theses". Copies collapse into evidence families. Merrymen's own
  posts and echoes are excluded from independent confirmation. One well-supported
  objection outranks ten copies of one bullish post.
- **Contents.** Source statements, observed actions, verified facts and inference are
  separated. Each dossier holds the strongest support and opposition, flow (distinct
  buyers vs repeat adds), words-vs-actions inconsistencies (explicitly not proof of fraud),
  unknowns, change conditions, exact coverage and schema/prompt/model versions.
- **Revisions.** An unchanged evidence set does not create a new revision.

`features.ts` adds:
- early discovery and participation breadth
- conviction changes, from buy events only
- thesis changes and narrative development
- position deterioration
- "what changed" summaries. "No change" is only reported with a comparable earlier
  baseline and a successful check.

`lens.ts` renders the vendor-neutral `trader-flow` Brain lens. It contains no addresses and
no vendor name, and carries opaque refs that the worker validates against what was sent.

## Selective following, sizing and lifecycle

`following.ts`, `sizing.ts`, `lifecycle.ts`, wired in `worker/src/fomo-child.ts`.

**Research states.** `WATCH`, `PROBE_CANDIDATE`, `ENTRY_CANDIDATE`, `ADD_CANDIDATE`,
`HOLD_POSITION`, `REDUCE_CANDIDATE`, `EXIT_CANDIDATE`, `REJECT_SETUP`, `RESEARCH_ONLY`.

**Judged at our own price and time.** Signal delay, research delay and price movement are
measured against Merrymen's own quote. A trader's dollar size is never copied, and their
entry is never assumed to still be available.

**Hard constraints versus ordinary uncertainty.**
- `REJECT_SETUP`: identity, authorization, stale quote, a run-away price, a verified
  objection, or a route too thin for our size.
- `WATCH`: ordinary uncertainty such as short history, thin or conflicting theses, a size
  below the economic floor, or entries paused. It is never automatically bearish.

**Mapping into existing code.** Reviewed trusted code turns an assessment into a
nomination, a priority and a per-coin ceiling for the **existing** Trencher review.
- Brain decides.
- `take()` keeps its 60 s / 2% guards.
- The strategy emits the ordinary intent.
- `checkPolicy`, the vault, energy and the paper/live rail apply unchanged.

There is no second executor and no policy bypass. `revalidate()` runs immediately before
submission and checks:
- expiry
- price move since the decision quote
- permission and pause changes
- the rail
- sponsorship availability. A sponsored flow whose sponsor is unavailable is dropped and
  never charged to the owner.

**Sizing.** In micro-USDG, rounded down. The ceiling is the minimum of:
- the signed per-trade limit
- daily headroom
- the remaining exploration allocation
- the per-token allocation
- exposure headroom
- route capacity
- the 5 USDG autonomous vault bound

Any unknown input gives 0. The exploration allocation **is the owner's existing scout
budget**; there is no parallel allowance. Follow positions and the existing unpriceable
scout positions draw on one pool in both directions, so their combined cost can never
exceed `scoutBudgetUsdg`. Realised exploration losses consume it, and closing a losing
position never refills it; only changing the scout settings, which re-authorises them,
resets the loss.

**The money state is durable.** The exploration ledger, the pending-entry record and the
daily follow count live in the owner's tenant store: hosted, the shared Postgres via the
broker; self-hosted, `fomo.sqlite`. Hosted child homes are wiped on redeploy, so a local
file alone would let a redeploy refill a spent allocation. Until the durable copy has been
read the ceiling is 0. Each entry is recorded as pending and read back **before** it is
submitted, so a crash after broadcast cannot lose it; if the record cannot be confirmed
within 8 s, the entry is dropped. Absence of stored state must be proven: a failed or
refused read is "unknown", never "nothing stored", so a redeploy under load cannot reset a
spent allocation. While the ledger is unknown, the existing scout gate is charged the cost
of every open Trencher position, which bounds what follow and early entries can hold. It is
charged the whole budget only if that book cannot be read either, so the Fomo kill switch
never stops unrelated scout buys. A newer assessment that is no longer an entry candidate
withdraws the open nomination, and the gate checks the latest assessment. No martingale, no averaging down, no leverage,
no rounding up. A size below the economic floor becomes `WATCH`. In-process reservations
stop concurrent signals from overspending.

**Lifecycle.**
- Our own stop, take-profit and max-hold run first and are never delayed by social data or
  model calls.
- A trader selling triggers an **independent review**, never a mirrored exit.
- Reduce or exit candidates need independent deterioration. Liquidity is judged at the
  current size.
- The entry rationale is append-only and never rewritten after the outcome is known.

## Tailing a trader

An owner can ask Merrymen to **tail** one Fomo trader for a few hours: to be told, in
their own Telegram DM, about that trader's buys, sells and theses that Fomo's live feed
records, with Merrymen's own read of each coin where research runs for that owner
(monitoring or follow on; with both off, the default, there is no read, and the card,
the answer and each notice say so). It is not copy trading. The backend is
`worker/src/fomo/store.ts`, `tools.ts`, `service.ts`, `ingest.ts`,
`orchestrator-fomo.ts`, `tail-notices.ts` and `tail-notifier.ts`; what the owner types
and presses is `packages/core/src/tail-request.ts` (her words, read by code),
`worker/src/telegram/{interpreter,executor,buttons,fomo-tail,service}.ts` and, for a
group line, `tg-groups/handler.ts` (below, "Asking for a tail").

- **Tools.** `fomo_tail_trader {trader, hours 1–12 (default 3), consider (default
  false)}`, `fomo_untail_trader {trader}` or `{all: true}` (exactly one), and
  `fomo_extend_tail {trader, hours 1–12 (default 1)}`, which only ever moves a
  running tail's end later, never past 12 hours from now, and never revives an ended
  one (`store.ts extendTail`; `fomo_tail_trader` with a shorter span would cut a
  longer tail). Owner-only mutations: never offered to a model loop (the DM
  classifier's enum, `toolSpecs`, the chat loop's Fomo tools) or over MCP, and refused
  by the service for any audience but the owner. Resolving the trader is free when Merrymen already knows
  the handle, otherwise one 250-credit search, never the 2,500-credit profile route.
  Stopping makes no provider call. An install without the hosted live feed
  (self-hosted, `liveFeed` false) refuses with `tail-needs-live-feed`, and with the
  switch off (`MERRYMEN_FOMO_TAILS=0`) the service refuses with `tails-disabled`; both
  are status `unavailable`, store nothing, read nothing, and are said to the owner as
  they are (never "Tailing X until…", never as a failed read).
- **Permissions.** Data access is all a tail needs to be stored and to notify: the
  alerts come from events the shared feed has already stored, at no cost. Routing
  research for the trader's coins, and putting their buys in front of the follow review,
  happen only for an owner with monitoring or follow on, and a considered buy can only
  lead to an entry with follow on. The tool's answer says which (`routable`,
  `following`).
- **Caps.** 3 active tails per owner (renewing one does not count, and may change its
  hours and `consider`), 1–12 hours each, counted under the owner's lock row like
  watches.
- **Tailing again soon after the end continues the tail.** There is one row per owner
  and trader, and an ended tail's row is what its end summary is read from for 15
  minutes. Tailing the same trader again inside those 15 minutes continues that tail
  rather than replacing the row: it keeps its start (its notices, caps and sent log carry
  on, and the minutes between are covered), counts against the 3 again, and gets one
  more end summary at its new end that says the whole span ("from" its first start).
  An end summary already sent stays sent; each end has its own. Later than 15 minutes,
  tailing again starts a new tail. The fleet's routing reads at most 200 tailed traders, with their owners, in
  one query (`store.ts tailOwners`). Per tail: 10 coins in
  the child file, 20 events in its tails block, 30 notices, 2 thesis reads (1 per coin),
  and 6 routed research events per owner and trader an hour (buys and theses only).
  The notice cap is said, never a silence she could read as "no trades": the 30th
  notice ends "That's 30 notices on this tail, the most I send for one tail; from here
  I'll only send its end summary.", the end summary of a capped tail says its counts
  include trades not told, and renewing it or pressing +1h (its count carries on) says
  only its end summary is left (`tail-notifier.ts capSpent`, a read of the sent log).
- **Storage.** `fomo_tails` (tenant, provider user id, display handle, `consider`,
  created, expires, created via). An ended row is kept a day for the end summary, then
  pruned. Which notices were told is the owner's durable state
  `state:fomo-tail-notified` (hashed keys only; retention never prunes `state:` keys).
- **Coverage.** The feed carries larger positions only (about $3,000 and up), a minute
  or two late, and the fleet asks it for Robinhood Chain (the stream's and recovery's
  chain filter), so a trade elsewhere reaches a tail only when the feed carries it
  anyway. Each notice names its event's own chain, and every notice and tail answer
  says the same line (`render.ts TAIL_COVERAGE_LINE`): larger positions only, watched
  for Robinhood Chain, trades elsewhere may be missed, and no alert is not proof they
  did not trade. It never says the feed is Robinhood Chain only.
- **Routing.** A tailed trader's buys and theses route research to the owners tailing
  them only, at interactive priority with reason `tailed`; the cohort's fan-out to every
  monitoring owner is not copied. In that owner's `fomo.json` the trader's coins since
  the tail began enter at discovery priority (like position dependencies, so cohort
  signals keep their place), and a `tails` block (at most 3 active and 3 that ended in
  the last 15 minutes) carries the trader's recent buys, sells and theses for the
  notices. Nothing of one owner's tails reaches another owner's file.
- **Not copy trading: the follow path is unchanged.** A tail with `consider` off adds
  no breadth to any review. With `consider` on, the trader's buys since the tail began
  (buys only: never their sells or theses) count as triggers in that owner's file, as a
  cohort member's do, unless the cohort marks them not followable. The file marks
  the buys only the tail admitted (`ChildSignal.tailTriggerKeys`: the trader is
  neither in the cohort nor one of her position dependencies), and an entry they led
  to never reports that trader as a position dependency (`fomo-child.ts
  reportDependencies`) or keeps them on the position: a tail's influence ends with the
  tail (Stop, its end, `MERRYMEN_FOMO_TAILS=0`), and its trader never becomes a 14-day
  dependency fanned out to every monitoring owner. A nomination only a tail stood behind
  is withdrawn as soon as that tail stops, ends, turns tell-only or tails are switched
  off: the child checks the file's tails block each tick and again at the entry gate
  (an expiry by the clock), and a stop or tell-only renewal from her DM or the Stop
  button withdraws it at once (`FomoChild.tailRevoked`), so a BUY already on its way
  is dropped rather than entered on authority she took back. `following.ts`, sizing, the early book, the Trencher
  review, `take()` and policy are untouched: one buyer is at most a probe (≤ 2.5 USDG),
  and a considered tail's buy counts as a buyer like a cohort trader's, so beside
  another buyer (a cohort trader, or a second considered tail) it is breadth for a
  normal follow entry within the same ceiling. All of it only if Merrymen's own checks
  and the Brain agree, inside the scout budget, on paper unless
  `MERRYMEN_FOMO_FOLLOW_LIVE` allows live, and nothing at all with following off. The
  card's live line says exactly this (a probe on its own, a normal entry beside
  another buyer), never that every entry would be a small probe.
  A sell is a reason for an independent re-check, never an exit to copy.
- **Notices.** Code-written, sent by the Telegram notifier only past its own gates
  (Telegram on, notifications on, a linked owner), link previews off, with Stop and +1h
  buttons (`ftl:stop:<userId>`, `ftl:ext:<userId>`). One per trader, coin and kind per 5
  minutes, and at most 4 per notifier pass (oldest first; the rest stay unclaimed and
  go on the next pass, 15 seconds later); a buy waits up to 3 minutes for Merrymen's
  assessment of the coin, except where her coins are not researched at all (monitoring
  and follow off: `FomoChild.tailsResearched`), when it goes at once and "my read"
  says "none; with monitoring and following off I don't research their coins". A buy
  notice carries their position after it (never called their buy), their thesis as
  "their words, unverified" (stream text when there is some, otherwise one
  `fomo_get_token_theses` read of that trader on that coin, 1,250 credits; without one,
  the reason in plain words: no reader, no chain on the alert, the tail's two reads
  spent, or no time left), Merrymen's
  read from its assessment, what following would do (tell only; one signal into the
  normal review, which a thesis notice words as "a thesis alone is never a signal; only
  their buys go into my normal review", since only buys are ever triggers; or, when it
  cannot act, the reason in plain words: following off, not
  the fast Trencher strategy, scout budget off, entries paused, no Trencher vault (every
  follow entry is a vault-custody entry), live follow not enabled, trading held), the
  coverage floor and when the tail ends. Their words are sanitised, clipped to 280
  characters, links removed and addresses only in short form. An end summary says when
  the tail started and ended and counts what the feed showed. Each notice is recorded
  durably before it is sent, so a crash can lose a notice but never repeat one; a log
  that cannot be read sends nothing. The log records when each notice was told (it forgets an entry 8 hours
  after that, and never one an event still in the file needs) apart from the event time
  it covers from (the 5-minute coalescing), so an alert the fleet observed hours after
  the provider's own time is told once, not on every pass. The child reads the tails
  block itself (`FomoChild.tails()`, at most every 10 seconds, with the owner's data
  access read at that moment), apart from the trading tick, which an owner who only
  researches (no signed grant) never runs and a killed agent stops: she is still told,
  and still gets the end summary, and the follow path never sees its file change
  between ticks.
- **Only trades made during the tail.** An event whose own time (the provider's, else
  when it was observed) is before the tail began, such as a late recovery of an older
  alert, is not in the tails block, not told, not in the end summary's tally and never a
  trigger.
- **Privacy.** A tail is the owner's private state: research status lists it for the
  owner, and a group is never told about one.
- **Kill switch.** `MERRYMEN_FOMO_TAILS=0` (orchestrator and children, read by one
  function, `contract.ts fomoTailsOn`) stops tail routing, the tails block and the
  notices, and the service refuses new tails and extensions (`tails-disabled`). Stored
  tails stay stored and expire; the owner can still stop them, and research status says
  they are on hold.

### Asking for a tail

Only the linked owner, in her own DM (chat id = sender id = owner id, the trusted ids
Telegram sends, never anything said), can start, stop or list tails. Anyone else, in a
DM or a group, is told "Only my owner can set up a tail." and nothing is called.

- **Commands.** `/tail NAME [hours]` (1–12, 3 when unsaid; a part hour rounds up, so
  "1.5 hours" is 2 and "0.5h" is 1; more than 12, a day or a week is cut to 12 and the
  card says so), `/untail [NAME|all]` (bare is all) and `/tails` (what runs,
  until when, tell-only or considered). `/tail` and `/untail` are mutations to the
  interpreter, `/tails` a private read. The classifier's enum has none of them, and a
  kind it does not know becomes chat, so a model can never start or stop a tail.
- **Her words.** In her own DM, before the research planner and the classifier, her
  line is read by code (`parseTailRequest`): "can you tail unipcs trades for the next 3
  hours …", "keep tabs on trader cupsey for a couple hours", "stop tailing unipcs",
  "untail all". It becomes the `/tail` or `/untail` it means. "copy", "copytrade",
  "mirror" and "follow" a trader are never a tail (they keep their old meaning), nor
  is a coin ("watch PONS on fomo", "track $PONS", "track PONS", "keep an eye on PONS"),
  a thing of hers ("track my order", "stop monitoring the price"), a pronoun ("tail
  him"), a question word or quantifier where the trader would be ("tail what unipcs
  buys", "monitor how unipcs trades", "track every move unipcs makes") or the bot's own
  name. Anyone else's words, and every line where Fomo is off in
  the process, go on exactly as before.
- **A stop is as narrow as a start.** A coin is never a trader for a stop either: "stop
  tracking $PONS on fomo", "stop monitoring PONS" or an address goes on to the
  planner's unwatch, as before tails existed. Every tail stops at once only for "untail
  all", "stop tailing everyone", "stop tracking everyone", or a stop with a tail word and
  nothing else ("stop tailing", "untail", "ok stop tailing for now"). A stop with a tail
  word that points at someone it does not name ("stop tailing him", "stop tailing the
  second one") or "stop tracking him" / "that guy" stops nothing: she gets her `/tails`
  list headed "Which tail should I stop? I haven't stopped any yet.". "stop tracking" or
  "stop monitoring" with no tail word and nobody named ("stop tracking it", "stop
  monitoring the cpu", "cancel tracking") is not about tails and goes on as before. A
  negated stop ("don't stop tailing unipcs") or a question about one ("when will you
  stop tailing unipcs?") stops nothing; "can you stop tailing unipcs?" does. In her DM,
  a stop with no tail word that names someone she is not tailing ("stop tracking pons",
  a lower-case coin) also goes on to the planner; one local read
  (`fomo_get_research_status`) decides, never a provider call.
- **Where a tail cannot work.** Telegram asks first (`fomoTailsState` in
  `worker/src/index.ts`: the switch and the hosted live feed). With
  `MERRYMEN_FOMO_TAILS=0`, or self-hosted (no live feed), `/tail` answers the service's
  own refusal straight away ("Tailing is switched off on this service right now…" /
  "Tailing needs Fomo's live feed…"): no search is spent, no card is shown, nothing is
  parked. Her words asking for a tail, in her DM or her group line, go on to research
  exactly as before; with the switch off a stop is still read, so a stored tail can be
  stopped. The trader board's moves offer no `/tail`. With 3 tails running, a `/tail`
  for a fourth trader is refused before the lookup too (one local read of her tails);
  renewing one of the three is not.
- **The confirm card.** `/tail` first resolves the trader read-only
  (`fomo_resolve_subject`: our own record, else one 250-credit search). Not found: "I
  couldn't find a Fomo trader called X." Two accounts answering to the handle: up to
  three, and a request for the exact one. Otherwise a `fomo-tail` action is parked
  for her (ten minutes, the one pending slot, bound to her chat and id) and the card
  says: "Tail X on Fomo for N hours (until HH:MM UTC)?"; what she gets (each buy, sell
  or thesis the live feed shows from them, with their thesis when there is one and my
  read of the coin, with Stop and +1h buttons; with monitoring and following off, no
  read, and it says why); the coverage line; what following would
  do now (`fomo-child.ts followReadiness`: off, paper, live, or what is in the way, in
  the notices' own words); when her words asked me to take the trade too ("if you like
  it, take it"), that a tail never skips my normal review; and the clamp. Nothing is
  stored until she presses. With her "all Telegram messages" off
  (`telegramNotifyEnabled`), the notifier sends nothing at all, tail notices and end
  summaries included, so the card says that in place of what she'd get ("Your “all
  Telegram messages” setting is off …, so I won't send you any of these notices, the
  end summary included, until you turn it back on."), and so do the press's answer, a
  +1h and `/tails`. The setting is hers and silences even the warnings about her money:
  a tail never sends past it.
- **Its buttons.** "👀 Tell me only" always; "👀 + consider their buys" only when
  following could act (paper or live, no blockers); "✖ No". A press is checked like
  every confirm (her nonce, this exact action, not expired, still the linked owner in
  her own DM), and consider is checked again against followReadiness at the press: a
  stale or forged consider press (`mm:c:` on a card that never offered it) stores a
  tell-only tail and says why. A `mm:c:` press on any other question is refused. A
  typed `/confirm` is tell-only. The card becomes the tool's answer ("Tailing X on Fomo
  until …"). An expired card, No, or anyone else's press starts nothing.
- **Stop and +1h** under each running-tail notice (`ftl:stop:<userId>`,
  `ftl:ext:<userId>`) act on the stored tail as it is now, so a notice from before a
  restart still works (they are taken before the backlog rule, like the groups' own
  buttons). Only her press in her own DM counts. Stop is `fomo_untail_trader`; +1h is
  `fomo_extend_tail {hours: 1}`. A short toast answers the press ("Stopped", "+1h",
  "Extended to the 12-hour limit", "That tail has ended.", "That tail had already
  ended.", "That tail had already stopped.") and a plain line follows as a reply to the
  notice, so the notice keeps what it told her. Stopping a tail that ended on its own
  (Stop, `/untail NAME` or her words) says "Your tail on X already ended at HH:MM UTC."
  and leaves its row, which its end summary is read from; one she already stopped says
  "That tail has already stopped."; never "you weren't tailing" a trader she was, and
  never an internal id. Only a handle with no tail at all is "You weren't tailing that
  trader."
- **Backlog.** A `/tail` that waited out an outage is held, like an order; a late
  `/untail` runs, since it only stops something.
- **Asked in a group.** Groups never order trades and never hear a trader or a tail
  (docs/tg-groups.md rules 1 and 3). Her addressed line is read by code the same way,
  where the research lane is wired, and only what code read (trader, hours, clamp,
  take, or a stop) goes to her DM through `TgOwnerPort.proposeTail`, which checks her
  id and the allowlist again, proves her DM with a typing action, and runs the `/tail`
  or `/untail` it means there: the same card and buttons. The room hears only "sent it
  to your DMs 🤫" (or "dm me /start first"). Anyone else's tail line gets the owner-only
  line, at most once an hour per person, and nothing else. The group router's
  `fomo_tail` pick goes the same way, reading the line in code; her line that names no
  trader gets the `/tail` usage in her DM. `/tail` typed in a group by her goes to her
  DM like any command; by anyone else, the owner-only line and no DM.
- **Discovery.** After the trader board, her DM moves (never the room) carry
  `/tail <handle> 3h` beside the two book questions (`tg-fomo-port.ts ownerMoves`),
  only where a tail can work (`tailsAvailable`).

## Publication

`worker/src/fomo/publish.ts`.

- **Drafts come from persisted records only.** A post's wording must match the actual
  status: researching, watching, considering, submitted ("sent, waiting to settle"),
  paper-traded ("on paper"), or confirmed purchase / reduction / exit. "Bought" requires a
  landed fill.
- **The outbox.** It stores the content revision, destination, consent scope, evidence
  ref, a tenant-inclusive dedupe key and a fleet key. At most 2 near-identical posts go out
  per coin, kind and 6-hour window across all agents.
- **Delivery safety.** Consent is re-checked at send time. An ambiguous timeout is
  reconciled before any retry.
- **Delivery to X is disabled in this change.** Every draft ends `blocked-policy`
  ("policy-review-required"). X posting rule 3 allows coin posts only about coins the agent
  bought. The provider's terms reserve redistribution rights for an Enterprise plan. X's
  automation rules need verifying. Confirmed buys keep flowing through the existing X
  pipeline unchanged. Autonomous replies stay off.

## Security and isolation

- **Untrusted text.** Theses, comments, handles, token names and metadata are untrusted:
  sanitised, fenced as data, and unable to add tool calls or change a research state.
- **No model authority.** The model never chooses a tenant, database query, path, URL or
  host.
- **Authorization is checked twice:** in the service below the model, and again at
  delivery or action time (`revalidate`, Telegram's recipient re-check, the outbox's
  consent re-check).
- **Secrets.** Keys stay out of prompts, logs, traces and errors. Stream URLs that carry a
  key are only ever logged in redacted form. Boundary tests pin which files may read the key
  and that only the adapter names the host.
- **Caches.** Shared caches hold public provider data only. Subject memory, watches,
  assessments, funnel traces and jobs are tenant-scoped, and the tests cover every getter.

## Cost model (credits)

Documented costs:

| Item | Credits |
|---|---|
| Leaderboard, normal read | 250 |
| Alerts page | 125 |
| Thesis page | 1,250 |
| Wallet resolution (handle or userId profile) | 2,500 |
| `/v2/me` and the WebSocket | 0 |

Measured `x-credits-cost` replaces these estimates when it is present. Plans per month:
Free 250k, Starter 2.5M, Builder 12.5M, Growth 37.5M, Scale 112.5M.

| Work | Credits | Notes |
|---|---|---|
| Cohort refresh (4 leaderboards) | 1,000 per 6 h = 4,000/day | background budget |
| Cohort enrichment (positions) | ≤ 20 × 250 per refresh | measured inputs, reused about 3 days |
| Stream | 0 | free on every plan |
| Recovery after a reconnect | 125–1,250 | at most 10 pages |
| Quick dossier refresh | ≈ 1,625 | 1 thesis page + alerts + stats |
| Holdings question | 250 | |
| Theses question | 1,250 per page | |
| A tail | 0–250 to resolve the trader, at most 2 × 1,250 thesis reads | alerts come from the stored feed: 0 |

The shared daily pool is `plan × (1 − 20%) / 31`, split 25% position protection, 45%
interactive and 30% discovery. Discovery is shed first. Per-owner hourly and daily caps,
per-group caps and model-call caps apply. Nothing upgrades a plan, tops up credits or
switches provider. On the Free plan (about 6,450 credits/day) the fleet gets roughly one
cohort refresh, a few holdings lookups and about one thesis page a day: enough to verify,
not to operate. **Builder** (about 322k/day) is the realistic minimum for a fleet;
**Starter** suits a single canary. Factual chat answers use zero model calls. Analytical
answers use one call on the existing house model.

## Operations

| Variable | Process | Meaning |
|---|---|---|
| `MERRYMEN_FOMO_API_KEY` (alias `FOMO_API_KEY`) | web, orchestrator; self-hosted worker or settings `fomoApiKey` | provider key, stripped from hosted children |
| `MERRYMEN_FOMO_PLAN_CREDITS` | web and orchestrator, same value | monthly credits; sizes the shared budget |
| `MERRYMEN_FOMO_ENABLED=1` | web and orchestrator, same value | **hosted Fomo is opt-in: off unless exactly `1`.** Off, the orchestrator opens no Fomo pool, runs no `fomo_*` DDL, writes no `fomo.json` and spawns children without IPC; a hosted child is Fomo-on only with both the channel and this value, and off it runs no Fomo code (no Telegram research lane or classifier entries, nothing charged to the scout budget). The web builds no runtime, its chat answers as before, Settings shows no Fomo section and MCP lists no Fomo tool. Self-hosted: on unless `0` (worker and web alike); a self-hosted install never owes the scout budget anything for Fomo |
| `MERRYMEN_FOMO_FOLLOW_LIVE` | worker children | allowlist of agents whose follow nominations may execute live (default nobody) |
| `MERRYMEN_TG_GROUPS_FOMO=0` | worker children | turns off the Telegram group research lane |
| `MERRYMEN_TG_GROUPS_ROUTER=0` | worker children | turns off the group router (docs/tg-groups.md "What a line wants"): lines no rule knew go to the persona |
| `MERRYMEN_FOMO_TAILS=0` | orchestrator and worker children | turns tails off: `fomo_tail_trader` refuses (`tails-disabled`), no tail routing, no tails block in child files, no tail notices. Stored tails stay stored, can be stopped, and expire on their own |
| `MERRYMEN_TENANT` | set by the orchestrator in each child | not a secret; the child checks `fomo.json` belongs to it. IPC never trusts it: the orchestrator stamps the tenant itself. |

Surface limits:
- **Telegram DM:** 25 s for the whole Fomo answer, 15 s per lookup, and 3 research lookups
  per model answer, because the poll loop is serial. The model loop never starts deep
  research; that comes only from the planner on explicit owner wording.
- **Telegram groups:** 6 research answers per chat and 30 per agent per 10 minutes.
  Answers are coin-level, with no addresses, links or @handles, plus Fomo's public
  leaderboard (Milla's call, 2026-10-07): its handles and their provider-reported money
  made on closed trades, never who Merrymen follows. One trader's holdings, trades or
  profile, and the owner's own research state, stay in a DM. Lines pass the group gate as
  `research` (every clause but money), with money in short form ($151.4k) and four rows a
  board. "What can you do with fomo" and "is fomo working?" are answered by code with no
  lookup: a fixed list, and whether research is on here. Group answers carry no
  attribution line and no skill caveat (Milla, 2026-10-07: the room has had a post about
  the source); owner answers keep both. When the owner asks in a group, her moves for the
  rows (the DM questions to ask next, and `/buy SYM` only for a Robinhood Chain coin her
  `/buy` resolves) go to her DM, and the room hears only that they went. A line no rule
  reads is routed by the group model to a closed menu (docs/tg-groups.md); a Fomo pick
  runs as a fixed question through the same planner. The owner's ask about one trader by
  name (routed, or planned and deflected in the room) is answered read-only in her DM
  (`AnswerFomoInput.readOnly`) as one of three fixed questions (profile, holdings, this
  week's trades), at most six per 10 minutes.
- **App chat:** at most 4 lookups per question. Analysis answers count against a
  per-owner model allowance of 40 calls and 160k tokens a day. When it is spent, the
  factual answer is sent with a note.
- **MCP:** the read tools only, under `market.read`, with research status under
  `agents.read`. Watch, unwatch, tails and deep research are not offered over MCP.

Health is visible to owners without logs. "Is Fomo working?" and the status route report:
`not-configured`, `disabled`, `permission-required`, `provider-unavailable`,
`budget-limited`, `research-only`, `watching-condition`, `receiving-fresh-data`. The
orchestrator logs one aggregated line per 20 minutes, with no identities and no key-bearing
URLs.

To verify with a key: run the read-only probe below. It reports per-capability evidence
and touches no trading route.

```bash
MERRYMEN_FOMO_API_KEY=… npx tsx scripts/fomo-probe.mts [--theses] [--trader] [--stream]
```

## Rollback

1. Unset `MERRYMEN_FOMO_ENABLED` (or set anything but `1`) on the orchestrator and the
   web. The stream, cohort, research and child files stop, children respawn without IPC
   and run no Fomo code, and the web chat answers as it did before Fomo.
   Turning the pass off also stops charging Fomo exploration to the scout budget, so
   close any follow or early positions first. Follow is paper-only until Stage E.
2. Or, to keep the switch on but spend nothing: unset `MERRYMEN_FOMO_API_KEY` on the web
   and orchestrator. Lookups answer "not configured".

**Turning it on, the first time.** With Fomo on, every hosted agent's scout gate counts
what Fomo exploration holds, and while that ledger cannot be read over IPC it charges
every open Trencher position's cost instead, which errs toward refusing. So:

- confirm the orchestrator logs `fomo: on` and that its runtime builds on the first pass;
- then watch scout-gate refusals for a few ticks;
- unsetting the switch makes that term exactly 0 again.
3. Owners' `fomoFollowEnabled` defaults to off. Turning it off stops nominations at the
   next tick. Open positions keep their normal exits.
4. The schema is additive (`fomo_*` tables only). Leaving it in place is harmless; dropping
   the tables loses only research caches, cohort history and drafts, never ledger or money
   records.
5. Brain: the `trader-flow` lens is sent only when Brain advertises it in `/health`, and
   the probe's cached answer is dropped on the first decide that fails while carrying the
   lens. A Brain rollback stops the lens after at most one failed review.

## Decisions needed from Milla

1. **Terms.** The provider licenses use "within your own applications and internal
   operations" and reserves redistribution for Enterprise. fomo.family's own terms forbid
   automated harvesting. Decide on LLM processing and on any public republication before
   commercial deployment.
2. **X publication** of research, watching or considering posts conflicts with X rule 3.
   Keep it off, or change the rule and collect a separate research-post consent.
3. **Regular-tape screens** (the $100k volume and top-20 slice), the entry floors and the
   three-caveat Brain gate rule: left unchanged here. The diagnosis above says which ones
   look like accidental permanent holds.
4. **Plan.** Credits for the fleet (Builder or higher recommended) and the
   `MERRYMEN_FOMO_PLAN_CREDITS` value.
5. **Stage E canary.** Name the agent, its scout budget and the live allowlist entry.
6. **Verification asks.** Coins with cohort buying may be verified on chain beyond the
   top-20 slice, so that a follow nomination has a verified route. They are kept out of the
   regular candidate lists. Confirm this use of the slice, or ask for asks to be limited
   to coins already inside it.
7. **Calibration.** The cohort weights, the follow thresholds and the economic floor
   (1 USDG) are reasoned defaults, not fitted ones. Revisit them once real data has been
   read.

## Live verification (2026-10-04/05, Starter plan key)

Read-only, from a developer machine; the key was read from a private file and never
printed or committed. Captured response bodies stayed in a scratch area; the repository's
test fixtures copy only their field structure, with fabricated values.

- **Account (`/v2/me`):** plan Starter, 2,500,000 credits a month, a **100,000-credit daily
  ceiling**, the app-feed stream included and the on-chain stream (`/ws/trades`) not.
- **AUTHENTICATED_TESTED:**
  - account
  - leaderboard
  - trending board
  - alerts feed
  - theses by token
  - the alerts stream, realtime
- **PARTIAL:** holdings, because the provider truncates large books (the total is reported as a floor).
- **ENTITLEMENT_BLOCKED:** `/ws/trades` on this plan.
- **Upstream transient:** token stats answered 503 "upstream did not answer in time" on
  every attempt in both sessions, billed nothing, and is reported as missing, not empty.
  Positions (502) and trade comments (503) behaved the same once.
- **Measured costs** matched the documentation exactly:

  | Read | Credits |
  |---|---|
  | Leaderboard | 250 |
  | Board | 250 |
  | Alerts page | 125 |
  | Thesis page | 1,250 |
  | Holdings | 250 |
  | Search | 250 |
  | `/v2/me` | 0 |
  | 5xx failures | 0 |

- **Measured latency:**

  | Read | Time |
  |---|---|
  | Boards and leaderboard | about 0.6 s |
  | Alerts | about 1 s |
  | Fills | about 5 s |
  | Holdings and theses | about 7 s |
  | Failing stats | 11 s per attempt |

  This led to the 20 s per-attempt and 45 s overall limits, and the 40 s invoke deadline.
- **Live shape differences fixed:**
  - Token search returns `results`.
  - Stream entitlements are objects.
  - Thesis and fill times are ISO strings.
  - Feed rows use `type`.
  - Undocumented EVM network ids 1, 56 and 8453 are Ethereum, BNB and Base.
  - Unpriced holdings are unknown, not zero.
  - Thesis "equity 0" is not a stake.
  - Per-token P&L on the leaderboard is not window P&L.
- **End-to-end chat** (planner → broker → service → renderer, in-memory store) ran against the live API:
  - theses
  - "what about the sellers?" (kept the coin and chain)
  - "which of our 150 traders bought this?"
  - weekly leaderboard
  - a trader's holdings
  - smaller coins getting attention
  - an owner-ledger question correctly left alone
- **Credits used** by all verification: about 8,500.

## Status labels

**IMPLEMENTED:** code exists and is wired. **FIXTURE_TESTED:** tests pass against fixtures
constructed from the provider's documentation (not captured responses).
**AUTHENTICATED_TESTED:** verified with a real key (see "Live verification"). **PAPER_TESTED:** exercised
by a real paper agent end to end; none yet. **LIVE_AUTHORIZED:** owner-approved live use;
none. **NOT_YET_VERIFIED:** behaviour assumed from documentation (stream heartbeats, ring
retention, thesis-by-token Robinhood filtering, holders coverage, paid-plan daily ceiling).

## Capability report (documented baseline, fetched 2026-10-04T16:05Z)

Statuses move to AUTHENTICATED_TESTED, PARTIAL, ENTITLEMENT_BLOCKED or UNAVAILABLE as calls
are observed. They are stored in `fomo_capabilities` and shown by
`fomo_get_research_status`. Three observations move no status: a rejected key (HTTP 401, or a
close 1008 whose reason names the key), a call our own deadline or abort cut short, and a 5xx the
provider marked retryable (its upstream did not answer for one subject in time). The last is
noted beside the standing verdict as transient evidence, keeping its time and last success; only
a failure the provider did not call transient marks a route UNAVAILABLE. A close 1008 with no
reason, or one naming neither, is recorded as "policy close (1008): key or plan".

| Capability | Route | Status | Evidence | As of |
|---|---|---|---|---|
| account | `/v2/me` | DOCUMENTED | documented: /v1 catalogue GET /v2/me: plan, credits{monthly,usedThisMonth,prepaid,remaining}, streams{appFeed,onChain}; zero credits; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| leaderboard | `/v2/leaderboard/{window}` | DOCUMENTED | documented: openapi.json GET /v2/leaderboard/{window}: window 24h\|7d\|30d\|all, limit 1-150 (100 on all), 250 credits per call; rows carry userId; no chain filter; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| trader-by-handle | `/v2/users/{handle}` | DOCUMENTED | documented: openapi.json GET /v2/users/{handle}: 2,500 credits on a hit, 250 on an unresolvable handle, refunded while wallets are resolving; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| trader-by-id | `/v2/users/id/{userId}` | DOCUMENTED | documented: openapi.json GET /v2/users/id/{userId}: same identity payload as the handle route, 2,500 credits; 404 does not consume the allowance; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| positions | `/v2/users/{userId}/positions` | DOCUMENTED | documented: openapi.json GET /v2/users/{handle}/positions (userId accepted): 25 closed per cursor page, 250 credits per page; the vendor states a full history is not obtainable at any setting; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| swaps | `/v2/users/{userId}/swaps` | DOCUMENTED | documented: openapi.json GET /v2/users/{handle}/swaps: 100 fills per cursor page, 250 credits per page; tradeIdIn/tradeIdOut join to positions; observed live 2026-10-04: complete:false with a note that at most 100 swaps are served per trader and no cursor reaches past them, so fills are a recent window, not history; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| swaps-relay | `/v2/users/{userId}/swaps?source=relay` | PARTIAL | documented: listed only in the /v1 catalogue, absent from openapi.json; covers Relay-routed flow only (vendor measured 96% in-window); 409 retryable while a wallet resolves; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| balances | `/v2/users/{userId}/balances` | DOCUMENTED | documented: openapi.json GET /v2/users/{handle}/balances: upstream cap of ~100 holdings with no way past it, so totalValueUsd is a floor when truncated; ?chain= narrows rows; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| following | `/v2/users/{userId}/following` | DOCUMENTED | documented: openapi.json GET /v2/users/{handle}/following: at most 200 names upstream, flat 250 credits; 503 retryable never means not-found; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| spotlight | `/v2/users/{userId}/spotlight` | DOCUMENTED | documented: openapi.json GET /v2/users/{handle}/spotlight: the vendor's own pick of best trades and theses, 250 credits; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| theses | `/v2/thesis` | DOCUMENTED | documented: openapi.json GET /v2/thesis: recent theses across coins with networkId and equity (no likes); ?chain= filter; 1,250 credits per page; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| theses-by-token | `/v2/thesis/token/{address}` | PARTIAL | documented: openapi.json GET /v2/thesis/token/{mint}: the network enum is sol\|bnb\|base\|eth\|arc with no robinhood value, so a Robinhood token is queried without one and every row's networkId must be checked; 1,250 credits per page; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| theses-by-user | `/v2/thesis/user/{userId}` | DOCUMENTED | documented: openapi.json GET /v2/thesis/user/{id}: every thesis by one trader, sort likes\|recent, ?chain=; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| theses-by-user-token | `/v2/thesis/user/{userId}/token/{address}` | DOCUMENTED | documented: openapi.json GET /v2/thesis/user/{id}/token/{address}: one trader's theses on one token; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| trade-detail | `/v2/trades/{tradeId}` | DOCUMENTED | documented: openapi.json GET /v2/trades/{tradeId}: swaps, transfers, entry/exit, realized PnL, isDev; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| trade-comments | `/v2/trades/{tradeId}/comments` | DOCUMENTED | documented: openapi.json GET /v2/trades/{tradeId}/comments: thread with parentId, limit 1-200, 250 credits; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| token-stats | `/v2/token/{address}/stats` | DOCUMENTED | documented: openapi.json GET /v2/token/{address}/stats: windows 5m\|1h\|4h\|24h, volumes sent as strings, buySellRatio null with no sells; networkId needed outside the vendor directory; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| token-devs | `/v2/token/{address}/devs` | DOCUMENTED | documented: openapi.json GET /v2/token/{address}/devs: deployer and insider positions with their theses; an empty list is not a clean bill of health; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| token-holders | `/token/{address}/holders` | PARTIAL | documented: openapi.json GET /token/{address}/holders is populated from captured balances, and GET /health and GET /v1 report a captured dataset of 8 traders, so the holder set is tiny and an absence proves nothing; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| token-board-trending | `/v2/leaderboard/tokens/trending` | DOCUMENTED | documented: openapi.json GET /v2/leaderboard/tokens/trending: live with a 5-minute cache; source captured marks the provider's stored copy; observed live 2026-10-04: both token boards answered source captured with stale:false and an age of minutes, so stale and age, not the source alone, say whether it is a fallback; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| token-board-graduated | `/v2/leaderboard/tokens/graduated` | DOCUMENTED | documented: openapi.json GET /v2/leaderboard/tokens/graduated: same shape as trending; small caps by nature; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| token-board-most-held | `/v2/leaderboard/tokens/most-held` | DOCUMENTED | documented: openapi.json GET /v2/leaderboard/tokens/most-held: holders is null on this board upstream; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| token-activity | `/v2/tokens/activity` | PARTIAL | documented: openapi.json GET /v2/tokens/activity: the vendor states its upstream stopped publishing this board on 2026-08-23; answers carry stale:true; not wired into the client; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| token-candles | `/v2/token/{address}/candles` | PARTIAL | documented: listed in the /v1 catalogue and the pricing page (Growth and Scale only) but absent from openapi.json; not wired into the client; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| search | `/v2/search` | DOCUMENTED | documented: openapi.json GET /v2/search: traders and tokens, each with a type; trader rows carry userId; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| tokens-search | `/v2/tokens/search` | DOCUMENTED | documented: openapi.json GET /v2/tokens/search: symbol/name to address, networkId, market cap; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| alerts-rest | `/v2/alerts` | DOCUMENTED | documented: openapi.json GET /v2/alerts: the app feed's LARGE events only (floor near $3,000 of position value), opaque cursor checkpointing, 125 credits; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| ws-alerts | `/ws/alerts` | DOCUMENTED | documented: openapi.json WSS /ws/alerts: app feed on every plan, zero credits; paid keys realtime, a free key delayed 15 s after 7 days; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| ws-trades | `/ws/trades` | DOCUMENTED | documented: openapi.json WSS /ws/trades: on-chain stream for Growth or Scale keys only; a lower plan is refused (403, or close 1008) and is ENTITLEMENT_BLOCKED once probed; a 1008 also closes a bad key, so it blocks only when its reason names the plan; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| trading-account | `/v2/trading/*` | UNSUPPORTED | policy: the vendor's order-placing account product; Merrymen keeps its own execution system and the client refuses the path; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
| credit-top-up | `/pay/create` | UNSUPPORTED | policy: a payment flow; Merrymen never pays through a research adapter and the client refuses the path; fetched 2026-10-04T16:05Z | 2026-10-04T16:05Z |
