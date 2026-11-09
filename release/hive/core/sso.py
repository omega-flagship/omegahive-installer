"""Sign-in through the family webhost, and what a request from outside this machine may do.

The hive binds 127.0.0.1.  Anything that arrives through the public tunnel is *public*: it came in
under a base-path prefix (HIVE_BASE_PATH) or carries a proxy header (Cf-Ray, Cf-Connecting-Ip,
X-Forwarded-For).  Public requests:

- cannot log in with the operator password (unless HIVE_PUBLIC_PASSWORD=1);
- cannot reach agent routes (the hub, the LLM gateway, /api/agent/*): minds connect locally only;
- are operators only with a hive session that was issued by sign-in (``kind = 'sso'``), for an
  allowed person, and that has not expired.
- member password sessions count from outside only with HIVE_PUBLIC_PASSWORD=1 and Google sign-in off.
  Wrong guesses use the same bounded identifier counters for member and unknown emails.

Sign-in reuses the family webhost's session (cookie ``omega_session``, Google login): the hive reads
the webhost's sessions and users files read-only and never writes them.  A cookie alone never
authorizes an API call; POST /api/auth/sso exchanges it for a short-lived hive token.
"""

from __future__ import annotations

import json
import os
import pathlib
import time
from collections import OrderedDict
from http.cookies import SimpleCookie

PROXY_HEADERS = (b"cf-ray", b"cf-connecting-ip", b"x-forwarded-for")
AGENT_PREFIXES = ("/agent-hub", "/llm/", "/api/agent/")
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
    """Wrong member passwords from outside this machine, counted per account (the email as typed, after strip and
    lowercase), the online guessing NIST SP 800-63B 5.2.2 says a verifier must limit. The schedule is omegahive#27's
    for the operator password: after n wrong in a row the next outside attempt for that account is not checked for
    2^(n-1) - 1 seconds (none after one typo, then 1 s, 3 s, 7 s ..., at most LONGEST_WAIT), and LIMIT in a row close
    the account's outside login until a right local sign-in or an admin's reset (``clear``). An email no person has is
    counted the same way, so waits do not tell which emails exist. Attempts on this machine never count or wait.

    Kept in memory (a restart starts again) and bounded: an entry with no wait left and no failure for LONGEST_WAIT is
    dropped, and past ``cap`` entries the least recently failed one goes, waiting or closed ones last.
    Time: O(1) per attempt, amortized; at most ``cap`` entries of three numbers."""

    LIMIT = 100           # NIST SP 800-63B 5.2.2: no more than 100 consecutive failed attempts on one account
    LONGEST_WAIT = 3600   # its example of waits that grow "from 30 seconds up to an hour"
    CAP = 10000

    def __init__(self, clock=time.monotonic, cap=CAP):
        self.clock, self.cap = clock, cap
        self._entries = OrderedDict()   # key -> [failures, not_before, last_failed], least recently failed first

    def __len__(self):
        return len(self._entries)

    def keys(self):
        return list(self._entries)

    def wait(self, key):
        """Seconds until the next outside attempt for ``key`` may be checked: 0 now, None while it is closed."""
        entry = self._entries.get(key)
        if entry is None:
            return 0.0
        if entry[0] >= self.LIMIT:
            return None
        return max(0.0, entry[1] - self.clock())

    def failed(self, key):
        now = self.clock()
        entry = self._entries.pop(key, None) or [0, 0.0, now]
        entry[0] += 1
        entry[1] = now + min(2 ** (entry[0] - 1) - 1, self.LONGEST_WAIT)
        entry[2] = now
        self._entries[key] = entry
        self._prune(now)

    def clear(self, key):
        self._entries.pop(key, None)

    def _prune(self, now):
        for key, (failures, not_before, last) in list(self._entries.items()):   # least recently failed first
            if last + self.LONGEST_WAIT > now:
                break   # the rest failed more recently
            if failures < self.LIMIT and not_before <= now:
                del self._entries[key]   # idle: no wait left and quiet for LONGEST_WAIT
        while len(self._entries) > self.cap:
            for spare in (lambda e: e[0] < self.LIMIT and e[1] <= now, lambda e: e[0] < self.LIMIT, lambda e: True):
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
        path = scope.get("path", "")
        if any(path == p or path.startswith(p + "/") for p in self.sso.prefixes):
            return True
        return any(name in PROXY_HEADERS for name, _ in scope.get("headers", []))

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
