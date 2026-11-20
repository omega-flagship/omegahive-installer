# Purpose: the LLM gateway: the OpenAI-compatible endpoint in front of every model, which picks the provider, injects
# its key, meters tokens and cost, and classifies each provider refusal.
"""LLM gateway: an OpenAI-compatible endpoint in front of every model.

Agents call ``/llm/v1/chat/completions`` and ``/llm/v1/embeddings`` with their
own hive token.  The gateway picks the upstream from the agent's ``model``
(``<provider>/<model>``), injects the provider key, meters tokens and cost,
and refuses calls once the agent's budget is spent.  Keys never reach agents.

``mock/echo`` is a built-in offline model that speaks the Omega skill-line
format, so a hive can be demoed and tested without any provider.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import datetime
import email.utils
import hashlib
import json
import logging
import math
import random
import re
import time
import os
import ipaddress
from urllib.parse import urlsplit

import httpx

from .config import SUBSCRIPTION_CLI, SUBSCRIPTION_CODEX, Provider, is_free, is_subscription
from .providers import openrouter_routing
from .redact import provider_category
from .refusals import LONGEST_WAIT_S, provider_code, refused, when

# The commitment point (ask-takeover r3, kept in r5): a caller may set SEND_GATE to an async callable for the duration of
# one chat call. It is awaited at httpcore's send_request_headers.started trace: after any wait for a pooled connection
# and after connecting, and may raise to abort the call with nothing sent. Passing it commits the call. It is not the
# first byte: the conductor's gate yields once after committing, before the bytes are handed to the OS, so a close
# committed in that one step sees this one already-authorised request leave. A call that never reaches a transport (the
# mock provider) never awaits it.
SEND_GATE: contextvars.ContextVar = contextvars.ContextVar("hive_send_gate", default=None)


async def signal_send():
    """Await the current send gate, if any (the transport's trace calls this; a test's fake provider may too)."""
    gate = SEND_GATE.get()
    if gate is not None:
        await gate()


async def _send_trace(name, info):
    if name.endswith("send_request_headers.started"):
        await signal_send()

EMBED_DIM = 384



FREE_MODEL_RESERVE_USD = 0.000001   # one micro-dollar: cost_reservations refuses a $0 reservation


def reported_cost(usage):
    """The provider's own charge for a call, in USD (OpenRouter's usage.cost), or None when absent or not a finite,
    nonnegative number. Providers that report another unit must not be configured with one."""
    value = usage.get("cost") if isinstance(usage, dict) else None
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
        return float(value)
    return None


def billable(response, usage):
    """Whether an answered call can be settled: valid token counters, or a charge the provider reported (sol R2 P1:
    a reported charge is settled even without counters, as media.py does; absent both, the hold stays unknown)."""
    counters = response.get("usage") if isinstance(response, dict) else None
    if isinstance(counters, dict) and all(type(counters.get(k)) is int and counters[k] >= 0
                                          for k in ("prompt_tokens", "completion_tokens")):
        return True
    return usage.get("reported_cost_usd") is not None

def _plan_counters(usage):
    """A subscription answer's token counters: (prompt, completion) as non-negative ints, else None."""
    if not isinstance(usage, dict):
        return None
    pt, ct = usage.get("prompt_tokens"), usage.get("completion_tokens")
    return (pt, ct) if type(pt) is int and type(ct) is int and pt >= 0 and ct >= 0 else None


class GatewayError(Exception):
    # set only on a refusal built from refusals.py's table (refusals.refused): what the person can do, and the seconds
    # until trying again can help; refusals.spoken tells such a refusal apart
    remedy = None
    retry_after = None

    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def upstream_refusal(provider_name, response, model=None):
    """A provider's refusal, as this hive passes it on (sol and Kimi on bef0f01b): the row of refusals.py's table for its
    status category, in the hive's own sentence for a person, never the provider's words, which can carry ids, account
    names or echoed titles no pattern can be sure to catch. The provider's body is not logged either (sol on 593fde34:
    scrub only runs on a local-owner hive, and a provider can echo a key): the log keeps its status, category and
    length. The status is kept for callers too, so they still see its class (429 rate limited, 401 refused the key, ...),
    and retry_after is the wait the answer asked for, if it asked. `model` is the model as the provider names it.
    Example: OpenRouter's 402 with no Retry-After is provider_no_credit, remedy credit."""
    status = int(response.status_code)
    category = provider_category(status)   # redact: one category table for every provider refusal
    logging.getLogger("hive").warning("provider %s answered %s (%s, %d bytes)", provider_name, status, category,
                                      len(response.content or b""))
    label = LABELS_UPSTREAM.get(provider_name, provider_name)
    wait = asked_wait(response.headers, provider_name)
    err = refused(provider_code(category, wait, is_free(provider_name)), status, retry_after=wait, provider=label,
                  model=model or "this model", when=when(wait))
    err.refusal_usage = refusal_usage(response)   # a structured top-level usage object, if any (charge_from_refusal)
    err.charge_usd = charge_from_refusal(err.refusal_usage)   # a charge the body itself reports, else None
    err.unbilled = (status in UNBILLED_REFUSALS.get(provider_name, frozenset())
                    and err.refusal_usage is None and canonical_refusal_body(response.content, status, provider_name))
    return err


# A free call its endpoint answers 429 is retried. That endpoint's key takes so many calls a second, shared by every hive
# the deploy's key is in: Singularity Compute's took about 5 at once and 3 a second on 17 Nov, refusing the rest with 429
# and no Retry-After after about 1 s. The wait honours the answer's Retry-After (retry-after-ms first), as
# openai-python's client does, and is otherwise exponential backoff with full jitter, which AWS's "Exponential Backoff
# And Jitter" (2015) found finishes contended work soonest. Its 1 s base is that endpoint's window. Four retries wait
# 7.5 s on average and 15 s at most, and in a simulation of that limit they served a burst of 20 calls within about 5 s.
FREE_RETRIES = 4
FREE_RETRY_BASE, FREE_RETRY_CAP = 1.0, 8.0


