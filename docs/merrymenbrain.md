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
  alongside the analysts. The POST returns the latest finished report and queues
  a refresh when that report is older than `MERRYMENBRAIN_FRESH_SEC` (6h by
  default on the merrymenbrain side).
- **The report can only add evidence.** A missing report, a stale one (older
  than `MERRYMENBRAIN_MAX_AGE_SEC`), a timeout, a refusal, a malformed body or a
  report about the wrong symbol all leave the dossier unchanged. None of them
  refuses a run.
- **The report is untrusted and not independent.** It is fenced like scraped
  text and labelled as reading the same public sources as our lenses. Its
  rating is a view, not an instruction. The gate and `_assemble` still
  constrain whatever the manager decides. Hex is redacted on both sides.
- **It is only asked where it can help.** Only `research` and `deep` tiers
  ask (not `pulse`), and only for `equity-token` and `crypto-native`
  instruments. merrymenbrain refuses memecoins and stablecoins.
- **Budgets and keys are separate.** merrymenbrain spends its own
  `MERRYMENBRAIN_LLM_API_KEY` and refuses to start a run on Brain's
  `BRAIN_LLM_API_KEY`. Its calls never count against a Brain run's budget.

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
(trader). The table lives in `services/brain/brain/cast.py` and is mirrored in
merrymenbrain's `tradingagents/merrymen/cast.py`. If you change one, change both.

## Setting it up on Railway

1. **Deploy merrymenbrain** as its own service from the merrymenbrain repo. Its
   `railway.json` builds `Dockerfile.merrymen` and health-checks `/health`.
   Keep it private: **do not generate a public domain.**
2. On the **merrymenbrain** service, set:

   | Variable | Value |
   | --- | --- |
   | `MERRYMENBRAIN_TOKEN` | a long random string |
   | `MERRYMENBRAIN_LLM_API_KEY` | a model key of its own, not `BRAIN_LLM_API_KEY` |

3. On the **brain** service, set:

   | Variable | Value |
   | --- | --- |
   | `MERRYMENBRAIN_URL` | `http://${{merrymenbrain.RAILWAY_PRIVATE_DOMAIN}}:${{merrymenbrain.PORT}}` |
   | `MERRYMENBRAIN_TOKEN` | the same token as step 2 |
   | `MERRYMENBRAIN_TIERS` | optional, default `research,deep` |
   | `MERRYMENBRAIN_TIMEOUT_SEC` | optional, default `3` |
   | `MERRYMENBRAIN_MAX_AGE_SEC` | optional, default `86400` |

4. Check it. Brain's `/health` should show `"outside_research": {"configured": true, ...}`,
   and merrymenbrain's `/health` should show `"ok": true`.

Leave `MERRYMENBRAIN_URL` unset to turn the second desk off. Brain then behaves
exactly as before.

## Running it locally

```bash
# in merrymenbrain
pip install -e ".[merrymen]"
MERRYMENBRAIN_TOKEN=dev MERRYMENBRAIN_LLM_API_KEY=... python -m tradingagents.merrymen serve --port 8090

# in merrymen/services/brain
MERRYMENBRAIN_URL=http://localhost:8090 MERRYMENBRAIN_TOKEN=dev uvicorn brain.server:app --port 8080
```
