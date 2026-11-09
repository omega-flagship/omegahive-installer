"""Model providers: operator-set keys, the OpenRouter catalogue and per-model routing.

Keys are set once by the operator (UI or environment) and live in
``<data>/providers.json`` with mode 0600.  They never leave the hive: the
gateway injects them, agents and the UI only ever see a hint (``…ab12``).

OpenRouter exposes hundreds of models behind one key.  The catalogue is
fetched on demand and cached for an hour; its prices feed the gateway's
worst-case cost estimate, so a mind on an OpenRouter model is metered like any
other.  A mind may also ask for a particular upstream provider for its model
(``options.route``), which the gateway passes to OpenRouter as provider routing.
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import logging
import os
import re
import pathlib
import secrets
import time

import httpx

from .config import is_subscription
from .keyids import KEY_ID
from .redact import provider_error_text, register as register_secret

CATALOG_TTL = 3600
ANSWER_TTL = 60.0  # process-local evidence, never a background probe or admission
ENDPOINTS_TTL = 900
OPENROUTER = "openrouter"
LABELS = {"mock": "Offline", "anthropic": "Anthropic", "openai": "OpenAI", "openrouter": "OpenRouter", "local": "Local server",
          "subscription-cli": "AI subscription (this Mac)", "subscription-codex": "ChatGPT subscription (this Mac)"}


def owner_mark(principal):
    """A removed key's owner as its tombstone keeps it: a one-way mark, enough to recognise them, never their principal."""
    return hashlib.sha256(("keyview-tombstone:" + str(principal)).encode()).hexdigest()[:32]


class ProviderError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _per_million(value):
    try:
        return round(float(value) * 1_000_000, 4)
    except (TypeError, ValueError):
        return None


def _slim_model(raw):
    """The part of an OpenRouter catalogue entry the picker needs."""
    pricing = raw.get("pricing") or {}
    arch = raw.get("architecture") or {}
    top = raw.get("top_provider") or {}
    params = raw.get("supported_parameters") or []
    return {
        "id": raw.get("id", ""),
        "name": raw.get("name", raw.get("id", "")),
        "description": str(raw.get("description") or "")[:240],
        "context_length": raw.get("context_length") or top.get("context_length") or 0,
        "max_completion_tokens": top.get("max_completion_tokens"),
        "in_per_m": _per_million(pricing.get("prompt")),
        "out_per_m": _per_million(pricing.get("completion")),
        "inputs": arch.get("input_modalities") or [],
        "outputs": arch.get("output_modalities") or [],
        "tools": "tools" in params,
        "reasoning": "reasoning" in params or bool(raw.get("reasoning")),
        "created": raw.get("created"),
    }


def _slim_endpoint(raw):
    pricing = raw.get("pricing") or {}
    return {
        "name": raw.get("name", ""),
        "provider": raw.get("provider_name", ""),
        "tag": raw.get("tag", ""),
        "context_length": raw.get("context_length") or 0,
        "max_completion_tokens": raw.get("max_completion_tokens"),
        "in_per_m": _per_million(pricing.get("prompt")),
        "out_per_m": _per_million(pricing.get("completion")),
        "quantization": raw.get("quantization"),
        "uptime": raw.get("uptime_last_30m"),
        "status": raw.get("status"),
        "latency_ms": raw.get("latency_last_30m"),
        "throughput": raw.get("throughput_last_30m"),
        "tools": bool((raw.get("supports_tool_choice") or {}).get("auto")),
    }


