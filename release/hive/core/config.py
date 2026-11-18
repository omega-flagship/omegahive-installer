# Purpose: the hive's settings, read once from the environment (and an optional providers file).
"""Hive configuration from the environment (and an optional providers file)."""

from __future__ import annotations

import dataclasses
import ipaddress
import json
import logging
import math
import os
import pathlib
import re
from urllib.parse import urlsplit

CORE_ROOT = pathlib.Path(__file__).resolve().parents[2]

BUDGET_ENV = ("HIVE_BUDGET_USD", "HIVE_MEMBER_MONTHLY_USD", "HIVE_ASK_CONDUCTOR_TURN_USD", "HIVE_START_LIMIT_MONTH_USD")
# Spending settings the one-allowance limits retired (budgets.py): a team's default month and one instruction's ceiling.
# A request is bounded by the asker's allowance and the caps set instead, so a hive that still sets one is told once at
# startup that it does nothing (_note_retired).
RETIRED_ENV = ("HIVE_SWARM_MONTHLY_USD", "HIVE_PERSON_REQUEST_CEILING_USD")
_RETIRED_NOTED: set = set()
START_LIMIT_DEFAULT_USD = 50.0


@dataclasses.dataclass
class Provider:
    """An OpenAI-compatible upstream.  ``mock`` is built in and needs no key."""

    name: str
    base_url: str = ""
    key_env: str = ""
    local: bool = False
    # USD per million tokens, by model name; "*" is the provider default.
    prices: dict = dataclasses.field(default_factory=dict)
    models: list = dataclasses.field(default_factory=list)
    # A key the operator set from the UI (hive/core/providers.py); it wins over the environment.
    stored_key: str = ""
    # Host-pinned media endpoint records by op ("image.generate", ...), read by hive/core/media.py (P1). Empty = no
    # media op is admitted on this provider. Set only in the providers file, never from a request.
    media: dict = dataclasses.field(default_factory=dict)

    @property
    def api_key(self):
        return self.stored_key or (os.environ.get(self.key_env, "") if self.key_env else "")

    def price(self, model):
        entry = self.prices.get(model) or self.prices.get("*") or {}
        return float(entry.get("in", 0.0)), float(entry.get("out", 0.0))

    def priced(self, model):
        return bool(self.prices.get(model) or self.prices.get("*"))


DEFAULT_PROVIDERS = [
    Provider("mock", models=["echo"], local=True),
    Provider("anthropic", "https://api.anthropic.com/v1", "ANTHROPIC_API_KEY",
             models=["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"],
             prices={"claude-opus-5-5": {"in": 15, "out": 75},
                     "claude-sonnet-5-5": {"in": 3, "out": 15},
                     "claude-haiku-4-5-20251001": {"in": 1, "out": 5}}),
    Provider("openai", "https://api.openai.com/v1", "OPENAI_API_KEY", models=["gpt-6.1", "gpt-5.4"]),
    # OpenRouter: one key, hundreds of models.  These are the featured few; the full catalogue (with
    # prices) is fetched live by hive/core/providers.py and offered in the model picker.
    Provider("openrouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY",
             models=["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "openai/gpt-5.6-sol",
                     "google/gemini-3.1-pro-preview", "deepseek/deepseek-v4-pro", "moonshotai/kimi-k3",
                     "z-ai/glm-5.1"]),
    # Self-hosted OpenAI-compatible servers (vLLM, SGLang, Ollama, llama.cpp).
    Provider("local", os.environ.get("HIVE_LOCAL_LLM_URL", "http://127.0.0.1:8000/v1"),
             "HIVE_LOCAL_LLM_KEY", local=True, models=[]),
    # ASI Cloud with a person's own key, or the hive's ASI_API_KEY (the variable the Omega runtime reads too). asi1-mini is
    # free there (ASI Cloud's FAQ), so it carries an explicit $0. ASI Cloud shows its other prices only in its dashboard,
    # and the hive never calls a model it can't price, so another model joins this list with its price.
    Provider("asicloud", "https://inference.asicloud.cudos.org/v1", "ASI_API_KEY", models=["asi1-mini"],
             prices={"asi1-mini": {"in": 0, "out": 0}}),
]

