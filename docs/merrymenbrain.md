# merrymenbrain: the second desk

[merrymenbrain](https://github.com/millw14/merrymenbrain) is our fork of
TradingAgents. It runs the full research committee: tool-calling analysts, a
bull/bear debate, a research manager, a trader, a risk committee and a portfolio
manager. It uses the same Robin Hood cast as `services/brain`. One run takes
minutes and 20–40 model calls. That is too slow for a decision, but useful as a
second opinion.

## How the two connect

```
worker ──/v1/decide──▶ services/brain ──POST /v1/research (3s timeout)──▶ merrymenbrain
                          │  analysts run meanwhile                          │ single worker,
                          │                                                  │ queued, deduped
                          ◀───── latest finished report (or none) ───────────┘
                          │
                          ▼
                 fenced "OUTSIDE RESEARCH" block in the manager's dossier
```

- **Brain never waits for a run.** Each decision makes one POST, started
  alongside the analysts, with a total deadline of `MERRYMENBRAIN_TIMEOUT_SEC`
  (3s, capped at 10s). The POST returns the latest finished report and queues
  a refresh when that report is older than `MERRYMENBRAIN_FRESH_SEC` (6h by
  default on the merrymenbrain side). A failed refresh is retried only after a
  backoff (30 min, doubling), so a provider cap is not hit again on every
  decision.
- **The report can only add evidence.** A missing report, a stale one (older
  than `MERRYMENBRAIN_MAX_AGE_SEC`, measured from the report's own
  `completed_at`), an unreadable committee run (`REVIEW`), a timeout, a refusal,
  a malformed body or a report about the wrong symbol all leave the dossier
  unchanged. None of them refuses a run.
- **The report is untrusted and not independent.** It is fenced like scraped
  text and labelled as reading the same public sources as our lenses. Its
  rating is a view, not an instruction, and it is attributed to
  "merrymenbrain", not to characters that share names with this desk's seats.
  The gate and `_assemble` still constrain whatever the manager decides. Hex is
  redacted on both sides.
- **It is only asked where it can help.** Only `research` and `deep` tiers
  ask (not `pulse`), and only for `equity-token` and `crypto-native`
  instruments. merrymenbrain refuses memecoins and stablecoins.
- **Budgets and keys are separate.** merrymenbrain spends its own
  `MERRYMENBRAIN_LLM_API_KEY`, which must come from a **separate Groq
  organization** (see below). Its calls never count against a Brain run's budget.

## The desk

Each node's system prompt is the house rules, then its character, then its job.
The character sets tone and focus only.

| Node | Merryman |
| --- | --- |
| `analyst:technical` | Will Scarlet |
| `analyst:sentiment`, `analyst:social` | Alan-a-Dale |
| `analyst:news`, `analyst:news-sentiment` | Much the Miller's Son |
| `analyst:fundamentals` | Friar Tuck |
| `analyst:onchain`, `analyst:peg`, `analyst:reserve` | The Tinker |
| `analyst:liquidity` | David of Doncaster |
| `analyst:builder` | Reynold Greenleaf |
| `debate:bull` / `debate:bear` | Little John / Will Stutely |
| `risk:aggressive` / `risk:conservative` / `risk:neutral` | Arthur a Bland / Wat o' the Crabstaff / Sir Richard at the Lee |
| `portfolio-manager` | Robin Hood |

merrymenbrain adds Maid Marian (research manager) and Gilbert Whitehand
(trader). The cast is written into prompts only; the report Brain reads labels
the other desk's voices as "merrymenbrain", never by character. The table lives in `services/brain/brain/cast.py` and is mirrored in
merrymenbrain's `tradingagents/merrymen/cast.py`. If you change one, change both.

## Setting it up on Railway

merrymenbrain goes in the **same Railway project and environment** as the brain
service. Private addresses (`*.railway.internal`) only resolve inside one
project, so a service deployed as a new project fails silently: Brain simply
never gets a report.

1. **Add the service.** In the merrymen project, click
   **+ New → GitHub Repo → millw14/merrymenbrain**. Name the service exactly
   **`merrymenbrain`**; the private address in step 3 depends on the name. Its
   `railway.json` builds `Dockerfile.merrymen` and health-checks `/health`.
   That file is in the merrymenbrain repo, so it does not affect this repo's
   rule that `railway.json` must not pin `dockerfilePath`.
   **Do not generate a public domain.**
2. **On the merrymenbrain service**, set:

   | Variable | Value |
   | --- | --- |
   | `PORT` | `8080`, pinned so the private address below is stable (as for the browser) |
   | `MERRYMENBRAIN_TOKEN` | a fresh 32-byte secret, shared with the brain service |
   | `MERRYMENBRAIN_LLM_API_KEY` | a Groq key from a **separate Groq organization** |

   > **Give it its own Groq organization**, for the same reason as the group
   > chat's key. Groq rations per organization and model, not per key.
   > merrymenbrain uses `gpt-oss-120b` and `gpt-oss-20b`, the same models as
   > Brain, and one run is 20–40 calls. A second key made in the house
   > organization would let the research queue spend the allowance every Brain
   > decision depends on. merrymenbrain refuses a key equal to
   > `BRAIN_LLM_API_KEY` only when both are in one environment, such as a
   > local `.env`. On Railway they sit on different services, so the check
   > can't see it. Alternatively, point it at another provider with
   > `TRADINGAGENTS_LLM_PROVIDER` and its model variables.

3. **On the brain service**, set:

   | Variable | Value |
   | --- | --- |
   | `MERRYMENBRAIN_URL` | `http://merrymenbrain.railway.internal:8080` |
   | `MERRYMENBRAIN_TOKEN` | the same secret as step 2 |
   | `MERRYMENBRAIN_TIERS` | optional, default `research,deep` |
   | `MERRYMENBRAIN_TIMEOUT_SEC` | optional, default `3`, at most `10` |
   | `MERRYMENBRAIN_MAX_AGE_SEC` | optional, default `86400` |

   Do not build the URL from `${{merrymenbrain.PORT}}`. Railway injects `PORT`
   into the running container but does not publish it as a variable other
   services can reference, so the reference would come out empty.

4. **Check it from the brain service's `/health`.** It now calls
   merrymenbrain's token-gated `/v1/ping`, so one look proves the whole path:

   | `outside_research` shows | Meaning |
   | --- | --- |
   | `"configured": false` | `MERRYMENBRAIN_URL` or `MERRYMENBRAIN_TOKEN` is unset on brain |
   | `"reachable": false` | wrong service name, wrong port, `PORT` not pinned, or a different project |
   | `"auth_ok": false` | the two `MERRYMENBRAIN_TOKEN` values differ, or merrymenbrain has none |
   | `"remote_ok": false` | merrymenbrain is reachable but has no model key; `remote_problem` says which variable |
   | `"reachable": true, "auth_ok": true, "remote_ok": true` | wired |

   merrymenbrain's own `/health` answers 200 even when it cannot research, so
   its Railway health check turning green only means it started. Its deploy logs
   print a `cannot research yet` warning when the token or key is missing.

Leave `MERRYMENBRAIN_URL` unset to turn the second desk off. Brain then behaves
exactly as before, and a malformed optional variable only costs the second desk,
never a decision.

Reports and the data cache live on merrymenbrain's container disk. A redeploy
clears them, so for a while after a deploy Brain gets no outside report while
the queue refills.

## Running it locally

```bash
# in merrymenbrain
pip install -e ".[merrymen]"
MERRYMENBRAIN_TOKEN=dev MERRYMENBRAIN_LLM_API_KEY=... python -m tradingagents.merrymen serve --port 8080

# in merrymen/services/brain
MERRYMENBRAIN_URL=http://localhost:8080 MERRYMENBRAIN_TOKEN=dev uvicorn brain.server:app --port 8081
```