class ProviderStore:
    def __init__(self, settings, client: httpx.AsyncClient | None = None):
        self.settings = settings
        self.providers = settings.providers
        self.client = client or httpx.AsyncClient(timeout=30)
        self.path = pathlib.Path(settings.data_dir) / "providers.json"
        self.ring = self._read()
        self._committing = False   # r1ab.3: _commit is not re-entrant
        self.catalog = {"models": [], "fetched_at": 0.0, "error": None}
        self.endpoints: dict[str, tuple[float, list]] = {}
        self.accounts: dict[str, dict] = {}  # by key id; "env:<provider>" for an environment key
        self._apply_defaults()
        self._answers = {}  # configuration-bound outcomes only; no content, key or account
        self._answer_clock = time.monotonic

    # ---- the keyring -----------------------------------------------------------------------------
    #
    # Keys belong to a principal (today "user:operator"; with sign-in, each person) and are many per
    # provider.  One key per provider may be the hive default: it pays for every mind that has not been
    # assigned a key of its own.  A provider's environment key (e.g. OPENROUTER_API_KEY) is the default
    # of last resort.  Secrets never leave this object except as an Authorization header upstream.

    def _read(self):
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        if data.get("version") == 2:
            data.setdefault("keys", {})
            data.setdefault("defaults", {})
            return data
        # version 1: {provider: {"key", "set_at"}} -> one default key per provider
        ring = {"version": 2, "keys": {}, "defaults": {}}
        for name, value in data.items():
            if isinstance(value, dict) and value.get("key"):
                key_id = f"k_{secrets.token_hex(4)}"
                ring["keys"][key_id] = {"id": key_id, "provider": name, "label": f"{LABELS.get(name, name)} key",
                                        "owner": "user:operator", "secret": value["key"],
                                        "created_at": value.get("set_at") or time.time()}
                ring["defaults"][name] = key_id
        return ring

    def _write(self):
        """The keyring, written privately (J1 design r2 C, r3 N): a fresh random temp name created exclusively, never
        through a link, with mode 0600 from its first byte; fsynced, atomically renamed over the keyring, then the
        folder fsynced so the rename itself survives a crash. A failure leaves the old keyring and no temp file.
        r1ab.3 (Kimi r1ab.2): once os.replace has succeeded the new keyring IS the file, so a failed folder fsync after it
        is logged and the write counts as committed; raising there would let a caller restore memory to the old keyring
        while the file holds the new one."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f".{self.path.name}.{secrets.token_hex(8)}.tmp")
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        fd = os.open(tmp, flags, 0o600)
        try:
            try:
                os.fchmod(fd, 0o600)   # the umask can only remove bits; this pins exactly 0600 whatever it is
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    fd = None
                    handle.write(json.dumps(self.ring))
                    handle.flush()
                    os.fsync(handle.fileno())
            finally:
                if fd is not None:
                    os.close(fd)
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        try:
            directory = os.open(self.path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except OSError as exc:
            logging.getLogger("hive").warning("keyring: written, but its folder could not be synced (%s)", exc)

    def _commit(self, mutate):
        """gateway r1ab.2 (stand-in r1ab.1 P1): one keyring change, applied as a unit. `mutate` changes self.ring; then it
        is written. If either step raises, the in-memory keyring is put back exactly as it was (in place, so every holder
        of self.ring sees it) and the error is raised. _write either replaces the file or leaves the old one (r1ab.3: a
        failure after the rename is not raised), so memory and file stay in step and a failed write can never leave
        the provider defaults changed. Not re-entrant (Kimi r1ab.2 #4): a mutate that commits again is refused, since the
        inner write would persist the outer change half-made."""
        if self._committing:
            raise RuntimeError("keyring change inside a keyring change")
        before = copy.deepcopy(self.ring)
        self._committing = True
        try:
            out = mutate()
            self._write()
        except BaseException:
            self.ring.clear()
            self.ring.update(before)
            self._apply_defaults()
            raise
        finally:
            self._committing = False
        self._apply_defaults()
        return out

    def has_default(self, provider_name):
        """Whether the provider already has a default: a stored one, or its environment key (add_key's own rule)."""
        provider = self.provider(provider_name)
        return provider_name in self.ring["defaults"] or bool(provider.key_env and os.environ.get(provider.key_env))

    def _apply_defaults(self):
        for record in self.ring["keys"].values():   # every key this hive holds is known to the one redactor (r2 F)
            register_secret(record.get("secret"))
        for name, provider in self.providers.items():
            if provider.key_env:
                register_secret(os.environ.get(provider.key_env, ""))
            key_id = self.ring["defaults"].get(name)
            record = self.ring["keys"].get(key_id) if key_id else None
            provider.stored_key = record["secret"] if record else ""

    def provider(self, name):
        provider = self.providers.get(name)
        if provider is None:
            raise ProviderError(404, "unknown_provider", f"no provider {name!r}")
        return provider

    @staticmethod
    def hint(key):
        return f"…{key[-4:]}" if key and len(key) >= 8 else ("set" if key else "")

    def key_record(self, key_id):
        record = self.ring["keys"].get(str(key_id or ""))
        if record is None:
            raise ProviderError(404, "unknown_key", "no such key")
        return record

    def paying_route(self, provider_name):
        """How a call with no key of its own is paid for this provider, as the gateway pays it (gateway.paying_key): the
        provider's default key, else its environment key. {key_id, secret}; secret is empty when there is none."""
        return {"key_id": self.ring["defaults"].get(provider_name) or f"env:{provider_name}",
                "secret": self.provider(provider_name).api_key}

    def secret_for(self, provider_name, key_id=None):
        """The secret that pays for a call: the mind's own key, else the provider's default."""
        if key_id:
            record = self.ring["keys"].get(key_id)
            if record and record["provider"] == provider_name:
                return record["secret"]
            return ""  # an assigned key that is gone or for another provider never silently falls back
        return self.provider(provider_name).api_key

    def key_view(self, record, usage=None, minds=None):
        default = self.ring["defaults"].get(record["provider"]) == record["id"]
        return {"id": record["id"], "provider": record["provider"],
                "provider_label": LABELS.get(record["provider"], record["provider"]),
                "label": record["label"], "owner": record["owner"], "hint": self.hint(record["secret"]),
                "default": default, "created_at": record.get("created_at"),
                "account": self.accounts.get(record["id"]),
                "spent_usd": round((usage or {}).get(record["id"], 0.0), 6), "minds": minds or []}

    def env_key_view(self, name, usage=None, minds=None):
        provider = self.provider(name)
        secret = os.environ.get(provider.key_env, "") if provider.key_env else ""
        if not secret:
            return None
        key_id = f"env:{name}"
        return {"id": key_id, "provider": name, "provider_label": LABELS.get(name, name),
                "label": f"{LABELS.get(name, name)} key from the hive's environment ({provider.key_env})",
                "owner": "hive", "hint": self.hint(secret), "default": name not in self.ring["defaults"],
                "created_at": None, "account": self.accounts.get(key_id), "env": True,
                "spent_usd": round((usage or {}).get(key_id, 0.0), 6), "minds": minds or []}

    def keys(self, owner=None, usage=None, minds_by_key=None):
        """Every key the caller may see: their own, plus the hive's environment keys."""
        usage, minds_by_key = usage or {}, minds_by_key or {}
        out = [self.key_view(r, usage, minds_by_key.get(r["id"])) for r in self.ring["keys"].values()
               if owner is None or r["owner"] == owner]
        for name in self.providers:
            env = self.env_key_view(name, usage, minds_by_key.get(f"env:{name}"))
            if env:
                out.append(env)
        out.sort(key=lambda k: (k["provider"], not k["default"], k["label"].lower()))
        return out

    def own_key(self, provider_name, secret, owner):
        """gateway r1ab.4: the id of this owner's stored key for this provider with exactly this secret, or None (a
        retry of POST /api/keys carries on with it). Compared in constant time against every record; the secret is never
        echoed or logged. A key held by anyone else is not theirs, and add_key does not refuse it either: duplicates are
        per owner (it is stored as this owner's own row, after verification)."""
        self.provider(provider_name)
        secret = str(secret or "").strip().encode()
        if not secret:
            return None
        found = None
        # every record, no early exit; O(ring) per request is fine at a hive's ring size (Kimi r1ab.4 #4)
        for record in self.ring["keys"].values():
            same = hmac.compare_digest(str(record.get("secret") or "").encode(), secret)
            if same and record["provider"] == provider_name and record["owner"] == owner:
                found = record["id"]
        return found

    async def add_key(self, provider_name, secret, label="", owner="user:operator", make_default=None):
        provider = self.provider(provider_name)
        secret = str(secret or "").strip()
        if not secret:
            raise ProviderError(400, "bad_request", "key is required")
        if provider.local or provider_name == "mock" or is_subscription(provider_name):
            raise ProviderError(400, "no_key_needed", f"{provider_name} does not take a key")
        # duplicates are per owner (sol on 46f13f98): only the caller's OWN stored copy of this exact secret is refused,
        # found as own_key finds it (constant time, every record). Another person's copy has no effect at all: the add
        # verifies and stores this owner's own row like any new key, so nothing here tells anyone that someone else
        # holds the same secret (no 409, no label, no shortcut past verification).
        mine = self.own_key(provider_name, secret, owner)
        if mine is not None:
            raise ProviderError(409, "duplicate_key", "that key is already saved as one of yours")
        register_secret(secret)   # before verification: the key is scrubbed from anything a failure writes (r3 N)
        account = await self.verify(provider_name, secret)
        key_id = f"k_{secrets.token_hex(4)}"
        label = str(label or "").strip()[:60] or (account or {}).get("label") or f"{LABELS.get(provider_name, provider_name)} key"

        def mutate():
            self.ring["keys"][key_id] = {"id": key_id, "provider": provider_name, "label": label, "owner": owner,
                                         "secret": secret, "created_at": time.time()}
            (self.ring.get("removed") or {}).pop(key_id, None)   # a live key is never also a tombstone
            if make_default or (make_default is None and not self.has_default(provider_name)):
                self.ring["defaults"][provider_name] = key_id
        self._commit(mutate)
        self.accounts[key_id] = account
        if provider_name == OPENROUTER and self.ring["defaults"].get(provider_name) == key_id:
            # keyview R10 (sol on 26e22ed0): only a key that now fetches the catalogue (the default) refreshes it; a
            # private, non-default key changes nothing anyone else is shown or the cache's hit or miss
            self.catalog["fetched_at"] = 0.0
        return self.key_view(self.ring["keys"][key_id])

    def update_key(self, key_id, label=None, default=None):
        record = self.key_record(key_id)
        if label is not None:
            label = str(label).strip()[:60]
            if not label:
                raise ProviderError(400, "bad_request", "label cannot be empty")

        def mutate():
            current = self.ring["keys"][key_id]
            if label is not None:
                current["label"] = label
            if default is True:
                self.ring["defaults"][current["provider"]] = key_id
            elif default is False and self.ring["defaults"].get(current["provider"]) == key_id:
                del self.ring["defaults"][current["provider"]]
        self._commit(mutate)   # r1ab.2: a failed write leaves the label and the default exactly as they were
        return self.key_view(self.ring["keys"][key_id])

    def removed_by(self, key_id, principal):
        """Whether `principal` held this key before it was removed (keyview: its tombstone; a live key is never one)."""
        if not principal or key_id in self.ring["keys"]:
            return False
        mark = (self.ring.get("removed") or {}).get(key_id)
        return bool(mark) and hmac.compare_digest(mark, owner_mark(principal))

    def forget_removed_many(self, key_ids):
        """Drop several removed keys' tombstones in ONE keyring write (startup reconcile)."""
        gone = [k for k in key_ids if k in (self.ring.get("removed") or {})]
        if gone:
            def mutate():
                for k in gone:
                    self.ring["removed"].pop(k, None)
            self._commit(mutate)

    def forget_removed(self, key_id):
        """Drop a removed key's tombstone once no mind names it any more (callers check that)."""
        if key_id in (self.ring.get("removed") or {}):
            self._commit(lambda: self.ring["removed"].pop(key_id, None))

    def remove_key_id(self, key_id):
        record = self.key_record(key_id)

        def mutate():
            del self.ring["keys"][key_id]
            if self.ring["defaults"].get(record["provider"]) == key_id:
                del self.ring["defaults"][record["provider"]]
            # keyview (Kimi on bef0f01b, 593fde34): who held a key outlives it, as a hash of its owner only (never the
            # secret, never the principal itself), so its owner still recognises their own key's id on a mind left
            # assigned to it; nobody else ever sees it. Pruned once no mind names it (forget_removed).
            self.ring.setdefault("removed", {})[key_id] = owner_mark(record.get("owner") or "")

        self._commit(mutate)   # r1ab.2: a failed write leaves the key and the default in place
        self.accounts.pop(key_id, None)
        return record

    async def refresh_account(self, key_id):
        if key_id.startswith("env:"):
            name = key_id[4:]
            provider = self.provider(name)
            secret = os.environ.get(provider.key_env, "") if provider.key_env else ""
        else:
            record = self.key_record(key_id)
            name, secret = record["provider"], record["secret"]
        try:
            self.accounts[key_id] = await self.verify(name, secret)
        except ProviderError as exc:
            self.accounts[key_id] = {"error": exc.message}
        return self.accounts[key_id]

    # ---- evidence from existing, explicitly admitted chat calls -----------------------------------

    def _answer_config(self, name):
        provider = self.provider(name)
        # The secret digest stays internal and is never part of the public status.
        return (id(provider), provider.name, provider.base_url, provider.local, provider.key_env,
                tuple(provider.models), self.ring['defaults'].get(name),
                hashlib.sha256((provider.api_key or '').encode()).digest(),
                getattr(self.settings, 'default_model', None))

    def answer_context(self, name, model, secret):
        """Capture the actual route before its existing request; this method performs no I/O."""
        provider = self.provider(name)
        if name == 'mock' or provider.name == 'mock':
            return None
        # A person's non-default key answering does not validate the hive's default key.
        if not provider.local and (not provider.api_key or secret != provider.api_key):
            return None
        return (name, model, self._answer_config(name))

    def _record_answer(self, context, answered):
        if context is None:
            return False
        name, model, config = context
        if name not in self.providers or name == 'mock' or config != self._answer_config(name):
            return False
        self._answers[name] = {'config': config, 'model': model,
                               'at': self._answer_clock(), 'answered': answered}
        return answered

    def record_answer(self, context, response):
        """Retain only that an assistant answered, never its response or credentials."""
        def reject_constant(_value):
            raise ValueError("non-standard JSON constant")

        answered = False
        if isinstance(response, dict) and isinstance(response.get('choices'), list):
            for choice in response['choices']:
                message = choice.get('message') if isinstance(choice, dict) else None
                if not isinstance(message, dict) or message.get('role') != 'assistant':
                    continue
                content = message.get('content')
                if isinstance(content, str) and content.strip():
                    answered = True
                    break
                calls = message.get('tool_calls')
                if isinstance(calls, list):
                    for call in calls:
                        if not (isinstance(call, dict) and call.get('type') == 'function'
                                and isinstance(call.get('id'), str) and bool(call['id'])
                                and isinstance(call.get('function'), dict)
                                and isinstance(call['function'].get('name'), str) and bool(call['function']['name'])):
                            continue
                        arguments = call['function'].get('arguments')
                        if not isinstance(arguments, str) or not arguments.strip():
                            continue
                        try:
                            json.loads(arguments, parse_constant=reject_constant)
                        except (ValueError, RecursionError):
                            continue
                        answered = True
                        break
                    if answered:
                        break
        return self._record_answer(context, answered)

    def record_failure(self, context):
        """An observed upstream transport/error response is not a policy or budget refusal."""
        self._record_answer(context, False)

    def _readiness(self, name):
        provider = self.provider(name)
        if name == 'mock' or provider.name == 'mock':
            return 'test_only'
        record = self._answers.get(name)
        if record is None:
            return 'unverified'
        if record['config'] != self._answer_config(name):
            self._answers.pop(name, None)  # an observed config change cannot revive old proof
            return 'unverified'
        age = self._answer_clock() - record['at']
        if not 0 <= age < ANSWER_TTL:
            self._answers.pop(name, None)
            return 'unverified'
        return 'answered' if record['answered'] else 'not_answering'

    # ---- providers (one line each in the picker) ---------------------------------------------------

    def status(self, name):
        provider = self.provider(name)
        default_id = self.ring["defaults"].get(name)
        env = bool(provider.key_env and os.environ.get(provider.key_env))
        source = "stored" if default_id else "env" if env else None
        readiness = self._readiness(name)
        # Legacy "connected" means configured, not evidence that a model answered.
        connected = provider.local or provider.name == "mock" or bool(provider.api_key) or any(
            r["provider"] == name for r in self.ring["keys"].values())
        out = {
            "name": name, "label": LABELS.get(name, name.capitalize()), "local": provider.local,
            "needs_key": not provider.local and name != "mock" and not is_subscription(name), "connected": connected, "source": source,
            "configured": connected, "answer_ready": readiness == "answered",
            "test_only": readiness == "test_only", "readiness": readiness,
            # the subscription bridge's key is never hinted, even in part (it is the bridge's door, not a paying key)
            "key_hint": self.hint(provider.api_key) if provider.api_key and not is_subscription(name) else "",
            "key_env": provider.key_env, "base_url": provider.base_url, "models": list(provider.models),
            "keys": sum(1 for r in self.ring["keys"].values() if r["provider"] == name) + (1 if env else 0),
            "account": self.accounts.get(default_id or f"env:{name}"),
        }
        if name == OPENROUTER:
            out["catalog"] = {"count": len(self.catalog["models"]), "fetched_at": self.catalog["fetched_at"] or None,
                              "error": self.catalog["error"]}
        return out

    def list(self):
        order = ["openrouter", "anthropic", "openai", "local", "mock"]
        names = [n for n in order if n in self.providers] + [n for n in self.providers if n not in order]
        return [self.status(n) for n in names]

    async def set_key(self, name, key):
        """Connect a provider from the picker: save the key and make it that provider's default."""
        view = await self.add_key(name, key, make_default=True)
        self.accounts[f"default:{name}"] = view.get("account")
        return self.status(name)

    async def account(self, name):
        key_id = self.ring["defaults"].get(name) or f"env:{name}"
        if not self.provider(name).api_key:
            return None
        return await self.refresh_account(key_id)

    async def verify(self, name, key):
        """Check a key against its provider; returns account details to show (never the key)."""
        provider = self.provider(name)
        try:
            if name == OPENROUTER:
                response = await self.client.get(f"{provider.base_url}/key", headers={"Authorization": f"Bearer {key}"})
                if response.status_code == 200:
                    data = response.json().get("data") or {}
                    return {"label": data.get("label"), "limit": data.get("limit"), "usage": data.get("usage"),
                            "limit_remaining": data.get("limit_remaining"), "free_tier": data.get("is_free_tier")}
            elif name == "anthropic":
                response = await self.client.get(f"{provider.base_url}/models",
                                                 headers={"x-api-key": key, "anthropic-version": "2023-06-01"})
                if response.status_code == 200:
                    return {"label": "Anthropic API key"}
            else:
                response = await self.client.get(f"{provider.base_url.rstrip('/')}/models", headers={"Authorization": f"Bearer {key}"})
                if response.status_code == 200:
                    return {"label": f"{LABELS.get(name, name)} key"}
        except httpx.HTTPError as exc:
            raise ProviderError(502, "provider_unreachable", f"could not reach {LABELS.get(name, name)}") from exc   # fixed words
        if response.status_code in (401, 403):
            raise ProviderError(401, "bad_key", f"{LABELS.get(name, name)} rejected that key")
        raise ProviderError(502, "provider_error", provider_error_text(name, response))


    # ---- the OpenRouter catalogue ----------------------------------------------------------------

    async def models(self, refresh=False):
        provider = self.provider(OPENROUTER)
        fresh = time.time() - self.catalog["fetched_at"] < CATALOG_TTL
        if self.catalog["models"] and fresh and not refresh:
            return self.catalog
        headers = {"Authorization": f"Bearer {provider.api_key}"} if provider.api_key else {}
        try:
            response = await self.client.get(f"{provider.base_url}/models", headers=headers)
            response.raise_for_status()
            raw = response.json().get("data") or []
        except (httpx.HTTPError, ValueError) as exc:
            self.catalog["error"] = f"could not fetch the OpenRouter catalogue: {exc}"
            if not self.catalog["models"]:
                raise ProviderError(502, "catalog_unavailable", self.catalog["error"]) from exc
            return self.catalog
        models = sorted((_slim_model(m) for m in raw if m.get("id")), key=lambda m: m["name"].lower())
        self.catalog = {"models": models, "fetched_at": time.time(), "error": None}
        # Prices feed the gateway's estimate, so an OpenRouter mind is metered like any other.
        for model in models:
            if model["in_per_m"] is not None and model["out_per_m"] is not None:
                provider.prices[model["id"]] = {"in": model["in_per_m"], "out": model["out_per_m"]}
        return self.catalog

    async def model_endpoints(self, model_id, refresh=False):
        provider = self.provider(OPENROUTER)
        cached = self.endpoints.get(model_id)
        if cached and time.time() - cached[0] < ENDPOINTS_TTL and not refresh:
            return cached[1]
        headers = {"Authorization": f"Bearer {provider.api_key}"} if provider.api_key else {}
        try:
            response = await self.client.get(f"{provider.base_url}/models/{model_id}/endpoints", headers=headers)
        except httpx.HTTPError as exc:
            raise ProviderError(502, "provider_unreachable", "could not reach OpenRouter") from exc
        if response.status_code == 404:
            raise ProviderError(404, "unknown_model", f"OpenRouter has no model {model_id!r}")
        if response.status_code >= 400:
            raise ProviderError(502, "provider_error", provider_error_text("OpenRouter", response))   # never its body
        data = (response.json().get("data") or {}).get("endpoints") or []
        endpoints = [_slim_endpoint(e) for e in data]
        self.endpoints[model_id] = (time.time(), endpoints)
        return endpoints

    def price_known(self, model_id):
        return model_id in self.provider(OPENROUTER).prices


# ---- routing options carried on a mind ---------------------------------------------------------

ROUTE_SORTS = {"price", "throughput", "latency"}


def clean_options(value):
    """Validate model routing and bounded native output capacity (effective at next start)."""
    if value in (None, "", {}):
        return {}
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError as exc:
            raise ValueError("options must be a JSON object") from exc
    if not isinstance(value, dict):
        raise ValueError("options must be an object")
    out = {}
    if 'tools' in value:
        from .tools import clean_selection
        out['tools'] = clean_selection(value['tools'])
    if "approvals" in value:
        if value["approvals"] != "owner_only":
            raise ValueError("options.approvals is owner_only; omit it for the default approval policy")
        out["approvals"] = "owner_only"
    if "max_output_tokens" in value:
        capacity = value["max_output_tokens"]
        if type(capacity) is not int or not 256 <= capacity <= 32768:
            raise ValueError("options.max_output_tokens must be an integer from 256 to 32768")
        out["max_output_tokens"] = capacity
    key = value.get("key")
    if key:
        if not isinstance(key, str) or not re.fullmatch(KEY_ID, key):   # keyids: the one grammar
            raise ValueError("options.key must be a key id")
        out["key"] = key
    if "key_locked" in value:   # app platform P3a: the mind runs only on its owner's own key, never a fallback
        if type(value["key_locked"]) is not bool:
            raise ValueError("options.key_locked is true or false")
        out["key_locked"] = value["key_locked"]   # preserve explicit false: a locked options write must confirm unlock
    route = value.get("route")
    if route:
        if not isinstance(route, dict):
            raise ValueError("options.route must be an object")
        clean = {}
        order = route.get("order")
        if order:
            if not isinstance(order, list) or not all(isinstance(p, str) and p for p in order):
                raise ValueError("options.route.order must be a list of provider tags")
            clean["order"] = [p[:64] for p in order[:8]]
        if "allow_fallbacks" in route:
            clean["allow_fallbacks"] = bool(route["allow_fallbacks"])
        if route.get("sort"):
            if route["sort"] not in ROUTE_SORTS:
                raise ValueError(f"options.route.sort must be one of {sorted(ROUTE_SORTS)}")
            clean["sort"] = route["sort"]
        if clean:
            out["route"] = clean
    return out


def openrouter_routing(options):
    """The ``provider`` block OpenRouter understands, from a mind's options."""
    if isinstance(options, str):  # a raw agents row carries the JSON text
        try:
            options = json.loads(options)
        except ValueError:
            options = None
    route = (options or {}).get("route") or {}
    if not route:
        return None
    block = {}
    if route.get("order"):
        block["order"] = list(route["order"])
    if "allow_fallbacks" in route:
        block["allow_fallbacks"] = bool(route["allow_fallbacks"])
    if route.get("sort"):
        block["sort"] = route["sort"]
    return block or None