# Free inference (hive/core/free_inference.py): an OpenAI-compatible endpoint on a key the deploy supplies, offered to the
# people in the hive and never shown to anyone. HIVE_FREE_INFERENCE_KEY holds the key; _URL the endpoint the key belongs
# to (Singularity Compute's when unset, where the team's key comes from); _MODELS the models it pays for (comma-separated,
# the first is the default a person's mind moves to). Its limits are free_inference.py's.
FREE = "free"
FREE_KEY_ENV = "HIVE_FREE_INFERENCE_KEY"
FREE_URL_ENV = "HIVE_FREE_INFERENCE_URL"
# Singularity Compute's OpenAI-compatible base, the one its model page names; a key from elsewhere comes with its own URL,
# so an unset URL never sends the team's key to another provider
FREE_DEFAULT_URL = "https://llm.a.singularitycompute.com/v1"
# MiniMax M3.1 Flash, the model suggested for the deploy, under the id Singularity Compute serves it (its /models lists
# minimax/minimax-m3.1-flash, and the hive's loop ran end to end on it with the team's key on 17 Nov); a deploy whose
# endpoint names it otherwise sets HIVE_FREE_INFERENCE_MODELS
FREE_DEFAULT_MODELS = ("minimax/minimax-m3.1-flash",)


def is_free(name):
    """Whether a provider name is the free route (the one test every route uses)."""
    return name == FREE


def caller_judged(name):
    """A route whose gate judges who each call is for (a subscription instance, the free route): a caller that knows
    who that is (the Ask conductor's asker, the mind gateway's token principal) passes it as principal."""
    return is_subscription(name) or is_free(name)


def _free_provider():
    """The free route, only while HIVE_FREE_INFERENCE_KEY holds a key and HIVE_FREE_INFERENCE_URL (if set) is an endpoint
    the key may travel to; else None. Never local: what a person writes leaves the machine for the endpoint. No prices: a
    call costs the hive nothing, and the calls a day of each person and of the hive bound it instead
    (free_inference.FreeGate)."""
    if not os.environ.get(FREE_KEY_ENV, "").strip():
        return None
    url = os.environ.get(FREE_URL_ENV, "").strip().rstrip("/") or FREE_DEFAULT_URL
    if not free_endpoint_ok(url):
        # never a fallback to the default endpoint: the key may belong to another, and is sent nowhere it wasn't meant for
        logging.getLogger("hive.config").warning("%s is not an https address (or plain http to a literal loopback "
                                                 "address on this machine); free inference is off", FREE_URL_ENV)
        return None
    models = [m.strip() for m in os.environ.get("HIVE_FREE_INFERENCE_MODELS", "").split(",") if m.strip()]
    return Provider(FREE, url, FREE_KEY_ENV, models=models or list(FREE_DEFAULT_MODELS))


def free_endpoint_ok(url):
    """Whether the deploy's key may travel to `url`: https, or plain http to a literal loopback address (a stand-in on this
    machine, as the gateway's local-only egress rule reads loopback), with a host, a readable port if one is given, and no
    credentials, query or fragment. Example: https://llm.a.singularitycompute.com/v1 and http://127.0.0.1:9911/v1 pass;
    http://example.org/v1 and https://example.org:bad/v1 don't."""
    try:
        parts = urlsplit(str(url or ""))
        port = parts.port   # raises for a port that isn't a number from 0 to 65535
    except ValueError:
        return False
    try:
        loopback = ipaddress.ip_address(parts.hostname or "").is_loopback
    except ValueError:
        loopback = False   # a name, never a literal address: not counted as this machine
    return (bool(parts.hostname) and port != 0 and not (parts.username or parts.password or parts.query or parts.fragment)
            and (parts.scheme == "https" or (parts.scheme == "http" and loopback)))


def carries_free_key(provider):
    """Whether a providers file entry would hold the deploy's free key outside the free route, make that route local, or
    send the key where free_endpoint_ok refuses: each would show the key or pass the local-only egress rule, so such an
    entry is refused. An entry named free on the free key replaces the route like any provider (another endpoint, its
    models), and stays remote."""
    if is_free(provider.name):
        return provider.key_env != FREE_KEY_ENV or provider.local or not free_endpoint_ok(provider.base_url)
    return provider.key_env == FREE_KEY_ENV


