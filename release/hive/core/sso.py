# Purpose: sign-in through the family webhost, and which requests are local (from this machine, directly) or public,
# with what a public request may never do.
"""Sign-in through the family webhost, and what a request from outside this machine may do.

The hive binds 127.0.0.1.  A request is *local* only when all of these hold, and *public* otherwise
(PublicGate.is_public, the one place that decides; every local-only check reads its ``hive_public``):

- it reached the listener from this machine: its connection's peer is a loopback address, or it has no
  network peer at all (a unix socket, or an in-process caller);
- for a network peer, its Host names this machine (a loopback address, ``localhost`` or a ``.localhost``
  name), so a page that rebinds its own domain to 127.0.0.1 is not local, and an Origin, when it sends one,
  is the same origin as that Host, so a page from another site, or a sandboxed app frame (Origin ``null``),
  is not local either even though the browser sending it runs here;
- nothing relayed it: no base-path prefix (HIVE_BASE_PATH) and no header a proxy adds (RELAY_HEADERS).

A header can only make a request public, never local, and the peer comes from the connection, which a
client cannot choose: through the tunnel or a reverse proxy the peer is the proxy on this machine and its
headers mark the request; a direct connection from another machine (HIVE_HOST bound beyond loopback) has a
peer that is not loopback.  uvicorn rewrites the peer from X-Forwarded-For only for its trusted proxies
(--forwarded-allow-ips, the loopback addresses by default), and such a request carries that header, so it
is public either way.  A local process can mark its own requests public; that only takes its own local rights away.
Public requests:

- cannot log in with the operator password (unless HIVE_PUBLIC_PASSWORD=1);
- with HIVE_PUBLIC_PASSWORD=1, wait after each wrong password before the next one is checked, and lose the
  password login after 100 wrong in a row until a sign-in on this machine or a rotation (PasswordAttempts);
- cannot reach agent routes (the hub, the LLM gateway, /api/agent/*): minds connect locally only;
- are operators only with a hive session that was issued by sign-in (``kind = 'sso'``), for an
  allowed person, and that has not expired.  The operator password's session (``kind = 'password'``)
  never counts from outside, wherever it was made, HIVE_PUBLIC_PASSWORD=1 included: that flag opens
  passwords to members, never to the operator;
- member password sessions count from outside only with HIVE_PUBLIC_PASSWORD=1 and Google sign-in off.
  Wrong guesses use the same bounded identifier counters for member and unknown emails, whose counts
  decay rather than reset (AccountAttempts).

Sign-in reuses the family webhost's session (cookie ``omega_session``, Google login): the hive reads
the webhost's sessions and users files read-only and never writes them.  A cookie alone never
authorizes an API call; POST /api/auth/sso exchanges it for a short-lived hive token.
"""

from __future__ import annotations

import ipaddress
import json
import os
import pathlib
import re
import time
from collections import OrderedDict
from http.cookies import SimpleCookie

# Headers a relaying proxy adds, lowercased as ASGI gives them: RFC 7239's Forwarded; Via, which RFC 9110 section
# 7.6.3 says a proxy must send in every message it forwards; the X-Forwarded-* family (-For, -Host, -Proto, -Port,
# -Prefix ...); and the client-address headers of the proxies a hive is put behind: Cloudflare's CF-* (its tunnel adds
# Cf-Ray and Cf-Connecting-Ip to every request), nginx's X-Real-IP, Akamai's True-Client-IP, Fastly-Client-IP,
# X-Client-IP, X-Cluster-Client-IP, and Tailscale serve's Tailscale-* identity headers. Any one of them marks a request
# relayed. A same-machine proxy that adds none and strips the base path cannot be told apart from a local browser;
# deploy/RUNBOOK.md's proxy settings keep the prefix and send X-Forwarded-For.
RELAY_HEADERS = frozenset({b"forwarded", b"via", b"x-real-ip", b"true-client-ip", b"fastly-client-ip", b"x-client-ip",
                           b"x-cluster-client-ip"})
