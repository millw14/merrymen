"""
THE ONE PLACE A MODEL IS CALLED, so the one place spend can be counted.

Every node goes through `complete()`. That is not a style preference: an
accounting system with two call sites has no accounting, and the incident this
service is designed around happened because the counter did not exist anywhere.

NO SDK RETRIES. The provider clients default to retrying 2-3 times on a 429,
which silently triples the cost of a rate-limited run and hides the rate limit
from the budget. Retries here are explicit, bounded, and counted — and a retry
that would breach the ceiling does not happen.

PROVIDER-AGNOSTIC BY BASE URL rather than by a provider enum with a branch per
vendor. Groq, OpenAI, Together and most others speak the same chat-completions
shape, so one client covers them and the config says which endpoint.
"""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from typing import Any

import httpx

from .budget import RunBudget
from .credential import Credential, CredentialRefused, resolve as resolve_credential


class ProviderError(RuntimeError):
    pass


@dataclass(frozen=True)
class LlmConfig:
    base_url: str
    api_key: str
    #: The model that does the reasoning-heavy nodes.
    deep_model: str
    #: The model for summarising, routing and formatting.
    quick_model: str
    provider: str = "groq"
    temperature: float | None = 0.2
    #: Hard cap on output tokens per call. A model that emits unbounded
    #: reasoning does not hang the run; it gets truncated and the node says so.
    max_output_tokens: int = 1400
    request_timeout_s: float = 45.0

    @staticmethod
    def from_env() -> LlmConfig:
        """
        Build the config, or refuse.

        The key comes from credential.resolve, which will not accept the fleet's
        house key — the earlier version of this function fell back to
        GROQ_API_KEY, which is precisely the variable the 24 live agents read.
        A Brain evaluation on that credential spends their quota.
        """
        base = os.getenv("BRAIN_LLM_BASE_URL", "https://api.groq.com/openai/v1")
        cred = resolve_credential()
        return LlmConfig(
            base_url=base.rstrip("/"),
            api_key=cred.key,
            provider=os.getenv("BRAIN_LLM_PROVIDER", "groq"),
            deep_model=os.getenv("BRAIN_DEEP_MODEL", "openai/gpt-oss-120b"),
            quick_model=os.getenv("BRAIN_QUICK_MODEL", "openai/gpt-oss-20b"),
            max_output_tokens=int(os.getenv("BRAIN_MAX_OUTPUT_TOKENS", "1400")),
        )


class Llm:
    """A chat client that reports what it spent, every time."""

    def __init__(self, cfg: LlmConfig, client: httpx.AsyncClient | None = None) -> None:
        self.cfg = cfg
        self._client = client

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.cfg.request_timeout_s)
        return self._client

    async def complete(
        self,
        *,
        node: str,
        budget: RunBudget,
        system: str,
        user: str,
        deep: bool = False,
        json_schema: dict[str, Any] | None = None,
        max_attempts: int = 2,
    ) -> str:
        """
        One model call, counted before it is made and recorded after.

        `json_schema`, when given, asks the provider for structured output. The
        RESULT IS RETURNED AS TEXT and parsed by the caller — but the schema is
        still sent, because a provider that can constrain the shape produces far
        fewer unparseable answers than a prompt that merely asks nicely.
        """
        budget.check_before(node)
        model = self.cfg.deep_model if deep else self.cfg.quick_model
        if not self.cfg.api_key:
            raise ProviderError(
                "no model key configured — set BRAIN_LLM_API_KEY. Refusing to run "
                "rather than silently producing an unbacked decision."
            )

        payload: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": self.cfg.max_output_tokens,
        }
        if self.cfg.temperature is not None:
            payload["temperature"] = self.cfg.temperature
        if json_schema is not None:
            payload["response_format"] = {"type": "json_object"}

        client = await self._http()
        last: Exception | None = None
        for attempt in range(max_attempts):
            # EVERY ATTEMPT IS A CALL. Counting only successes is how a
            # rate-limited run comes in "under budget" while costing more.
            if attempt:
                budget.check_before(f"{node}#retry{attempt}")
            try:
                r = await client.post(
                    f"{self.cfg.base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {self.cfg.api_key}"},
                    json=payload,
                )
                if r.status_code == 429:
                    last = ProviderError("rate limited")
                    # Bounded, and only if the budget still allows it.
                    await asyncio.sleep(1.5 * (attempt + 1))
                    continue
                r.raise_for_status()
                body = r.json()
            except httpx.HTTPError as e:
                last = ProviderError(f"{type(e).__name__}: {e}")
                if attempt + 1 >= max_attempts:
                    break
                await asyncio.sleep(1.0)
                continue

            usage = body.get("usage") or {}
            budget.record(
                node=node,
                provider=self.cfg.provider,
                model=model,
                tin=int(usage.get("prompt_tokens", 0)),
                tout=int(usage.get("completion_tokens", 0)),
            )
            choices = body.get("choices") or []
            if not choices:
                raise ProviderError("provider returned no choices")
            return str(choices[0].get("message", {}).get("content") or "")

        raise ProviderError(f"{node} failed after {max_attempts} attempts: {last}")


def extract_json(text: str) -> dict[str, Any]:
    """
    Pull the JSON object out of a model's answer.

    Models wrap JSON in prose and fences no matter what the prompt says, so this
    is deliberate tolerance rather than trust: it finds the outermost balanced
    object and parses THAT. What it will not do is guess — an answer with no
    parseable object raises, and the caller turns that into a typed refusal
    rather than a decision assembled from a regex.
    """
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```")[1] if "```" in text[3:] else text[3:]
        if text.startswith("json"):
            text = text[4:]
    start = text.find("{")
    if start < 0:
        raise ValueError("no JSON object in model output")
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return json.loads(text[start : i + 1])
    raise ValueError("unbalanced JSON object in model output")