# The owner's AI subscriptions through local CLI bridges (hive/core/subscription_cli.py): a family of providers, one per
# bridge, so a hive can run on a Claude subscription, a ChatGPT subscription, or any mix. Never local: a prompt sent here
# leaves the machine through the CLI, so it must not pass the local-only egress rule or settle as local.
# Each instance is configured from the environment only, from its prefix: <PREFIX>_URL / _KEY / _MODELS, and optionally
# _SWARMS and _DAILY_CALLS. subscription-cli keeps its original name and variables (backward compatible).
SUBSCRIPTION_CLI = "subscription-cli"
SUBSCRIPTION_CODEX = "subscription-codex"
SUBSCRIPTIONS = {SUBSCRIPTION_CLI: "HIVE_SUBSCRIPTION_CLI", SUBSCRIPTION_CODEX: "HIVE_SUBSCRIPTION_CODEX"}


SUBSCRIPTION_CLI_KEY_ENV = "HIVE_SUBSCRIPTION_CLI_KEY"
SUBSCRIPTION_KEY_ENVS = frozenset(f"{prefix}_KEY" for prefix in SUBSCRIPTIONS.values())


def is_subscription(name):
    """Whether a provider name is one of the owner's subscription bridges (the one test every route uses)."""
    return name in SUBSCRIPTIONS


def subscription_env(name, suffix):
    """<PREFIX>_<suffix> of a subscription instance, stripped ("" when unset or not a subscription)."""
    prefix = SUBSCRIPTIONS.get(name)
    return os.environ.get(f"{prefix}_{suffix}", "").strip() if prefix else ""


def subscription_bridge_urls():
    """Every configured bridge URL (raw, as set), for refusing other entries aimed at any of them."""
    return [url for url in (subscription_env(name, "URL") for name in SUBSCRIPTIONS) if url]


def literal_loopback_url(url):
    """True for an http(s) URL whose host is a literal loopback address (127.0.0.0/8, ::1) with no credentials, query or
    fragment: the same bar as the local-only egress rule. A name (localhost included) is not literal: it is a lookup.
    Malformed input is False, never an exception."""
    try:
        address = urlsplit(str(url or "").strip())
        loopback = ipaddress.ip_address(address.hostname or "").is_loopback
        address.port   # raises on a malformed port
    except ValueError:
        return False
    return bool(loopback and address.scheme in ("http", "https") and not (address.username or address.password
                                                                        or address.query or address.fragment))


def _endpoint(url):
    """(on this machine by address or name, port) of a provider URL, or None when it cannot be read."""
    try:
        address = urlsplit(str(url or "").strip())
        host = (address.hostname or "").lower()
        port = address.port or {"http": 80, "https": 443}.get(address.scheme)
    except ValueError:
        return None
    try:
        local = ipaddress.ip_address(host).is_loopback or ipaddress.ip_address(host).is_unspecified
    except ValueError:
        local = host in ("", "localhost") or host.endswith(".localhost")
    return local, port


def aims_at_bridge(provider, bridge_url):
    """Whether a provider other than a subscription instance would reach a subscription bridge or carry its key: its
    name, its key variable, its base URL equal to a bridge's, or an on-machine URL on a bridge's port. bridge_url: one
    URL or a list of them (every configured bridge). Such an entry would bypass the owner gate (and, marked local, the
    local-only egress rule), so it is refused."""
    if is_subscription(provider.name) or provider.key_env in SUBSCRIPTION_KEY_ENVS:
        return True
    urls = [bridge_url] if isinstance(bridge_url, str) or bridge_url is None else list(bridge_url)
    for url in urls:
        if not url:
            continue
        if str(provider.base_url or "").strip().rstrip("/") == url.strip().rstrip("/"):
            return True
        mine, bridge = _endpoint(provider.base_url), _endpoint(url)
        if mine and bridge and mine[0] and mine[1] == bridge[1]:
            return True
    return False


def _subscription_provider(name):
    """A subscription instance's provider, only when <PREFIX>_URL is a literal-loopback bridge address
    (literal_loopback_url); else None (not configured; a malformed address too, never a failed start). Key: <PREFIX>_KEY.
    Models: <PREFIX>_MODELS, comma-separated. No prices: it is plan usage, never a money price (R3.1 §H)."""
    prefix = SUBSCRIPTIONS[name]
    url = subscription_env(name, "URL")
    if not url:
        return None
    if not literal_loopback_url(url):
        print(f"[hive] {prefix}_URL is not a literal-loopback bridge address: {name} route off", flush=True)
        return None
    models = [m.strip() for m in subscription_env(name, "MODELS").split(",") if m.strip()]
    return Provider(name, url, f"{prefix}_KEY", local=False, models=models)


def _subscription_cli_provider():
    """The subscription-cli provider (kept for callers of the single-instance name)."""
    return _subscription_provider(SUBSCRIPTION_CLI)


