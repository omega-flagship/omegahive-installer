# Purpose: the hive's API as its callers depend on it once the UI is its own image (omega-flagship/omegahive#674): the
# API version the UI states it needs, the five path prefixes the hive answers behind the proxy, and the OpenAPI document
# committed as hive/api/openapi.json. hive/tests/test_api_contract.py fails when any of them drifts.
"""The hive's API contract (omegahive#674).

HIVE_API_VERSION is the version of the hive's HTTP API, MAJOR.MINOR: MAJOR goes up on a change that breaks a caller,
MINOR on an addition. It is the FastAPI app's version, so it is the `info.version` of the OpenAPI document. The UI
(omega-flagship/omegahive-ui) states the MAJOR.MINOR it needs, and the deploy manifest refuses a UI whose need the
pinned hive does not meet (same MAJOR, hive MINOR at least the UI's).

hive/api/openapi.json is that document, generated from the app and committed, so a change to the API shows in the diff
of the pull request that makes it. Regenerate it with:

    HIVE_OPENAPI_WRITE=1 python -m pytest hive/tests/test_api_contract.py -k committed

under hive/ci-constraints.txt (another FastAPI or pydantic renders the same routes differently).

HIVE_PREFIXES are the only paths the hive serves its API under. With the UI split out, the proxy sends exactly these to
the hive and the rest of the site to the UI, so a route outside them is unreachable behind the proxy until the proxy's
matcher (CADDY_MATCHER) names it too. The page routes the hive still adds when it is built with hive/ui/dist (dev and
the installers run one process) are the one exception: behind the proxy the UI container answers those paths.
"""
import json
import re

HIVE_API_VERSION = "1.1"

HIVE_PREFIXES = ("/api", "/llm", "/agent-hub", "/mcp", "/flow-studio")

# Where the proxy names the hive's prefixes: the one place to change with HIVE_PREFIXES.
CADDY_MATCHER = ("the hive's path matcher in the nostr-relay Caddyfile (gitlab.com/nunet/applications/tools/"
                 "nostr-relay; `@omegahive path /staging /staging/*` before the /staging split, after it the matcher "
                 "that sends /staging/{api,llm,agent-hub,mcp,flow-studio} to omegahive:8700)")


def under_prefixes(path: str) -> bool:
    """Whether a route path (as the app registers it, before any base path) is one of HIVE_PREFIXES or under one."""
    return any(path == prefix or path.startswith(prefix + "/") for prefix in HIVE_PREFIXES)


def top_segment_is_prefix(path: str) -> bool:
    """The same test for a request path without its leading slash, as the page catch-all sees it ("api/x")."""
    return "/" + path.split("/", 1)[0] in HIVE_PREFIXES


def operation_id(route) -> str:
    """FastAPI's own operation id (fastapi.utils.generate_unique_id), but with the first of a route's methods in sorted
    order. FastAPI takes the first of a set, whose order changes with the process's hash seed, so a route with several
    methods (/mcp) would give the committed document a different id on every other run."""
    name = re.sub(r"\W", "_", f"{route.name}{route.path_format}")
    return f"{name}_{sorted(route.methods)[0].lower()}"


def openapi_text(app) -> str:
    """The app's OpenAPI document as hive/api/openapi.json holds it: keys sorted, two-space indent, one final newline."""
    return json.dumps(app.openapi(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