def asked_wait(headers, provider_name=None):
    """The seconds an answer asks a caller to wait before calling again, or None when it asks for none: retry-after-ms
    first, then retry-after as seconds or an HTTP date (RFC 9110 10.2.3), as openai-python's client reads them; a zero,
    past or unreadable value counts as none given. OpenRouter also names when a free model's limit resets, in
    X-RateLimit-Reset as milliseconds since the epoch (its API reference, "Limits"), read only from OpenRouter. A wait
    longer than refusals.LONGEST_WAIT_S is read as that, so no answer holds a mind for longer (a Retry-After of years).
    Example: 'retry-after: 3' gives 3.0; 'retry-after-ms: 1500' gives 1.5; 'retry-after: 99999999' gives 1800.0;
    neither gives None."""
    sources = [("retry-after-ms", 0.001), ("retry-after", 1.0)] + ([("x-ratelimit-reset", None)] if provider_name == "openrouter" else [])
    for name, scale in sources:
        raw = headers.get(name)
        if raw is None:
            continue
        try:
            seconds = float(raw) * scale if scale is not None else float(raw) / 1000 - time.time()
        except ValueError:
            if scale is None:
                continue
            try:
                moment = email.utils.parsedate_to_datetime(raw)
                seconds = (moment - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
            except (TypeError, ValueError, IndexError, OverflowError):
                continue
        if not math.isfinite(seconds) or seconds <= 0:
            continue
        return min(seconds, float(LONGEST_WAIT_S))
    return None


def free_retry_delay(attempt, headers, rng=random.random):
    """Seconds to wait before retry `attempt` (0 for the first) of a free call answered 429, or None when the answer asks
    for a longer wait than FREE_RETRY_CAP, which this call doesn't make. The wait the answer asks for (asked_wait), else
    full jitter: uniform over [0, min(FREE_RETRY_CAP, FREE_RETRY_BASE * 2 ** attempt)). Example: attempt 2 with no
    header waits 0 to 4 s; 'retry-after: 3' waits 3 s; 'retry-after: 30' gives None."""
    seconds = asked_wait(headers)
    if seconds is not None:
        return seconds if seconds <= FREE_RETRY_CAP else None
    return rng() * min(FREE_RETRY_CAP, FREE_RETRY_BASE * 2 ** attempt)


# Error answers a provider documents as never charged, by provider and status. The hive never streams, so an error
# status is the whole answer: the call failed. A body that reports usage or cost settles at it instead (refusal_charge),
# and a body that is not the provider's own error shape (canonical_refusal_body) keeps its hold unknown. A timeout or a
# dropped connection is not an answer and stays held: Anthropic still charges a request that was on track to succeed
# when the client disconnects or times out. Every other provider keeps every hold unknown.
# - anthropic: "You're billed only for successful API calls and completed tasks. Failed requests aren't charged."
#   (support.anthropic.com/en/articles/8977456-how-do-i-pay-for-my-api-usage)
# - openrouter: only its own refusals before any model runs (openrouter.ai/docs/api-reference/errors): 401 "Invalid
#   credentials", 402 "insufficient credits" and 403 "Forbidden (insufficient permissions, guardrail block, or
#   moderation flag)", as before, and 400 "Bad Request (invalid or missing params, CORS)" and 503 "There is no available
#   model provider that meets your routing requirements" while the body names no provider (ROUTER_ONLY). A 408 timeout,
#   429 rate limit, 502 "model is down or we received an invalid response from it" or any other status can follow a
#   call a provider already started, which can still be billed upstream, so it stays held. Web search, file parsing and
#   web fetch that ran first may still be billed, so a call that asked for one keeps its hold (paid_extras).
ERROR_STATUSES = frozenset(range(400, 600))
UNBILLED_REFUSALS = {"anthropic": ERROR_STATUSES, "openrouter": frozenset({400, 401, 402, 403, 503})}
# OpenRouter statuses its router and an upstream provider both answer with. OpenRouter tags a provider's error with
# error_type and surfaces the provider's own code, name and payload as provider_code, provider_name and raw, so a 400 or
# 503 carrying any of them (a provider_name other than OpenRouter's own) came from a provider and stays held.
ROUTER_ONLY = frozenset({400, 503})
_PROVIDER_FIELDS = ("error_type", "provider_code", "raw")

_CANONICAL_BODY_MAX = 4096
_CANONICAL_CODES = frozenset({401, 402, 403})   # OpenRouter's front-door refusals, which may name one another's code
_CHARGE_WORDS = ("usage", "cost")
# Each provider's own error body, exactly: the top-level keys it may have, its error object's keys, the ones that must be
# there, and what its code may be. OpenRouter: {"error": {"code", "message", "metadata"?}}, where "The HTTP Response will
# have the same status code as error.code" (openrouter.ai/docs/api-reference/errors).
# Anthropic's OpenAI-compatible endpoint, the one the hive calls, keeps OpenAI's error format (docs.anthropic.com/en/
# api/openai-sdk): {"error": {"message", "type"?, "param"?, "code"?}}, with Anthropic's own "type" and "request_id" allowed
# beside it.
_ERROR_SHAPES = {
    "openrouter": ({"error"}, {"code", "message", "metadata"}, {"code", "message"}),
    "anthropic": ({"error", "type", "request_id"}, {"message", "type", "param", "code"}, {"message"}),
}


def paid_extras(body):
    """Whether an OpenRouter request asked for a service OpenRouter may bill even when the model's answer is an error: web
    search (the web plugin, web_search_options or an :online model), file parsing (a file part in a message) or any
    other plugin."""
    if body.get("plugins") or "web_search_options" in body or str(body.get("model") or "").endswith(":online"):
        return True
    for message in body.get("messages") or ():
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, list) and any(isinstance(part, dict) and part.get("type") == "file" for part in content):
            return True
    return False


def canonical_refusal_body(content, status, provider="openrouter"):
    """A strict allowlist, not a search for charge evidence: True only for a body of at most 4 KB, strict UTF-8 with no
    BOM, parsing as JSON in exactly the provider's own error shape (_ERROR_SHAPES) with string or integer values and no
    other keys, and no "usage" or "cost" (any case) anywhere in the decoded text or its decoded strings. OpenRouter's code
    is an int equal to the status (a 401, 402 or 403 may carry any of those three); Anthropic's is a string, an int or
    null. Anything else (other encodings, empty, non-JSON, extra or nested keys, a code that is not the status, an
    OpenRouter 400 or 503 whose metadata names a provider, another provider) is False and the hold stays unknown."""
    if not isinstance(content, (bytes, bytearray)) or not content or len(content) > _CANONICAL_BODY_MAX:
        return False
    if content.startswith(b"\xef\xbb\xbf"):
        return False
    try:
        text = bytes(content).decode("utf-8", errors="strict")
        data = json.loads(text)
    except (UnicodeDecodeError, ValueError):
        return False
    if provider not in _ERROR_SHAPES:
        return False
    top, allowed, required = _ERROR_SHAPES[provider]
    if not isinstance(data, dict) or "error" not in data or not set(data) <= top or not isinstance(data["error"], dict):
        return False
    if any(not isinstance(data[k], str) for k in set(data) - {"error"}):
        return False
    error = data["error"]
    if not required <= set(error) <= allowed:
        return False
    code, message = error.get("code"), error["message"]
    if provider == "openrouter":
        if type(code) is not int or not (code == status or (status in _CANONICAL_CODES and code in _CANONICAL_CODES)):
            return False
        named = error.get("metadata") if isinstance(error.get("metadata"), dict) else {}
        if status in ROUTER_ONLY and (any(k in named for k in _PROVIDER_FIELDS)
                                      or named.get("provider_name", "OpenRouter") != "OpenRouter"):
            return False   # a provider answered: it may have started the call
    elif not (code is None or isinstance(code, str) or type(code) is int):
        return False
    if not isinstance(message, str) or any(not (error[k] is None or isinstance(error[k], str))
                                           for k in ("type", "param") if k in error):
        return False
    strings = [text, message] + [data[k] for k in set(data) - {"error"}] + \
        [error[k] for k in ("type", "param", "code") if isinstance(error.get(k), str)]
    if "metadata" in error:
        metadata = error["metadata"]
        if not isinstance(metadata, dict):
            return False
        for key, value in metadata.items():
            if not (isinstance(value, str) or type(value) is int):
                return False
            strings.append(key)
            if isinstance(value, str):
                strings.append(value)
    if any("\\" in t for t in strings[1:]):
        return False   # an escape left inside a decoded string (escaped JSON within JSON): not canonical
    return not any(w in t.lower() for t in strings for w in _CHARGE_WORDS)