def _subscription_providers():
    """Every configured subscription instance, in SUBSCRIPTIONS order. Two instances on one bridge (the same address, or
    on-machine on the same port) would share one CLI under two day caps, so the later one is refused."""
    out = {}
    for name in SUBSCRIPTIONS:
        provider = _subscription_provider(name)
        if provider is None:
            continue
        clash = next((other for other in out.values()
                      if aims_at_bridge(dataclasses.replace(provider, name="", key_env=""), other.base_url)), None)
        if clash is not None:
            print(f"[hive] {name} would reach the same bridge as {clash.name}; {name} route off", flush=True)
            continue
        out[name] = provider
    return out


@dataclasses.dataclass
class Settings:
    data_dir: pathlib.Path
    admin_password: str
    public_url: str
    petta_path: str
    core_root: pathlib.Path
    default_driver: str
    providers: dict
    default_model: str
    embedding_model: str
    # Spend guards (docs/omegadots/DRIFT.md): a cap for the whole hive (0 = none)
    # and a per-agent ceiling on LLM calls per minute, which stops retry storms.
    hive_budget_usd: float = 0.0
    max_llm_calls_per_minute: int = 60
    allow_unpriced: bool = False
    # A claimed goal goes back to the swarm when its claimer stops renewing it.
    goal_lease_minutes: float = 60.0
    # Tests and air-gapped hives: never call out for provider catalogues at boot.
    offline: bool = False
    # Also serve everything under these prefixes (comma-separated, e.g. "/omegahive,/omegadot") so a
    # reverse proxy or tunnel can mount the hive beside other sites.  The root keeps working for agents.
    base_path: str = ""
    # Sub-motivations (Jon Q1): the parent_id shape ships, but every route refuses it until this is switched on.
    motivation_hierarchy: bool = False
    # Generic child spawning/resume requires HIVE_MIND_SPAWN=1. The separately
    # host-bound foundation team is checked by Minds; an explicit non-1 is a kill.
    # Operator templates still use HIVE_MIND_TEMPLATES, a JSON list.
    mind_spawn: bool = False
    # Presence of the existing flag with a non-1 value is an operator kill,
    # including for the host-bound foundation team. No new environment switch.
    mind_spawn_operator_off: bool = False
    mind_templates: list = dataclasses.field(default_factory=list)
    # Linkage slice 3 (PLATFORM_COPY_APPLY_AUTHORITY_ANSWER_20261007 §2): the controller's copy_apply purpose capability
    # and the held copy-apply relay entries stay off until the operator sets HIVE_COPY_APPLY_CLAIMS=on (launcher env file).
    copy_apply_claims: bool = False
    # Linkage slice 4 (linkage spec r3.6 §b): the controller's proposal_test purpose capability, its preparation binding and
    # its run-and-time holds stay off until the operator sets HIVE_PROPOSAL_TEST_CLAIMS=on (launcher env file, one source).
    # The claim's argv_prefixes are operator-configured (HIVE_PROPOSAL_TEST_ARGV_PREFIXES, a JSON list of argv prefixes);
    # with none configured, issuance stays off as well.
    proposal_test_claims: bool = False
    # Create - Code: the MeTTa coding controller (hive/core/code_controller_engine.py, reducer R3.11.5 root-suggest) runs
    # every new Code request; a model is called only where the reducer says think, and for review. On unless the operator
    # sets HIVE_CODE_CONTROLLER_ENGINE=0/off; off keeps the earlier controller-mind path (the receiving goal's brief) for
    # NEW requests. A request adopted while the switch was on keeps the engine's brief and its run: switching off later
    # neither wakes a controller mind for it nor re-briefs its goal (a person discards it, or it ends with its lease).
    code_controller_engine: bool = True
    # Create plans: the MeTTa plan controller R4.0 host engine (create_plan_engine.py). On in every install (Jon on #395:
    # "Create should be fully deployed and working from setup"); HIVE_CREATE_PLAN_ENGINE=off turns it off.
    create_plan_engine: bool = True
    # The spending settings this process found in its environment ({name: raw text}). They only seed a hive with no total
    # on the Limits page (Jon 2026-10-07, "they should match the number I set in the admin panel"); the limits API
    # reports each one (hive/core/budgets.py Budgets.server_settings).
    budget_env: dict = dataclasses.field(default_factory=dict)
    # The starting limit (Jon 2026-11-09): the hive month total set when an admin or the owner adds a key while nothing
    # governs a paid call yet (POST /api/keys), so the first paid call after a fresh install is admitted. Changeable on
    # the Limits page like any total; HIVE_START_LIMIT_MONTH_USD, default 50, 0 = never set one.
    start_limit_month_usd: float = START_LIMIT_DEFAULT_USD
    proposal_test_argv_prefixes: list = dataclasses.field(default_factory=list)
    # P1 media route (hive/core/media.py): POST /llm/v1/media exists only when the operator sets HIVE_MEDIA_ROUTE=on, and
    # sessions.end then also refuses while the mind runs (open liabilities refuse it always). Off by default: route absent (404).
    media_route: bool = False
    # Personal-mind gateway r1 (PLATFORM_PERSONAL_MIND_GATEWAY_R1_PLAN §2.4, §6): HIVE_MIND_GATEWAY=1 switches on the
    # gateway, the browser mind and (r1d) the frame header (hive/core/mind_frame.py). Off: every route behaves as before.
    mind_gateway: bool = False
    # media r2 P1-3 (HIVE_MEDIA_ALLOW): which minds may use each media op, as JSON {op: ["agent:a_…" | "swarm:s_…", ...]}.
    # Empty (the default), unreadable JSON or a malformed entry admits nobody; there is no wildcard. Skill policy still
    # applies to the minds named here.
    media_allow: dict = dataclasses.field(default_factory=dict)
    # media r2 P1-1 (HIVE_MEDIA_BREAKER_REFUSALS): billed_refused results in a row that pause a mind's media ops until an
    # admin resets its breaker (an overrun pauses it at once). At least 1; default 2.
    media_breaker_refusals: int = 2
    # Web tools (hive/core/webtools.py): POST /api/agent/web/search and /api/agent/web/fetch, host-side search and a vetted
    # https fetch for minds (a sandboxed mind reaches only the hive). On unless HIVE_WEB_TOOLS=off (routes then absent).
    web_tools: bool = True
    # Mac test hive restart prepare (Jon 2026-10-18): POST /api/local/restart-prepare, which asks awake minds to sleep once
    # before a restart, exists only when the launcher sets HIVE_RESTART_PREPARE=1. Off by default: route absent (404).
    restart_prepare: bool = False
    # Jon's second review (omega-flagship/omegahive#299, item 1): reboot-self runs sudo reboot, which restarts the whole
    # computer, so a mind may ask for it only where the launcher sets HIVE_EMBODIED_VM=1 because this computer is the
    # mind's own embodied VM. Off by default: the policy refuses reboot-self.
    embodied_vm: bool = False
    # Files (hive/core/assets.py, folders.py): the most one uploaded or written file may hold, in bytes
    # (HIVE_ASSET_MAX_BYTES). None (the default) = no cap on the local store; cloud stores keep their own limit.
    asset_max_bytes: int | None = None
    # The free-space floor (HIVE_MIN_FREE_GB, default 25): uploads and linked-folder writes are refused when they would
    # leave less than this free on the hive's disk. 0 = no floor.
    min_free_bytes: int = 25 * 1024 ** 3
    # The most one upload by a mind may hold (HIVE_MIND_UPLOAD_MAX_BYTES, default 2 GiB; 0 = no cap). People keep no cap
    # above the floor unless HIVE_ASSET_MAX_BYTES is set.
    mind_upload_max_bytes: int | None = 2 * 1024 ** 3
    # Linked folders through the public URL or a proxy (HIVE_LINKED_FOLDERS_REMOTE=on): off by default, so only requests
    # made on this machine reach them. Jon's decision to turn on.
    linked_folders_remote: bool = False
    # Where feedback and bug reports go (HIVE_FEEDBACK_TO; unset, the FEEDBACK_TO the release was built with, else the
    # team's feedback board): an https address of a GitHub repository is a board, any other https address a report
    # service, none no direct route (feedback.py configured, destination).
    feedback_to: str | None = None

    # Operator-only resource policy for Code's existing Linux sandbox owner.
    # These never turn on Linux admission; only actual runner-applied limits can.
    code_cgroup_service_unit: str = "omegahive.service"
    code_sandbox_memory_bytes: int | None = 1073741824
    code_sandbox_pids: int | None = 256
    code_sandbox_runtime_seconds: int | None = 120
    code_sandbox_swap_bytes: int = 0  # mandatory no-swap policy, not a request field
    # No automatic host/pool caps: the operator must select and qualify the
    # complete parent-charge/slack policy before Linux Code can bootstrap.
    code_sandbox_host_memory_bytes: int | None = None
    code_sandbox_host_memory_min_bytes: int | None = None
    code_sandbox_pool_memory_bytes: int | None = None
    code_sandbox_root_memory_reserve_bytes: int | None = None
    code_sandbox_kernel_slack_bytes: int | None = None
    code_sandbox_host_pids: int | None = None
    code_sandbox_pool_pids: int | None = None
    code_sandbox_root_pids_reserve: int | None = None

    @property
    def agents_dir(self):
        return self.data_dir / "agents"


