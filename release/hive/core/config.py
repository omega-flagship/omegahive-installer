"""Hive configuration from the environment (and an optional providers file)."""

from __future__ import annotations

import dataclasses
import ipaddress
import json
import os
import pathlib
import re
from urllib.parse import urlsplit

CORE_ROOT = pathlib.Path(__file__).resolve().parents[2]

BUDGET_ENV = ("HIVE_BUDGET_USD", "HIVE_SWARM_MONTHLY_USD", "HIVE_PERSON_REQUEST_CEILING_USD", "HIVE_MEMBER_MONTHLY_USD",
              "HIVE_ASK_CONDUCTOR_TURN_USD")


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
]


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
    # Default spending limit for every swarm per calendar month (UTC), unless a swarm has its own
    # rule (hive/core/budgets.py).  0 = none.
    swarm_monthly_usd: float = 500.0
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
    # r2.13: the most one person's instruction request may carry (HIVE_PERSON_REQUEST_CEILING_USD).
    person_request_ceiling_usd: float = 1.0
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
    # Create plans: the MeTTa plan controller R4.0 host engine (create_plan_engine.py). Off until reviewed and deployed.
    create_plan_engine: bool = False
    # The spending settings this process found in its environment ({name: raw text}). They only seed a hive with no total
    # on the Limits page (Jon 2026-10-07, "they should match the number I set in the admin panel"); the limits API
    # reports each one (hive/core/budgets.py Budgets.server_settings).
    budget_env: dict = dataclasses.field(default_factory=dict)
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
    # Mac test hive restart prepare (Jon 2026-10-18): POST /api/local/restart-prepare, which asks awake minds to sleep once
    # before a restart, exists only when the launcher sets HIVE_RESTART_PREPARE=1. Off by default: route absent (404).
    restart_prepare: bool = False

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
    bridge = subscription_bridge_urls()
    path = os.environ.get("HIVE_PROVIDERS_FILE")
    if path and pathlib.Path(path).exists():
        for raw in json.loads(pathlib.Path(path).read_text()):
            provider = Provider(**raw)
            if aims_at_bridge(provider, bridge):
                print(f"[hive] providers file entry {provider.name!r} would reach the subscription bridge; refused "
                      "(subscription bridges are set from the environment only)", flush=True)
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


def load_settings(**overrides) -> Settings:
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
        swarm_monthly_usd=float(os.environ.get("HIVE_SWARM_MONTHLY_USD", "500") or 0),
        motivation_hierarchy=os.environ.get("HIVE_MOTIVATION_HIERARCHY", "") == "1",
        mind_spawn=os.environ.get("HIVE_MIND_SPAWN", "") == "1",
        mind_spawn_operator_off=("HIVE_MIND_SPAWN" in os.environ and os.environ["HIVE_MIND_SPAWN"] != "1"),
        mind_templates=_mind_templates(),
        person_request_ceiling_usd=float(os.environ.get("HIVE_PERSON_REQUEST_CEILING_USD", "1.00") or 0),
        copy_apply_claims=os.environ.get("HIVE_COPY_APPLY_CLAIMS", "") == "on",
        proposal_test_claims=os.environ.get("HIVE_PROPOSAL_TEST_CLAIMS", "") == "on",
        code_controller_engine=os.environ.get("HIVE_CODE_CONTROLLER_ENGINE", "on").strip().lower() in ("1", "on", "true", "yes"),
        create_plan_engine=os.environ.get("HIVE_CREATE_PLAN_ENGINE", "off").strip().lower() in ("1", "on", "true", "yes"),
        proposal_test_argv_prefixes=_argv_prefixes(),
        media_route=os.environ.get("HIVE_MEDIA_ROUTE", "") == "on",
        mind_gateway=os.environ.get("HIVE_MIND_GATEWAY", "") == "1",
        media_allow=_media_allow(),
        media_breaker_refusals=_media_breaker_refusals(),
        restart_prepare=os.environ.get("HIVE_RESTART_PREPARE", "") == "1",
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
        base_path=",".join("/" + p.strip("/") for p in os.environ.get("HIVE_BASE_PATH", "").split(",") if p.strip("/")),
    )
    values.update(overrides)
    settings = Settings(**values)
    settings.data_dir = pathlib.Path(settings.data_dir)
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.agents_dir.mkdir(parents=True, exist_ok=True)
    return settings