def refusal_usage(response):
    """A refusal body's structured top-level "usage" object, or None; for pricing a charge it reports (settled, never
    released). Byte-aware (json.loads detects UTF-8/16/32), so a charge in another encoding is still found. The body is
    read, never logged or passed on."""
    content = response.content or b""
    if len(content) > 1_000_000:
        return None
    try:
        data = json.loads(content)
    except (ValueError, UnicodeDecodeError):
        return None
    usage = data.get("usage") if isinstance(data, dict) else None
    return usage if isinstance(usage, dict) else None


def charge_from_refusal(usage, cost=None):
    """The charge a refusal's usage proves, in USD, or None (unparseable: held unknown). cost(pt, ct), if given, prices
    valid token counters at the configured rate; the larger of that and a reported cost is taken, as for an answer."""
    if not isinstance(usage, dict):
        return None
    reported = reported_cost(usage)
    pt, ct = usage.get("prompt_tokens"), usage.get("completion_tokens")
    counted = type(pt) is int and type(ct) is int and pt >= 0 and ct >= 0
    rated = cost(pt, ct) if (counted and cost is not None) else None
    if reported is None and rated is None:
        return None
    return max(v for v in (reported, rated) if v is not None)


def unbilled(exc):
    """Whether a failed call's exception is a guaranteed non-billed refusal (UNBILLED_REFUSALS, no charge evidence)."""
    return isinstance(exc, GatewayError) and getattr(exc, "unbilled", False) is True


def held_cause(exc, model=None):
    """Why a sent call's cost is unknown, in this hive's own words, never the provider's: the line a person reads beside
    the held call (Reservations.unknown). exc is the call's failure, or None when it answered without a cost the hive
    could record. A refusal's sentence is upstream_refusal's own, refusals.py's row for its status ("OpenAI is taking no
    more calls to this model for now, so this mind tries again shortly. Choose another model to go on sooner.")."""
    name = str(model or "").partition("/")[0]
    label = LABELS_UPSTREAM.get(name, name or "the provider")
    if isinstance(exc, GatewayError):
        return exc.message
    if isinstance(exc, (httpx.TimeoutException, asyncio.TimeoutError)):
        return f"No answer from {label} before the hive stopped waiting. A provider can still charge a call it finished."
    if isinstance(exc, httpx.TransportError):
        return f"The connection to {label} broke before its answer arrived."
    if isinstance(exc, asyncio.CancelledError):
        return "The call was stopped after it was sent."
    if exc is None:
        return f"{label[:1].upper()}{label[1:]} answered without saying what the call cost."
    return "The hive could not read the call's answer."


RESTART_CAUSE = "The hive restarted while this call was in flight, so its answer was lost."


def refusal_charge(exc):
    """The charge a refusal's own body proves, in USD, or None."""
    charge = getattr(exc, "charge_usd", None) if isinstance(exc, GatewayError) else None
    return charge if isinstance(charge, float) and math.isfinite(charge) and charge >= 0 else None


LABELS_UPSTREAM = {"free": "Free inference", "openrouter": "OpenRouter", "anthropic": "Anthropic", "openai": "OpenAI", "local": "The local model server",
                   SUBSCRIPTION_CLI: "The subscription bridge", SUBSCRIPTION_CODEX: "The ChatGPT subscription bridge"}


def split_model(model):
    provider, _, name = str(model).partition("/")
    if not name:
        raise GatewayError(400, "bad_model", f"model must be <provider>/<model>, got {model!r}")
    return provider, name


def billable_tokens(body):
    """A call's prompt as a true worst case: every billable input (all of the body but the model and stream fields), in
    UTF-8 bytes plus one, since a token always covers at least one byte (OmegaReview 2026-10-04)."""
    billable = {k: v for k, v in body.items() if k not in ("model", "stream")}
    return len(json.dumps(billable, ensure_ascii=False).encode("utf-8")) + 1


def _completion(model, text, prompt_tokens, completion_tokens):
    return {
        "id": f"hive-{int(time.time() * 1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
                  "total_tokens": prompt_tokens + completion_tokens},
    }


def _prompt_text(body):
    parts = []
    for message in body.get("messages", []):
        content = message.get("content")
        if isinstance(content, list):
            content = " ".join(str(p.get("text", "")) for p in content if isinstance(p, dict))
        parts.append(str(content or ""))
    return "\n".join(parts)