def _load_providers():
    providers = {p.name: p for p in DEFAULT_PROVIDERS}
    free = _free_provider()
    if free is not None:
        providers[FREE] = free
    bridge = subscription_bridge_urls()
    path = os.environ.get("HIVE_PROVIDERS_FILE")
    if path and pathlib.Path(path).exists():
        for raw in json.loads(pathlib.Path(path).read_text()):
            provider = Provider(**raw)
            if aims_at_bridge(provider, bridge):
                print(f"[hive] providers file entry {provider.name!r} would reach the subscription bridge; refused "
                      "(subscription bridges are set from the environment only)", flush=True)
                continue
            if carries_free_key(provider):
                print(f"[hive] providers file entry {provider.name!r} would carry the free inference key outside its "
                      "remote route; refused", flush=True)
                continue
            providers[provider.name] = provider
    local_models = os.environ.get("HIVE_LOCAL_LLM_MODELS", "")
    if local_models:
        providers["local"].models = [m.strip() for m in local_models.split(",") if m.strip()]
    if bridge and aims_at_bridge(providers["local"], bridge):
        # the built-in local slot pointed at the bridge (both once defaulted to port 8000): it would pass the local-only
        # egress rule while the CLI sends the prompt off the machine, so it is left with no address
        print("[hive] HIVE_LOCAL_LLM_URL is a subscription bridge's address; the local provider is off", flush=True)
        providers["local"] = dataclasses.replace(providers["local"], base_url="", models=[])
    providers.update(_subscription_providers())
    return providers


