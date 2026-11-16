"""Views: a saved artifact revision drawn as an interactive MCP Apps view.

A view a mind makes is MeTTa: an artifact of kind ``view`` whose body is MeTTa declarations, a screen in the hive's own
screens vocabulary with the values it works out and what each press does (hive/ui/src/features/views/lib_view.metta).
The hive serves that text to a person shown the artifact, and their browser composes and draws it like the hive's own
screens (``MettaView``); a new revision of it reaches a view already open as it is saved. ``metta_problem`` checks its
shape on save, so a mind hears at once what keeps a view from being drawn.

A view may also be what the MCP Apps extension calls a UI resource: one HTML document with the MIME type
``text/html;profile=mcp-app`` and its ``_meta.ui`` (the domains it may reach, the permissions it asks for, whether it
wants a border). The hive keeps that one representation and derives it from a saved revision (``view_of``):

- an artifact of kind ``view`` whose body is an HTML document, or whose body is that resource as JSON;
- any other artifact whose body is an HTML document, which the person may choose to view instead of reading.

The hive serves the document itself, from its own origin, at ``GET /api/views/<ticket>``. The ticket names one revision
for a short while and grants nothing else (``Tickets``). The document's CSP header is built from the declared domains
(``policy``) and carries the ``sandbox`` directive, so the document has an opaque origin wherever it is opened: it can
never read the hive's storage, where the person's token lives, and the hive's own origin is never among the sources it
may reach. Ahead of the view's own markup the hive adds one script (``document``): an in-memory ``localStorage`` and
``sessionStorage``, which an opaque origin lacks, and the size reports a view written without the MCP Apps SDK never
sends. The specification is modelcontextprotocol/ext-apps, ``specification/2026-01-26/apps.mdx`` and its draft.

No view runs until the person asks it to, and a declared domain is reached only once the person allows it for that
revision (``Grants``): a view a message names, or one opened on Artifacts, shows as a card with Run it until then, the
hive hands out its text or its document only after that click, and an HTML view's document is served with
``connect-src 'none'`` and no declared domain at all until the person allows those domains for that very revision. A
view written in MeTTa reaches no domain ever, so the click to run it covers its later revisions, which arrive live.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import ipaddress
import json
import re
import secrets
import time
from dataclasses import dataclass, field

MCP_APP_MIME = "text/html;profile=mcp-app"

# How long a minted ticket opens its document. The frame loads the document right after the hive mints the ticket;
# the margin covers a slow phone network and a view that reloads itself soon after. The host mints a fresh one each
# time it draws the view.
TICKET_SECONDS = 600

# The permissions a view may ask for (_meta.ui.permissions) that the hive grants, and the iframe allow feature each
# maps to. Camera, microphone and geolocation are declined: the specification lets a host decline and tells views to
# detect features rather than assume them.
GRANTED_PERMISSIONS = {"clipboardWrite": "clipboard-write"}

# The script of the worker each open MeTTa view runs in (hive/ui/src/features/views/viewSandbox.worker.ts, which vite
# builds as assets/viewSandbox.worker-<hash>.js). A worker takes its policy from its own script's response, so the hive
# serves this one with no network and no code generation: the browser then enforces what the worker's own hardening
# (viewSandbox.ts) does, and a view's MeTTa never compiles to JavaScript (MettaScript falls back to its interpreter).
VIEW_WORKER_SCRIPT = re.compile(r"assets/viewSandbox\.worker-[A-Za-z0-9_-]+\.js")
VIEW_WORKER_CSP = "default-src 'none'; script-src 'self'; connect-src 'none'"


class NotAView(ValueError):
    """The revision is meant as a view (its kind says so) but its body is not one; the message says why."""


@dataclass(frozen=True)
class View:
    """One view as the hive serves it. ``carrier`` says where it came from: ``view`` (kind view, HTML body),
    ``resource`` (kind view, the MCP resource as JSON) or ``document`` (another kind whose body is an HTML document)."""
    html: str
    carrier: str
    meta: dict = field(default_factory=dict)


@dataclass(frozen=True)
class MettaView:
    """A view written in MeTTa (kind view, a MeTTa body). It has no document, ticket or CSP of its own: the hive hands its
    text to a person shown the artifact, and their browser composes it (hive/ui/src/features/views/mettaView.ts)."""
    source: str
    carrier: str = "metta"


# WHATWG MIME Sniffing, section 7.1, the first two HTML patterns ("<!DOCTYPE HTML" and "<HTML"), case-insensitive,
# after leading whitespace, followed by a tag-terminating character. The hive treats only a whole document as one; a
# fragment such as "<b>Note</b>" stays text.
_WHITESPACE = "\t\n\x0c\r "
_DOCUMENT_START = re.compile(r"(?:<!doctype\s+html|<html)(?=[\s>])", re.IGNORECASE)


def is_html_document(text: str) -> bool:
    """Whether a saved text is an HTML document: it opens, after an optional byte order mark and whitespace, with an
    HTML doctype or an <html> tag."""
    return bool(_DOCUMENT_START.match(text.lstrip("\ufeff").lstrip(_WHITESPACE)))


def metta_problem(text: str) -> str | None:
    """Why a view's MeTTa cannot be drawn, in words a mind can act on, or None when its shape is sound: every string and
    expression closes, nothing stands at the top level but expressions, none of them starts with ``!`` (a view is
    declarations only, so nothing a mind wrote runs as the view loads), and exactly one ``(Screen name "Title")`` names
    its screen. The person's browser parses and composes the rest (the blocks a view may use, its values, its presses)
    and says what it refuses there. Strings, comments and tokens follow MeTTa's reader: a string closes at an unescaped
    quote, and a ``;`` outside a string comments out the rest of its line.

    Time: O(len(text)), one pass."""
    depth, line, i, n, screens = 0, 1, 0, len(text), 0
    opened = []          # the line each open "(" is on, for the message when one never closes
    head = False         # the next token is the head of a top-level expression
    while i < n:
        ch = text[i]
        if ch == "\n":
            line, i = line + 1, i + 1
        elif ch in _WHITESPACE or ch == "\ufeff":
            i += 1
        elif ch == ";":
            end = text.find("\n", i)
            i = n if end < 0 else end
        elif ch == '"':
            start, j = line, i + 1
            while j < n and text[j] != '"':
                if text[j] == "\n":
                    line += 1
                j += 2 if text[j] == "\\" else 1
            if j >= n:
                return f"line {start}: a string is never closed"
            if depth == 0:
                return f"line {start}: a string stands outside any expression"
            i, head = j + 1, False
        elif ch == "(":
            opened.append(line)
            depth, head, i = depth + 1, depth == 0, i + 1
        elif ch == ")":
            if depth == 0:
                return f"line {line}: a ) closes nothing"
            opened.pop()
            depth, head, i = depth - 1, False, i + 1
        else:
            j = i
            while j < n and text[j] not in _WHITESPACE and text[j] not in '()";':
                j += 1
            token = text[i:j]
            if depth == 0:
                if token.startswith("!"):
                    return f"line {line}: a view holds declarations only, so nothing in it may start with !"
                return f"line {line}: {token[:40]} stands outside any expression"
            if head and token == "Screen":
                screens += 1
            i, head = j, False
    if opened:
        return f"line {opened[-1]}: a ( is never closed"
    if screens == 0:
        return 'a view names its screen first: (Screen <name> "Title")'
    if screens > 1:
        return f"a view names one screen, and this one names {screens}"
    return None


def view_of(kind: str, body: str) -> View | MettaView | None:
    """The view a revision holds, or None when it holds none. An artifact of kind ``view`` whose body is not a usable
    view raises NotAView, so the person is told what is wrong instead of seeing its text as if it were meant as such.
    For kind ``view`` the body's first character decides what it is: ``(``, ``;`` or ``!`` MeTTa (a ``!`` only to be
    told why a view may not start so), ``{`` the MCP resource as JSON, ``<`` an HTML document; anything else is none.

    Time: O(len(body)) for the MeTTa check or the JSON parse, and one prefix match."""
    if kind == "view":
        text = body.lstrip("\ufeff").lstrip(_WHITESPACE)
        if not text:
            raise NotAView("this view has nothing in it")
        if text[0] in "(;!":
            problem = metta_problem(text)
            if problem:
                raise NotAView(problem)
            return MettaView(source=body)
        if text[0] == "{":
            resource = _json_object(body)
            if resource is None:
                raise NotAView("this view starts like JSON but is not one JSON object")
            return _resource_view(resource)
        if text[0] == "<":
            return View(html=body, carrier="view")
        raise NotAView('a view is MeTTa that starts with (Screen <name> "Title"), one HTML document, '
                       "or the MCP resource as JSON")
    if is_html_document(body):
        return View(html=body, carrier="document")
    return None


def _json_object(body: str):
    if not body.lstrip().startswith("{"):
        return None
    try:
        value = json.loads(body)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _resource_view(resource: dict) -> View:
    """A view saved as the MCP resource itself: {"mimeType": "text/html;profile=mcp-app", "text" or "blob", "_meta"}."""
    mime = resource.get("mimeType")
    if not isinstance(mime, str) or re.sub(r"\s+", "", mime).lower() != MCP_APP_MIME:
        raise NotAView(f"a view saved as a resource needs mimeType {MCP_APP_MIME}")
    text, blob = resource.get("text"), resource.get("blob")
    if isinstance(text, str):
        html = text
    elif isinstance(blob, str):
        try:
            html = base64.b64decode(blob, validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError):
            raise NotAView("this view's blob is not base64 of UTF-8 HTML") from None
    else:
        raise NotAView("a view saved as a resource needs its HTML as text or blob")
    if not html.strip():
        raise NotAView("this view has no HTML in it")
    meta = resource.get("_meta")
    ui = meta.get("ui") if isinstance(meta, dict) else None
    return View(html=html, carrier="resource", meta=ui if isinstance(ui, dict) else {})


# ---- the domains a view may reach --------------------------------------------------------------------------------

# An origin with an explicit host and nothing else: a scheme a view may use, then a DNS name (a "*." wildcard only as
# the leftmost label, over at least two labels), an IPv4 literal or a bracketed IPv6 literal, then an optional port.
# This keeps out CSP keywords ('self', 'unsafe-inline'), a bare "*", scheme-only sources ("https:"), paths, and the
# characters ext-apps' reference host refuses because they would end a directive or add a source (; quotes, spaces).
# Matched whole (fullmatch): "$" alone would also accept a trailing newline, which would end the header line.
_LABEL = r"(?!-)[a-z0-9-]{1,63}(?<!-)"
_SOURCE = re.compile(
    rf"(?P<scheme>https|wss|http|ws)://"
    rf"(?P<host>(?P<wild>\*\.)?{_LABEL}(?:\.{_LABEL})*|\[[0-9a-f:.]+\])"
    rf"(?::(?P<port>[0-9]{{1,5}}))?")
_LOOPBACK_NAMES = {"localhost"}


def _host_key(host: str) -> str:
    return host[1:-1] if host.startswith("[") else host


def _is_loopback(host: str) -> bool:
    host = _host_key(host)
    if host in _LOOPBACK_NAMES or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def allowed_source(entry, own_hosts) -> bool:
    """Whether a declared domain may go into the view's CSP: it is an origin with an explicit host, and that host is
    none of the hive's own (``own_hosts``: every name the hive answers at; any port, or under a wildcard that covers
    one) nor, when the hive answers on a loopback address, any loopback address, which reaches the same hive under
    another name."""
    if not isinstance(entry, str):
        return False
    m = _SOURCE.fullmatch(entry.lower())
    if m is None:
        return False
    host, wild = m.group("host"), m.group("wild")
    if m.group("port") is not None and not 0 < int(m.group("port")) < 65536:
        return False
    if host.startswith("["):
        try:
            ipaddress.IPv6Address(host[1:-1])
        except ValueError:
            return False
    elif wild and host.count(".") < 2:
        return False   # "*.com" names every site under a public suffix
    bare = host[2:] if wild else _host_key(host)
    for own in {_host_key((h or "").lower().rstrip(".")) for h in own_hosts} - {""}:
        if bare == own or (wild and own.endswith("." + bare)):
            return False
        if _is_loopback(own) and _is_loopback(bare):
            return False
    return True


def _kept(entries, own_hosts, refused: list) -> list:
    if not isinstance(entries, list):
        if entries is not None:
            refused.append(entries if isinstance(entries, str) else json.dumps(entries)[:200])
        return []
    kept = []
    for e in entries:
        if allowed_source(e, own_hosts):
            if e.lower() not in kept:
                kept.append(e.lower())
        else:
            refused.append(e if isinstance(e, str) else json.dumps(e)[:200])
    return kept


@dataclass(frozen=True)
class Policy:
    """What the hive lets one view do: the CSP header it serves the document with, the declared domains it kept (as
    _meta.ui.csp), the permissions it grants (as _meta.ui.permissions) with the iframe allow value they need, and every
    declared domain or permission it refused, so the frame can say so."""
    header: str
    csp: dict
    permissions: dict
    allow: str
    refused: list


_CSP_KEYS = ("connectDomains", "resourceDomains", "frameDomains", "baseUriDomains")


def policy(meta: dict, own_hosts) -> Policy:
    """The view's policy from its resource's _meta.ui. The directive set is ext-apps' reference host's
    (examples/basic-host/serve.ts, buildCspHeader), which every ext-apps example is tested against, with the hive's
    changes: no 'self' anywhere, since the view's URL is on the hive's own origin; base-uri and frame-src 'none'
    unless declared; the sandbox directive, which gives the document an opaque origin even when its address is opened
    directly; form-action 'none'; and frame-ancestors 'self', so only the hive embeds it."""
    ui = meta if isinstance(meta, dict) else {}
    declared = ui.get("csp") if isinstance(ui.get("csp"), dict) else {}
    refused: list = []
    kept = {key: _kept(declared.get(key), own_hosts, refused) for key in _CSP_KEYS}

    def with_resources(*fixed):   # the fixed sources, then every kept resource domain
        return " ".join([*fixed, *kept["resourceDomains"]])

    def declared_or_none(key):
        return " ".join(kept[key]) or "'none'"

    directives = [
        "sandbox allow-scripts allow-forms",
        "default-src 'none'",
        "script-src " + with_resources("'unsafe-inline'", "'unsafe-eval'", "blob:", "data:"),
        "style-src " + with_resources("'unsafe-inline'", "blob:", "data:"),
        "img-src " + with_resources("data:", "blob:"),
        "font-src " + with_resources("data:", "blob:"),
        "media-src " + with_resources("data:", "blob:"),
        "worker-src " + with_resources("blob:"),
        "connect-src " + declared_or_none("connectDomains"),
        "frame-src " + declared_or_none("frameDomains"),
        "base-uri " + declared_or_none("baseUriDomains"),
        "object-src 'none'",
        "form-action 'none'",
        "frame-ancestors 'self'",
    ]
    asked = ui.get("permissions") if isinstance(ui.get("permissions"), dict) else {}
    granted = {name: {} for name in asked if name in GRANTED_PERMISSIONS}
    refused.extend(f"permission {name}" for name in asked if name not in GRANTED_PERMISSIONS)
    return Policy(header="; ".join(directives), csp={k: v for k, v in kept.items() if v}, permissions=granted,
                  allow="; ".join(GRANTED_PERMISSIONS[name] for name in granted), refused=refused)


# ---- tickets ---------------------------------------------------------------------------------------------------

_DIGITS = re.compile(r"[0-9]{1,18}")   # ASCII only: str.isdigit() also takes "²", which int() then refuses


class Tickets:
    """Short-lived addresses for view documents. A ticket is ``<artifact id>.<revision>.<expiry>.<reach>.<signature>``,
    the signature an HMAC-SHA256 under a key this process makes at start and never stores, so a ticket names exactly one
    revision until it expires or the hive restarts, and grants nothing else: not the person's session, not another
    revision. ``reach`` is 1 when the person who asked for it allowed that revision's declared domains (``Grants``), else
    0; it is signed with the rest, so a ticket cannot be made to reach out. Artifact ids are ``ar_`` and hex
    (db.new_id), so the fields never contain a dot."""

    def __init__(self, key: bytes | None = None, clock=None):
        self._key = key or secrets.token_bytes(32)
        self._clock = clock

    def _now(self) -> float:
        """Seconds since the epoch: the clock given, else time.time read at this call, so a test that moves this
        module's clock moves every ticket's, the hive's own included."""
        return (self._clock or time.time)()

    def _sign(self, payload: str) -> str:
        mac = hmac.new(self._key, payload.encode("utf-8"), hashlib.sha256).digest()
        return base64.urlsafe_b64encode(mac).rstrip(b"=").decode("ascii")

    def mint(self, artifact_id: str, revision: int, reach: bool = False) -> str:
        if "." in artifact_id or not artifact_id:
            raise ValueError("an artifact id never contains a dot")
        payload = f"{artifact_id}.{int(revision)}.{int(self._now()) + TICKET_SECONDS}.{1 if reach else 0}"
        return f"{payload}.{self._sign(payload)}"

    def redeem(self, ticket: str) -> tuple[str, int, bool] | None:
        """(artifact id, revision, reach) for a ticket this process minted and that has not expired, else None."""
        parts = ticket.split(".")
        if len(parts) != 5:
            return None
        artifact_id, revision, expiry, reach, signature = parts
        if not (_DIGITS.fullmatch(revision) and _DIGITS.fullmatch(expiry) and reach in ("0", "1")):
            return None
        if not hmac.compare_digest(signature, self._sign(f"{artifact_id}.{revision}.{expiry}.{reach}")):
            return None
        if int(expiry) < self._now():
            return None
        return artifact_id, int(revision), reach == "1"


