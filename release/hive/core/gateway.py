"""LLM gateway: an OpenAI-compatible endpoint in front of every model.

Agents call ``/llm/v1/chat/completions`` and ``/llm/v1/embeddings`` with their
own hive token.  The gateway picks the upstream from the agent's ``model``
(``<provider>/<model>``), injects the provider key, meters tokens and cost,
and refuses calls once the agent's budget is spent.  Keys never reach agents.

``mock/echo`` is a built-in offline model that speaks the Omega skill-line
format, so a hive can be demoed and tested without any provider.
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import math
import re
import time
import os
import ipaddress
from urllib.parse import urlsplit

import httpx

from .redact import scrub   # J1 r2 F: a no-op unless the local-owner hive enabled it
from .config import Provider
from .providers import openrouter_routing

# The commitment point (ask-takeover r3, kept in r5): a caller may set SEND_GATE to an async callable for the duration of
# one chat call. It is awaited at httpcore's send_request_headers.started trace: after any wait for a pooled connection
# and after connecting, and may raise to abort the call with nothing sent. Passing it commits the call. It is not the
# first byte: AnyIO's socket send yields once before handing the bytes to the OS, so a close committed in that one step
# may still see this one already-authorised request leave. A call that never reaches a transport (the mock provider)
# never awaits it.
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


class GatewayError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def split_model(model):
    provider, _, name = str(model).partition("/")
    if not name:
        raise GatewayError(400, "bad_model", f"model must be <provider>/<model>, got {model!r}")
    return provider, name


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


def mock_tool_reply(agent_name, body):
    """Mock for agents that use native tool calling (Iter): returns tool calls.

    Acts only on a fresh hive message; otherwise calls nop, the Iter way of
    saying there is nothing to do.
    """
    tools = {t.get("function", {}).get("name") for t in body.get("tools", [])}
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

    def _agent_guard(self, agent):
        if self.authorize_agent is not None and agent is not None:
            self.authorize_agent(agent["id"])

    def _trace(self, agent):
        async def trace(name, info):
            if name.endswith("send_request_headers.started"):
                self._agent_guard(agent)
                await signal_send()   # keep the existing Studio/Ask commitment gate
                self._agent_guard(agent)   # a gate may have awaited while authority changed
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
        provider = self.provider(provider_name)
        address = urlsplit(provider.base_url)
        try:
            loopback = ipaddress.ip_address(address.hostname or '').is_loopback
        except ValueError:
            loopback = False
        if (not provider.local or not loopback or address.scheme not in ('http', 'https')
                or address.username or address.password or address.query or address.fragment):
            raise GatewayError(403, 'egress_refused', 'Swarm permits only literal-loopback local model routes')

    @staticmethod
    def _options(agent):
        options = agent.get("options")
        if isinstance(options, str):
            try:
                options = json.loads(options)
            except ValueError:
                options = None
        return options if isinstance(options, dict) else {}

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
                raise GatewayError(402, "key_unavailable",
                                   f"{agent.get('name', 'this mind')} is assigned key {assigned}, which is gone or not a "
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

    def provider(self, name) -> Provider:
        provider = self.providers.get(name)
        if provider is None:
            raise GatewayError(400, "unknown_provider", f"no provider {name!r}")
        return provider

    def estimate(self, agent, body, allow_unpriced=False):
        """Worst-case cost of a call before it is made: (paid, usd).

        Local and mock models are free.  A remote model with no known price is
        refused rather than counted as $0, unless the operator allows it.
        """
        provider_name, model = split_model(agent["model"])
        self.enforce_egress(agent, provider_name)
        provider = self.provider(provider_name)
        if provider.local:
            return False, 0.0
        if not provider.priced(model):
            if allow_unpriced:
                return True, 0.0
            raise GatewayError(402, "unpriced_model",
                               f"no price is configured for {agent['model']}; add one to the providers file "
                               "or set HIVE_ALLOW_UNPRICED=1")
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
        billable = {k: v for k, v in body.items() if k not in ("model", "stream")}
        prompt_tokens = len(json.dumps(billable, ensure_ascii=False).encode("utf-8")) + 1
        max_out = int(body.get("max_completion_tokens") or body.get("max_tokens") or 4096)
        return True, self.cost(provider, model, prompt_tokens, max_out)

    def cost(self, provider, model, prompt_tokens, completion_tokens):
        price_in, price_out = provider.price(model)
        return (prompt_tokens * price_in + completion_tokens * price_out) / 1_000_000

    async def chat(self, agent, body):
        """Returns (response_json, usage_dict)."""
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
        upstream = dict(body, model=model)
        key_id, secret = self.paying_key(agent, provider_name) if not provider.local else (None, provider.api_key)
        headers = {"Authorization": f"Bearer {secret}"} if secret else {}
        if provider_name == "openrouter":
            # The mind's preferred upstream(s) for this model, if it has any (hive/core/providers.py).
            routing = openrouter_routing(agent.get("options"))
            if routing:
                upstream["provider"] = routing
            headers["X-Title"] = "OmegaHive"
        extensions = {"trace": self._trace(agent)} if self.authorize_agent is not None or SEND_GATE.get() is not None else None
        response = await self.client.post(f"{provider.base_url.rstrip('/')}/chat/completions", json=upstream, headers=headers,
                                          extensions=extensions)
        if response.status_code >= 400:
            raise GatewayError(response.status_code, "upstream_error", scrub(response.text[:500]))
        data = response.json()
        usage = data.get("usage") or {}
        pt, ct = int(usage.get("prompt_tokens", 0)), int(usage.get("completion_tokens", 0))
        return data, {"prompt_tokens": pt, "completion_tokens": ct, "cost_usd": self.cost(provider, model, pt, ct),
                      "key_id": key_id}

    async def embeddings(self, embedding_model, body, agent=None, key_id=None):
        """key_id (J3 R7.3, a person's own Studio maker only): send with that key's secret instead of the provider's
        default key; every other caller leaves it None and is unchanged."""
        self._agent_guard(agent)
        provider_name, model = split_model(embedding_model)
        self.enforce_egress(agent, provider_name)
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
                raise GatewayError(402, "key_unavailable", f"key {key_id} is gone or not a {provider_name} key")
        headers = {"Authorization": f"Bearer {secret}"} if secret else {}
        extensions = {"trace": self._trace(agent)} if self.authorize_agent is not None or SEND_GATE.get() is not None else None
        response = await self.client.post(f"{provider.base_url.rstrip('/')}/embeddings",
                                          json=dict(body, model=model), headers=headers, extensions=extensions)
        if response.status_code >= 400:
            raise GatewayError(response.status_code, "upstream_error", scrub(response.text[:500]))
        return response.json()
