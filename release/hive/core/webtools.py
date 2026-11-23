"""Web tools for minds: host-side web search and a vetted https fetch (research route design, part b).

A sandboxed mind reaches only its hive (127.0.0.1:<hive port>), so the mind-side ``web-search`` and ``web-fetch`` skills
(modules/web_search) are thin calls to two agent-authenticated routes, ``POST /api/agent/web/search`` and
``POST /api/agent/web/fetch``. Everything that touches the internet, and every rule about it, is here, on the host:

- search goes through a small provider interface (``SearchProvider``); the default is the ``ddgs`` package (free),
  asked one engine per call, the engines that answered from this hive's network first and those that keep failing
  left to rest (``DdgsProvider``). A keyed provider (Tavily) can be added beside it; its key stays host-side and never
  reaches a mind;
- fetch is https only, port 443, no user info in the URL. The host resolves the name itself and refuses private,
  loopback, link-local, CGNAT, multicast, reserved, unspecified and cloud-metadata addresses (IPv4 and IPv6, IPv4-mapped,
  6to4, Teredo and NAT64 forms unwrapped first). Every address a name resolves to must pass, not just one;
- it then connects to that vetted address (an IP-literal URL), sending the real name as the Host header and as TLS SNI,
  and the certificate is checked against the real name. Nothing resolves the name a second time, so a name that
  answers public first and private next (DNS rebinding) cannot move the connection. One fetch resolves each name once
  and reuses it for robots.txt and the page;
- every redirect hop is vetted by the same rules (an http hop is refused), at most 5; one deadline of 10 seconds covers
  the whole call, robots.txt and reading the page included; only uncompressed answers are read (``Accept-Encoding:
  identity``; any other content-encoding is refused, and the raw bytes are read, never inflated), so the 2 MB body cap
  is a real cap;
- only a fixed list of text encodings is decoded (others read as UTF-8), so decoding stays linear; PDF text comes from
  the hive's own PDF tool inside the sandbox (pdf_text), one read at a time per mind, stopped at the deadline;
- only text/html, application/xhtml+xml, text/plain, application/json and application/pdf are read; anything else is
  refused with a plain reason before its body is read. HTML becomes readable text (scripts, styles and page chrome
  dropped) with its title;
- robots.txt is honoured for every URL fetched (RFC 9309: a missing file allows, an unreachable one disallows), cached
  briefly per host;
- admins keep a denylist and an optional allowlist of hosts (``GET``/``PUT /api/web/settings``, seeded from
  HIVE_WEB_DENY / HIVE_WEB_ALLOW), applied to every hop;
- per turn (the calls a mind makes between two of its model calls; the chat route marks each new one) at most
  HIVE_WEB_TURN_MAX_FETCHES fetches (default 20) and HIVE_WEB_TURN_MAX_SEARCHES searches (default 10). The mind's own
  budget and every monthly or daily limit that applies to it refuse a web call once used up, as they refuse its model
  calls (the call's own price, zero for ddgs, is what is checked against them);
- a per-mind breaker, as media.py's: HIVE_WEB_BREAKER_REFUSALS (default 5) safety refusals within
  HIVE_WEB_BREAKER_WINDOW_SECONDS (default 600; a name resolving to a refused address, a denied host, a non-https
  hop) pause that mind's web access until an admin resets it, with a reason. A site's robots.txt verdict and a name
  that does not resolve (a typo) never count;
- a name that does not resolve and one that resolves somewhere refused get the same answer (no probe of internal
  names); the audit keeps the real reason for admins;
- searches run on a pool of SEARCH_WORKERS threads, so the engines never get more than that many searches from one
  hive at once; when all are busy (a slow call keeps its worker) a search waits for one, and one deadline of
  TOTAL_SECONDS covers the wait and the call, so a search answers or is refused within it. Each engine gets
  ENGINE_SECONDS, well inside the deadline, so a slow or throttling engine is dropped and the search answers from the
  others;
- one audit row per call (``web_audit``): tool, URLs of every hop (scheme, host and path only: no query, fragment or
  user info), final URL, status, bytes, content type, outcome and reason, mind and turn. Never a page body. The same
  refusal from one mind within a minute adds to one row's count.

Refusals are plain words; the route turns them into the hive's usual error answer.
"""

from __future__ import annotations

import asyncio
import codecs
import contextlib
import ipaddress
import json
import os
import re
import socket
import threading
import time
import urllib.robotparser
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

import httpx

from . import run_backends
from .db import now
from .hive import HiveError

MAX_REDIRECTS = 5
TOTAL_SECONDS = 10.0
# ddgs asks engines in rounds, waits for every engine of a round up to that engine's own timeout, and starts another
# round only when the first gave too few results (ddgs.DDGS._search_sync). With the whole deadline as each engine's
# timeout, one slow or throttling engine timed the search out: during one Ask research on a fresh v0.38 Mac hive, 6
# of 9 searches ended at the deadline and 2 more found both workers held by them. Two rounds of ENGINE_SECONDS fit
# inside the deadline with room for the hive's own work.
ENGINE_SECONDS = 4
BODY_CAP = 2 * 1024 * 1024
ROBOTS_CAP = 512 * 1024
ROBOTS_TTL = 600.0          # a robots.txt answer is kept 10 minutes
ROBOTS_ERROR_TTL = 60.0     # an unreachable one only a minute
ROBOTS_CACHE_MAX = 512
ROBOTS_AGENT = "OmegaHive"
USER_AGENT = "OmegaHive/1.0 (research fetch; honours robots.txt)"
MAX_URL = 2048
MAX_QUERY = 400
DEFAULT_RESULTS, MAX_RESULTS = 8, 20
DEFAULT_CHARS, MAX_CHARS = 20_000, 200_000
CONTENT_KINDS = {"text/html": "html", "application/xhtml+xml": "html", "text/plain": "text",
                 "application/json": "text", "application/pdf": "pdf"}
BODY_LIMIT = 16 * 1024      # a request to either route is small
SEARCH_PROVIDER_ENV = "HIVE_WEB_SEARCH_PROVIDER"
SEARCH_WORKERS = 2          # searches run on their own small pool; when both are busy a search is refused, never queued
AUDIT_QUERY_CHARS = 200     # the audit keeps the start of a search, not all of it
AUDIT_COLLAPSE_SECONDS = 60  # refusals with the same reason from one mind within a minute share one audit row (a count)
PDF_CPU_SECONDS = 8         # each PDF read's limits in the sandbox (memory on Linux only); stopped at the call's deadline
PDF_MEMORY_BYTES = 512 * 1024 * 1024
# Encodings a page may name. Anything else (punycode, utf-7, unicode_escape, idna and the like: slow or not text
# encodings at all) is read as UTF-8 with replacement. Names are codecs.lookup(...).name.
CHARSETS = frozenset({"utf-8", "utf-8-sig", "utf-16", "utf-16-le", "utf-16-be", "utf-32", "utf-32-le", "utf-32-be",
                      "ascii", "cp874", "koi8-r", "koi8-u", "shift_jis", "cp932", "euc_jp", "iso2022_jp", "gb2312",
                      "gbk", "gb18030", "big5", "big5hkscs", "cp950", "euc_kr", "cp949", "tis-620"}
                     | {f"iso8859-{n}" for n in range(1, 17)} | {f"cp{n}" for n in range(1250, 1259)})