RELAY_PREFIXES = (b"x-forwarded-", b"cf-", b"tailscale-")
AGENT_PREFIXES = ("/agent-hub", "/llm/", "/api/agent/")
# A Host value (RFC 9110 7.2: uri-host [":" port]) and a serialized Origin (RFC 6454 6.1), lowercased first. Anything
# else, userinfo, a path or an Origin of "null" included, is not this machine's and so is never local.
_AUTHORITY = r"(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?"
_HOST = re.compile(_AUTHORITY)
_ORIGIN = re.compile(r"(https?)://" + _AUTHORITY)
_DEFAULT_PORT = {"http": 80, "https": 443}


def relayed(headers):
    """Whether any of these ASGI headers is one a relaying proxy adds (RELAY_HEADERS)."""
    return any(name in RELAY_HEADERS or name.startswith(RELAY_PREFIXES) for name, _ in headers)


def names_this_machine(host):
    """Whether a host (lowercase, an IPv6 address without its brackets) is this machine: a loopback address,
    ``localhost``, or a name under ``.localhost``, which resolvers and browsers keep on this machine (RFC 6761 6.3).
    The same set Jupyter's check_host allows against DNS rebinding, with RFC 6761's subdomains."""
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_loopback


def _authority(match, scheme):
    """(scheme, host, port) from a _HOST or _ORIGIN match: brackets off, the scheme's default port filled in."""
    host, port = match.group(match.re.groups - 1), match.group(match.re.groups)
    host = host[1:-1] if host.startswith("[") else host
    return scheme, host, int(port) if port else _DEFAULT_PORT[scheme]


def direct_local(scope):
    """Whether this request came straight from this machine (the module notes): no network peer at all (a unix
    socket, an in-process caller), or a loopback peer whose one Host names this machine and whose Origin, if it sends
    one, is that same origin. A request with no Host is judged by its peer alone: no browser sends one without it.
    Time: one pass over the headers."""
    client = scope.get("client")
    try:
        peer = ipaddress.ip_address(client[0]) if client else None
    except (TypeError, ValueError, IndexError):
        peer = None                     # not an address: no network peer
    if peer is None:
        return True
    if peer.version == 6 and peer.ipv4_mapped is not None:
        peer = peer.ipv4_mapped
    if not peer.is_loopback:
        return False                    # another machine, however its headers read
    seen = {b"host": [], b"origin": []}
    for name, value in scope.get("headers") or []:
        if name in seen:
            seen[name].append(value.decode("latin-1").strip().lower())
    hosts, origins = seen[b"host"], seen[b"origin"]
    if len(hosts) > 1 or len(origins) > 1:
        return False                    # a repeated Host or Origin is never guessed between
    if not hosts:
        return not origins
    scheme = "https" if scope.get("scheme") in ("https", "wss") else "http"
    host = _HOST.fullmatch(hosts[0])
    if host is None:
        return False
    target = _authority(host, scheme)
    if not names_this_machine(target[1]):
        return False                    # a page that rebound its own name to 127.0.0.1
    if not origins:
        return True
    origin = _ORIGIN.fullmatch(origins[0])
    return origin is not None and _authority(origin, origin.group(1)) == target   # else another site's page
SESSION_COOKIE = "omega_session"


class PasswordAttempts:
    """Wrong operator passwords from outside this machine, the online guessing NIST SP 800-63B 5.2.2 says a verifier
    must limit: after n wrong in a row the next outside attempt is not even checked for 2^(n-1) - 1 seconds (none
    after a single typo, then 1 s, 3 s, 7 s ..., at most an hour, its example's longest wait), and LIMIT in a row
    close the outside password login until the operator signs in on this machine or rotates the password. Attempts on
    this machine never count or wait, so nobody outside can lock the operator out. Kept in memory: a restart starts
    the count again.
    Time: O(1) per attempt; two numbers of state."""

    LIMIT = 100           # NIST SP 800-63B 5.2.2: no more than 100 consecutive failed attempts on one account
    LONGEST_WAIT = 3600   # its example of waits that grow "from 30 seconds up to an hour"

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.failures = 0
        self.not_before = 0.0

    def wait(self):
        """Seconds until the next outside attempt may be checked: 0 now, None while the outside login is closed."""
        if self.failures >= self.LIMIT:
            return None
        return max(0.0, self.not_before - self.clock())

    def failed(self):
        self.failures += 1
        self.not_before = self.clock() + min(2 ** (self.failures - 1) - 1, self.LONGEST_WAIT)

    def reset(self):
        self.failures, self.not_before = 0, 0.0


