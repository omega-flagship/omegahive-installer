"""Web tools (hive/core/webtools.py): host-side web search and a vetted https fetch for minds.

No network: every test runs under deny_network, with a fake resolver, a fake connector (it records the address each
hop connects to) and a fake search provider. Synthetic data, in-process hive, disposable data directories."""
import contextlib
import importlib.util
import json
import pathlib
import tempfile
import urllib.request

import httpx
import pytest
from fastapi.testclient import TestClient

from hive.core import run_backends, webtools
from hive.core.app import create_app
from hive.core.config import load_settings
from hive.core.webtools import BODY_CAP, HttpxConnector, address_refusal
from hive.tests.test_core_api import PETTA, FakeSupervisor, agent_headers, make_swarm_and_agents

ROOT = pathlib.Path(__file__).resolve().parents[2]
PUBLIC = "93.184.216.34"
PUBLIC6 = "2606:4700:4700::1111"
MARKER = "INVENTED-PAGE-BODY-7f3a"


@pytest.fixture(autouse=True)
def _no_network(deny_network):
    yield


class Resolver:
    """host -> list of answers; a list of lists answers each call in turn (the last one repeats)."""

    def __init__(self, table=None):
        self.table, self.calls = dict(table or {}), []

    async def __call__(self, host):
        self.calls.append(host)
        answer = self.table.get(host)
        if answer is None:
            raise OSError("no such name")
        if answer and isinstance(answer[0], list):
            index = min(self.calls.count(host) - 1, len(answer) - 1)
            return answer[index]
        return answer


class Site:
    """(host, target) -> (status, headers, body). A missing robots.txt is a 404 (allow all)."""

    def __init__(self):
        self.pages, self.connects = {}, []

    def page(self, host, target, body=b"", status=200, ctype="text/html; charset=utf-8", **headers):
        hdrs = {"content-type": ctype, **{k.replace("_", "-"): v for k, v in headers.items()}}
        self.pages[(host, target)] = (status, hdrs, body)

    def redirect(self, host, target, location, status=302):
        self.pages[(host, target)] = (status, {"location": location}, b"")

    @contextlib.asynccontextmanager
    async def stream(self, ip, host, target, headers, timeout):
        self.connects.append({"ip": ip, "host": host, "target": target, "headers": dict(headers)})
        status, hdrs, body = self.pages.get((host, target), (404, {"content-type": "text/plain"}, b"not here"))

        async def chunks():
            for i in range(0, len(body), 65536):
                yield body[i:i + 65536]
        yield status, hdrs, chunks()

    def page_connects(self):
        return [c for c in self.connects if c["target"] != "/robots.txt"]


class Provider(webtools.SearchProvider):
    name, label, cost_usd = "fake", "an invented search service", 0.0

    def __init__(self):
        self.calls, self.fail = [], None

    def search(self, query, max_results):
        self.calls.append((query, max_results))
        if self.fail:
            raise self.fail
        return [{"title": "Cepheid variables", "url": "https://example.org/cepheids", "snippet": "Period and luminosity."},
                {"title": "not a web link", "url": "ftp://example.org/x", "snippet": "dropped"}][:max_results]


HTML = (b"<html><head><title>Invented Page</title><style>.x{color:red}</style><script>var secret=1;</script></head>"
        b"<body><nav>Menu Home About</nav><h1>Heading</h1><p>First paragraph " + MARKER.encode() + b".</p>"
        b"<p>Second &amp; last.</p><footer>Footer links</footer></body></html>")


def _app(**overrides):
    settings = load_settings(data_dir=pathlib.Path(tempfile.mkdtemp(prefix="hive-web-")), admin_password="pw",
                             petta_path=PETTA, offline=True, **overrides)
    return create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)


@pytest.fixture
def w():
    app = _app()
    with TestClient(app) as c:
        token = c.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        c.headers["Authorization"] = f"Bearer {token}"
        tools = app.state.web_tools
        c.tools, c.hive = tools, app.state.hive
        c.site, c.resolver, c.provider = Site(), Resolver({"example.org": [PUBLIC], "www.example.org": [PUBLIC]}), Provider()
        tools.connector, tools.resolver, tools.provider = c.site, c.resolver, c.provider
        _swarm, (c.mind,) = make_swarm_and_agents(c, n=1)
        c.site.page("example.org", "/page", HTML)
        yield c


def fetch(c, url, **extra):
    return c.post("/api/agent/web/fetch", headers=agent_headers(c.mind), json={"url": url, **extra})


def search(c, query, **extra):
    return c.post("/api/agent/web/search", headers=agent_headers(c.mind), json={"query": query, **extra})


def message(response):
    return response.json()["error"]["message"]


# ---- the address rules ----------------------------------------------------------------------------------------------

REFUSED = ["127.0.0.1", "127.8.9.10", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "169.254.1.1",
           "100.64.0.1", "100.100.100.200", "224.0.0.1", "239.255.255.250", "0.0.0.0", "240.0.0.1", "255.255.255.255",
           "192.0.0.192", "168.63.129.16", "198.18.0.1", "192.0.2.1", "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254",
           "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
           "2002:7f00:1::1", "64:ff9b::a9fe:a9fe", "64:ff9b::7f00:1", "fe80::1%en0", "not-an-address",
           "fec0::1", "fec0:1:2::3"]


