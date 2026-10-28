"""Sign-in through the companion webhost, and what a request from outside this machine may do.

The hive binds 127.0.0.1.  Anything that arrives through the public tunnel is *public*: it came in
under a base-path prefix (HIVE_BASE_PATH) or carries a proxy header (Cf-Ray, Cf-Connecting-Ip,
X-Forwarded-For).  Public requests:

- cannot log in with the operator password (unless HIVE_PUBLIC_PASSWORD=1);
- cannot reach agent routes (the hub, the LLM gateway, /api/agent/*): minds connect locally only;
- are operators only with a hive session that was issued by sign-in (``kind = 'sso'``), for an
  allowed person, and that has not expired.

Sign-in reuses the companion webhost's session (cookie ``omega_session``, Google login): the hive reads
the webhost's sessions and users files read-only and never writes them.  A cookie alone never
authorizes an API call; POST /api/auth/sso exchanges it for a short-lived hive token.
"""

from __future__ import annotations

import json
import os
import pathlib
import time
from http.cookies import SimpleCookie

PROXY_HEADERS = (b"cf-ray", b"cf-connecting-ip", b"x-forwarded-for")
AGENT_PREFIXES = ("/agent-hub", "/llm/", "/api/agent/")
SESSION_COOKIE = "omega_session"


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
                # listed webhost admins may use the legacy webhost principal; anyone else needs a hive person or invite
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