MEDIA_ALLOW_ENTRY = re.compile(r"(agent:a_(?:[0-9a-f]{8}|[0-9a-f]{32})|swarm:s_(?:[0-9a-f]{8}|[0-9a-f]{32}))\Z")


def _media_allow():
    """HIVE_MEDIA_ALLOW: {op: [entries]}. Fails closed: anything unreadable admits nobody, a bad entry is dropped."""
    raw = os.environ.get("HIVE_MEDIA_ALLOW", "").strip()
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except ValueError:
        print("[hive] HIVE_MEDIA_ALLOW is not JSON: no mind may use a media op", flush=True)
        return {}
    if not isinstance(value, dict):
        return {}
    return {op: [n for n in names if isinstance(n, str) and MEDIA_ALLOW_ENTRY.match(n)]
            for op, names in value.items() if isinstance(op, str) and isinstance(names, list)}


def _media_breaker_refusals():
    try:
        return max(1, int(os.environ.get("HIVE_MEDIA_BREAKER_REFUSALS", "2") or 2))
    except ValueError:
        return 2


def _mind_templates():
    raw = os.environ.get("HIVE_MIND_TEMPLATES", "").strip()
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except ValueError:
        return []                      # unreadable: no templates, never a guess
    return value if isinstance(value, list) else []


def _argv_prefixes():
    """HIVE_PROPOSAL_TEST_ARGV_PREFIXES: a JSON list of non-empty argv prefixes (lists of non-empty strings); anything
    else is no prefixes at all, never a guess."""
    try:
        value = json.loads(os.environ.get("HIVE_PROPOSAL_TEST_ARGV_PREFIXES", "") or "[]")
    except ValueError:
        return []
    ok = isinstance(value, list) and len(value) <= 16 and all(
        isinstance(p, list) and 1 <= len(p) <= 32 and all(isinstance(a, str) and 0 < len(a) <= 512 for a in p) for p in value)
    return value if ok else []


def _code_resource_int(name, default):
    raw = os.environ.get(name)
    if raw is None:
        return default
    if type(raw) is not str or re.fullmatch(r"[0-9]{1,19}", raw) is None:
        return None  # invalid operator config is visible as unavailable, never guessed
    return int(raw)