@pytest.mark.parametrize("address", REFUSED)
def test_every_non_public_address_class_is_refused(address):
    assert address_refusal(address)


@pytest.mark.parametrize("address", [PUBLIC, "1.1.1.1", PUBLIC6, "::ffff:93.184.216.34"])
def test_public_addresses_pass(address):
    assert address_refusal(address) is None


def test_refusals_name_the_class_in_plain_words():
    assert "metadata" in address_refusal("169.254.169.254")
    assert "loopback" in address_refusal("::ffff:127.0.0.1")
    assert "carrier-grade" in address_refusal("100.64.0.1")


@pytest.mark.parametrize("address", ["127.0.0.1", "10.0.0.5", "169.254.169.254", "100.64.1.1", "::1", "fd12::1",
                                     "::ffff:127.0.0.1", "224.0.0.251"])
def test_a_name_that_resolves_to_a_refused_address_is_never_connected(w, address):
    w.resolver.table["inner.example.org"] = [address]
    r = fetch(w, "https://inner.example.org/x")
    assert r.status_code == 403
    assert message(r) == "inner.example.org could not be reached as a public web address"
    assert w.site.connects == []
    assert address in w.tools.audit(w.mind["id"])[0]["reason"]          # admins see why; the mind does not


@pytest.mark.parametrize("url", ["https://127.0.0.1/", "https://[::1]/", "https://169.254.169.254/latest/meta-data/",
                                 "https://[::ffff:127.0.0.1]/", "https://localhost/", "https://printer.local/",
                                 "https://metadata.google.internal/", "https://intranet/"])
def test_address_and_local_name_literals_are_refused_without_resolving(w, url):
    r = fetch(w, url)
    assert r.status_code == 403
    assert w.site.connects == [] and w.resolver.calls == []


def test_one_private_answer_among_public_ones_refuses(w):
    w.resolver.table["mixed.example.org"] = [PUBLIC, "10.0.0.7"]
    assert fetch(w, "https://mixed.example.org/").status_code == 403
    assert w.site.connects == []


# ---- the fetch ------------------------------------------------------------------------------------------------------

def test_fetch_returns_readable_text_title_final_url_time_and_type(w):
    r = fetch(w, "https://example.org/page")
    assert r.status_code == 200, r.text
    page = r.json()
    assert page["title"] == "Invented Page"
    assert page["final_url"] == "https://example.org/page"
    assert page["content_type"] == "text/html"
    assert page["fetched_at"].endswith("Z") and "T" in page["fetched_at"]
    assert "First paragraph" in page["text"] and "Second & last." in page["text"]
    for dropped in ("var secret", "color:red", "Menu Home", "Footer links"):
        assert dropped not in page["text"]
    assert page["redirects"] == 0 and page["truncated"] is False


def test_fetch_connects_to_the_vetted_address_with_the_real_name(w):
    fetch(w, "https://example.org/page")
    hops = w.site.page_connects()
    assert [(h["ip"], h["host"], h["target"]) for h in hops] == [(PUBLIC, "example.org", "/page")]
    assert "OmegaHive" in hops[0]["headers"]["User-Agent"]


def test_dns_rebinding_cannot_move_the_connection(w):
    """The name answers public first and private on every later lookup: it is resolved once per fetch, robots.txt and
    the page both go to the address that was vetted, and nothing resolves it again."""
    w.resolver.table["rebind.example.org"] = [[PUBLIC], ["127.0.0.1"]]
    w.site.page("rebind.example.org", "/", HTML)
    r = fetch(w, "https://rebind.example.org/")
    assert r.status_code == 200, r.text
    assert w.resolver.calls == ["rebind.example.org"]
    assert {c["ip"] for c in w.site.connects} == {PUBLIC}
    # the next fetch resolves afresh, gets the private answer and is refused before any connection
    before = len(w.site.connects)
    assert fetch(w, "https://rebind.example.org/").status_code == 403
    assert len(w.site.connects) == before


def test_http_is_refused(w):
    r = fetch(w, "http://example.org/page")
    assert r.status_code == 403 and "only https" in message(r)
    assert w.site.connects == []


@pytest.mark.parametrize("url", ["https://user:pw@example.org/", "https://example.org:8443/", "ftp://example.org/",
                                 "file:///etc/passwd"])
def test_other_unsafe_urls_are_refused(w, url):
    assert fetch(w, url).status_code == 403
    assert w.site.connects == []


def test_redirect_to_cloud_metadata_is_refused(w):
    w.site.redirect("example.org", "/go", "https://169.254.169.254/latest/meta-data/")
    r = fetch(w, "https://example.org/go")
    assert r.status_code == 403 and "could not be reached" in message(r)
    assert "metadata" in w.tools.audit(w.mind["id"])[0]["reason"]
    assert all(c["ip"] == PUBLIC for c in w.site.connects)


def test_redirect_to_ipv4_mapped_loopback_is_refused(w):
    w.site.redirect("example.org", "/go", "https://[::ffff:127.0.0.1]/admin")
    r = fetch(w, "https://example.org/go")
    assert r.status_code == 403 and "could not be reached" in message(r)
    assert "loopback" in w.tools.audit(w.mind["id"])[0]["reason"]
    w.resolver.table["sneaky.example.org"] = ["::ffff:127.0.0.1"]
    w.site.redirect("example.org", "/go2", "https://sneaky.example.org/")
    assert fetch(w, "https://example.org/go2").status_code == 403
    assert all(c["ip"] == PUBLIC for c in w.site.connects)


