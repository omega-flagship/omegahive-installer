"""Key visibility for what leaves the hive for one caller (sol on 6dc7a837): ONE projection, for HTTP and events alike.

A person may see a key reference only when GET /api/keys would show them that key: the listing's own policy
(app.key_permit: everything for a hive admin or the hive's owner; for anyone else their own keys and the hive keys they
are offered, never another person's). Seeing a mind, or a provider, never implies seeing the key that pays for it.

`project(value, may_see, provider_key)` walks a JSON value and returns a copy in which
- a mind (a dict with an `a_` id and `options`) loses `options.key` when the caller may not see that key;
- a provider's status (a dict with `name`, `needs_key` and `key_hint`) loses the paying key's hint and account details
  (label, usage, limit, balance) when the caller may not see the key it describes (the provider default, else its
  environment key), keeping only what the provider can do.
Past MAX_DEPTH (deeper than any answer here nests) a subtree is dropped, never passed on unprojected.
Nothing else changes. Internal code keeps reading the real rows: this runs only where a response or a frame leaves.
"""
from __future__ import annotations

import re

MAX_DEPTH = 12

# ---- refusals (sol and Kimi on f4bb6907, bef0f01b, 593fde34): one caller-facing projection for what refusals say ----
#: the key-id grammar providers.clean_options accepts (a stored key: 8 or 32 hex digits; an environment key), shared
from .keyids import KEY_ID   # the hive's one key-id grammar
#: ONE pass over a text: a key reference (an id, or a key:<id> budget scope) or a named person
IDENTITY = re.compile(r"(?<![A-Za-z0-9_])(?:(?P<scope>key:)?(?P<key>" + KEY_ID + r")(?![A-Za-z0-9_-])"
                      r"|(?P<person>user:u_[A-Za-z0-9_-]{1,64}))")
HIDDEN_KEY = "a key"
HIDDEN_PERSON = "someone"
#: (keyview R9, Dot on a0975c2f) there is no field exemption: EVERY string of a refusal goes through the identity pass.
#: The pass only ever replaces a key id, a key:<id> scope or a named person the caller may not see, so codes, kinds and
#: reasons (which are never ids) come out exactly as they went in, and an id or principal smuggled into one does not.
#: (keyview R10, sol on 26e22ed0) typed fields: a model id ("openai/k_deadbeef") or a path ("/models/k_deadbeef/x.json")
#: in a model or path field keeps its segments, which are names, not key references; a key:<id> scope or another person
#: in one is still replaced. A value that does not have its field's shape is prose, and gets the full pass.
MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}/[^\s]{1,256}")
PATH = re.compile(r"(?=[^\s]{1,1024}$)[^\s]*/[^\s]*")   # a path has a separator: a bare id alone is not one
TYPED = {"model": MODEL_ID, "models": MODEL_ID, "model_id": MODEL_ID,
         "path": PATH, "paths": PATH, "file": PATH, "files": PATH}


def _mind(value):
    return isinstance(value.get("id"), str) and value["id"].startswith("a_") and isinstance(value.get("options"), dict)


def _provider(value):
    return isinstance(value.get("name"), str) and "needs_key" in value


def project(value, may_see, provider_key, depth=0, provider_for=None):
    """A copy of `value` with every key reference `may_see` refuses removed (see the module notes). provider_for(status,
    may_see): a provider status's caller-facing availability (whether THIS caller could pay with it, how many of its keys
    they may see, where its paying key comes from for them; keyview R8/R9), which replaces the hive-wide one, so storing
    a private key changes nothing anyone else is shown. Without it the hive-wide fields that would tell are left out."""
    if depth > MAX_DEPTH:
        return None   # fail closed: nothing deeper than any answer here nests is passed on unprojected
    if isinstance(value, list):
        return [project(v, may_see, provider_key, depth + 1, provider_for) for v in value]
    if not isinstance(value, dict):
        return value
    out = {k: project(v, may_see, provider_key, depth + 1, provider_for) for k, v in value.items()}
    if _mind(out):
        key = out["options"].get("key")
        if isinstance(key, str) and key and not may_see(key):
            out["options"] = {k: v for k, v in out["options"].items() if k != "key"}
    if _provider(out):
        key = provider_key(out["name"])
        if key and not may_see(key):
            out["key_hint"] = ""
            out["account"] = None
        if provider_for is not None:
            out.update(provider_for(out, may_see))
        else:
            for field in ("keys", "connected", "configured", "source", "readiness", "answer_ready"):
                out.pop(field, None)
    return out


def mentions_keys(text):
    """Cheap pre-check on a serialized body or frame: could it carry anything project() changes?"""
    return '"options"' in text or '"key_hint"' in text or '"needs_key"' in text or '"account"' in text


def redact_text(text, may_see, me=None, bare_keys=True):
    """One descriptive string as this caller may read it, in a single regex pass (no placeholders, so nothing in the
    text can steer it): a key id or key:<id> scope they may not see becomes "a key" (the scope just "key"); any named
    person but themselves becomes "someone"; everything else, their own principal and the keys may_see allows included,
    stays exactly as it was. Key labels are never matched: no first-party refusal names one (keyview R7)."""
    if not isinstance(text, str) or not text:
        return text

    def one(m):
        if m.group("person") is not None:
            return m.group(0) if m.group(0) == me else HIDDEN_PERSON
        if may_see(m.group("key")) or not (bare_keys or m.group("scope")):
            return m.group(0)
        return "key" if m.group("scope") else HIDDEN_KEY
    return IDENTITY.sub(one, text)


def _typed(field, value, may_see, me):
    """A model or path field's string (keyview R10): its own shape keeps its segments; anything else is prose."""
    shape = TYPED.get(field)
    if shape is not None and shape.fullmatch(value):
        return redact_text(value, may_see, me, bare_keys=False)
    return redact_text(value, may_see, me)


def redact_error(value, may_see, me=None, depth=0, field=None):
    """A refusal (or a refusal frame) through redact_text: every string, at any depth, whatever its field (see the note
    above: codes are never ids, so only what the caller may not see changes); a model or path field by its type (TYPED).
    Past MAX_DEPTH a subtree is dropped."""
    if depth > MAX_DEPTH:
        return None
    if isinstance(value, str):
        return _typed(field, value, may_see, me)
    if isinstance(value, list):
        return [redact_error(v, may_see, me, depth + 1, field) for v in value]
    if isinstance(value, dict):
        return {k: redact_error(v, may_see, me, depth + 1, k) for k, v in value.items()}
    return value


def refusal_for_no_one(value):
    """A refusal for a caller with no session (an agent token: MCP, the gateway): no key id or person at all."""
    return redact_error(value, lambda key: False)


def strip_identities(text):
    """This hive's key ids and people, out of a text whoever reads it."""
    return redact_text(text, lambda key: False)