def _note_retired():
    """Each retired spending setting (RETIRED_ENV) still in the environment, logged once per process: it does nothing."""
    for name in RETIRED_ENV:
        if os.environ.get(name, "").strip() and name not in _RETIRED_NOTED:
            _RETIRED_NOTED.add(name)
            logging.getLogger("hive.config").warning(
                "%s is retired and does nothing: a call is held by its payer's monthly allowance, the hive cap and the "
                "caps set on the Limits page", name)


def _start_limit():
    """HIVE_START_LIMIT_MONTH_USD: a dollar figure from 0 (off) to 1,000,000 (Budgets.set's bound). Anything else is the
    default ($50) with a warning at startup, never a guess at what was meant."""
    raw = os.environ.get("HIVE_START_LIMIT_MONTH_USD", "").strip()
    if not raw:
        return START_LIMIT_DEFAULT_USD
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if not math.isfinite(value) or value < 0 or value > 1_000_000:
        logging.getLogger("hive.config").warning(
            "HIVE_START_LIMIT_MONTH_USD=%r is not a dollar figure from 0 to 1000000; using the default %s",
            raw[:40], START_LIMIT_DEFAULT_USD)
        return START_LIMIT_DEFAULT_USD
    return value


def _asset_max_bytes():
    """HIVE_ASSET_MAX_BYTES: unset, empty or 0 = no cap. Anything that is not a whole number of bytes keeps the earlier
    100 MB cap with a warning (an operator who set something meant a cap), never no cap."""
    raw = os.environ.get("HIVE_ASSET_MAX_BYTES", "").strip()
    if not raw or raw == "0":
        return None
    if re.fullmatch(r"[0-9]{1,19}", raw) is None:
        logging.getLogger("hive.config").warning("HIVE_ASSET_MAX_BYTES=%r is not a number of bytes; using 104857600", raw[:40])
        return 100 * 1024 * 1024
    return int(raw)


def _min_free_bytes():
    """HIVE_MIN_FREE_GB: gigabytes (a number, 0 = no floor); anything else keeps the default 25 with a warning."""
    raw = os.environ.get("HIVE_MIN_FREE_GB", "").strip()
    if not raw:
        return 25 * 1024 ** 3
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if not math.isfinite(value) or value < 0:
        logging.getLogger("hive.config").warning("HIVE_MIN_FREE_GB=%r is not a number of gigabytes; using 25", raw[:40])
        return 25 * 1024 ** 3
    return int(value * 1024 ** 3)


def _mind_upload_max_bytes():
    """HIVE_MIND_UPLOAD_MAX_BYTES: bytes, 0 = no cap; unset or malformed = 2 GiB (malformed with a warning)."""
    raw = os.environ.get("HIVE_MIND_UPLOAD_MAX_BYTES", "").strip()
    if not raw:
        return 2 * 1024 ** 3
    if re.fullmatch(r"[0-9]{1,19}", raw) is None:
        logging.getLogger("hive.config").warning("HIVE_MIND_UPLOAD_MAX_BYTES=%r is not a number of bytes; using 2 GiB", raw[:40])
        return 2 * 1024 ** 3
    return int(raw) or None