def test_redirect_to_http_is_refused(w):
    w.site.redirect("example.org", "/go", "http://example.org/page")
    assert fetch(w, "https://example.org/go").status_code == 403


def test_relative_redirects_are_followed_and_reported(w):
    w.site.redirect("example.org", "/old", "/page", status=301)
    page = fetch(w, "https://example.org/old").json()
    assert page["final_url"] == "https://example.org/page" and page["redirects"] == 1


def test_at_most_five_redirects(w):
    for i in range(6):
        w.site.redirect("example.org", f"/r{i}", f"/r{i + 1}")
    w.site.page("example.org", "/r6", HTML)
    assert fetch(w, "https://example.org/r0").status_code == 403         # six hops
    r = fetch(w, "https://example.org/r1")                                 # five hops
    assert r.status_code == 200 and r.json()["redirects"] == 5


def test_body_over_the_cap_is_cut_at_two_megabytes(w):
    w.site.page("example.org", "/big", b"a" * (BODY_CAP + 500_000), ctype="text/plain")
    page = fetch(w, "https://example.org/big", max_chars=200_000).json()
    assert page["truncated"] is True and page["bytes"] == BODY_CAP
    row = w.tools.audit(w.mind["id"])[0]
    assert row["bytes"] == BODY_CAP


def test_a_pdf_over_the_cap_is_refused(w):
    w.site.page("example.org", "/big.pdf", b"%PDF-1.4" + b"0" * BODY_CAP, ctype="application/pdf")
    r = fetch(w, "https://example.org/big.pdf")
    assert r.status_code == 413 and "larger than 2 MB" in message(r)


def test_unsupported_types_are_refused_plainly(w):
    w.site.page("example.org", "/pic", b"\x89PNG", ctype="image/png")
    r = fetch(w, "https://example.org/pic")
    assert r.status_code == 415 and "image/png" in message(r) and "PDF" in message(r)


def test_plain_text_and_json_are_read_as_text(w):
    w.site.page("example.org", "/t", b"hello plain", ctype="text/plain")
    w.site.page("example.org", "/j", b'{"a": 1}', ctype="application/json")
    assert fetch(w, "https://example.org/t").json()["text"] == "hello plain"
    assert fetch(w, "https://example.org/j").json()["text"] == '{"a": 1}'


def test_a_site_error_is_reported_with_its_status(w):
    r = fetch(w, "https://example.org/missing")
    assert r.status_code == 502 and "404" in message(r)


# ---- robots.txt -----------------------------------------------------------------------------------------------------

def test_robots_disallow_is_honoured(w):
    w.site.page("example.org", "/robots.txt", b"User-agent: *\nDisallow: /private/\n", ctype="text/plain")
    w.site.page("example.org", "/private/a", HTML)
    r = fetch(w, "https://example.org/private/a")
    assert r.status_code == 403 and "robots.txt" in message(r)
    assert fetch(w, "https://example.org/page").status_code == 200
    assert [c["target"] for c in w.site.connects].count("/robots.txt") == 1      # cached


def test_robots_is_checked_on_the_redirect_target(w):
    w.site.page("example.org", "/robots.txt", b"User-agent: OmegaHive\nDisallow: /page\n", ctype="text/plain")
    w.site.redirect("example.org", "/go", "/page")
    assert fetch(w, "https://example.org/go").status_code == 403


def test_unreachable_robots_disallows(w):
    w.site.page("example.org", "/robots.txt", b"oops", status=503, ctype="text/plain")
    assert fetch(w, "https://example.org/page").status_code == 403


# ---- host lists -----------------------------------------------------------------------------------------------------

def test_admin_denylist_and_allowlist(w):
    assert w.get("/api/web/settings").json()["deny"] == []
    assert w.put("/api/web/settings", json={"deny": ["example.org"]}).status_code == 200
    r = fetch(w, "https://www.example.org/page")
    assert r.status_code == 403 and "may not fetch" in message(r)
    w.put("/api/web/settings", json={"deny": [], "allow": ["other.example"]})
    assert fetch(w, "https://example.org/page").status_code == 403
    w.put("/api/web/settings", json={"allow": ["example.org"]})
    assert fetch(w, "https://example.org/page").status_code == 200
    assert w.put("/api/web/settings", json={"deny": ["not a host!"]}).status_code == 400
    assert w.get("/api/web/settings", headers=agent_headers(w.mind)).status_code in (401, 403)


def test_a_redirect_to_a_denied_host_is_refused(w):
    w.put("/api/web/settings", json={"deny": ["bad.example"]})
    w.resolver.table["bad.example"] = [PUBLIC]
    w.site.redirect("example.org", "/go", "https://bad.example/")
    assert fetch(w, "https://example.org/go").status_code == 403


def test_host_lists_seed_from_the_environment(monkeypatch):
    monkeypatch.setenv("HIVE_WEB_DENY", "a.example, b.example")
    app = _app()
    with TestClient(app):
        assert app.state.web_tools.settings()["deny"] == ["a.example", "b.example"]


# ---- limits ---------------------------------------------------------------------------------------------------------