def mock_reply(agent_name, prompt):
    """A tiny deterministic 'mind' for offline hives.

    It only answers when the prompt carries a new human message:
      believe <statement> [f c]  -> publish the belief to the swarm and confirm
      ask <pattern>              -> query the swarm commons
      share-ask <mind> <space> <minutes> [reason]  -> ask another mind to see one of its spaces
      exhibit <minds|swarm> <minutes> <title | text> -> show a piece of work for a while
      [SHARE-REQUEST ...]        -> grant it;  [SHARE-GRANTED/OFFERED, EXHIBIT ...] -> read it
      anything else              -> a friendly echo
    """
    if "HUMAN-MSG:" not in prompt:
        return "wait idle"
    tail = prompt.rsplit("HUMAN-MSG:", 1)[1]
    # The CHANNEL_EVENT block may arrive flattened onto one line, so stop at the
    # next key=value field.
    if "_newline_" in tail:  # encoded block: fields are separated by _newline_
        found = [field[5:] for field in tail.split("_newline_") if field.startswith("text=")]
    else:
        found = re.findall(r"text=(.*?)(?=\s+[a-z_]+=|\n|$)", tail)
    # The Omega prompt encodes some characters as _name_ tokens.
    text = (found[-1] if found else tail).replace("_quote_", '"').replace("_newline_", " ")
    text = text.replace('\\"', '"').strip()
    if text.count(")") > text.count("("):  # the closing paren of the HUMAN-MSG wrapper
        text = text[: text.rfind(")")].rstrip()
    lowered = text.lower()
    approved = re.match(r"^\[APPROVED (p_\w+)\] (\(.*\))$", text)
    if approved:
        return f"{approved.group(2)}\nsend Approved - running {approved.group(1)}"
    if text.startswith("[DENIED "):
        return "send Understood, I will not do that"
    if text.startswith("[WAKE "):
        reason = text.split("] ", 1)[-1]
        return f"send Awake: {reason}"
    # Several goal announcements can arrive in one batch: take up to two.
    announced = re.findall(r"New goal (g_\w+) \(priority [0-9.]+\): (.*?)(?=_newline_|\n|$)", tail)
    simple = [(g, t) for g, t in announced if not t.startswith("Project:")]
    if len(simple) > 1:
        lines = []
        for goal_id, title in simple[:2]:
            lines += [f"hive-goal-claim {goal_id}", f"hive-goal-done {goal_id} did: {title.split(' - ', 1)[0]}"]
        return "\n".join(lines)
    goal = re.match(r"^New goal (g_\w+) \(priority [0-9.]+\): (.*)$", text)
    if goal:
        goal_id, title = goal.group(1), goal.group(2).split(" - ", 1)[0]
        if title.startswith("Project:") and ";" in title:
            parts = [p.strip() for p in title[len("Project:"):].split(";") if p.strip()]
            lines = [f"hive-goal-claim {goal_id}"] + [f"hive-goal-create {goal_id} {p}" for p in parts]
            return "\n".join(lines[:5])
        return f"hive-goal-claim {goal_id}\nhive-goal-done {goal_id} did: {title}"
    # Timed sharing: grant what is asked, read what is shown.
    asked = re.match(r"^\[SHARE-REQUEST (sh_\w+)\]", text)
    if asked:
        return f"hive-share-grant {asked.group(1)}\nsend Granted {asked.group(1)}"
    shown = re.match(r"^\[(?:SHARE-GRANTED|SHARE-OFFERED|EXHIBIT) (sh_\w+)\]", text)
    if shown:
        return f"hive-shared {shown.group(1)} *"
    if lowered.startswith("share-ask "):
        parts = text.split(None, 4)
        if len(parts) >= 4:
            reason = parts[4] if len(parts) > 4 else "to build on your work"
            return f"hive-share-request {parts[1]} {parts[2]} {parts[3]} {reason}\nsend Asked {parts[1]} for {parts[2]}"
    if lowered.startswith("exhibit "):
        parts = text.split(None, 3)
        if len(parts) == 4:
            return f"hive-exhibit {parts[1]} {parts[2]} {parts[3]}\nsend Shared it with {parts[1]}"
    merged = re.match(r"^\[SUBGOALS-DONE (g_\w+)\] (.*)$", text)
    if merged:
        return f"hive-goal-done {merged.group(1)} merged: {merged.group(2)}"
    if lowered.startswith("run "):
        return text[4:].strip()
    if lowered.startswith("believe "):
        body = text[8:].strip()
        match = re.match(r"^(\(.*\))\s*([0-9.]+)?\s*([0-9.]+)?$", body)
        if match:
            statement, f, c = match.group(1), match.group(2) or "0.9", match.group(3) or "0.8"
            return f"hive-publish {statement} {f} {c}\nsend I now believe {statement}"
    if lowered.startswith("ask "):
        return f"hive-query {text[4:].strip()}\nsend Looking that up in our commons"
    return f"send I hear you - \"{text[:300]}\""