# Cloud metadata services. Most sit in ranges refused anyway (link-local, CGNAT, ULA, IETF reserved); they are named so a
# refusal says what it is, and Azure's wire server (168.63.129.16) sits in public space and is refused only by this list.
METADATA_ADDRESSES = frozenset(ipaddress.ip_address(a) for a in (
    "169.254.169.254", "169.254.170.2", "169.254.169.253", "100.100.100.200", "192.0.0.192", "168.63.129.16",
    "fd00:ec2::254", "fd00:ec2::23"))
CGNAT = ipaddress.ip_network("100.64.0.0/10")
NAT64 = (ipaddress.ip_network("64:ff9b::/96"), ipaddress.ip_network("64:ff9b:1::/48"))
LOCAL_SUFFIXES = (".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet", ".corp")
LOCAL_NAMES = {"localhost", "metadata", "metadata.google.internal"}


def _int_env(name, default, low=1):
    try:
        return max(low, int(os.environ.get(name, "") or default))
    except ValueError:
        return default


def turn_max_fetches():
    return _int_env("HIVE_WEB_TURN_MAX_FETCHES", 20)


def turn_max_searches():
    return _int_env("HIVE_WEB_TURN_MAX_SEARCHES", 10)


def breaker_refusals():
    return _int_env("HIVE_WEB_BREAKER_REFUSALS", 5)


def breaker_window():
    """Safety refusals are counted over this many seconds (a sliding window), not only in a row."""
    return _int_env("HIVE_WEB_BREAKER_WINDOW_SECONDS", 600)


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fit_text(text, max_bytes):
    """The longest start of text that, escaped as a JSON string twice over (the tool's answer, then that answer inside
    the mind's next request), is at most max_bytes of UTF-8: a researcher's page cut to what its next call can carry.
    Time: about log2(len(text)) encodes of up to len(text) characters."""
    def size(n):
        return len(json.dumps(json.dumps(text[:n], ensure_ascii=False), ensure_ascii=False).encode("utf-8"))
    if size(len(text)) <= max_bytes:
        return text
    low, high = 0, len(text)
    while low < high:   # the largest n whose start fits: size grows with n
        mid = (low + high + 1) // 2
        if size(mid) <= max_bytes:
            low = mid
        else:
            high = mid - 1
    return text[:low]


class WebError(Exception):
    """A refusal or failure, in plain words. ``safety`` marks the refusals that count toward the breaker; ``audit`` is
    the fuller reason kept for admins when the mind is told less (a name that does not resolve and one that resolves
    to a private address get the same answer, so the route is no probe of internal names)."""

    def __init__(self, status, code, message, details=None, safety=False, audit=None):
        super().__init__(message)
        self.status, self.code, self.message, self.details, self.safety = status, code, message, details, safety
        self.audit = audit or message


def _refuse(message, code="web_refused", audit=None, safety=True):
    return WebError(403, code, message, safety=safety, audit=audit)


def not_reachable(host, why, strike=True):
    """One answer for a name that does not resolve and for one that leads somewhere minds may not go. Only the second
    counts toward the breaker (strike): a typo never pauses a mind."""
    return _refuse(f"{host} could not be reached as a public web address", audit=f"{host}: {why}", safety=strike)


def audit_url(url):
    """A URL as the audit keeps it: scheme, host and path. Query, fragment and any user info are dropped (a query can
    carry a key or token)."""
    try:
        parts = urlsplit(str(url or ""))
        host = parts.hostname or ""
        port = parts.port
    except ValueError:
        return "(unreadable address)"
    if not parts.scheme:
        return "(unreadable address)"
    netloc = (f"[{host}]" if ":" in host else host) + (f":{port}" if port else "")
    return f"{parts.scheme.lower()}://{netloc}{parts.path}"[:MAX_URL]


def _size(limit):
    return f"{limit // (1024 * 1024)} MB" if limit >= 1024 * 1024 else f"{max(1, limit // 1024)} KB"


# ---- addresses ------------------------------------------------------------------------------------------------------

def _embedded_ipv4(ip):
    """The IPv4 address an IPv6 address carries (IPv4-mapped, 6to4, Teredo client, NAT64), or None."""
    if ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    if ip.sixtofour is not None:
        return ip.sixtofour
    if ip.teredo is not None:
        return ip.teredo[1]
    if any(ip in net for net in NAT64):
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    return None


def address_refusal(text):
    """Why this address may not be fetched from, in plain words, or None for a public internet address."""
    raw = str(text or "").strip().strip("[]")
    if "%" in raw:
        return "a link-local address with a zone is not a public internet address"
    try:
        ip = ipaddress.ip_address(raw)
    except ValueError:
        return "that is not an internet address"
    if ip.version == 6:
        inner = _embedded_ipv4(ip)
        if inner is not None:
            why = address_refusal(str(inner))
            if why:
                return why + " (inside an IPv6 address)"
            if ip.teredo is not None and address_refusal(str(ip.teredo[0])):
                return "a tunnel address through a private server"
    if ip in METADATA_ADDRESSES:
        return "a cloud metadata address"
    if ip.version == 6 and ip.is_site_local:
        return "a site-local address"
    if ip.is_loopback:
        return "a loopback address (this computer)"
    if ip.is_link_local:
        return "a link-local address"
    if ip.is_multicast:
        return "a multicast address"
    if ip.version == 4 and ip in CGNAT:
        return "a carrier-grade NAT (shared) address"
    if ip.is_unspecified:
        return "an unspecified address"
    if ip.is_private:
        return "a private network address"
    if ip.is_reserved:
        return "a reserved address"
    if not ip.is_global:
        return "not a public internet address"
    return None


def host_matches(host, entry):
    """A list entry names a host and its subdomains: "example.com" matches example.com and www.example.com."""
    entry = str(entry or "").strip().lower().lstrip("*").lstrip(".").rstrip(".")
    return bool(entry) and (host == entry or host.endswith("." + entry))


def _idna(host):
    try:
        return host.encode("idna").decode("ascii").lower()
    except (UnicodeError, ValueError):
        raise _refuse("that web address has a host name that cannot be read") from None


def parse_url(url):
    """(host, target, display) for an https URL this hive may fetch, or a plain refusal. ``target`` is path + query."""
    url = str(url or "").strip()
    if not url:
        raise WebError(400, "bad_request", "give a web address to fetch")
    if len(url) > MAX_URL:
        raise WebError(400, "bad_request", f"web addresses are limited to {MAX_URL} characters")
    if any(c.isspace() or ord(c) < 32 for c in url):
        raise WebError(400, "bad_request", "a web address has no spaces or control characters")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise WebError(400, "bad_request", "that is not a web address this hive can read") from None
    if parts.scheme.lower() != "https":
        raise _refuse("only https web addresses are fetched")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise _refuse("web addresses with a user name or password in them are not fetched")
    if port not in (None, 443):
        raise _refuse("only the standard https port (443) is fetched")
    host = (parts.hostname or "").rstrip(".")
    if not host:
        raise WebError(400, "bad_request", "that web address has no host")
    literal = None
    with contextlib.suppress(ValueError):
        literal = ipaddress.ip_address(host.strip("[]"))
    if literal is None:
        host = _idna(host).rstrip(".")      # a Unicode full stop becomes "." only after IDNA ("evil.com。")
        if not host:
            raise WebError(400, "bad_request", "that web address has no host")
        if host in LOCAL_NAMES or host.endswith(LOCAL_SUFFIXES) or "." not in host:
            raise _refuse("that is a local network name, not a public web address")
    else:
        host = str(literal)
    target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    netloc = f"[{host}]" if literal is not None and literal.version == 6 else host
    return host, target, f"https://{netloc}{target}", literal is not None