def test_per_turn_fetch_cap_and_a_model_call_starts_a_new_turn(w, monkeypatch):
    monkeypatch.setenv("HIVE_WEB_TURN_MAX_FETCHES", "2")
    assert fetch(w, "https://example.org/page").status_code == 200
    assert fetch(w, "https://example.org/page").status_code == 200
    r = fetch(w, "https://example.org/page")
    assert r.status_code == 429 and "this turn has used its 2 web fetches" in message(r)
    turn = w.tools.turn_label(w.mind["id"])
    chat = w.post("/llm/v1/chat/completions", headers=agent_headers(w.mind),
                  json={"messages": [{"role": "user", "content": "hello"}]})
    assert chat.status_code == 200, chat.text
    assert w.tools.turn_label(w.mind["id"]) != turn
    assert fetch(w, "https://example.org/page").status_code == 200


def test_per_turn_search_cap(w, monkeypatch):
    monkeypatch.setenv("HIVE_WEB_TURN_MAX_SEARCHES", "1")
    assert search(w, "cepheids").status_code == 200
    assert search(w, "cepheids").status_code == 429
    w.tools.new_turn(w.mind["id"])
    assert search(w, "cepheids").status_code == 200


def test_a_used_up_budget_refuses_plainly(w):
    w.hive.db.execute("UPDATE agents SET budget_usd = 1.0, spent_usd = 1.0 WHERE id = ?", (w.mind["id"],))
    r = fetch(w, "https://example.org/page")
    assert r.status_code == 402 and "budget" in message(r)
    assert search(w, "x").status_code == 402


def test_a_used_up_monthly_limit_refuses(w):
    w.hive.budgets.set(f"agent:{w.mind['id']}", "month", 0.5)
    w.hive.db.execute("UPDATE agents SET budget_usd = 0 WHERE id = ?", (w.mind["id"],))
    w.hive.db.insert("usage", {"agent_id": w.mind["id"], "model": "mock/echo", "prompt_tokens": 1, "completion_tokens": 1,
                               "cost_usd": 0.6, "created_at": webtools.now(), "payer": "hive"})
    r = fetch(w, "https://example.org/page")
    assert r.status_code == 402 and "limit is used up" in message(r)


def test_breaker_opens_after_safety_refusals_and_an_admin_resets_it(w, monkeypatch):
    monkeypatch.setenv("HIVE_WEB_BREAKER_REFUSALS", "2")
    w.resolver.table["inner.example.org"] = ["10.0.0.1"]
    assert fetch(w, "https://inner.example.org/").status_code == 403
    r = fetch(w, "https://inner.example.org/")
    assert r.status_code == 403 and "paused" in message(r)
    r = fetch(w, "https://example.org/page")
    assert r.status_code == 423 and "until an admin resets it" in message(r)
    assert search(w, "x").status_code == 423
    assert w.get("/api/web/breakers").json()[0]["tripped_at"]
    assert w.post(f"/api/web/breakers/{w.mind['id']}/reset", json={}).status_code == 400
    assert w.post(f"/api/web/breakers/{w.mind['id']}/reset", json={"reason": "checked the mind"}).status_code == 200
    assert fetch(w, "https://example.org/page").status_code == 200


def test_breaker_counts_refusals_in_a_window_even_between_good_fetches(w, monkeypatch):
    """Review 10: a good fetch between probes used to clear the count, so the breaker never opened."""
    monkeypatch.setenv("HIVE_WEB_BREAKER_REFUSALS", "3")
    w.resolver.table["inner.example.org"] = ["10.0.0.1"]
    for _ in range(2):
        assert fetch(w, "https://inner.example.org/").status_code == 403
        assert fetch(w, "https://example.org/page").status_code == 200
    assert fetch(w, "https://inner.example.org/").status_code == 403
    assert fetch(w, "https://example.org/page").status_code == 423


def test_breaker_window_forgets_old_refusals(w, monkeypatch):
    monkeypatch.setenv("HIVE_WEB_BREAKER_REFUSALS", "2")
    assert fetch(w, "http://example.org/").status_code == 403
    w.hive.db.execute("UPDATE web_strikes SET at = at - 3600")              # an hour ago: outside the window
    assert fetch(w, "http://example.org/").status_code == 403
    assert fetch(w, "https://example.org/page").status_code == 200


def test_robots_disallow_never_counts_toward_the_breaker(w, monkeypatch):
    """Review 10: a third-party site's robots.txt could pause a mind."""
    monkeypatch.setenv("HIVE_WEB_BREAKER_REFUSALS", "2")
    monkeypatch.setenv("HIVE_WEB_TURN_MAX_FETCHES", "50")
    w.site.page("example.org", "/robots.txt", b"User-agent: *\nDisallow: /private/\n", ctype="text/plain")
    for _ in range(4):
        assert fetch(w, "https://example.org/private/x").status_code == 403
    assert fetch(w, "https://example.org/page").status_code == 200


# ---- audit ----------------------------------------------------------------------------------------------------------