def load_settings(**overrides) -> Settings:
    _note_retired()
    data_dir = pathlib.Path(os.environ.get("HIVE_DATA_DIR", pathlib.Path.home() / ".omegadots" / "hive"))
    values = dict(
        data_dir=data_dir,
        admin_password=os.environ.get("HIVE_ADMIN_PASSWORD", ""),
        public_url=os.environ.get("HIVE_PUBLIC_URL", "http://127.0.0.1:8700"),
        petta_path=os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa")),
        core_root=pathlib.Path(os.environ.get("HIVE_CORE_ROOT", CORE_ROOT)),
        default_driver=os.environ.get("HIVE_DRIVER", "local"),
        providers=_load_providers(),
        default_model=os.environ.get("HIVE_DEFAULT_MODEL", "mock/echo"),
        embedding_model=os.environ.get("HIVE_EMBEDDING_MODEL", "mock/hash"),
        hive_budget_usd=float(os.environ.get("HIVE_BUDGET_USD", "0") or 0),
        max_llm_calls_per_minute=int(os.environ.get("HIVE_MAX_LLM_CALLS_PER_MINUTE", "60") or 0),
        allow_unpriced=os.environ.get("HIVE_ALLOW_UNPRICED", "") == "1",
        goal_lease_minutes=float(os.environ.get("HIVE_GOAL_LEASE_MINUTES", "60") or 60),
        offline=os.environ.get("HIVE_OFFLINE", "") == "1",
        motivation_hierarchy=os.environ.get("HIVE_MOTIVATION_HIERARCHY", "") == "1",
        mind_spawn=os.environ.get("HIVE_MIND_SPAWN", "") == "1",
        mind_spawn_operator_off=("HIVE_MIND_SPAWN" in os.environ and os.environ["HIVE_MIND_SPAWN"] != "1"),
        mind_templates=_mind_templates(),
        copy_apply_claims=os.environ.get("HIVE_COPY_APPLY_CLAIMS", "") == "on",
        proposal_test_claims=os.environ.get("HIVE_PROPOSAL_TEST_CLAIMS", "") == "on",
        code_controller_engine=os.environ.get("HIVE_CODE_CONTROLLER_ENGINE", "on").strip().lower() in ("1", "on", "true", "yes"),
        create_plan_engine=os.environ.get("HIVE_CREATE_PLAN_ENGINE", "on").strip().lower() in ("1", "on", "true", "yes"),
        proposal_test_argv_prefixes=_argv_prefixes(),
        media_route=os.environ.get("HIVE_MEDIA_ROUTE", "") == "on",
        mind_gateway=os.environ.get("HIVE_MIND_GATEWAY", "") == "1",
        media_allow=_media_allow(),
        media_breaker_refusals=_media_breaker_refusals(),
        web_tools=os.environ.get("HIVE_WEB_TOOLS", "on").strip().lower() not in ("off", "0", "false", "no"),
        restart_prepare=os.environ.get("HIVE_RESTART_PREPARE", "") == "1",
        embodied_vm=os.environ.get("HIVE_EMBODIED_VM", "") == "1",
        asset_max_bytes=_asset_max_bytes(),
        min_free_bytes=_min_free_bytes(),
        mind_upload_max_bytes=_mind_upload_max_bytes(),
        linked_folders_remote=os.environ.get("HIVE_LINKED_FOLDERS_REMOTE", "off").strip().lower() == "on",
        feedback_to=os.environ.get("HIVE_FEEDBACK_TO"),
        code_cgroup_service_unit=os.environ.get("HIVE_CODE_CGROUP_SERVICE_UNIT", "omegahive.service"),
        code_sandbox_memory_bytes=_code_resource_int("HIVE_CODE_SANDBOX_MEMORY_BYTES", 1073741824),
        code_sandbox_pids=_code_resource_int("HIVE_CODE_SANDBOX_PIDS", 256),
        code_sandbox_runtime_seconds=_code_resource_int("HIVE_CODE_SANDBOX_RUNTIME_SECONDS", 120),
        code_sandbox_swap_bytes=0,
        code_sandbox_host_memory_bytes=_code_resource_int("HIVE_CODE_SANDBOX_HOST_MEMORY_BYTES", None),
        code_sandbox_host_memory_min_bytes=_code_resource_int("HIVE_CODE_SANDBOX_HOST_MEMORY_MIN_BYTES", None),
        code_sandbox_pool_memory_bytes=_code_resource_int("HIVE_CODE_SANDBOX_POOL_MEMORY_BYTES", None),
        code_sandbox_root_memory_reserve_bytes=_code_resource_int("HIVE_CODE_SANDBOX_ROOT_MEMORY_RESERVE_BYTES", None),
        code_sandbox_kernel_slack_bytes=_code_resource_int("HIVE_CODE_SANDBOX_KERNEL_SLACK_BYTES", None),
        code_sandbox_host_pids=_code_resource_int("HIVE_CODE_SANDBOX_HOST_PIDS", None),
        code_sandbox_pool_pids=_code_resource_int("HIVE_CODE_SANDBOX_POOL_PIDS", None),
        code_sandbox_root_pids_reserve=_code_resource_int("HIVE_CODE_SANDBOX_ROOT_PIDS_RESERVE", None),
        budget_env={k: os.environ[k] for k in BUDGET_ENV if os.environ.get(k, "").strip()},
        start_limit_month_usd=_start_limit(),
        base_path=",".join("/" + p.strip("/") for p in os.environ.get("HIVE_BASE_PATH", "").split(",") if p.strip("/")),
    )
    values.update(overrides)
    settings = Settings(**values)
    settings.data_dir = pathlib.Path(settings.data_dir)
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.agents_dir.mkdir(parents=True, exist_ok=True)
    return settings