# ---- a person's consent ----------------------------------------------------------------------------------------

GRANTS_SCHEMA = """CREATE TABLE IF NOT EXISTS view_grants (artifact_id TEXT NOT NULL, revision INTEGER NOT NULL,
    principal TEXT NOT NULL, reach INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    PRIMARY KEY (artifact_id, revision, principal))"""


class Grants:
    """A person's consent to a view, one row per person and revision: that they asked it to run (their click on Run it),
    and whether they let that revision reach the domains it declares (``reach``). Who it covers is the person who gave
    it, never another. An HTML view is arbitrary code whose next revision can declare new domains, so its consent is
    for one revision; a MeTTa view reaches nothing and its mind's changes arrive while it is open, so a click to run any
    revision of it covers the later ones."""

    def __init__(self, db, now):
        self.db, self._now = db, now
        db.execute(GRANTS_SCHEMA)

    def of(self, artifact_id: str, revision: int, principal: str, carrier: str) -> dict:
        """{ran, reach} for this person and revision of a view (a MeTTa view: ran at any revision)."""
        exact = self.db.one("SELECT reach FROM view_grants WHERE artifact_id = ? AND revision = ? AND principal = ?",
                            (artifact_id, revision, principal))
        if carrier == "metta":
            ran = exact is not None or self.db.one(
                "SELECT 1 FROM view_grants WHERE artifact_id = ? AND principal = ? LIMIT 1", (artifact_id, principal)) is not None
            return {"ran": ran, "reach": False}
        return {"ran": exact is not None, "reach": bool(exact and exact["reach"])}

    def give(self, artifact_id: str, revision: int, principal: str, reach: bool) -> None:
        """Record that this person ran this revision, and allowed its domains when ``reach``; an allowance once given
        for a revision stays (a later click to run does not take it back)."""
        self.db.execute("INSERT INTO view_grants (artifact_id, revision, principal, reach, created_at) VALUES (?,?,?,?,?) "
                        "ON CONFLICT (artifact_id, revision, principal) DO UPDATE SET reach = MAX(reach, excluded.reach)",
                        (artifact_id, revision, principal, 1 if reach else 0, self._now()))