def test_audit_keeps_urls_status_bytes_mind_and_turn_but_never_the_body(w):
    w.site.redirect("example.org", "/old", "/page")
    fetch(w, "https://example.org/old")
    fetch(w, "http://example.org/x")
    search(w, "cepheids")
    rows = w.get("/api/web/audit").json()
    assert [r["tool"] for r in rows] == ["search", "fetch", "fetch"]
    ok = rows[2]
    assert ok["outcome"] == "ok" and ok["status"] == 200 and ok["bytes"] == len(HTML)
    assert ok["urls"] == ["https://example.org/old", "https://example.org/page"]
    assert ok["final_url"] == "https://example.org/page" and ok["agent_id"] == w.mind["id"] and ok["turn"]
    assert rows[1]["outcome"] == "refused" and "https" in rows[1]["reason"]
    assert rows[0]["query"] == "cepheids" and rows[0]["results"] == 1
    dump = json.dumps(rows) + json.dumps([dict(r) for r in w.hive.db.all("SELECT * FROM web_audit")])
    assert MARKER not in dump and "First paragraph" not in dump
    columns = {r["name"] for r in w.hive.db.all("PRAGMA table_info(web_audit)")}
    assert not columns & {"body", "text", "content"}


def test_audit_is_admin_only(w):
    assert w.get("/api/web/audit", headers=agent_headers(w.mind)).status_code in (401, 403)


# ---- search ---------------------------------------------------------------------------------------------------------

def test_search_through_the_provider(w):
    r = search(w, "  cepheid   variables ", max_results=5)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["results"] == [{"title": "Cepheid variables", "url": "https://example.org/cepheids",
                                "snippet": "Period and luminosity."}]
    assert body["provider"] == "an invented search service" and body["searched_at"].endswith("Z")
    assert w.provider.calls == [("cepheid variables", 5)]


def test_search_failure_is_plain(w):
    w.provider.fail = RuntimeError("upstream exploded")
    r = search(w, "x")
    assert r.status_code == 502 and "could not answer" in message(r) and "exploded" not in message(r)


def test_search_validates_its_request(w):
    assert search(w, "").status_code == 400
    assert search(w, "x", max_results=99).status_code == 400
    assert search(w, "x" * 500).status_code == 400
    assert w.post("/api/agent/web/search", json={"query": "x"}).status_code == 401   # an admin session is not a mind


def test_the_default_provider_is_ddgs_and_keeps_no_key_on_the_mind():
    assert isinstance(webtools.default_provider(), webtools.DdgsProvider)
    assert "TAVILY" not in (ROOT / "modules/web_search/entry.metta").read_text()
    assert "TAVILY" not in (ROOT / "modules/web_search/module.toml").read_text()


def test_routes_are_absent_when_switched_off():
    app = _app(web_tools=False)
    with TestClient(app) as c:
        assert c.post("/api/agent/web/fetch", json={"url": "https://example.org/"}).status_code in (404, 405)
        assert not hasattr(app.state, "web_tools")


# ---- the real connector ---------------------------------------------------------------------------------------------

def test_the_connector_dials_the_ip_literal_with_host_and_sni(monkeypatch):
    seen = {}

    async def send(self, request, **kwargs):
        seen.update(url=str(request.url), host=request.headers.get("host"), sni=request.extensions.get("sni_hostname"),
                    trust_env=self._trust_env, follow=self.follow_redirects)
        return httpx.Response(200, headers={"content-type": "text/plain"}, stream=httpx.ByteStream(b"ok"), request=request)
    monkeypatch.setattr(httpx.AsyncClient, "send", send)

    async def run(ip, host):
        async with HttpxConnector().stream(ip, host, "/a?b=1", {"User-Agent": "t"}, 5) as (status, headers, chunks):
            return status, b"".join([c async for c in chunks])
    import asyncio
    assert asyncio.run(run(PUBLIC, "example.org")) == (200, b"ok")
    assert seen == {"url": f"https://{PUBLIC}/a?b=1", "host": "example.org", "sni": "example.org", "trust_env": False,
                    "follow": False}
    asyncio.run(run(PUBLIC6, "example.org"))
    assert seen["url"] == f"https://[{PUBLIC6}]/a?b=1"
    with pytest.raises(webtools.WebError):
        asyncio.run(run("127.0.0.1", "example.org"))


# ---- the mind side --------------------------------------------------------------------------------------------------