def _tool_call(index, name, arguments):
    return {"id": f"call_{index}_{name}", "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments)}}


# The single transport tool every native-core mind offers (hive/runtime/hive_provider.py): its one "text" argument is
# a Hive skill response, parsed and authorized by the mind exactly like a plain-text reply.
HIVE_TRANSPORT_TOOL = "hive-run-response"


def mock_tool_reply(agent_name, body):
    """Mock for agents that use native tool calling (Iter): returns tool calls.

    Acts only on a fresh hive message; otherwise calls nop, the Iter way of
    saying there is nothing to do. A native-core mind offers the transport tool instead: it gets the same text the
    text-only mock writes (mock_reply), carried as that tool's argument, so a mock mind answers as it did before the
    tool was offered and never sees an empty tool-call list (a format failure).
    """
    tools = {t.get("function", {}).get("name") for t in body.get("tools", [])}
    if HIVE_TRANSPORT_TOOL in tools:
        text = mock_reply(agent_name, _prompt_text(body))
        return {
            "id": f"hive-{int(time.time() * 1000)}", "object": "chat.completion", "created": int(time.time()),
            "model": "mock/echo",
            "choices": [{"index": 0, "finish_reason": "tool_calls",
                         "message": {"role": "assistant", "content": None,
                                     "tool_calls": [_tool_call(0, HIVE_TRANSPORT_TOOL, {"text": text})]}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
    messages = body.get("messages") or []
    last = messages[-1] if messages else {}
    content = str(last.get("content") or "")
    calls = []
    if last.get("role") == "user" and "[hive] " in content:
        text = content.split("[hive] ", 1)[1].strip()
        text = text.split(": ", 1)[1] if re.match(r"^[\w:.-]+: ", text) else text
        goals = re.findall(r"New goal (g_\w+) \(priority [0-9.]+\): (.*)", content)
        belief = re.match(r"^believe (\(.*\))\s*([0-9.]+)?\s*([0-9.]+)?$", text, re.I)
        if goals and {"hive_goal_claim", "hive_goal_done"} <= tools:
            for goal_id, title in goals[:4]:
                title = title.split(" - ", 1)[0].strip()
                calls += [_tool_call(len(calls), "hive_goal_claim", {"goal_id": goal_id}),
                          _tool_call(len(calls) + 1, "hive_goal_done",
                                     {"goal_id": goal_id, "status": "done", "result": f"did: {title}"})]
        elif belief and "hive_publish" in tools:
            calls = [_tool_call(0, "hive_publish", {"statement": belief.group(1), "f": belief.group(2) or "0.9",
                                                    "c": belief.group(3) or "0.8"}),
                     _tool_call(1, "send", {"channel": "hive", "content": f"I now believe {belief.group(1)}"})]
        elif "send" in tools:
            calls = [_tool_call(0, "send", {"channel": "hive", "content": f"I hear you - \"{text[:300]}\""})]
    if not calls:
        calls = [_tool_call(0, "nop", {})] if "nop" in tools else []
    return {
        "id": f"hive-{int(time.time() * 1000)}", "object": "chat.completion", "created": int(time.time()),
        "model": "mock/echo",
        "choices": [{"index": 0, "finish_reason": "tool_calls",
                     "message": {"role": "assistant", "content": None, "tool_calls": calls}}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }


def mock_embedding(text):
    """Deterministic unit vector from hashed character trigrams."""
    vector = [0.0] * EMBED_DIM
    text = f"  {text.lower()}  "
    for i in range(len(text) - 2):
        digest = hashlib.blake2b(text[i:i + 3].encode(), digest_size=4).digest()
        vector[int.from_bytes(digest, "little") % EMBED_DIM] += 1.0
    norm = math.sqrt(sum(v * v for v in vector)) or 1.0
    return [v / norm for v in vector]


class Gateway:
    def __init__(self, providers: dict[str, Provider], timeout=600):
        self.providers = providers
        self.client = httpx.AsyncClient(timeout=timeout, trust_env=False)
        self.keyring = None  # hive/core/providers.ProviderStore, attached by the app
        self.own_key_for = None  # own hive H1 (ownhive.OwnHive.own_key_for): (agent, provider) -> the caller's own key id
        self.authorize_agent = None  # host's current person-swarm authority; never a credential or a second payer rule
        self.free_unreconciled = None  # Reservations.free_unknown: (model label) -> an earlier $0 call is held unknown
        # subscription_cli.SubscriptionGate, attached by the app: admits a call on any subscription instance (owner only,
        # that instance's daily cap). None: every subscription call is refused (fails closed).
        self.subscription_gate = None
        # free_inference.FreeGate, attached by the app: admits a call on the free route for the person it is for, under
        # their model calls for the day. None: every free call is refused (fails closed).
        self.free_gate = None

    def _agent_guard(self, agent):
        if self.authorize_agent is not None and agent is not None:
            self.authorize_agent(agent["id"])

    def _trace(self, agent, recheck=None, on_send=None, on_commit=None):
        async def trace(name, info):
            if name.endswith("send_request_headers.started"):
                if on_send is not None:
                    on_send()   # the connection is up and the request is about to be written: past this, it may arrive
                self._agent_guard(agent)
                await signal_send()   # keep the existing Studio/Ask commitment gate
                self._agent_guard(agent)   # a gate may have awaited while authority changed
                if recheck is not None:
                    recheck()   # a subscription instance: its authority and egress, now, after any awaited gate
                if on_commit is not None:
                    on_commit()   # every check here passed: the request is written next, so from now it may arrive
        return trace

    def enforce_egress(self, agent, provider_name):
        try:
            protected = json.loads(os.environ.get('HIVE_LOCAL_ONLY_SWARMS', '[]'))
        except ValueError:
            raise GatewayError(403, 'egress_refused', 'Invalid local-only swarm policy') from None
        if not isinstance(protected, list) or not all(isinstance(s, str) and s for s in protected):
            raise GatewayError(403, 'egress_refused', 'Invalid local-only swarm policy')
        if not protected:
            return
        if not isinstance(agent, dict) or not agent.get('swarm_id'):
            raise GatewayError(403, 'egress_refused', 'Trusted swarm identity required')
        if agent['swarm_id'] not in protected:
            return
        if provider_name == 'mock':
            return
        if is_subscription(provider_name):
            # explicit, whatever its flags say: a subscription route sends the prompt off this machine through the CLI
            raise GatewayError(403, 'egress_refused', 'Swarm permits only literal-loopback local model routes')
        provider = self.provider(provider_name)
        address = urlsplit(provider.base_url)
        try:
            loopback = ipaddress.ip_address(address.hostname or '').is_loopback
        except ValueError:
            loopback = False
        if (not provider.local or not loopback or address.scheme not in ('http', 'https')
                or address.username or address.password or address.query or address.fragment):
            raise GatewayError(403, 'egress_refused', 'Swarm permits only literal-loopback local model routes')

    def admit_subscription(self, agent, principal=None, dispatch=False, provider=SUBSCRIPTION_CLI):
        """A call on subscription instance `provider` is admitted only by the hive's SubscriptionGate (subscription_cli.py: the owner's own
        mind in the owner's scope, on a call for the owner, under the day's cap). principal: the trusted caller the call
        is for, when the caller knows it (the conductor's asker, the mind gateway's token principal); the gate always
        also checks Hive.user_for. dispatch=True records this attempt and returns its ticket (for
        subscription_transport_failed). Refuses with no gate."""
        if self.subscription_gate is None:
            raise GatewayError(403, "subscription_unavailable", "This model route is not available on this hive.")
        return self.subscription_gate.admit(agent, principal=principal, dispatch=dispatch, provider=provider)

    def subscription_transport_failed(self, provider, ticket, exc, sent):
        """A subscription dispatch's transport raised. Never connected (ConnectError/ConnectTimeout and the send boundary
        never reached): nothing can have reached the bridge, so the attempt is released and the bridge marked down
        (the gate's cooldown). Anything else may have reached it: the attempt stands and the bridge was up."""
        gate = self.subscription_gate
        if isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout)) and not sent:
            if ticket is not None and callable(getattr(gate, "release", None)):
                gate.release(provider, ticket)
            if callable(getattr(gate, "bridge_down", None)):
                gate.bridge_down(provider)
        elif callable(getattr(gate, "bridge_up", None)):
            gate.bridge_up(provider)

    def admit_free(self, agent, principal=None, dispatch=False, idle_guard=True):
        """A call on the free route is admitted only by the hive's FreeGate (free_inference.py: offered, a model the deploy
        pays for, for a person it admits, a mind someone asked lately, under their calls and the hive's for the day).
        dispatch=True counts this call and returns its ticket (for free_uncommitted). principal: as admit_subscription.
        idle_guard=False asks whether the route would serve the mind at all, resting aside (FreeGate.admit). Refuses
        with no gate."""
        if self.free_gate is None:
            raise refused("free_inference_off", 403)
        return self.free_gate.admit(agent, principal=principal, dispatch=dispatch, idle_guard=idle_guard)

    def free_uncommitted(self, ticket, committed):
        """A counted free call ended, any way (no connection, a refusal or a closed turn at the send boundary, a
        cancellation), before it committed at the send boundary (_trace's on_commit, after every check there): its request
        was never written, so nothing reached the endpoint and its count is given back. Past that point it counts,
        whatever happens to the answer."""
        if not committed and self.free_gate is not None:
            self.free_gate.release(ticket)

    def _subscription_recheck(self, agent, principal, provider=SUBSCRIPTION_CLI):
        """At the send boundary: egress and the gate's authority again (no second count of the attempt)."""
        def recheck():
            self.enforce_egress(agent, provider)
            if self.subscription_gate is None:
                raise GatewayError(403, "subscription_unavailable", "This model route is not available on this hive.")
            self.subscription_gate.authorize(agent, principal, provider=provider)
        return recheck

    def _free_recheck(self, agent, principal):
        """At the send boundary: egress and the free route's authority again (FreeGate.authorize: offered, the deploy's
        model, a person it admits), never the day's counts, which this call already holds."""
        def recheck():
            self.enforce_egress(agent, "free")
            if self.free_gate is None:
                raise refused("free_inference_off", 403)
            self.free_gate.authorize(agent, principal)
        return recheck

    @staticmethod
    def _options(agent):
        options = agent.get("options")
        if isinstance(options, str):
            try:
                options = json.loads(options)
            except ValueError:
                options = None
        return options if isinstance(options, dict) else {}

    def payment_options(self, agent):
        """The options that decide who pays for a mind's call, and nothing else: its assigned key and that key's lock.
        Every route that pays for a personal mind resolves its key from these (the mind gateway, Budgets.settlement), so
        the page and the call cannot disagree, and a lock holds on every route (First Light, sol on 0f88cf5d)."""
        options = self._options(agent)
        return {k: options[k] for k in ("key", "key_locked") if k in options}

    def paying_key(self, agent, provider_name):
        """(key id, secret) that pays for this mind's call; the id is recorded with the usage."""
        options = self._options(agent)
        assigned = options.get("key")
        locked = bool(options.get("key_locked"))   # app platform P3a: refuse, never fall back to another payer
        if locked and (self.keyring is None or not assigned):
            raise GatewayError(402, "own_key_needed",
                               f"{agent.get('name', 'this mind')} runs only on its owner's own key, and none is assigned")
        if self.keyring is None:
            return None, self.provider(provider_name).api_key
        if assigned:
            secret = self.keyring.secret_for(provider_name, assigned)
            if not secret:
                fix = ("its owner can switch it to another of their own keys, or unlock it" if locked
                       else "assign another key or the hive default")
                # never the key's id (sol on 16842acb): this answer reaches whoever calls for the mind (an outside
                # harness's token included), who may not be allowed to see which key it is assigned
                raise GatewayError(402, "key_unavailable",
                                   f"{agent.get('name', 'this mind')}'s assigned key is gone or is not a "
                                   f"{provider_name} key; {fix}")
            if locked:
                holder = ((self.keyring.ring.get("keys") or {}).get(assigned) or {}).get("owner")
                if not agent.get("owner") or holder != agent.get("owner"):
                    raise GatewayError(402, "own_key_needed",
                                       f"{agent.get('name', 'this mind')} runs only on its owner's own key")
            return assigned, secret
        own = self.own_key_for(agent, provider_name) if self.own_key_for else None
        if own:   # own hive H1: a guest or public visitor with no grant on the hive's key pays with their own
            secret = self.keyring.secret_for(provider_name, own)
            if secret:
                return own, secret
        default = self.keyring.ring["defaults"].get(provider_name)
        return (default or f"env:{provider_name}"), self.provider(provider_name).api_key

    # The #89 review asked for a short timeout on the OpenRouter lookups. A record read is one small JSON answer, and a
    # reconcile pass runs every 5 s, so a read that has not answered in 5 s is left to the next pass.
    GENERATION_LOOKUP_TIMEOUT_S = 5.0

    async def generation_cost(self, key_id, generation_id):
        """What OpenRouter's own record of one generation says it cost, in USD (GET /generation?id=, data.total_cost), read
        with the key that paid for the call; None while the record is not there yet (404), on any other answer, when the
        record's data.id is not the generation asked for, when no answer comes within GENERATION_LOOKUP_TIMEOUT_S, or
        when that key is gone. OpenRouter keeps this record for every request it answered ("you can also use the returned
        id to query for the generation stats (including token counts and cost) after the request is complete",
        openrouter.ai/docs/api_reference/overview), so an answer whose usage the hive could not read is priced from it."""
        provider = self.provider("openrouter")
        secret = self.keyring.secret_for("openrouter", key_id) if self.keyring is not None else ("" if key_id else provider.api_key)
        if not secret or not provider.base_url or not isinstance(generation_id, str) or not generation_id:
            return None
        try:
            response = await self.client.get(f"{provider.base_url.rstrip('/')}/generation", params={"id": generation_id},
                                             headers={"Authorization": f"Bearer {secret}"}, timeout=self.GENERATION_LOOKUP_TIMEOUT_S)
            data = response.json().get("data") if response.status_code == 200 else None
        except (httpx.HTTPError, ValueError, AttributeError):
            return None
        if not isinstance(data, dict) or data.get("id") != generation_id:
            return None   # no record, or a record of another generation: never settle a call at someone else's cost
        cost = data.get("total_cost")
        return float(cost) if type(cost) in (int, float) and math.isfinite(cost) and cost >= 0 else None

    def sender(self, agent, provider_name, provider):
        """(key id, secret) a mind's call to this provider goes out with: its paying key, except where no key of the ring
        is used. A subscription never has a paying key (R3.2 §M): the CLI holds its own sign-in, and this is the
        bridge's own key. Nor does the free route: the deploy's key pays, never a key in the ring or one assigned to the
        mind. A local model's key is its own. Raises as paying_key does when no key can pay."""
        if provider.local or is_subscription(provider_name) or is_free(provider_name):
            return None, provider.api_key
        return self.paying_key(agent, provider_name)

    def provider(self, name) -> Provider:
        provider = self.providers.get(name)
        if provider is None:
            if is_free(name):   # a mind left on free inference after the deploy took the key away
                raise refused("free_inference_off", 403)
            raise GatewayError(400, "unknown_provider", f"no provider {name!r}")
        return provider

    def estimate(self, agent, body, allow_unpriced=False, principal=None):
        """Worst-case cost of a call before it is made: (paid, usd). principal: see admit_subscription (only that route
        reads it).

        Local and mock models are free.  A remote model with no known price is
        refused rather than counted as $0, unless the operator allows it.
        """
        provider_name, model = split_model(agent["model"])
        self.enforce_egress(agent, provider_name)
        provider = self.provider(provider_name)
        if is_subscription(provider_name):
            # R3.2 §M: its own branch. No money is reserved: it is the owner's plan usage, recorded with its tokens at
            # $0 and payer_mode 'plan', bounded by the gate's day call cap, never by a price (and never called free)
            self.admit_subscription(agent, principal, provider=provider_name)
            return False, 0.0
        if is_free(provider_name):
            # the deploy's key, not the hive's money: no price, no reservation; the person's calls for the day bound it
            self.admit_free(agent, principal)
            return False, 0.0
        if provider.local:
            return False, 0.0
        if not provider.priced(model):
            # Mike's audit (#56): a $0 estimate can never be reserved, so "allowed but unpriced" used to fail later as
            # reservation_refused. Unpriced is never bounded (ec78895e), so it is refused here, in words that say why.
            raise GatewayError(402, "unpriced_model",
                               f"no price is configured for {agent['model']}, so its cost can't be reserved; add one "
                               "to the providers file" + ("" if not allow_unpriced else
                                                          " (HIVE_ALLOW_UNPRICED admits it to pickers, not to paid calls)"))
        # A true worst case, so a reservation is a hard bound (found by OmegaReview 2026-10-04): every billable input
        # counts (messages, tools, response schemas, everything forwarded), measured in UTF-8 bytes, because a
        # token always covers at least one byte.  Several outputs per call multiply cost unpredictably, so n>1 and
        # best_of>1 are refused rather than under-reserved.
        for field in ("n", "best_of"):
            if field in body and body[field] not in (None, 1):
                raise GatewayError(400, "unsupported_field", f"{field} > 1 is not supported: one output per call")
        # External or multimodal content (images, audio, files, URLs) has a cost the request bytes do not bound
        # (OmegaReview 2026-10-04). Text-only is the bounded contract; anything else is refused before dispatch.
        def text_only(content):
            if content is None or isinstance(content, str):
                return True
            if isinstance(content, list):
                return all(isinstance(p, str) or (isinstance(p, dict) and p.get("type") in ("text", "input_text")) for p in content)
            return False
        for message in body.get("messages") or []:
            if isinstance(message, dict) and not text_only(message.get("content")):
                raise GatewayError(400, "unsupported_content", "only text message content is supported on paid calls")
        # The Responses-style `input` shape is forwarded too, so it obeys the same rule (Kimi 2026-10-04).
        if "input" in body:
            items = body["input"] if isinstance(body["input"], list) else [body["input"]]
            for item in items:
                if not (text_only(item) or (isinstance(item, dict) and item.get("type") in ("text", "input_text"))
                        or (isinstance(item, dict) and "content" in item and text_only(item["content"]))):
                    raise GatewayError(400, "unsupported_content", "only text input is supported on paid calls")
        for field in ("input_audio", "audio", "modalities", "attachments"):
            if field in body:
                raise GatewayError(400, "unsupported_content", f"{field} is not supported on paid calls")
        prompt_tokens = billable_tokens(body)
        max_out = int(body.get("max_completion_tokens") or body.get("max_tokens") or 4096)
        # A model priced at exactly $0 (a free remote model) still goes through every access, payer and budget check:
        # it reserves one micro-dollar, the smallest positive amount, and settles at what the provider reports.
        worst = self.cost(provider, model, prompt_tokens, max_out)
        if worst <= 0:
            # Free only by an explicit $0 entry for THIS model; a $0 "*" wildcard never makes an unknown model free (sol).
            worst = self.free_reserve(provider, model, agent["model"])
        return True, worst

    def free_reserve(self, provider, model, label):
        """The hold for a call whose configured worst case is $0 (chat and embeddings alike).

        Free only by an explicit $0 entry for THIS model; a $0 "*" wildcard never makes an unknown model free (sol).
        The micro-dollar is an admission floor, not a bound on what a mispriced model may charge, so while any earlier
        call to this model has an unknown outcome, no further call is made until that call settles (sol R2 P1): from
        OpenRouter's record, or by the expiry at $0 an hour after its outcome went unknown (cost_reservations.expire_unknown)."""
        if not (isinstance(provider.prices.get(model), dict) and provider.price(model) == (0.0, 0.0)):
            raise GatewayError(402, "unpriced_model",
                               f"no price is configured for {label}, so its cost can't be reserved; add one "
                               "to the providers file")
        settles = self.free_unreconciled(label) if self.free_unreconciled is not None else None
        if settles is not None:
            # its sentence is the table's, saying when that call settles by itself (from OpenRouter's record, or the
            # hour's expiry); the same wait goes out as its Retry-After
            wait = max(1, settles - time.time())
            raise refused("free_model_unreconciled", 402, retry_after=wait, model=label, when=when(wait))
        return FREE_MODEL_RESERVE_USD

    def cost(self, provider, model, prompt_tokens, completion_tokens):
        price_in, price_out = provider.price(model)
        return (prompt_tokens * price_in + completion_tokens * price_out) / 1_000_000

    def affordable_room(self, agent, body, limit, room_micros):
        """The most output tokens, up to `limit`, a call with this body can reserve when `room_micros` is what a new
        reservation for it could hold (None: nothing limits it): estimate's worst case solved for the output,
        (room - prompt x price in) / price out, floored, one micro under so the reservation's own rounding up still
        fits. The prompt is counted as if the room were `limit`, the widest number it can be. A model with no price
        here reserves no money and gets `limit`. Example: $0.30 of room, a 40,000-byte prompt, $3 in and $15 out per
        million tokens: (300,000 - 120,000 - 1) // 15 = 11,999 tokens."""
        provider_name, model = split_model(agent["model"])
        provider = self.providers.get(provider_name)
        if room_micros is None or provider is None or not provider.priced(model):
            return limit
        price_in, price_out = provider.price(model)
        if price_out <= 0:
            return limit
        widest = {**body, ("max_completion_tokens" if body.get("max_completion_tokens") else "max_tokens"): limit}
        return max(0, min(limit, int((room_micros - billable_tokens(widest) * price_in - 1) // price_out)))

    async def chat(self, agent, body, principal=None):
        """Returns (response_json, usage_dict). principal: see admit_subscription (only that route reads it)."""
        self._agent_guard(agent)
        provider_name, model = split_model(agent["model"])
        self.enforce_egress(agent, provider_name)
        provider = self.provider(provider_name)
        if body.get("stream"):
            raise GatewayError(400, "stream_unsupported", "streaming is not supported yet")
        if provider_name == "mock" and body.get("tools"):
            return mock_tool_reply(agent["name"], body), {"prompt_tokens": 1, "completion_tokens": 1, "cost_usd": 0.0}
        if provider_name == "mock":
            prompt = _prompt_text(body)
            text = mock_reply(agent["name"], prompt)
            pt, ct = max(1, len(prompt) // 4), max(1, len(text) // 4)
            return _completion(agent["model"], text, pt, ct), {"prompt_tokens": pt, "completion_tokens": ct, "cost_usd": 0.0}
        if not provider.base_url:
            raise GatewayError(500, "provider_unconfigured", f"{provider_name} has no base_url")
        subscription = is_subscription(provider_name)
        free = is_free(provider_name)
        ticket, sent, committed = None, [], []
        if subscription:
            # again just before dispatch (R3.1 §F), recorded as an attempt against the instance's day cap
            ticket = self.admit_subscription(agent, principal, dispatch=True, provider=provider_name)
        upstream = dict(body, model=model)
        if upstream.get("tool_choice") == "required":
            upstream["tool_choice"] = "auto"   # 'required' maps to Anthropic 'any', rejected by some models (as provider_features.py)
        if provider_name == "anthropic":
            upstream.pop("enable_thinking", None)   # Iter's vLLM/Qwen switch, not an Anthropic field
        key_id, secret = self.sender(agent, provider_name, provider)
        headers = {"Authorization": f"Bearer {secret}"} if secret else {}
        if provider_name == "openrouter":
            # The mind's preferred upstream(s) for this model, if it has any (hive/core/providers.py).
            routing = openrouter_routing(agent.get("options"))
            if routing:
                upstream["provider"] = routing
            headers["X-Title"] = "OmegaHive"
        extensions = {"trace": self._trace(agent)} if self.authorize_agent is not None or SEND_GATE.get() is not None else None
        if subscription:   # always traced: authority and egress are judged again at the send boundary itself
            extensions = {"trace": self._trace(agent, self._subscription_recheck(agent, principal, provider_name),
                                               on_send=lambda: sent.append(True))}
        elif free:   # authority and egress judged again at the send boundary, and the commit marked there (free_uncommitted)
            extensions = {"trace": self._trace(agent, self._free_recheck(agent, principal),
                                               on_commit=lambda: committed.append(True))}
        readiness = self.keyring
        if not all(callable(getattr(readiness, method, None))
                   for method in ('answer_context', 'record_answer', 'record_failure')):
            readiness = None  # existing stand-ins do not acquire evidence authority
        context = readiness.answer_context(provider_name, model, secret) if readiness is not None else None
        if free:
            # again just before dispatch, counted as one of the person's calls and the hive's for the day; given back
            # below if the call ends before it commits
            ticket = self.admit_free(agent, principal, dispatch=True)
        try:
            attempt = 0
            while True:
                response = await self.client.post(f"{provider.base_url.rstrip('/')}/chat/completions", json=upstream,
                                                  headers=headers, extensions=extensions)
                if not (free and response.status_code == 429):
                    break
                # the endpoint's rate limit refused it unserved: uncommitted again (the retry commits at its own send
                # boundary, after the same checks), and retried after a wait while retries remain and the answer asks for
                # no longer wait than this call makes
                committed.clear()
                delay = free_retry_delay(attempt, response.headers) if attempt < FREE_RETRIES else None
                logging.getLogger("hive").info("free inference: the endpoint answered 429 (attempt %d); %s", attempt + 1,
                                               "giving up" if delay is None else f"retrying in {delay:.1f} s")
                if delay is None:
                    break
                await asyncio.sleep(delay)
                attempt += 1
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadError, httpx.ReadTimeout,
                httpx.WriteError, httpx.WriteTimeout, httpx.RemoteProtocolError) as exc:
            if readiness is not None:
                readiness.record_failure(context)
            if subscription:
                self.subscription_transport_failed(provider_name, ticket, exc, sent)
            elif free:
                self.free_uncommitted(ticket, committed)
            raise
        except BaseException:   # a refusal at the send boundary, a cancelled turn, a full pool: whatever ended it there
            if free:
                self.free_uncommitted(ticket, committed)
            raise
        if subscription and callable(getattr(self.subscription_gate, "bridge_up", None)):
            self.subscription_gate.bridge_up(provider_name)   # the bridge answered: any cooldown ends
        if free and response.status_code == 429:
            # still refused after its retries: nothing was served, so its count goes back, and the person reads why in
            # plain words, never the provider's
            if readiness is not None:
                readiness.record_failure(context)
            self.free_uncommitted(ticket, committed)
            logging.getLogger("hive").warning("free inference: the endpoint still answered 429 after %d retries", attempt)
            # when trying again can help: the wait the answer asked for, however long (a mind's calls hold that long), else
            # the next wait this loop would have made; the sentence names the wait only when the endpoint asked for one
            # (Singularity Compute's 429 asks none, and a jitter draw is no one's promise), else it says "in a moment"
            asked = asked_wait(response.headers)
            if asked is not None:
                raise refused("free_inference_busy", 429, retry_after=asked, when=when(asked))
            raise refused("free_inference_busy", 429, retry_after=free_retry_delay(attempt, response.headers))
        # Pool exhaustion, local protocol errors, budget/policy/SEND_GATE refusal and
        # cancellation are not observations that the provider failed to answer.
        if response.status_code >= 400:
            if readiness is not None:
                readiness.record_failure(context)
            err = upstream_refusal(provider_name, response, model)
            if provider_name == "openrouter" and paid_extras(upstream):
                err.unbilled = False   # web search, file parsing or fetch may have run and been billed before the error
            if err.refusal_usage is not None:   # a refusal that reports usage: priced as an answer would be
                with contextlib.suppress(Exception):
                    err.charge_usd = charge_from_refusal(err.refusal_usage,
                                                         lambda pt, ct: self.cost(provider, model, pt, ct))
            if subscription:
                err.charge_usd = None   # the owner's plan, not the hive's money: a reported figure is never a charge
            raise err
        try:
            data = response.json()
        except ValueError:
            if readiness is not None:
                readiness.record_failure(context)
            raise
        if not isinstance(data, dict) and readiness is not None:
            readiness.record_answer(context, data)  # invalidate prior evidence; preserve original parse failure below
        if subscription and (not isinstance(data, dict) or _plan_counters(data.get("usage")) is None):
            # plan usage is recorded by its tokens: without valid counters there is nothing honest to record
            if readiness is not None:
                readiness.record_failure(context)
            raise GatewayError(502, "upstream_usage_invalid", "The subscription bridge did not report valid token counts.")
        try:
            usage = data.get("usage") or {}
            reported = reported_cost(usage)
            if reported is not None:
                # a valid reported charge is never discarded by unavailable counters (sol R3 P1): they count as 0 here,
                # and billable() settles the call on the charge
                pt, ct = (v if type(v) is int and v >= 0 else 0 for v in (usage.get("prompt_tokens"), usage.get("completion_tokens")))
            else:
                # no charge: malformed usage still raises, so readiness marks the provider and the hold stays unknown
                pt, ct = int(usage.get("prompt_tokens", 0)), int(usage.get("completion_tokens", 0))
            # A charge the provider reports is never hidden (sol on 38325250): record the larger of the configured
            # rate and the provider's own usage.cost; above the hold, settle flags the overrun as for media.
            cost = self.cost(provider, model, pt, ct)
            if reported is not None and reported > cost:
                cost = reported
            result = data, {"prompt_tokens": pt, "completion_tokens": ct, "cost_usd": cost, "key_id": key_id,
                            "reported_cost_usd": reported}
            if subscription:
                # the owner's plan, not the hive's money: tokens kept, $0 recorded, marked as plan usage (R3.1 §H); a
                # CLI-reported figure is notional on a plan, so it is not recorded as a charge
                result[1].update(cost_usd=0.0, reported_cost_usd=None, payer_mode="plan")
            elif free:
                # the deploy's key, not the hive's money: tokens kept, $0 to the hive, marked as free inference
                result[1].update(cost_usd=0.0, reported_cost_usd=None, payer_mode="free")
        except (AttributeError, TypeError, ValueError, OverflowError):
            if readiness is not None:
                readiness.record_failure(context)
            raise  # preserve the existing parse/cost exception, not a new caller result
        if readiness is not None:
            if 200 <= response.status_code < 300:
                readiness.record_answer(context, data)
            else:
                readiness.record_failure(context)
        return result

    async def embeddings(self, embedding_model, body, agent=None, key_id=None):
        """key_id (J3 R7.3, a person's own Studio maker only): send with that key's secret instead of the provider's
        default key; every other caller leaves it None and is unchanged."""
        self._agent_guard(agent)
        provider_name, model = split_model(embedding_model)
        self.enforce_egress(agent, provider_name)
        if is_subscription(provider_name) or is_free(provider_name):
            raise GatewayError(400, "unsupported_route", "This model route does not serve embeddings.")
        inputs = body.get("input", "")
        inputs = inputs if isinstance(inputs, list) else [inputs]
        if provider_name == "mock":
            data = [{"object": "embedding", "index": i, "embedding": mock_embedding(str(t))} for i, t in enumerate(inputs)]
            return {"object": "list", "data": data, "model": embedding_model,
                    "usage": {"prompt_tokens": 0, "total_tokens": 0}}
        provider = self.provider(provider_name)
        secret = provider.api_key
        if key_id is not None:
            secret = self.keyring.secret_for(provider_name, key_id) if self.keyring is not None else None
            if not secret:
                raise GatewayError(402, "key_unavailable", f"the paying key is gone or is not a {provider_name} key")
        headers = {"Authorization": f"Bearer {secret}"} if secret else {}
        extensions = {"trace": self._trace(agent)} if self.authorize_agent is not None or SEND_GATE.get() is not None else None
        response = await self.client.post(f"{provider.base_url.rstrip('/')}/embeddings",
                                          json=dict(body, model=model), headers=headers, extensions=extensions)
        if response.status_code >= 400:
            raise upstream_refusal(provider_name, response, model)
        return response.json()