def declared_domains(meta: dict, own_hosts) -> dict:
    """The domains a view declares that the hive would let it reach once allowed: what ``policy`` keeps of them."""
    return policy(meta, own_hosts).csp


def without_domains(meta: dict) -> dict:
    """The view's _meta.ui with its declared domains taken out: what it may do before the person allows them, which is
    to reach nothing (connect-src, frame-src and base-uri 'none'; scripts, styles and images inline or from data and
    blob only). Its permissions (clipboard-write) and border stay."""
    return {key: value for key, value in (meta if isinstance(meta, dict) else {}).items() if key != "csp"}


# ---- the served document ------------------------------------------------------------------------------------------

# Runs ahead of the view's own scripts. Storage: an opaque origin throws on localStorage and sessionStorage, which
# views such as ext-apps' pdf and map examples use, so each gets an in-memory store for as long as the view is open.
# Size: measured as the MCP Apps SDK measures it (ext-apps src/app.ts, App.setupSizeChangedNotifications: max-content
# height, the window's width, sent only on change), so a view written without the SDK still sizes its frame; a view
# that uses the SDK reports the same numbers.
BOOT_SCRIPT = """<script>(function () {
  function memoryStorage() {
    var items = new Map();
    var api = {
      key: function (i) { var keys = Array.from(items.keys()); return i >= 0 && i < keys.length ? keys[i] : null; },
      getItem: function (k) { k = String(k); return items.has(k) ? items.get(k) : null; },
      setItem: function (k, v) { items.set(String(k), String(v)); },
      removeItem: function (k) { items.delete(String(k)); },
      clear: function () { items.clear(); }
    };
    return new Proxy(api, {
      get: function (t, p) { return p === 'length' ? items.size : (p in t || typeof p !== 'string') ? t[p] : (items.has(p) ? items.get(p) : undefined); },
      set: function (t, p, v) { if (typeof p === 'string' && !(p in t)) items.set(p, String(v)); return true; },
      deleteProperty: function (t, p) { items.delete(String(p)); return true; },
      has: function (t, p) { return p in t || items.has(String(p)); },
      ownKeys: function () { return Array.from(items.keys()); },
      getOwnPropertyDescriptor: function (t, p) { return items.has(String(p)) ? { value: items.get(String(p)), writable: true, enumerable: true, configurable: true } : undefined; }
    });
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    try { void window[name].length; } catch (e) {
      Object.defineProperty(window, name, { value: memoryStorage(), configurable: true, enumerable: true });
    }
  });
  var last = '', queued = false;
  function report() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      var html = document.documentElement, before = html.style.height;
      html.style.height = 'max-content';
      var height = Math.ceil(html.getBoundingClientRect().height);
      html.style.height = before;
      var width = Math.ceil(window.innerWidth), now = width + 'x' + height;
      if (now === last) return;
      last = now;
      window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: width, height: height } }, '*');
    });
  }
  function watch() {
    report();
    var seen = new ResizeObserver(report);
    seen.observe(document.documentElement);
    if (document.body) seen.observe(document.body);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();
})();</script>"""

