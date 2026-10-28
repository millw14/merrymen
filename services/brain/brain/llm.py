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
import logging
import os
import re
from dataclasses import dataclass
from typing import Any

import httpx

from .budget import RunBudget
from .credential import Credential, CredentialRefused, resolve as resolve_credential

log = logging.getLogger(__name__)


class ProviderError(RuntimeError):
    """
    A model call that did not produce an answer, and WHICH KIND of not.

    `kind` is a closed alphabet so a log line or a lens note can be counted:
    "rate-limit" (429), "server" (5xx), "invalid-json" (the provider's JSON mode
    rejected the model's own output — on Groq, `json_validate_failed`, which is
    also what a reasoning model that ran out of output tokens produces),
    "bad-request" (any other 4xx), "auth" (401/403), "timeout", "network",
    "bad-response" (a 2xx that is not JSON), "empty" (a 200 with no choices)
    and "config" (no key).

    Every one of these used to read "provider-failed" in the orchestrator log
    and nothing more, so a 400 caused by the Brain's own payload was taken for
    Groq rate-limiting the fleet. The kind and the status are the minimum that
    tells those apart.
    """

    def __init__(
        self,
        message: str,
        *,
        kind: str = "other",
        status: int | None = None,
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.kind = kind
        self.status = status
        self.code = code


def _kind_of(status: int, code: str | None) -> str:
    if status == 429:
        return "rate-limit"
    if status >= 500:
        return "server"
    if status in (401, 403):
        return "auth"
    if code == "json_validate_failed":
        return "invalid-json"
    return "bad-request"


#: Longest provider error message carried into a log line or a lens note.
_MESSAGE_MAX = 160


def _provider_error(r: httpx.Response, api_key: str) -> ProviderError:
    """
    The provider's own reason for refusing, bounded and with no secret in it.

    Only `error.message`, `error.code` and `error.type` are read. Groq's
    `failed_generation` — the model's raw output, which can quote the material
    the prompt carried — is deliberately never read, logged or returned.
    """
    code: str | None = None
    message = ""
    try:
        body = r.json()
    except ValueError:
        body = None
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        raw_code = err.get("code") or err.get("type")
        code = str(raw_code)[:60] if raw_code else None
        message = str(err.get("message") or "")
    elif isinstance(err, str):
        message = err
    if api_key:
        message = message.replace(api_key, "[key]")
    message = " ".join(message.split())[:_MESSAGE_MAX]
    kind = _kind_of(r.status_code, code)
    text = f"{r.status_code} {kind}" + (f" {code}" if code else "") + (f": {message}" if message else "")
    return ProviderError(text, kind=kind, status=r.status_code, code=code)


#: Families that emit chain-of-thought unless told not to. Substring match on
#: the model id, because providers prefix and suffix these freely
#: ("openai/gpt-oss-120b", "deepseek-r1-distill-llama-70b").
_REASONING_FAMILIES = ("gpt-oss", "deepseek-r1", "qwen3-thinking", "nemotron", "-thinking")


def _is_reasoning_model(model: str) -> bool:
    m = (model or "").lower()
    return any(f in m for f in _REASONING_FAMILIES)


#: The field that asks a reasoning model to put its answer in `content`.
REASONING_FIELD = "reasoning_effort"

#: Base URLs observed to REJECT that field rather than ignore it. Learned at
#: runtime from a 400 and remembered for the life of the process, so an endpoint
#: that refuses the hint pays for it once instead of on every call.
_REASONING_HINT_REFUSED: set[str] = set()

#: A raised effort an endpoint refused, remembered with the effort it refused.
#: Kept apart from `_REASONING_HINT_REFUSED` on purpose: an endpoint that only
#: takes "none" refusing the desk's "medium" must not switch off the "none"
#: hint every `/v1/decide` call depends on.
_REASONING_EFFORT_REFUSED: set[tuple[str, str]] = set()

#: (base URL, model) pairs that refused "none" but named a lower effort they DO
#: take, mapped to that effort. Per model, not per endpoint: on Groq, qwen3
#: takes "none" and gpt-oss does not, behind the same base URL.
_REASONING_NONE_STEP_DOWN: dict[tuple[str, str], str] = {}

#: The efforts a "none" request may step down to, cheapest first. Nothing above
#: "low": the point of "none" is an answer that does not spend the output cap on
#: thinking, and "medium" is the very default that does.
_STEP_DOWN_EFFORTS = ("minimal", "low")


def _rejects_reasoning_field(body: str) -> bool:
    """
    Is this 400 about the reasoning hint, or about our prompt?

    Narrow on purpose. A 400 that does not name the field is a real error and
    must stay one — silently retrying every bad request without the hint would
    hide malformed payloads behind a second call that fails the same way.
    """
    return REASONING_FIELD in (body or "")[:4000]


def _lowest_offered_effort(body: str) -> str | None:
    """
    The cheapest effort a refusal of "none" says the model WILL take.

    Groq refuses "none" for gpt-oss with "`reasoning_effort` must be one of
    `low`, `medium`, or `high`". Dropping the field there — what this module
    did — does not mean "no reasoning"; it means the model's DEFAULT, medium,
    which on a technical lens's material spends the whole 1,400-token cap
    thinking. JSON mode then cannot validate a truncated answer and Groq returns
    400 `json_validate_failed`: the lens reads "provider-failed", every time the
    material is long enough. Only quoted words are read, so "allowed" or "below"
    in prose never counts as "low".
    """
    offered = {w.lower() for w in re.findall(r"[`'\"](\w+)[`'\"]", (body or "")[:4000])}
    return next((e for e in _STEP_DOWN_EFFORTS if e in offered), None)


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
        reasoning_effort: str | None = None,
        max_tokens: int | None = None,
    ) -> str:
        """
        One model call, counted before it is made and recorded after.

        `json_schema`, when given, asks the provider for structured output. The
        RESULT IS RETURNED AS TEXT and parsed by the caller — but the schema is
        still sent, because a provider that can constrain the shape produces far
        fewer unparseable answers than a prompt that merely asks nicely.

        `reasoning_effort` and `max_tokens` are for a node that WANTS the model to
        think (the market desk). Both default to None, which is today's payload
        exactly: "none" for a reasoning model and the configured output cap. A
        caller raising the effort must raise the cap with it, because reasoning
        tokens are completion tokens and a thinking model under the default cap
        spends it all before writing the answer.
        """
        budget.check_before(node)
        model = self.cfg.deep_model if deep else self.cfg.quick_model
        if not self.cfg.api_key:
            raise ProviderError(
                "no model key configured — set BRAIN_LLM_API_KEY. Refusing to run "
                "rather than silently producing an unbacked decision.",
                kind="config",
            )

        payload: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": self.cfg.max_output_tokens if max_tokens is None else max_tokens,
        }
        if self.cfg.temperature is not None:
            payload["temperature"] = self.cfg.temperature
        if json_schema is not None:
            payload["response_format"] = {"type": "json_object"}

        # ASK A REASONING MODEL TO PUT ITS ANSWER IN `content`.
        #
        # The configured models ARE reasoning models — gpt-oss-120b and -20b —
        # and this payload had no opinion about that. So the model spent its
        # completion budget thinking, `content` came back empty or as prose, and
        # every analyst's verdict parsed as nothing. Five lenses reported "I
        # have nothing" while the technical one held 400 oracle rounds.
        #
        # Best effort by construction: a provider that does not know the field
        # ignores it. It is not the correctness fix — that is `parse_view`
        # naming the failure instead of calling it `no-data` — it is the fix
        # that stops the failure happening.
        #
        # Still only for a reasoning model, whatever effort a caller asks for: a
        # model that does not reason has no use for the field, and some
        # endpoints reject it outright.
        effort = "none" if reasoning_effort is None else reasoning_effort
        if effort == "none":
            # A model that has already said it takes no "none" is asked for
            # the lowest effort it named, not for its default (see
            # `_lowest_offered_effort`).
            effort = _REASONING_NONE_STEP_DOWN.get((self.cfg.base_url, model), effort)
        hint_allowed = (
            self.cfg.base_url not in _REASONING_HINT_REFUSED
            if effort == "none"
            else (self.cfg.base_url, effort) not in _REASONING_EFFORT_REFUSED
        )
        if _is_reasoning_model(model) and hint_allowed:
            payload[REASONING_FIELD] = effort

        client = await self._http()
        last: ProviderError | None = None
        attempt = 0
        while attempt < max_attempts:
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
            except httpx.HTTPError as e:
                kind = "timeout" if isinstance(e, httpx.TimeoutException) else "network"
                detail = " ".join(str(e).replace(self.cfg.api_key, "[key]").split())[:_MESSAGE_MAX]
                last = ProviderError(f"{kind} {type(e).__name__}" + (f": {detail}" if detail else ""), kind=kind)
                attempt += 1
                self._log_failure(node, model, attempt, max_attempts, last, None)
                if attempt < max_attempts:
                    await asyncio.sleep(1.0)
                continue

            # THE HINT MUST NOT BE ABLE TO BREAK THE CALL IT IMPROVES.
            #
            # `reasoning_effort` is best effort: some providers ignore an
            # unknown field, and some reject the request outright. If this
            # one rejects it, sending it would turn a working lens into
            # `provider-failed` on every single call — the fix causing a
            # worse version of the fault it was written for. So: step down to
            # the cheapest effort the refusal names, or drop the field when it
            # names none, remember which, and try again. The retry is free of
            # the attempt budget because the first request never reached the
            # model.
            if (
                r.status_code == 400
                and REASONING_FIELD in payload
                and _rejects_reasoning_field(r.text)
            ):
                refused = payload.pop(REASONING_FIELD)
                lower = _lowest_offered_effort(r.text) if refused == "none" else None
                if lower and (self.cfg.base_url, lower) not in _REASONING_EFFORT_REFUSED:
                    _REASONING_NONE_STEP_DOWN[(self.cfg.base_url, model)] = lower
                    payload[REASONING_FIELD] = lower
                elif refused == "none":
                    _REASONING_HINT_REFUSED.add(self.cfg.base_url)
                else:
                    _REASONING_EFFORT_REFUSED.add((self.cfg.base_url, refused))
                continue

            if r.status_code >= 400:
                last = _provider_error(r, self.cfg.api_key)
                attempt += 1
                self._log_failure(node, model, attempt, max_attempts, last, r)
                if attempt < max_attempts:
                    # Bounded, only between attempts, and only if the budget
                    # still allows the next one (checked at the loop's top).
                    await asyncio.sleep(1.5 * attempt if r.status_code == 429 else 1.0)
                continue

            try:
                body = r.json()
            except ValueError:
                last = ProviderError(f"{r.status_code} unparseable body", kind="bad-response", status=r.status_code)
                attempt += 1
                self._log_failure(node, model, attempt, max_attempts, last, r)
                continue

            usage = body.get("usage") or {}
            tout = int(usage.get("completion_tokens", 0))
            budget.record(
                node=node,
                provider=self.cfg.provider,
                model=model,
                tin=int(usage.get("prompt_tokens", 0)),
                tout=tout,
            )
            choices = body.get("choices") or []
            if not choices:
                raise ProviderError("provider returned no choices", kind="empty", status=r.status_code)
            if choices[0].get("finish_reason") == "length":
                # The answer was cut at the output cap. Without JSON mode this
                # arrives as a 200 with a truncated answer, so it is named here:
                # it is the same fault as `invalid-json`, seen from the other side.
                log.warning(
                    "llm %s %s: output cap reached (completion_tokens=%d max_tokens=%d effort=%s)",
                    node,
                    model,
                    tout,
                    payload["max_tokens"],
                    payload.get(REASONING_FIELD, "-"),
                )
            return str(choices[0].get("message", {}).get("content") or "")

        raise ProviderError(
            f"{node} failed after {max_attempts} attempts: {last}",
            kind=last.kind if last else "other",
            status=last.status if last else None,
            code=last.code if last else None,
        )

    @staticmethod
    def _log_failure(
        node: str,
        model: str,
        attempt: int,
        max_attempts: int,
        err: ProviderError,
        r: httpx.Response | None,
    ) -> None:
        """
        ONE BOUNDED LINE PER FAILED ATTEMPT, and nothing a reader should not see.

        The kind, the status, the provider's error code and its message (already
        bounded and key-scrubbed by `_provider_error`), and for a 429 the
        provider's own back-off and remaining-allowance headers: what it takes
        to tell a rate limit from a payload fault. Never the prompt, the
        material, the model's output or a credential.
        """
        rate = ""
        if r is not None and r.status_code == 429:
            h = r.headers
            rate = (
                f" retry_after={h.get('retry-after', '-')[:16]}"
                f" remaining_requests={h.get('x-ratelimit-remaining-requests', '-')[:16]}"
                f" remaining_tokens={h.get('x-ratelimit-remaining-tokens', '-')[:16]}"
            )
        log.warning(
            "llm %s %s: attempt %d/%d failed kind=%s status=%s code=%s%s (%s)",
            node,
            model,
            attempt,
            max_attempts,
            err.kind,
            err.status if err.status is not None else "-",
            err.code or "-",
            rate,
            str(err)[:_MESSAGE_MAX + 40],
        )


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