def _load(name, rel):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Answer:
    def __init__(self, payload):
        self.payload = payload

    def read(self):
        return json.dumps(self.payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_mind_side_skills_call_only_the_hive(monkeypatch):
    hive_web = _load("hive_web_under_test", "modules/web_search/src/hive_web.py")
    monkeypatch.setenv("HIVE_API_URL", "http://127.0.0.1:8700")
    monkeypatch.setenv("HIVE_WS_TOKEN", "invented-token")
    calls = []

    def urlopen(request, timeout=None):
        calls.append((request.full_url, request.get_method(), json.loads(request.data), request.headers.get("Authorization")))
        if request.full_url.endswith("/search"):
            return _Answer({"results": [{"title": "T", "url": "https://example.org/a", "snippet": "S"}]})
        return _Answer({"final_url": "https://example.org/a", "fetched_at": "2026-11-10T00:00:00Z",
                        "content_type": "text/html", "title": "T", "text": "body text", "truncated": False})
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    assert hive_web.search('"cepheids"') == "((TITLE: T URL: https://example.org/a SNIPPET: S) )"
    out = hive_web.fetch("https://example.org/a")
    assert out.startswith("WEB-FETCH url=https://example.org/a fetched_at=2026-11-10T00:00:00Z") and out.endswith("body text")
    assert [c[0] for c in calls] == ["http://127.0.0.1:8700/api/agent/web/search", "http://127.0.0.1:8700/api/agent/web/fetch"]
    assert calls[0][2]["query"] == "cepheids" and calls[1][3] == "Bearer invented-token"


def test_mind_side_refusals_are_plain(monkeypatch):
    hive_web = _load("hive_web_under_test2", "modules/web_search/src/hive_web.py")
    monkeypatch.delenv("HIVE_API_URL", raising=False)
    assert hive_web.fetch("https://example.org/") == "web-fetch refused: this mind is not connected to a hive"


def test_mind_side_module_has_no_way_to_the_internet():
    for rel in ("modules/web_search/src/hive_web.py", "modules/web_search/src/websearch.py"):
        source = (ROOT / rel).read_text()
        for banned in ("ddgs", "import socket", "httpx", "duckduckgo", "tavily", "requests"):
            assert banned not in source.lower(), (rel, banned)
    skills = (ROOT / "modules/web_search/skills.metta").read_text()
    assert "hive_web.search" in skills and "hive_web.fetch" in skills and "websearch." not in skills


def test_skill_policy_still_decides_and_a_refusal_is_audited(w):
    w.hive.policy.add_rule(f"agent:{w.mind['id']}", "web-fetch", "deny", note="not for this mind")
    r = fetch(w, "https://example.org/page")
    assert r.status_code == 403 and w.site.connects == []
    assert w.tools.audit(w.mind["id"])[0]["outcome"] == "refused"
    assert search(w, "x").status_code == 200          # web-search is a separate skill, still allowed by default


def test_web_fetch_is_allowed_by_default_like_web_search(w):
    agent = w.hive.agent(w.mind["id"])
    assert w.hive.policy.decide(agent, "web-fetch")[0] == "allow"
    assert w.hive.policy.decide(agent, "web-search")[0] == "allow"


# ---- security review of d02208f8 ------------------------------------------------------------------------------------

def test_review1_identity_is_asked_and_a_compressed_page_is_refused(w):
    w.site.page("example.org", "/gz", b"\x1f\x8b" + b"\0" * 500, content_encoding="gzip, gzip")
    r = fetch(w, "https://example.org/gz")
    assert r.status_code == 415 and "compressed" in message(r)
    assert all(c["headers"]["Accept-Encoding"] == "identity" for c in w.site.connects)


def test_review1_a_compressed_robots_txt_disallows(w):
    w.site.page("example.org", "/robots.txt", b"\x1f\x8b\0\0", ctype="text/plain", content_encoding="br")
    assert fetch(w, "https://example.org/page").status_code == 403


def test_review1_the_connector_hands_on_raw_bytes_never_inflated(monkeypatch):
    import gzip
    packed = gzip.compress(b"\0" * 1_000_000)

    async def send(self, request, **kwargs):
        return httpx.Response(200, headers={"content-type": "text/plain", "content-encoding": "gzip"},
                              stream=httpx.ByteStream(packed), request=request)
    monkeypatch.setattr(httpx.AsyncClient, "send", send)

    async def run():
        async with HttpxConnector().stream(PUBLIC, "example.org", "/", {}, 5) as (_s, _h, chunks):
            return b"".join([c async for c in chunks])
    import asyncio
    assert asyncio.run(run()) == packed


@pytest.mark.parametrize("name", ["punycode", "utf-7", "idna", "unicode_escape", "raw_unicode_escape", "rot13", "nonsense"])
def test_review2_hostile_or_unknown_charsets_read_as_utf8(name):
    assert webtools._charset(f"text/plain; charset={name}", b"", "text") == "utf-8"


@pytest.mark.parametrize("name,canonical", [("Shift_JIS", "shift_jis"), ("iso-8859-2", "iso8859-2"), ("windows-1252", "cp1252"),
                                            ("UTF-16", "utf-16"), ("gb18030", "gb18030"), ("latin-1", "iso8859-1")])
def test_review2_common_charsets_are_kept(name, canonical):
    assert webtools._charset(f"text/html; charset={name}", b"", "html") == canonical


def test_review2_a_punycode_page_is_read_as_utf8_quickly(w):
    w.site.page("example.org", "/p", "café ".encode() + b"a" * 200_000 + b"-" + b"8" * 200_000,
                ctype="text/plain; charset=punycode")
    r = fetch(w, "https://example.org/p")
    assert r.status_code == 200 and r.json()["text"].startswith("café")


def test_review2_reading_the_page_is_inside_the_deadline(w, monkeypatch):
    import time as _time
    monkeypatch.setattr(webtools, "TOTAL_SECONDS", 0.5)
    monkeypatch.setattr(webtools, "decode_page", lambda *a: (_time.sleep(1.5), ("", ""))[1])
    r = fetch(w, "https://example.org/page")
    assert r.status_code == 504


def test_review3_a_malformed_chat_call_does_not_reset_the_turn(w, monkeypatch):
    monkeypatch.setenv("HIVE_WEB_TURN_MAX_FETCHES", "1")
    assert fetch(w, "https://example.org/page").status_code == 200
    assert fetch(w, "https://example.org/page").status_code == 429
    bad = w.post("/llm/v1/chat/completions", headers={**agent_headers(w.mind), "Content-Type": "application/json"},
                 content=b"not json")
    assert bad.status_code == 400
    assert fetch(w, "https://example.org/page").status_code == 429


def test_review3_a_refused_model_call_does_not_reset_the_turn(w, monkeypatch):
    from hive.core.gateway import GatewayError
    monkeypatch.setenv("HIVE_WEB_TURN_MAX_FETCHES", "1")
    assert fetch(w, "https://example.org/page").status_code == 200

    async def refused(agent, data):
        raise GatewayError(429, "rate_limited", "the provider refused")
    monkeypatch.setattr(w.app.state.gateway, "chat", refused)
    chat = w.post("/llm/v1/chat/completions", headers=agent_headers(w.mind), json={"messages": [{"role": "user", "content": "x"}]})
    assert chat.status_code >= 400
    assert fetch(w, "https://example.org/page").status_code == 429


def test_review4_repeated_refusals_share_audit_rows(w, monkeypatch):
    monkeypatch.setenv("HIVE_WEB_BREAKER_REFUSALS", "2")
    for _ in range(300):
        fetch(w, "http://x.example/")
    for _ in range(50):
        assert fetch(w, "https://example.org/page").status_code == 423
    rows = w.hive.db.all("SELECT * FROM web_audit")
    assert len(rows) == 2
    assert sorted(r["count"] for r in rows) == [50, 300]
    paused = [r for r in rows if r["count"] == 50][0]
    assert paused["urls"] == "[]" and paused["final_url"] is None          # no detail while paused


def test_review5_audit_drops_query_strings_and_user_info(w):
    w.site.page("example.org", "/p?token=sk-SECRET456", b"<p>x</p>")
    w.site.redirect("example.org", "/go?api_key=sk-SECRET123", "/p?token=sk-SECRET456#frag")
    fetch(w, "https://example.org/go?api_key=sk-SECRET123")
    fetch(w, "https://user:sk-SECRET789@example.org/")
    rows = w.get("/api/web/audit").json()
    dump = json.dumps(rows)
    assert "SECRET" not in dump
    ok = [r for r in rows if r["outcome"] == "ok"][0]
    assert ok["urls"] == ["https://example.org/go", "https://example.org/p"] and ok["final_url"] == "https://example.org/p"


@pytest.mark.parametrize("dot", ["。", "．", "｡"])
def test_review6_a_unicode_full_stop_cannot_dodge_the_denylist(w, dot):
    assert webtools.parse_url(f"https://evil.example{dot}/")[0] == "evil.example"
    w.put("/api/web/settings", json={"deny": ["evil.example"]})
    w.resolver.table["evil.example"] = [PUBLIC]
    r = fetch(w, f"https://evil.example{dot}/")
    assert r.status_code == 403 and "may not fetch" in message(r)


def test_review6_a_unicode_full_stop_cannot_dodge_the_local_name_check():
    with pytest.raises(webtools.WebError):
        webtools.parse_url("https://localhost。/")


# The PDF reader runs inside the hive's sandbox (webtools.pdf_text): these need the OS sandbox the run backend uses.
SANDBOX = pytest.mark.skipif(not run_backends.get().available(), reason="needs the OS sandbox the hive reads PDFs in")


def _pdf_reader():
    for name in ("pypdf", "pymupdf", "fitz"):
        if importlib.util.find_spec(name):
            return name
    return None


@pytest.mark.skipif(_pdf_reader() not in ("pymupdf", "fitz"), reason="needs PyMuPDF to make a PDF")
def test_review7_a_pdf_is_read_in_a_child_process(w):
    try:
        import pymupdf
    except ImportError:
        import fitz as pymupdf
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), "Invented PDF words")
    w.site.page("example.org", "/d.pdf", doc.tobytes(), ctype="application/pdf")
    r = fetch(w, "https://example.org/d.pdf")
    assert r.status_code == 200 and "Invented PDF words" in r.json()["text"]