_PROLOG_SKIP = re.compile(r"(?:\s+|<!--.*?-->)*", re.DOTALL)
_DOCTYPE = re.compile(r"<!doctype[^>]*>", re.IGNORECASE)


def boot_at(html: str) -> int:
    """Where the boot script goes: right after the document's doctype when it has one (after a byte order mark,
    whitespace and comments, which may come first), so the doctype stays the first thing the parser sees and the
    document keeps standards mode; otherwise at the very start. Before the view's own <html> and <head>, the script
    lands in the head the parser opens for it, ahead of every script of the view."""
    start = 1 if html.startswith("\ufeff") else 0
    prolog = _PROLOG_SKIP.match(html, start)
    doctype = _DOCTYPE.match(html, prolog.end())
    return doctype.end() if doctype else start


def document(html: str) -> str:
    at = boot_at(html)
    return html[:at] + BOOT_SCRIPT + html[at:]


def resource_uri(artifact_id: str, revision: int) -> str:
    """The ui:// name of one revision's view. A revision never changes, so the name names exactly one document."""
    return f"ui://hive/artifacts/{artifact_id}/r{int(revision)}"


EXPIRED_PAGE = """<!doctype html><html lang="en"><meta charset="utf-8"><title>View closed</title>
<body style="font:14px/1.5 system-ui,sans-serif;margin:24px;color:#555">This view's address has expired. Open it again
from the hive.</body></html>"""

DOCUMENT_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}
EXPIRED_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'"