class AccountAttempts:
    """Wrong member passwords from outside this machine, the online guessing NIST SP 800-63B 5.2.2 says a verifier must
    limit, counted per typed email: app.py keys each by a hash of the email as typed (after strip and lowercase), with
    no membership lookup. Every typed email is counted by the same rules, a member's or not, so neither waits nor
    closures tell which emails belong to someone. Attempts on this machine never count or wait.

    Two numbers count per email. ``failures`` sets the wait: after n of them the next outside attempt for that email is
    not checked for 2^(n-1) - 1 seconds (none after one typo, then 1 s, 3 s, 7 s ..., at most LONGEST_WAIT), omegahive#27's
    schedule for the operator password. It decays, one failure forgiven per LONGEST_WAIT without a new one, and never
    resets after a quiet spell, so guesses paced an hour apart never buy back the short early waits. ``streak`` counts
    the failures since the last right password or an admin's reset (``clear``) and never decays: LIMIT of them close the
    email's outside login until then. It is a number of its own because waits stop growing at LONGEST_WAIT while a
    failure is forgiven every LONGEST_WAIT, so a decaying count levels off near 13 and could never reach LIMIT.

    Kept in memory (a restart starts again) and bounded: an entry goes only by ``clear`` or, past ``cap`` entries, as
    the least recently failed one, waiting or closed ones last.
    Time: O(1) per attempt, plus an O(cap) scan when the table is full; at most ``cap`` entries of four numbers."""

    LIMIT = 100           # NIST SP 800-63B 5.2.2: no more than 100 consecutive failed attempts on one account
    LONGEST_WAIT = 3600   # its example of waits that grow "from 30 seconds up to an hour"; also one forgiven failure
    CAP = 10000

    def __init__(self, clock=time.monotonic, cap=CAP):
        self.clock, self.cap = clock, cap
        # key -> [failures, not_before, last_failed, streak], least recently failed first
        self._entries = OrderedDict()

    def __len__(self):
        return len(self._entries)

    def keys(self):
        return list(self._entries)

    def _failures(self, entry, now):
        """``failures`` as of now: one forgiven per whole LONGEST_WAIT since the last failure."""
        return max(0, entry[0] - int((now - entry[2]) // self.LONGEST_WAIT))

    def wait(self, key):
        """Seconds until the next outside attempt for ``key`` may be checked: 0 now, None while it is closed."""
        entry = self._entries.get(key)
        if entry is None:
            return 0.0
        if entry[3] >= self.LIMIT:
            return None
        return max(0.0, entry[1] - self.clock())

    def failed(self, key):
        now = self.clock()
        entry = self._entries.pop(key, None)
        failures, streak = (self._failures(entry, now), entry[3]) if entry is not None else (0, 0)
        failures += 1
        self._entries[key] = [failures, now + min(2 ** (failures - 1) - 1, self.LONGEST_WAIT), now, streak + 1]
        self._prune(now)

    def clear(self, key):
        self._entries.pop(key, None)

    def _prune(self, now):
        while len(self._entries) > self.cap:
            for spare in (lambda e: e[3] < self.LIMIT and e[1] <= now, lambda e: e[3] < self.LIMIT, lambda e: True):
                key = next((k for k, e in self._entries.items() if spare(e)), None)
                if key is not None:
                    del self._entries[key]
                    break


class SSO:
    def __init__(self, settings):
        root = pathlib.Path(os.environ.get("HIVE_SSO_STATE_DIR", pathlib.Path.home() / "omega-webhost/OmegaClaw/runtime/webhost"))
        self.sessions_file = root / "sessions.json"
        self.users_file = root / "users.json"
        self.allowed = {u.strip().lower() for u in os.environ.get("HIVE_SSO_USERS", "").split(",") if u.strip()}
        self.login_url = os.environ.get("HIVE_SSO_LOGIN_URL", "/login?next={next}")
        self.ttl = int(float(os.environ.get("HIVE_SSO_TTL_HOURS", "12")) * 3600)
        self.public_password = os.environ.get("HIVE_PUBLIC_PASSWORD", "") == "1"
        self.prefixes = [p for p in settings.base_path.split(",") if p]

    @property
    def enabled(self):
        return bool(self.allowed) and self.sessions_file.exists()

    @staticmethod
    def _read(path):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def person(self, cookie_header):
        """The signed-in, allowed person behind a webhost cookie, or None."""
        if not self.enabled or not cookie_header:
            return None
        jar = SimpleCookie()
        try:
            jar.load(cookie_header)
        except Exception:
            return None
        token = jar.get(SESSION_COOKIE)
        if token is None or not token.value:
            return None
        session = self._read(self.sessions_file).get(token.value)
        now = int(time.time())
        if not isinstance(session, dict) or int(session.get("expires", 0) or 0) <= now:
            return None
        username = "".join(ch for ch in str(session.get("username", "")).lower() if ch.isalnum())
        user = self._read(self.users_file).get(username)
        if not isinstance(user, dict):
            return None
        for key in ("expires", "asset_access_expires"):
            if user.get(key) and int(user[key]) <= now:
                return None
        return {"username": username, "name": user.get("name") or username, "role": user.get("role") or "member",
                "email": str(user.get("google_email") or "").strip().lower() if user.get("google_linked_at") else "",
                # listed family admins may use the legacy family principal; anyone else needs a hive person or invite
                "allowed": username in self.allowed,
                "expires": min(int(session["expires"]), now + self.ttl)}

    def login_location(self, next_path):
        return self.login_url.format(next=next_path)


class PublicGate:
    """ASGI middleware: marks public requests and refuses what they may never do."""

    def __init__(self, app, sso: SSO):
        self.app, self.sso = app, sso

    def is_public(self, scope):
        """Public unless the request is local (the module notes): under a base-path prefix, relayed by a proxy, or not
        straight from this machine."""
        path = scope.get("path", "")
        if any(path == p or path.startswith(p + "/") for p in self.sso.prefixes):
            return True
        return relayed(scope.get("headers") or []) or not direct_local(scope)

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        if scope["type"] == "http" and path in self.sso.prefixes:
            # "/omegahive" without its slash would resolve the page's relative assets against the site
            # root, where they do not exist: send the browser to "/omegahive/".
            query = scope.get("query_string", b"")
            location = (path + "/" + ("?" + query.decode("latin-1") if query else "")).encode("latin-1")
            await send({"type": "http.response.start", "status": 308,
                        "headers": [(b"location", location), (b"content-length", b"0"), (b"cache-control", b"no-cache")]})
            await send({"type": "http.response.body", "body": b""})
            return
        public = self.is_public(scope)
        scope["hive_public"] = public
        if public:
            path = scope.get("path", "")
            for prefix in self.sso.prefixes:
                if path == prefix or path.startswith(prefix + "/"):
                    path = path[len(prefix):] or "/"
                    break
            raw = scope.get("raw_path") or b""
            refuse = None
            if b"/.." in raw or b"%2e%2e" in raw.lower() or "/.." in path:
                refuse = (400, "bad_path", "path traversal is not allowed")
            elif any(path == a.rstrip("/") or (a.endswith("/") and path.startswith(a)) for a in AGENT_PREFIXES):
                refuse = (404, "not_found", "minds connect to this hive locally")
            elif path == "/api/auth/login" and not self.sso.public_password:
                refuse = (403, "password_login_local_only", "sign in with your Google account")
            if refuse:
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 4403})
                    return
                status, code, message = refuse
                body = json.dumps({"error": {"code": code, "message": message}}).encode()
                await send({"type": "http.response.start", "status": status,
                            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
                await send({"type": "http.response.body", "body": body})
                return
        return await self.app(scope, receive, send)