@SANDBOX
def test_review7_a_slow_pdf_reader_is_killed_at_the_deadline(w, monkeypatch):
    import time as _time
    monkeypatch.setattr(webtools, "TOTAL_SECONDS", 3.0)
    monkeypatch.setattr(webtools, "PDF_SCRIPT", "while True: pass")
    w.site.page("example.org", "/d.pdf", b"%PDF-1.4 invented", ctype="application/pdf")
    started = _time.monotonic()
    r = fetch(w, "https://example.org/d.pdf")
    assert r.status_code == 504 and _time.monotonic() - started < 5


def test_review8_a_busy_search_pool_refuses_instead_of_queueing(w, monkeypatch):
    import threading
    gate = threading.Event()

    class Slow(webtools.SearchProvider):
        name, label = "slow", "a slow invented service"

        def search(self, query, max_results):
            gate.wait(10)
            return []
    w.tools.provider = Slow()
    monkeypatch.setattr(webtools, "TOTAL_SECONDS", 0.2)
    try:
        assert search(w, "a").status_code == 504
        assert search(w, "b").status_code == 504
        r = search(w, "c")
        assert r.status_code == 503 and "busy" in message(r)
    finally:
        gate.set()
    import time as _time
    deadline = _time.monotonic() + 5
    while w.tools.search_busy and _time.monotonic() < deadline:
        _time.sleep(0.01)
    w.tools.provider = w.provider
    assert search(w, "d").status_code == 200