# ---- name resolution and the connection ------------------------------------------------------------------------------

async def system_resolve(host):
    """Every address the system resolver gives for ``host`` (port 443, TCP)."""
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    seen = []
    for info in infos:
        address = info[4][0]
        if address not in seen:
            seen.append(address)
    return seen


class HttpxConnector:
    """Connects to one vetted IP address. The URL names the address itself, so nothing below resolves a name; the real
    name goes in the Host header and TLS SNI (``sni_hostname``), and the certificate is verified against it. A fresh
    client per hop, no environment proxies, no redirects followed by the client. The body is handed on raw
    (``aiter_raw``): httpx never inflates a compressed answer here."""

    @contextlib.asynccontextmanager
    async def stream(self, ip, host, target, headers, timeout):
        if address_refusal(ip):                      # defence in depth: never connect to an unvetted address
            raise _refuse("that address is not a public internet address")
        literal = f"[{ip}]" if ":" in ip else ip
        hdrs = {**headers, "Host": f"[{host}]" if ":" in host else host}
        async with httpx.AsyncClient(trust_env=False, follow_redirects=False, http2=False,
                                     timeout=httpx.Timeout(timeout)) as client:
            request = client.build_request("GET", f"https://{literal}{target}", headers=hdrs,
                                           extensions={"sni_hostname": host})
            response = await client.send(request, stream=True)
            try:
                yield response.status_code, {k.lower(): v for k, v in response.headers.items()}, response.aiter_raw()
            finally:
                await response.aclose()


# ---- search providers -----------------------------------------------------------------------------------------------

class SearchProvider:
    """One web search backend. ``search`` runs in a worker thread and returns [{title, url, snippet}]. ``cost_usd`` is
    the price of one call, checked against the mind's limits (zero for a free backend)."""

    name = "none"
    label = "no search service"
    cost_usd = 0.0

    def search(self, query, max_results):
        raise NotImplementedError


class DdgsProvider(SearchProvider):
    """The free provider: ddgs's text engines, asked one engine per call so the hive knows which answered.

    Engines that answered are asked first, most recent first, then engines not yet tried (by ddgs's own priority),
    then engines that failed; HEDGE are asked at once and the first rows back are the answer. On 19 Nov only yandex,
    and yahoo half the time, of ddgs 9.14.4's nine text engines returned rows, from three different networks, while
    ddgs's own auto mode always began with wikipedia and grokipedia and waited for every engine of each round (ddgs
    issue 498 reports the same). An engine that fails FAILURES_TO_REST times in a row rests for REST_SECONDS, doubling
    with each further failure up to REST_MAX_SECONDS, and an answer ends its rest (SearXNG suspends a failing engine
    the same way, for an hour after a 429). When every engine rests, the one whose rest ends first is asked anyway."""

    name, label, cost_usd = "ddgs", "DuckDuckGo and other public engines (ddgs)", 0.0
    HEDGE = 2                  # ddgs's own round width for up to ten results (DDGS._search_sync: ceil(10 / 10) + 1)
    FAILURES_TO_REST = 2       # one empty answer may be the query's; a second in a row is the engine's
    REST_SECONDS = 60.0
    REST_MAX_SECONDS = 3600.0

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.health = {}       # engine -> {"answered": clock time or None, "failures": in a row, "rest_until": clock time}
        self.lock = threading.Lock()

    def engines(self):
        """The text engines in the order a search asks them, those resting left out (unless all rest)."""
        from ddgs.engines import ENGINES
        now = self.clock()
        with self.lock:
            rows = [(name, cls.priority, self.health.get(name, {})) for name, cls in ENGINES["text"].items()]
        ready = [r for r in rows if r[2].get("rest_until", 0.0) <= now]
        if not ready:
            return [min(rows, key=lambda r: r[2]["rest_until"])[0]] if rows else []

        def rank(row):
            name, priority, h = row
            if h.get("answered") is not None and not h.get("failures"):
                return (0, -h["answered"], name)
            return (1 if not h else 2, -priority, name)
        return [name for name, _, _ in sorted(ready, key=rank)]

    def _outcome(self, name, answered):
        now = self.clock()
        with self.lock:
            h = self.health.setdefault(name, {"answered": None, "failures": 0, "rest_until": 0.0})
            if answered:
                h.update(answered=now, failures=0, rest_until=0.0)
                return
            h["failures"] += 1
            over = h["failures"] - self.FAILURES_TO_REST
            if over >= 0:
                h["rest_until"] = now + min(self.REST_SECONDS * 2 ** over, self.REST_MAX_SECONDS)

    def search(self, query, max_results):
        from ddgs import DDGS        # imported on use: the hive runs without it, and search then says so
        from ddgs.exceptions import DDGSException, TimeoutException

        def ask(name):
            begun = time.monotonic()
            try:
                return DDGS(timeout=ENGINE_SECONDS).text(query, max_results=max_results, safesearch="moderate",
                                                         backend=name)
            except DDGSException as exc:
                # ddgs waits for an engine exactly as long as the engine's own request may take, so an engine that used
                # its whole time can end as "No results found." just before its timeout error lands: its time says which
                if not isinstance(exc, TimeoutException) and time.monotonic() - begun >= ENGINE_SECONDS:
                    raise TimeoutException(f"no answer within {ENGINE_SECONDS} s") from None
                raise

        def record(name):
            def done(future):
                failed = future.cancelled() or future.exception() is not None or not future.result()
                self._outcome(name, not failed)
            return done
        started, queue = time.monotonic(), self.engines()
        pending, timed_out, failed = {}, 0, []
        pool = ThreadPoolExecutor(max_workers=self.HEDGE, thread_name_prefix="web-search-engine")
        # Time: at most len(engines) engine calls, HEDGE at once, each cut at ENGINE_SECONDS, and none started once
        # it could not end by TOTAL_SECONDS, so a search takes at most TOTAL_SECONDS here
        try:
            while queue or pending:
                while queue and len(pending) < self.HEDGE and time.monotonic() - started + ENGINE_SECONDS <= TOTAL_SECONDS:
                    name = queue.pop(0)
                    future = pool.submit(ask, name)
                    future.add_done_callback(record(name))
                    pending[future] = name
                if not pending:
                    break
                done, _ = wait(pending, timeout=max(0.0, TOTAL_SECONDS - (time.monotonic() - started)),
                               return_when=FIRST_COMPLETED)
                if not done:                 # the engines still out did not answer by the deadline
                    timed_out += len(pending)
                    failed += [f"{name}: still out at the deadline" for name in pending.values()]
                    break
                for future in done:
                    name = pending.pop(future)
                    error = future.exception()
                    if error is None and future.result():
                        return [{"title": r.get("title") or "", "url": r.get("href") or r.get("url") or "",
                                 "snippet": r.get("body") or ""} for r in future.result()]
                    timed_out += isinstance(error, TimeoutException)
                    failed.append(f"{name}: {error or 'no results'}")
        finally:
            pool.shutdown(wait=False)      # an engine still out finishes on its own and records how it went
        audit = ("ddgs: " + "; ".join(failed))[:300] if failed else "ddgs: no engine could be asked in time"
        if failed and timed_out == len(failed):
            raise WebError(504, "search_timeout", "the search engines did not answer in time; try again in a moment",
                           audit=audit)
        # ddgs says "No results found." both for an empty search and for an engine that refuses or throttles this
        # network's searches (an anti-bot page, a 429), so the words name both (ddgs issue 498)
        raise WebError(502, "search_failed", "no search engine returned results: they may be limiting searches from "
                       "this network, so try again in a minute or with other words", audit=audit)


PROVIDERS = {"ddgs": DdgsProvider}


def default_provider():
    name = os.environ.get(SEARCH_PROVIDER_ENV, "ddgs").strip().lower() or "ddgs"
    cls = PROVIDERS.get(name)
    return cls() if cls else None


# ---- readable text --------------------------------------------------------------------------------------------------

SKIP_TAGS = {"script", "style", "noscript", "template", "svg", "math", "iframe", "object", "canvas", "nav", "footer",
             "aside", "form", "button", "select"}
BLOCK_TAGS = {"p", "div", "br", "li", "ul", "ol", "tr", "table", "section", "article", "main", "header", "h1", "h2",
              "h3", "h4", "h5", "h6", "pre", "blockquote", "dd", "dt", "dl", "hr", "figure", "figcaption", "td", "th"}


class _Readable(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip, self.in_title, self.title, self.parts = 0, False, [], []

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self.in_title = True
        elif tag in SKIP_TAGS:
            self.skip += 1
        elif tag in BLOCK_TAGS and not self.skip:
            self.parts.append("\n")

    def handle_startendtag(self, tag, attrs):
        if tag in BLOCK_TAGS and not self.skip:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        elif tag in SKIP_TAGS:
            self.skip = max(0, self.skip - 1)
        elif tag in BLOCK_TAGS and not self.skip:
            self.parts.append("\n")

    def handle_data(self, data):
        if self.in_title:
            self.title.append(data)
        elif not self.skip:
            self.parts.append(data)


def _tidy(text):
    lines = (re.sub(r"[ \t\r\f\v ]+", " ", line).strip() for line in text.split("\n"))
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def readable_html(text):
    """(title, readable text) of an HTML page: scripts, styles and page chrome dropped, blocks on their own lines."""
    parser = _Readable()
    with contextlib.suppress(Exception):
        parser.feed(text)
        parser.close()
    return _tidy(" ".join(parser.title))[:300], _tidy("".join(parser.parts))


def _charset(content_type, body, kind):
    """The page's named encoding when it is one of CHARSETS, else UTF-8 (read with replacement)."""
    match = re.search(r"charset=[\"']?([A-Za-z0-9._-]+)", content_type or "", re.I)
    name = match.group(1) if match else None
    if name is None and kind == "html":
        found = re.search(rb"<meta[^>]+charset=[\"']?([A-Za-z0-9._-]+)", body[:4096], re.I)
        name = found.group(1).decode("ascii", "ignore") if found else None
    try:
        canonical = codecs.lookup(name).name if name else "utf-8"
    except LookupError:
        return "utf-8"
    return canonical if canonical in CHARSETS else "utf-8"


def decode_page(body, content_type, kind):
    """(title, text) of a text or HTML body. Linear in the body: only CHARSETS are decoded."""
    decoded = body.decode(_charset(content_type, body, kind), "replace")
    if kind == "html":
        return readable_html(decoded)
    return "", decoded.strip()


# The PDF reader is one of the hive's own tools, which the run backend runs inside the sandbox every tool run gets
# (run_backends.run_hive_tool; today sandbox_run: no network, writes to its own job folder only, CPU and file-size
# limits and on Linux a memory limit, its process group ended at the deadline). A hostile PDF can make a parser slow,
# hungry or worse, and Jon's second review (omega-flagship/omegahive#299) asked for it there, with the cap per mind:
# each mind reads one PDF at a time, every read has its own limits, and no read waits on another mind's. The tool reads
# in.pdf and writes at most its cap of text to text.txt, exiting 4 when it cut the text there and 3 when no PDF reader
# is installed; the file-size limit stops a tool that writes past the cap anyway.
PDF_SCRIPT = r"""
import io, sys
cap = int(sys.argv[1])
data = open("in.pdf", "rb").read()
try:
    import pypdf
    text = "\n\n".join((p.extract_text() or "") for p in pypdf.PdfReader(io.BytesIO(data)).pages)
except ImportError:
    try:
        import pymupdf
    except ImportError:
        try:
            import fitz as pymupdf
        except ImportError:
            sys.exit(3)
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        text = "\n\n".join(page.get_text() for page in doc)
out = text.encode("utf-8", "replace")
with open("text.txt", "wb") as f:
    f.write(out[:cap])
sys.exit(4 if len(out) > cap else 0)
"""
PDF_OUTPUT_CAP = 4 * 1024 * 1024
PDF_FILE_SLACK = 4096              # the file-size limit sits this far past the cap, so a tool writing on is cut past it
                                   # on both platforms (macOS rounds the limit down to whole KiB: keep this >= 1 KiB)
PDF_INPUT_CAP = 20 * 1024 * 1024   # the run backend's input limit: a larger PDF is refused before anything runs
_pdf_readers = set()               # minds reading a PDF now (changed only on the event loop, with no await between)


async def pdf_text(data, timeout, reader):
    """The text of a PDF read for the mind ``reader`` (its id) by the hive's PDF tool in the sandbox; None when no PDF
    reader is installed; WebError when the read is refused or fails."""
    if reader in _pdf_readers:
        raise WebError(503, "pdf_busy", "you are already reading a PDF; try again once it finishes")
    if len(data) > PDF_INPUT_CAP:
        raise WebError(413, "too_large", f"the PDF is larger than {_size(PDF_INPUT_CAP)}, so its text is not read")
    if timeout < 1:
        raise WebError(504, "fetch_timeout", f"the PDF could not be read within {int(TOTAL_SECONDS)} seconds")
    backend = run_backends.get()
    _pdf_readers.add(reader)
    try:
        out = await backend.run_hive_tool(
            "pdf-reader", {"pdf_text.py": PDF_SCRIPT}, "pdf_text.py", args=[str(PDF_OUTPUT_CAP)],
            inputs={"in.pdf": data}, outputs=["text.txt"], cpu_seconds=PDF_CPU_SECONDS,
            file_bytes=PDF_OUTPUT_CAP + PDF_FILE_SLACK, artifact_bytes=PDF_OUTPUT_CAP + PDF_FILE_SLACK,
            memory_bytes=PDF_MEMORY_BYTES, timeout=min(timeout, 120))
    except TimeoutError:
        raise WebError(504, "fetch_timeout", f"the PDF could not be read within {int(TOTAL_SECONDS)} seconds") from None
    except RuntimeError as exc:   # the backend's own refusals: no sandbox here (it never runs unsandboxed), or too much output
        if str(exc).startswith("sandbox unavailable"):
            raise WebError(503, "pdf_unavailable", "this hive reads PDF text only inside its sandbox, and the sandbox "
                           "is unavailable on this computer") from None
        if isinstance(exc, backend.OutputLimit):
            raise WebError(422, "unreadable", "the PDF could not be read") from None
        raise
    finally:
        _pdf_readers.discard(reader)
    if out.get("exit") == 3:
        return None
    raw = (out.get("outputs") or {}).get("text.txt") or b""
    capped = out.get("exit") == 4 or len(raw) > PDF_OUTPUT_CAP
    if out.get("exit") != 0 and not capped:
        raise WebError(422, "unreadable", "the PDF could not be read")
    return raw[:PDF_OUTPUT_CAP].decode("utf-8", "ignore" if capped else "replace")


# ---- the tools ------------------------------------------------------------------------------------------------------

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS web_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, agent_id TEXT NOT NULL,
  turn TEXT NOT NULL, tool TEXT NOT NULL, query TEXT, urls TEXT NOT NULL DEFAULT '[]', final_url TEXT, status INTEGER,
  outcome TEXT NOT NULL, reason TEXT, bytes INTEGER NOT NULL DEFAULT 0, content_type TEXT, results INTEGER,
  provider TEXT, elapsed_ms INTEGER, count INTEGER NOT NULL DEFAULT 1, last_at TEXT)""",
    "CREATE INDEX IF NOT EXISTS web_audit_agent ON web_audit(agent_id, id)",
    """CREATE TABLE IF NOT EXISTS web_breakers (agent_id TEXT PRIMARY KEY, consecutive INTEGER NOT NULL DEFAULT 0,
  tripped_at TEXT, reason TEXT, reset_at TEXT, reset_by TEXT, reset_reason TEXT)""",
    "CREATE TABLE IF NOT EXISTS web_strikes (agent_id TEXT NOT NULL, at REAL NOT NULL)",
    "CREATE INDEX IF NOT EXISTS web_strikes_agent ON web_strikes(agent_id, at)",
    "CREATE TABLE IF NOT EXISTS web_settings (id INTEGER PRIMARY KEY CHECK (id = 1), deny TEXT NOT NULL, allow TEXT NOT NULL, "
    "updated_at TEXT, updated_by TEXT)",
]

HOST_ENTRY = re.compile(r"\*?\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\Z")


def _host_list(value):
    if isinstance(value, str):
        value = [v for v in re.split(r"[\s,]+", value) if v]
    if not isinstance(value, list) or len(value) > 1000:
        raise ValueError("a host list is up to 1000 host names")
    out = []
    for raw in value:
        entry = str(raw).strip().lower().rstrip(".")
        if not entry:
            continue
        if len(entry) > 253 or not HOST_ENTRY.match(entry):
            raise ValueError(f"{str(raw)[:80]!r} is not a host name (example.com or *.example.com)")
        entry = entry.lstrip("*").lstrip(".")
        if entry not in out:
            out.append(entry)
    return out


class WebTools:
    def __init__(self, hive, provider=None, resolver=None, connector=None, clock=time.monotonic):
        self.hive = hive
        self.provider = provider if provider is not None else default_provider()
        self.resolver = resolver or system_resolve
        self.connector = connector or HttpxConnector()
        self.clock = clock
        self.boot = f"{int(time.time()):x}"
        self.turns = {}            # agent_id -> {"n": turn number, "fetch": count, "search": count}
        self.robots = {}           # host -> (expires, parser | True (allow all) | False (disallow all))
        self.search_pool = ThreadPoolExecutor(max_workers=SEARCH_WORKERS, thread_name_prefix="web-search")
        self.search_slots = None   # (loop, asyncio.Semaphore of SEARCH_WORKERS), made on the first search's loop
        for sql in SCHEMA:
            hive.db.execute(sql)
        columns = {r["name"] for r in hive.db.all("PRAGMA table_info(web_audit)")}
        # final_query: 1 when the page a fetch ended on had a query or fragment the audit does not keep (research.py
        # then calls a citation of it a "path" match, never "exact")
        for column, ddl in (("count", "INTEGER NOT NULL DEFAULT 1"), ("last_at", "TEXT"),
                            ("final_query", "INTEGER NOT NULL DEFAULT 0"), ("research_progress", "INTEGER NOT NULL DEFAULT 0")):
            if column not in columns:      # a table made by the first version of this file
                hive.db.execute(f"ALTER TABLE web_audit ADD COLUMN {column} {ddl}")

    # -- turns --

    def new_turn(self, agent_id):
        """The chat route calls this on each model call by a mind: its web calls after it belong to a new turn."""
        prev = self.turns.get(agent_id) or {"n": 0}
        self.turns[agent_id] = {"n": prev["n"] + 1, "fetch": 0, "search": 0}

    def _turn(self, agent_id):
        return self.turns.setdefault(agent_id, {"n": 0, "fetch": 0, "search": 0})

    def turn_label(self, agent_id):
        return f"{self.boot}-{self._turn(agent_id)['n']}"

    # -- settings --

    def settings(self):
        row = self.hive.db.one("SELECT * FROM web_settings WHERE id = 1")
        if row is None:
            def env(name):
                try:
                    return _host_list(os.environ.get(name, ""))
                except ValueError:
                    return []
            return {"deny": env("HIVE_WEB_DENY"), "allow": env("HIVE_WEB_ALLOW"), "updated_at": None, "updated_by": None,
                    "origin": "environment"}
        return {"deny": json.loads(row["deny"]), "allow": json.loads(row["allow"]), "updated_at": row["updated_at"],
                "updated_by": row["updated_by"], "origin": "admin"}

    def put_settings(self, data, by):
        if not isinstance(data, dict) or set(data) - {"deny", "allow"}:
            raise ValueError("send deny and allow, each a list of host names")
        current = self.settings()
        deny = _host_list(data["deny"]) if "deny" in data else current["deny"]
        allow = _host_list(data["allow"]) if "allow" in data else current["allow"]
        self.hive.db.execute("INSERT INTO web_settings(id, deny, allow, updated_at, updated_by) VALUES (1, ?, ?, ?, ?) "
                             "ON CONFLICT(id) DO UPDATE SET deny = excluded.deny, allow = excluded.allow, "
                             "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
                             (json.dumps(deny), json.dumps(allow), now(), str(by)[:200]))
        return self.settings()

    def _host_rules(self, host, rules):
        if any(host_matches(host, e) for e in rules["deny"]):
            raise _refuse(f"{host} is on this hive's list of sites minds may not fetch")
        if rules["allow"] and not any(host_matches(host, e) for e in rules["allow"]):
            raise _refuse(f"{host} is not on this hive's list of sites minds may fetch")

    # -- breaker (as media.py's) --

    def breaker(self, agent_id):
        row = self.hive.db.one("SELECT * FROM web_breakers WHERE agent_id = ?", (agent_id,))
        return dict(row) if row else None

    def _count_refusal(self, agent_id, reason):
        """One more safety refusal. The breaker opens at breaker_refusals() of them within breaker_window() seconds (a
        sliding window, so good fetches in between do not hide a run of probes). True if this one opened it."""
        db, moment = self.hive.db, time.time()
        with db.transaction():
            open_ = db.one("SELECT tripped_at FROM web_breakers WHERE agent_id = ?", (agent_id,))
            if open_ and open_["tripped_at"]:
                return False                # already paused: nothing more to count, and no rows to grow
            db.execute("DELETE FROM web_strikes WHERE agent_id = ? AND at < ?", (agent_id, moment - breaker_window()))
            db.execute("INSERT INTO web_strikes(agent_id, at) VALUES (?, ?)", (agent_id, moment))
            count = db.one("SELECT COUNT(*) AS n FROM web_strikes WHERE agent_id = ?", (agent_id,))["n"]
            db.execute("INSERT INTO web_breakers(agent_id, consecutive) VALUES (?, ?) "
                       "ON CONFLICT(agent_id) DO UPDATE SET consecutive = excluded.consecutive", (agent_id, count))
            row = db.one("SELECT tripped_at FROM web_breakers WHERE agent_id = ?", (agent_id,))
            if row["tripped_at"] or count < breaker_refusals():
                return False
            minutes = max(1, breaker_window() // 60)
            db.execute("UPDATE web_breakers SET tripped_at = ?, reason = ? WHERE agent_id = ?",
                       (now(), f"{count} refused web requests within {minutes} minutes, the last: {reason}"[:300], agent_id))
        return True

    def reset(self, agent_id, by, reason):
        reason = str(reason or "").strip()
        if not reason:
            raise ValueError("a reason is required")
        db = self.hive.db
        with db.transaction():
            row = db.one("SELECT tripped_at FROM web_breakers WHERE agent_id = ?", (agent_id,))
            if not row or not row["tripped_at"]:
                raise ValueError("this mind's web access is not paused")
            db.execute("DELETE FROM web_strikes WHERE agent_id = ?", (agent_id,))
            db.execute("UPDATE web_breakers SET consecutive = 0, tripped_at = NULL, reason = NULL, reset_at = ?, reset_by = ?, "
                       "reset_reason = ? WHERE agent_id = ?", (now(), str(by)[:200], reason[:500], agent_id))
        return self.breaker(agent_id)

    # -- admission --

    def _limits(self, agent, cost):
        """The mind's own budget and every limit that applies to it (budgets.applicable: hive, mind, swarm, person, by
        month or day), refusing once one is used up or this call's price would cross it. Never reserves or records."""
        hive = self.hive
        budget, spent = agent.get("budget_usd") or 0.0, agent.get("spent_usd") or 0.0
        if budget and spent + cost >= budget:
            raise WebError(402, "budget_exhausted", f"{agent['name']} has used its ${budget:.2f} budget, so web access "
                           "is paused until a person raises it")
        payer, own_key = hive.payer_for(agent)
        for scope, period, limit, _origin in hive.budgets.applicable(agent, None, payer, own_key):
            used = hive.budgets.spent(scope, period)
            if used + cost >= limit:
                label = {"day": "today", "month": "this month", "total": "in total"}.get(period, period)
                raise WebError(402, "spend_limit", f"a spending limit is used up ({scope}: ${used:.2f} of ${limit:.2f} "
                               f"{label}), so web access is paused until it resets or a person raises it")

    def _admit(self, agent, tool, skill, command, cost):
        open_ = self.breaker(agent["id"])
        if open_ and open_["tripped_at"]:
            raise WebError(423, "web_paused", "web access is paused for this mind until an admin resets it: "
                           f"{open_['reason']}")
        self.hive.policy.enforce(agent, skill, command)
        self.hive.person_swarms.require_current(agent["id"])
        self._limits(agent, cost)
        turn = self._turn(agent["id"])
        cap = turn_max_fetches() if tool == "fetch" else turn_max_searches()
        if turn[tool] >= cap:
            noun = "fetches" if tool == "fetch" else "searches"
            raise WebError(429, "turn_cap", f"this turn has used its {cap} web {noun}; use what you have, or continue "
                           "next turn")
        turn[tool] += 1

    def _research_room(self, agent):
        """For a researcher, the bytes its next web result may add (Research.fit_fetch), or None for any other mind, an
        unpriced model or calls no limit holds. Below MIN_FETCH_BYTES the limits on its calls leave room only for its
        report: it is told to write it now."""
        from .research import MIN_FETCH_BYTES   # at call time: research.py reads this module's audit
        research = getattr(self.hive, "research", None)
        room = research.fit_fetch(agent) if research is not None else None
        if room is not None and room < MIN_FETCH_BYTES:
            raise WebError(402, "research_budget_low", research.report_now(agent), safety=False)
        return room

    # -- audit --

    def _audit(self, agent_id, turn, tool, outcome, started, *, research_claim=None, **fields):
        """One row per call. URLs keep scheme, host and path only. A refusal with the same reason as one this mind had
        in the last AUDIT_COLLAPSE_SECONDS adds to that row's count instead of a new row, so refused calls cannot grow
        the table without bound."""
        stamp, db = now(), self.hive.db
        reason = str(fields["reason"])[:300] if fields.get("reason") is not None else None
        if outcome == "refused" and reason is not None:
            cutoff = (datetime.now(timezone.utc) - timedelta(seconds=AUDIT_COLLAPSE_SECONDS)).isoformat(
                timespec="milliseconds").replace("+00:00", "Z")
            with db.transaction():
                last = db.one("SELECT id FROM web_audit WHERE agent_id = ? AND tool = ? AND outcome = 'refused' AND reason = ? "
                              "AND COALESCE(last_at, at) >= ? ORDER BY id DESC LIMIT 1", (agent_id, tool, reason, cutoff))
                if last is not None:
                    db.execute("UPDATE web_audit SET count = count + 1, last_at = ? WHERE id = ?", (stamp, last["id"]))
                    return
        row = {"at": stamp, "agent_id": agent_id, "turn": turn, "tool": tool, "outcome": outcome,
               "elapsed_ms": int((self.clock() - started) * 1000)}
        for key in ("query", "status", "bytes", "content_type", "results", "provider"):
            if fields.get(key) is not None:
                row[key] = fields[key]
        if isinstance(row.get("query"), str):
            row["query"] = row["query"][:AUDIT_QUERY_CHARS]
        if reason is not None:
            row["reason"] = reason
        if fields.get("final_url"):
            row["final_url"] = audit_url(fields["final_url"])
            try:
                parts = urlsplit(str(fields["final_url"]))
                row["final_query"] = int(bool(parts.query or parts.fragment))
            except ValueError:
                row["final_query"] = 1
        row["urls"] = json.dumps([audit_url(u) for u in list(fields.get("urls") or [])[: MAX_REDIRECTS + 2]])
        research = getattr(self.hive, "research", None)
        admission = (research.prepare_fetch_credit(agent_id, research_claim, stamp)
                     if research_claim is not None and row.get("final_url") else None)
        if admission is not None:
            with db.transaction():
                audit_id = db.insert("web_audit", row)
                research.fetched(agent_id, research_claim, audit_id, row["final_url"], stamp, admission)
        else:
            db.insert("web_audit", row)

    def audit(self, agent_id=None, limit=100):
        try:
            limit = max(1, min(int(limit or 100), 500))
        except (TypeError, ValueError):
            raise ValueError("limit is a whole number from 1 to 500") from None
        if agent_id:
            rows = self.hive.db.all("SELECT * FROM web_audit WHERE agent_id = ? ORDER BY id DESC LIMIT ?", (agent_id, limit))
        else:
            rows = self.hive.db.all("SELECT * FROM web_audit ORDER BY id DESC LIMIT ?", (limit,))
        out = []
        for r in rows:
            item = dict(r)
            item["urls"] = json.loads(item["urls"] or "[]")
            out.append(item)
        return out

    def _refused(self, agent, turn, tool, exc, started, **fields):
        """Audit a refusal; a safety refusal counts toward the breaker and may open it."""
        tripped = False
        if exc.safety:
            tripped = self._count_refusal(agent["id"], exc.message)
        if exc.code == "web_paused":
            fields = {}                     # while paused, only the refusal itself is counted (no URLs or queries)
        self._audit(agent["id"], turn, tool, "refused" if exc.status < 500 else "error", started,
                    reason=exc.audit, **fields)
        if tripped:
            with contextlib.suppress(Exception):
                self.hive.events.publish("web.breaker_tripped", agent=agent["id"], agent_id=agent["id"], reason=exc.message)
            exc.message += " (web access is now paused for this mind until an admin resets it)"

    # -- search --

    async def _run_search(self, provider, query, n):
        """The provider's call on the search pool, inside one deadline of TOTAL_SECONDS for the whole search. When every
        worker is taken the search waits for one within that deadline, and is refused only once it has passed: a
        refusal at once failed the searches of an Ask research whose minds searched together. A call that outlives
        its deadline keeps its worker until it ends, so the engines never get more than SEARCH_WORKERS searches from
        this hive at once."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + TOTAL_SECONDS
        if self.search_slots is None or self.search_slots[0] is not loop:
            self.search_slots = (loop, asyncio.Semaphore(SEARCH_WORKERS))
        slots = self.search_slots[1]
        try:
            await asyncio.wait_for(slots.acquire(), max(0.0, deadline - loop.time()))
        except asyncio.TimeoutError:
            raise WebError(503, "search_busy", "the search service is busy; try again in a moment") from None
        if loop.time() >= deadline:
            slots.release()
            raise WebError(503, "search_busy", "the search service is busy; try again in a moment")

        def done(_future):
            with contextlib.suppress(RuntimeError):     # the loop is closed once the hive has stopped
                loop.call_soon_threadsafe(slots.release)
        try:
            future = self.search_pool.submit(provider.search, query, n)
        except BaseException:
            slots.release()
            raise
        future.add_done_callback(done)
        return await asyncio.wait_for(asyncio.wrap_future(future), deadline - loop.time())


    async def search(self, agent, data):
        started, turn = self.clock(), self.turn_label(agent["id"])
        query = data.get("query")
        try:
            if set(data) - {"query", "max_results"}:
                raise WebError(400, "bad_request", "send query and, optionally, max_results")
            if not isinstance(query, str) or not query.strip():
                raise WebError(400, "bad_request", "give something to search for")
            query = " ".join(query.split())
            if len(query) > MAX_QUERY:
                raise WebError(400, "bad_request", f"a search is limited to {MAX_QUERY} characters")
            n = data.get("max_results", DEFAULT_RESULTS)
            if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= MAX_RESULTS:
                raise WebError(400, "bad_request", f"max_results is 1 to {MAX_RESULTS}")
            provider = self.provider
            if provider is None:
                raise WebError(503, "search_unavailable", "this hive has no web search service set up")
            self._admit(agent, "search", "web-search", f"(web-search {json.dumps(query)})", provider.cost_usd)
            room = self._research_room(agent)
            turn = self.turn_label(agent["id"])
            try:
                rows = await self._run_search(provider, query, n)
            except ImportError:
                raise WebError(503, "search_unavailable", "web search is not installed on this hive") from None
            except asyncio.TimeoutError:
                raise WebError(504, "search_timeout", f"the search service did not answer within {int(TOTAL_SECONDS)} "
                               "seconds") from None
            except WebError:
                raise
            except Exception as exc:  # noqa: BLE001 - the provider's own failure, said plainly
                raise WebError(502, "search_failed", f"the search service could not answer ({type(exc).__name__})") from None
        except WebError as exc:
            self._refused(agent, turn, "search", exc, started, query=query if isinstance(query, str) else None,
                          provider=getattr(self.provider, "name", None))
            raise
        except HiveError as exc:            # the skill policy or the mind's person binding refused it
            self._audit(agent["id"], turn, "search", "refused", started, reason=str(exc.message),
                        query=query if isinstance(query, str) else None)
            raise
        results = []
        for r in rows[:n]:
            url = str(r.get("url") or "")
            if not url.lower().startswith(("https://", "http://")):
                continue
            results.append({"title": str(r.get("title") or "")[:300], "url": url[:MAX_URL],
                            "snippet": str(r.get("snippet") or "")[:600]})
        if room is not None:   # a researcher reads only the results its next call can carry
            while results and len(json.dumps(json.dumps(results, ensure_ascii=False), ensure_ascii=False).encode()) > room:
                results.pop()
        searched_at = utc_now()
        self._audit(agent["id"], turn, "search", "ok", started, query=query, results=len(results), provider=provider.name,
                    urls=[r["url"] for r in results])
        return {"query": query, "provider": provider.label, "searched_at": searched_at, "results": results}

    # -- fetch --

    async def _vet(self, url, rules, resolved):
        """(host, target, display, ip) for one hop: the URL's rules, the host lists, and every resolved address public.
        ``resolved`` holds this call's answers, so a name is resolved once per fetch and never again."""
        host, target, display, literal = parse_url(url)
        self._host_rules(host, rules)
        if literal:
            addresses = [host]
        elif host in resolved:
            addresses = resolved[host]
        else:
            try:
                addresses = list(await self.resolver(host))
            except (OSError, UnicodeError):
                raise not_reachable(host, "the name could not be resolved", strike=False) from None
            resolved[host] = addresses
        if not addresses:
            raise not_reachable(host, "the name has no address", strike=False) from None
        for address in addresses:
            why = address_refusal(address)
            if why:
                raise not_reachable(host, f"resolves to {address}, {why}")
        return host, target, display, addresses[0]

    async def _get(self, url, rules, resolved, deadline, cap, urls, kinds=None):
        """Follow up to MAX_REDIRECTS vetted hops. Returns (status, headers, body, truncated, final_display)."""
        hops = 0
        while True:
            host, target, display, ip = await self._vet(url, rules, resolved)
            urls.append(display)
            if kinds is not None:
                await self._robots_allow(host, target, rules, resolved, deadline)
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise asyncio.TimeoutError
            # identity only: a compressed answer could inflate far past the body cap before the cap sees it
            headers = {"User-Agent": USER_AGENT, "Accept-Encoding": "identity",
                       "Accept": ", ".join(sorted(kinds or ["text/plain"])) + ";q=0.9, */*;q=0.1"}
            async with self.connector.stream(ip, host, target, headers, remaining) as (status, rheaders, chunks):
                if status in (301, 302, 303, 307, 308):
                    location = rheaders.get("location")
                    if not location:
                        return status, rheaders, b"", False, display
                    hops += 1
                    if hops > MAX_REDIRECTS:
                        raise _refuse(f"the page redirected more than {MAX_REDIRECTS} times")
                    url = urljoin(display, location.strip())
                    continue
                encoding = (rheaders.get("content-encoding") or "").strip().lower()
                if encoding not in ("", "identity"):
                    raise WebError(415, "compressed", "the site sent a compressed answer though it was asked not to, so it "
                                   "is not read", {"status": status, "final_url": display})
                ctype = (rheaders.get("content-type") or "").split(";")[0].strip().lower()
                if kinds is not None and 200 <= status < 300 and ctype not in kinds:
                    shown = ctype or "an unnamed type"
                    raise WebError(415, "unsupported_type", f"the page is {shown}; only web pages, plain text, JSON and "
                                   "PDF are read", {"status": status, "content_type": ctype, "final_url": display})
                body, truncated = bytearray(), False
                if 200 <= status < 300:
                    async for chunk in chunks:
                        room = cap - len(body)
                        if len(chunk) > room:
                            body.extend(chunk[:room])
                            truncated = True
                            break
                        body.extend(chunk)
                return status, rheaders, bytes(body), truncated, display

    async def _robots_allow(self, host, target, rules, resolved, deadline):
        cached = self.robots.get(host)
        if cached is None or cached[0] <= self.clock():
            verdict, ttl = await self._robots_fetch(host, rules, resolved, deadline)
            if len(self.robots) >= ROBOTS_CACHE_MAX:
                self.robots.clear()
            self.robots[host] = cached = (self.clock() + ttl, verdict)
        verdict = cached[1]
        allowed = verdict if isinstance(verdict, bool) else verdict.can_fetch(ROBOTS_AGENT, f"https://{host}{target}")
        if not allowed:          # a site's own verdict: refused, but never counted toward the mind's breaker
            raise _refuse(f"{host} asks robots not to fetch that page (robots.txt), so it is not fetched", safety=False)

    async def _robots_fetch(self, host, rules, resolved, deadline):
        """RFC 9309: 2xx parsed; 4xx (none there) allows everything; 5xx or no answer disallows, briefly cached."""
        netloc = f"[{host}]" if ":" in host else host
        try:
            status, _h, body, _t, _final = await self._get(f"https://{netloc}/robots.txt", rules, resolved, deadline,
                                                           ROBOTS_CAP, [])
        except asyncio.TimeoutError:
            raise
        except WebError as exc:
            if exc.safety:
                raise
            return False, ROBOTS_ERROR_TTL
        except Exception:  # noqa: BLE001 - unreachable: disallow, briefly
            return False, ROBOTS_ERROR_TTL
        if 200 <= status < 300:
            parser = urllib.robotparser.RobotFileParser()
            parser.parse(body.decode("utf-8", "replace").splitlines())
            return parser, ROBOTS_TTL
        if 400 <= status < 500 or status in (301, 302, 303, 307, 308):
            return True, ROBOTS_TTL
        return False, ROBOTS_ERROR_TTL

    async def fetch(self, agent, data):
        started, turn = self.clock(), self.turn_label(agent["id"])
        url = data.get("url")
        urls, fields = [], {}
        try:
            if set(data) - {"url", "max_chars"}:
                raise WebError(400, "bad_request", "send url and, optionally, max_chars")
            if not isinstance(url, str):
                raise WebError(400, "bad_request", "give a web address to fetch")
            max_chars = data.get("max_chars", DEFAULT_CHARS)
            if isinstance(max_chars, bool) or not isinstance(max_chars, int) or not 100 <= max_chars <= MAX_CHARS:
                raise WebError(400, "bad_request", f"max_chars is 100 to {MAX_CHARS}")
            parse_url(url)          # a malformed or non-https address is refused before anything is counted
            self._admit(agent, "fetch", "web-fetch", f"(web-fetch {json.dumps(url[:500])})", 0.0)
            room = self._research_room(agent)
            research = getattr(self.hive, "research", None)
            claim = research.fetch_claim(agent["id"]) if research is not None else None
            turn = self.turn_label(agent["id"])
            rules, resolved = self.settings(), {}
            deadline = self.clock() + TOTAL_SECONDS
            try:
                # one deadline for everything: robots.txt, every hop, and reading the page (decode, HTML, PDF)
                async with asyncio.timeout(TOTAL_SECONDS):
                    status, headers, body, truncated, final = await self._get(url, rules, resolved, deadline, BODY_CAP,
                                                                              urls, kinds=set(CONTENT_KINDS))
                    fields.update(final_url=final, status=status, bytes=len(body))
                    ctype = (headers.get("content-type") or "").split(";")[0].strip().lower()
                    fields["content_type"] = ctype or None
                    if not 200 <= status < 300:
                        raise WebError(502, "site_status", f"the site answered with status {status}",
                                       {"status": status, "final_url": final})
                    kind = CONTENT_KINDS[ctype]
                    title = ""
                    if kind == "pdf":
                        if truncated:
                            raise WebError(413, "too_large", f"the PDF is larger than {_size(BODY_CAP)}, so it is not read")
                        text = await pdf_text(body, deadline - self.clock(), agent["id"])
                        if text is None:
                            raise WebError(415, "unsupported_type", "this hive cannot read PDF text yet")
                        text = await asyncio.to_thread(_tidy, text)
                    else:
                        title, text = await asyncio.to_thread(decode_page, body, headers.get("content-type"), kind)
            except (asyncio.TimeoutError, TimeoutError, httpx.TimeoutException):
                raise WebError(504, "fetch_timeout", f"the page did not arrive within {int(TOTAL_SECONDS)} seconds") from None
            except (httpx.HTTPError, OSError) as exc:
                raise WebError(502, "fetch_failed", f"the site could not be reached ({type(exc).__name__})") from None
        except WebError as exc:
            if isinstance(exc.details, dict):
                fields.setdefault("final_url", exc.details.get("final_url"))
                fields.setdefault("status", exc.details.get("status"))
                fields.setdefault("content_type", exc.details.get("content_type"))
            self._refused(agent, turn, "fetch", exc, started, urls=urls or ([url[:MAX_URL]] if isinstance(url, str) else []),
                          **fields)
            raise
        except HiveError as exc:            # the skill policy or the mind's person binding refused it
            self._audit(agent["id"], turn, "fetch", "refused", started, reason=str(exc.message),
                        urls=[url[:MAX_URL]] if isinstance(url, str) else [])
            raise
        except Exception as exc:  # noqa: BLE001 - anything unforeseen is a plain failure, audited, never a body
            error = WebError(502, "fetch_failed", f"the page could not be read ({type(exc).__name__})")
            self._refused(agent, turn, "fetch", error, started, urls=urls or ([url[:MAX_URL]] if isinstance(url, str) else []),
                          **fields)
            raise error from None
        kept = fit_text(text[:max_chars], room) if room is not None else text[:max_chars]
        cut = len(text) > len(kept)
        result = {"url": url, "final_url": final, "title": title, "content_type": ctype, "fetched_at": utc_now(),
                  "status": status, "bytes": len(body), "truncated": truncated or cut, "redirects": len(urls) - 1,
                  "text": kept}
        if claim is None:
            self._audit(agent["id"], turn, "fetch", "ok", started, urls=urls, **fields)
        else:
            await asyncio.to_thread(self._audit, agent["id"], turn, "fetch", "ok", started,
                                    urls=urls, research_claim=claim, **fields)
        return result