def test_review9_unknown_and_private_names_get_the_same_answer(w):
    w.resolver.table["db.corp-internal.example"] = ["10.9.8.7"]
    private = fetch(w, "https://db.corp-internal.example/")
    unknown = fetch(w, "https://nothere.corp-internal.example/")
    assert private.status_code == unknown.status_code == 403
    assert message(private).replace("db.", "") == message(unknown).replace("nothere.", "")


def test_review9_the_paused_answer_gives_the_reason_only(w, monkeypatch):
    monkeypatch.setenv("HIVE_WEB_BREAKER_REFUSALS", "1")
    fetch(w, "http://x.example/")
    error = fetch(w, "https://example.org/page").json()["error"]
    assert "details" not in error or not error["details"]
    assert "reset_by" not in json.dumps(error) and "tripped_at" not in json.dumps(error)


def test_review12_small_body_limit_is_said_in_kilobytes(w):
    r = w.post("/api/agent/web/fetch", headers=agent_headers(w.mind), json={"url": "https://example.org/" + "a" * 20_000})
    assert r.status_code == 413 and "16 KB" in message(r)


def test_review12_a_bad_audit_limit_is_a_plain_400(w):
    r = w.get("/api/web/audit?limit=abc")
    assert r.status_code == 400 and "whole number" in message(r)


def test_typos_never_trip_the_breaker_but_private_resolutions_do(w, monkeypatch):
    """A name that does not resolve gets the same answer as a private one, but only the private one is a strike."""
    monkeypatch.setenv("HIVE_WEB_BREAKER_REFUSALS", "3")
    monkeypatch.setenv("HIVE_WEB_TURN_MAX_FETCHES", "50")
    w.resolver.table["empty.example.org"] = []
    for i in range(6):
        r = fetch(w, f"https://typo{i}.example.org/")              # no such name
        assert r.status_code == 403 and message(r) == f"typo{i}.example.org could not be reached as a public web address"
    assert fetch(w, "https://empty.example.org/").status_code == 403      # resolves to no address
    assert fetch(w, "https://example.org/page").status_code == 200
    assert "could not be resolved" in w.tools.audit(w.mind["id"])[-1]["reason"]
    w.resolver.table["inner.example.org"] = ["10.0.0.1"]
    for _ in range(3):
        assert fetch(w, "https://inner.example.org/").status_code == 403
    assert fetch(w, "https://example.org/page").status_code == 423


# ---- re-review (P3) -------------------------------------------------------------------------------------------------

def test_rereview1_no_strike_rows_while_paused(w, monkeypatch):
    monkeypatch.setenv("HIVE_WEB_BREAKER_REFUSALS", "1")
    fetch(w, "http://x.example/")
    for _ in range(300):
        fetch(w, "http://x.example/")
    assert w.hive.db.one("SELECT COUNT(*) AS n FROM web_strikes")["n"] == 1


@SANDBOX
def test_rereview2_pdf_output_is_capped_and_the_child_stopped(w, monkeypatch):
    # the reader writes far past its cap: the sandbox's file-size limit stops it there, and the text is cut at the cap
    monkeypatch.setattr(webtools, "PDF_OUTPUT_CAP", 1000)
    monkeypatch.setattr(webtools, "PDF_SCRIPT", "open('text.txt', 'w').write('a' * 10 ** 7)\n")
    w.site.page("example.org", "/d.pdf", b"%PDF-1.4 invented", ctype="application/pdf")
    r = fetch(w, "https://example.org/d.pdf")
    assert r.status_code == 200 and r.json()["text"] == "a" * 1000


def test_rereview3_a_mind_reads_one_pdf_at_a_time(w, monkeypatch):
    # the cap is per mind (Jon's second review, omega-flagship/omegahive#299): this mind is already reading one
    monkeypatch.setattr(webtools, "_pdf_readers", {w.mind["id"]})
    w.site.page("example.org", "/d.pdf", b"%PDF-1.4 invented", ctype="application/pdf")
    r = fetch(w, "https://example.org/d.pdf")
    assert r.status_code == 503 and "already reading a PDF" in message(r)


@SANDBOX
def test_rereview4_the_sandbox_sets_the_pdf_readers_limits(w, monkeypatch):
    import inspect
    # the run backend starts the reader under the sandbox's launcher, which sets its limits; the hive starts no process
    source = inspect.getsource(webtools.pdf_text)
    assert "preexec_fn" not in source and "create_subprocess" not in source and "run_hive_tool" in source
    monkeypatch.setattr(webtools, "PDF_SCRIPT", "import resource\nopen('text.txt', 'w').write(str(resource.getrlimit(resource.RLIMIT_CPU)[0]))\n")
    w.site.page("example.org", "/d.pdf", b"%PDF-1.4 invented", ctype="application/pdf")
    r = fetch(w, "https://example.org/d.pdf")
    assert r.status_code == 200 and r.json()["text"] == str(webtools.PDF_CPU_SECONDS)


def test_rereview5_the_audit_keeps_only_the_start_of_a_search(w):
    assert search(w, "q" * 400).status_code == 200
    assert len(w.tools.audit(w.mind["id"])[0]["query"]) == webtools.AUDIT_QUERY_CHARS
