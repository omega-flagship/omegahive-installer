"""People, invitations and the hive's own Google sign-in.

The hive is invite only.  An admin invites an email address; the invitation is a single-use link that
expires.  Accepting it means signing in with Google as *that* address (Google must report the email as
verified).  After that the person signs in with Google directly.  People are never created any other
way, except through the domain allowlist below, and a Google account without an invitation or a person record is
refused.

Domain allowlist (``HIVE_SIGNIN_DOMAINS``, a comma list of domains, empty by default = invite only, exactly as before):
a Google account with no person row and no invitation is enrolled as ``member`` (never admin) only when Google says the
email is verified, the email's domain *exactly* equals a listed domain (no subdomain or suffix match), and Google's
hosted-domain claim ``hd`` (from userinfo and, when present, the ID token) is present and equals that same domain, i.e.
the account is managed by that Workspace domain. Disabled people stay refused. The row records
``invited_by = "domain:<domain>"`` and a ``people.updated`` event is published. With exactly one domain listed the
Google URL carries ``hd=<domain>`` as an account-picker hint only; the callback check is what enforces.

Identity: a person is bound to Google's stable subject (``sub``), stored on first sign-in (trust on first use for rows
made before this binding or by the webhost sign-in) and required to match on every later one: another Google account
reporting the same email is refused (``identity_mismatch``); only an admin clearing the binding lets a new one bind.
A person enrolled by domain, or whose email is in a listed domain, must also present the matching ``hd`` on every
sign-in. The webhost sign-in carries no Google ``sub`` or ``hd``, so it is refused for every person bound to a Google
account and for every person who needs the Workspace check (``google_signin_required``).

The ID token from the token endpoint is required and checked (iss, aud, exp, sub == userinfo sub, email == userinfo
email). Its signature is not verified: it is received directly from Google's token endpoint over TLS, which OIDC Core
3.1.3.7 (6) allows in place of signature validation.

Login CSRF: /start sets an HttpOnly ``hive_oauth`` cookie holding a random value whose hash is stored with the state;
the callback refuses (``state_mismatch``) before exchanging the code unless the same browser presents it.

Flow: GET /api/auth/google/start[?invite=…] -> Google -> GET /api/auth/google/callback.  The callback
checks the one-time ``state`` (CSRF), exchanges the code with Google over TLS, verifies the email,
then sets an HttpOnly ``hive_signin`` cookie scoped to the hive's path.  The page exchanges that cookie
for a bearer session (POST /api/auth/sso).  No token ever appears in a URL.

Roles: ``admin`` (everything, including people, invitations and limits) and ``member`` (uses the hive).

Own hive H1 (ownhive.py): the hive has one owner (stored; migrated from the first admin). Admins keep every right they
had, including over the owner's row (no change in anyone's access until the hives are rebuilt). An invitation has a ``kind``: ``member`` (as before) or ``use`` ("use my hive", owner
only, with a monthly ``limit_usd``): accepting a use invitation makes the person a guest (``people.access = "guest"``)
with a grant of that limit on the owner's keys. ``terms`` (a JSON object) keeps the shape open for "join my hive" (H2)
and "move out" (H4). A hive the owner made public lets a verified Google account with no invitation in as a public
visitor (``access = "public"``, ``invited_by = "public"``, role member); a private hive (the default) is invite only.

Configured admins (``HIVE_ADMIN_EMAILS``, a comma list matched exactly after strip and lowercase): a listed email is
always an admin. At startup a listed email with no row gets an admin row (``invited_by = "config"``), and an existing
enabled non-admin row is upgraded; every sign-in (the hive's Google flow and the webhost path) checks the same thing, so
a row that became a member later is upgraded again. An upgrade stamps ``promoted_by = "config:HIVE_ADMIN_EMAILS"`` and
``promoted_at``, logs a warning line and publishes ``people.updated`` ``{change: "promoted", via: "config", previous_role,
trigger}``. It never downgrades anyone, never touches ``invited_by`` (which drives the Workspace check for
domain-enrolled rows), and never enables a disabled row: a disabled listed email stays disabled until an admin or an
invitation restores it.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import math
import os
import secrets
import time
import urllib.parse

import httpx

from .db import new_id, now

GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo"
GOOGLE_ISSUERS = ("accounts.google.com", "https://accounts.google.com")
ROLES = ("admin", "member")
SIGNIN_COOKIE = "hive_signin"
OAUTH_COOKIE = "hive_oauth"   # binds an OAuth state to the browser that started it

SCHEMA = """
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL,
  invited_by TEXT, created_at TEXT NOT NULL, last_seen_at TEXT, disabled INTEGER NOT NULL DEFAULT 0,
  google_sub TEXT
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at REAL NOT NULL,
  accepted_at TEXT, accepted_by TEXT, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY, invite_id TEXT, created_at REAL NOT NULL, browser_hash TEXT
);
CREATE TABLE IF NOT EXISTS signins (
  token_hash TEXT PRIMARY KEY, person_id TEXT NOT NULL, expires_at REAL NOT NULL
);
"""


def _hash(value):
    return hashlib.sha256(str(value).encode()).hexdigest()


def admin_emails(raw=None):
    """HIVE_ADMIN_EMAILS as a tuple of addresses, each stripped and lowercased; empty entries dropped."""
    raw = os.environ.get("HIVE_ADMIN_EMAILS", "") if raw is None else raw
    out = []
    for e in str(raw).split(","):
        e = e.strip().lower()
        if e and e not in out:
            out.append(e)
    return tuple(out)


def signin_domains(raw=None):
    """HIVE_SIGNIN_DOMAINS as a tuple of lowercase domains; malformed entries are dropped, never widened."""
    raw = os.environ.get("HIVE_SIGNIN_DOMAINS", "") if raw is None else raw
    out = []
    for d in str(raw).split(","):
        d = d.strip().lower()
        if d and "@" not in d and "." in d and not any(c.isspace() for c in d) and not d.startswith(".") \
                and not d.endswith(".") and d not in out:
            out.append(d)
    return tuple(out)


def _id_token_claims(id_token):
    """The ID token's payload. It came straight from Google's token endpoint over TLS (OIDC Core 3.1.3.7), so it is
    read, not signature-checked. None when absent; raises ValueError when present but unreadable."""
    if not id_token:
        return None
    parts = str(id_token).split(".")
    if len(parts) != 3:
        raise ValueError("malformed id_token")
    body = parts[1] + "=" * (-len(parts[1]) % 4)
    claims = json.loads(base64.urlsafe_b64decode(body.encode()))
    if not isinstance(claims, dict):
        raise ValueError("malformed id_token")
    return claims


class SignInError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class People:
    def __init__(self, hive, client):
        self.hive, self.client = hive, client
        with hive.db._lock:
            hive.db._conn.executescript(SCHEMA)
        # older hives: add the identity binding and the browser binding (existing people bind on next sign-in)
        if "google_sub" not in {r["name"] for r in hive.db.all("PRAGMA table_info(people)")}:
            hive.db.execute("ALTER TABLE people ADD COLUMN google_sub TEXT")
        if "browser_hash" not in {r["name"] for r in hive.db.all("PRAGMA table_info(oauth_states)")}:
            hive.db.execute("ALTER TABLE oauth_states ADD COLUMN browser_hash TEXT")
        if "profile_kind" not in {r["name"] for r in hive.db.all("PRAGMA table_info(people)")}:
            hive.db.execute("ALTER TABLE people ADD COLUMN profile_kind TEXT CHECK (profile_kind IN ('child', 'adult') OR profile_kind IS NULL)")
        # older hives: the audit stamp for an upgrade by HIVE_ADMIN_EMAILS (see promote_configured_admin)
        columns = {r["name"] for r in hive.db.all("PRAGMA table_info(people)")}
        for column in ("promoted_by", "promoted_at"):
            if column not in columns:
                hive.db.execute(f"ALTER TABLE people ADD COLUMN {column} TEXT")
        from .ownhive import OwnHive
        OwnHive.migrate_people(hive.db)   # own hive H1: people.access, invites.kind / limit_usd / terms (additive)
        self.client_id = os.environ.get("HIVE_GOOGLE_CLIENT_ID", "")
        self.client_secret = os.environ.get("HIVE_GOOGLE_CLIENT_SECRET", "")
        self.redirect_uri = os.environ.get("HIVE_GOOGLE_REDIRECT_URI", "")
        self.signin_ttl = int(float(os.environ.get("HIVE_SSO_TTL_HOURS", "12")) * 3600)
        self.signin_domains = signin_domains()
        self.admin_emails = admin_emails()
        for email in self.admin_emails:
            row = self.db.one("SELECT * FROM people WHERE email = ?", (email,))
            if row is None:
                self.db.insert("people", {"id": new_id("u"), "email": email, "name": "", "role": "admin",
                                          "invited_by": "config", "created_at": now()})
            else:
                self.promote_configured_admin(row, at="startup")

    @property
    def db(self):
        return self.hive.db

    def promote_configured_admin(self, person, at="signin"):
        """A HIVE_ADMIN_EMAILS address is always an admin: upgrade this row if it is listed, enabled and not yet an
        admin, and return the row as it now is. Never downgrades. Never enables a disabled row: a disabled listed
        address stays disabled (and keeps its role) until an admin or an invitation restores it; the next sign-in or
        restart after that upgrades it. ``invited_by`` is left alone (it records how the person came in and drives the
        Workspace check); the upgrade is stamped in ``promoted_by``/``promoted_at``. Inside a transaction the notice is
        published only once it commits."""
        if person is None or person["email"] not in self.admin_emails or person["role"] == "admin" or person["disabled"]:
            return person
        stamp = {"role": "admin", "promoted_by": "config:HIVE_ADMIN_EMAILS", "promoted_at": now()}
        cur = self.db.execute("UPDATE people SET role = ?, promoted_by = ?, promoted_at = ? "
                              "WHERE id = ? AND role != 'admin' AND disabled = 0",
                              (stamp["role"], stamp["promoted_by"], stamp["promoted_at"], person["id"]))
        promoted = self.get(person["id"])
        if cur.rowcount:
            logging.getLogger("hive").warning("people: %s promoted %s -> admin by HIVE_ADMIN_EMAILS at %s",
                                              person["id"], person["role"], at)
            view = self.view(promoted)
            self.db.after_commit(lambda: self.hive.events.publish("people.updated", person=view, change="promoted",
                                                                  via="config", previous_role=person["role"], trigger=at))
        return promoted

    @property
    def google_ready(self):
        return bool(self.client_id and self.client_secret and self.redirect_uri)

    # ---- people ---------------------------------------------------------------------------------

    @staticmethod
    def view(row):
        return {k: row[k] for k in ("id", "email", "name", "role", "invited_by", "created_at", "last_seen_at")} | {
            k: row.get(k) for k in ("promoted_by", "promoted_at", "access", "profile_kind")} | {
            "disabled": bool(row["disabled"]), "google_bound": bool(row.get("google_sub"))}

    def list(self):
        return [self.view(r) for r in self.db.all("SELECT * FROM people ORDER BY created_at")]

    def get(self, person_id):
        row = self.db.one("SELECT * FROM people WHERE id = ?", (person_id,))
        if row is None:
            raise SignInError(404, "not_found", f"no person {person_id}")
        return row

    def set_profile_kind(self, person_id, value, session_hash):
        """R2.2: actual live admin session, never a by/principal field from an app."""
        import contextlib
        links = getattr(self.hive, "app_links", None)
        with links.guard if links is not None else contextlib.nullcontext():
            with self.db.transaction():
                session = self.db.one("SELECT * FROM sessions WHERE token_hash = ?", (session_hash,))
                if not session or session.get("expires_at") is not None and session["expires_at"] <= time.time():
                    raise SignInError(403, "forbidden", "an admin sets another person's profile")
                by = session.get("principal") or "user:operator"
                actor = self.db.one("SELECT role, disabled FROM people WHERE id = ?", (by[5:],)) if by.startswith("user:u_") else None
                local_admin = session.get("kind") == "password" and by == "user:operator"
                named_admin = session.get("kind") == "sso" and actor and actor["role"] == "admin" and not actor["disabled"]
                if by == f"user:{person_id}" or not (local_admin or named_admin):
                    raise SignInError(403, "forbidden", "an admin sets another person's profile")
                if value is not None and value not in ("child", "adult"):
                    raise SignInError(400, "bad_request", "profile_kind is child, adult or null")
                self.get(person_id)
                self.db.update("people", person_id, {"profile_kind": value})
        self.hive.app_ask.fence_person(f"user:{person_id}")
        out = self.view(self.get(person_id))
        self.hive.events.publish("people.updated", person=out, change="profile_kind")
        return out

    def update(self, person_id, role=None, disabled=None, by=None, clear_google=None):
        row = self.get(person_id)
        changes = {}
        if clear_google:   # the only way a different Google account can bind to this person (explicit, by an admin)
            changes["google_sub"] = None
        if role is not None:
            if role not in ROLES:
                raise SignInError(400, "bad_role", f"role is one of {list(ROLES)}")
            changes["role"] = role
        if disabled is not None:
            changes["disabled"] = 1 if disabled else 0
        if by == f"user:{person_id}" and (changes.get("role") == "member" or changes.get("disabled")):
            raise SignInError(400, "not_yourself", "you cannot remove your own admin access")
        if changes:
            self.db.update("people", person_id, changes)
        kept = None
        if changes.get("disabled") or changes.get("role") == "member" or "google_sub" in changes:
            kept = self.revoke_sessions(person_id)
        makers = getattr(self.hive, "studio_makers", None)
        if changes.get("disabled") and makers is not None:
            try:                       # J3 R7: their own Studio maker goes with their access (inert with Studio off)
                makers.retire_for(f"user:{person_id}")
            except Exception:   # noqa: BLE001  (never fails the access change; the startup sweep retires it)
                import logging
                logging.getLogger("hive").exception("studio maker of user:%s not retired", person_id)
        out = self.view(self.get(person_id) | changes)
        return out if kept is None else out | {"sessions_kept": len(kept)}   # r1.1: sessions that refused to end

    def revoke_sessions(self, person_id):
        self.db.execute("DELETE FROM sessions WHERE principal = ?", (f"user:{person_id}",))
        self.db.execute("DELETE FROM signins WHERE person_id = ?", (person_id,))
        sessions = getattr(self.hive, "sessions", None)
        # host-identity r1: their work sessions and open Ask turns end with their access; r1.1: what refused is returned
        return sessions.end_for(f"user:{person_id}") if sessions is not None else []

    # ---- invitations ---------------------------------------------------------------------------

    @staticmethod
    def invite_view(row):
        status = "revoked" if row["revoked_at"] else "accepted" if row["accepted_at"] else (
            "expired" if row["expires_at"] <= time.time() else "pending")
        try:
            terms = json.loads(row.get("terms") or "{}")
        except ValueError:
            terms = {}
        return {k: row[k] for k in ("id", "email", "name", "role", "created_by", "created_at", "expires_at",
                                    "accepted_at", "accepted_by", "revoked_at")} | {
            "status": status, "kind": row.get("kind") or "member", "limit_usd": row.get("limit_usd"), "terms": terms}

    def invites(self):
        return [self.invite_view(r) for r in self.db.all("SELECT * FROM invites ORDER BY created_at DESC")]

    def invite(self, email, name="", role="member", days=7, by="user:operator", kind="member", limit_usd=None, terms=None):
        """kind ``member`` (as before) or ``use`` (own hive H1: "use my hive", owner only, a guest with ``limit_usd`` a
        month on the owner's keys; always role member). ``terms``: a small JSON object kept with the invitation."""
        kind, limit_usd, terms = self.hive.ownhive.clean_invite(by, kind, limit_usd, terms)
        if kind == "use" and role != "member":
            raise SignInError(400, "bad_role", "a guest is a member of the hive, never an admin")
        email = str(email or "").strip().lower()
        if "@" not in email or len(email) > 254 or any(c.isspace() for c in email):
            raise SignInError(400, "bad_email", "a valid email address is required")
        if role not in ROLES:
            raise SignInError(400, "bad_role", f"role is one of {list(ROLES)}")
        try:
            days = float(days)
        except (TypeError, ValueError):
            days = 7
        days = max(0.04, min(days, 30))
        existing = self.db.one("SELECT * FROM people WHERE email = ? AND disabled = 0", (email,))
        if existing:
            raise SignInError(409, "already_member", f"{email} is already in this hive")
        # one live invitation per address: a new one replaces the old
        self.db.execute("UPDATE invites SET revoked_at = ? WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL",
                        (now(), email))
        token = secrets.token_urlsafe(32)
        row = {"id": new_id("i"), "email": email, "name": str(name or "").strip()[:100], "role": role,
               "token_hash": _hash(token), "created_by": by, "created_at": now(), "expires_at": time.time() + days * 86400,
               "kind": kind, "limit_usd": limit_usd, "terms": json.dumps(terms)}
        self.db.insert("invites", row)
        return self.invite_view(row | {"accepted_at": None, "accepted_by": None, "revoked_at": None}), token

    def revoke_invite(self, invite_id):
        if not self.db.one("SELECT 1 FROM invites WHERE id = ?", (invite_id,)):
            raise SignInError(404, "not_found", f"no invitation {invite_id}")
        self.db.execute("UPDATE invites SET revoked_at = ? WHERE id = ? AND accepted_at IS NULL", (now(), invite_id))
        return self.invite_view(self.db.one("SELECT * FROM invites WHERE id = ?", (invite_id,)))

    def live_invite(self, token):
        row = self.db.one("SELECT * FROM invites WHERE token_hash = ?", (_hash(token),))
        if row is None or row["revoked_at"] or row["accepted_at"] or row["expires_at"] <= time.time():
            return None
        return row

    def invite_preview(self, token):
        row = self.live_invite(token)
        if row is None:
            raise SignInError(410, "invite_unavailable", "this invitation has expired, been used or been withdrawn")
        local, _, domain = row["email"].partition("@")
        masked = (local[:2] + "…" if len(local) > 2 else local) + "@" + domain
        host = self.hive.ownhive._person(row["created_by"]) if (row.get("kind") or "member") == "use" else None
        return {"email_hint": masked, "name": row["name"], "role": row["role"], "expires_at": row["expires_at"],
                "kind": row.get("kind") or "member", "limit_usd": row.get("limit_usd"),
                "host_name": (host or {}).get("name") or None}

    # ---- Google ---------------------------------------------------------------------------------

    def start(self, invite_token=None, browser=""):
        """The Google URL. ``browser`` is the random value the caller puts in the HttpOnly OAUTH_COOKIE; its hash is
        stored with the state so the callback only completes in the browser that started it."""
        if not self.google_ready:
            raise SignInError(503, "google_unconfigured", "Google sign-in is not set up on this hive")
        if not browser:
            raise SignInError(400, "state_mismatch", "sign-in must start in a browser")
        invite_id = None
        if invite_token:
            row = self.live_invite(invite_token)
            if row is None:
                raise SignInError(410, "invite_unavailable", "this invitation has expired, been used or been withdrawn")
            invite_id = row["id"]
        state = secrets.token_urlsafe(32)
        self.db.execute("DELETE FROM oauth_states WHERE created_at < ?", (time.time() - 900,))
        self.db.insert("oauth_states", {"state_hash": _hash(state), "invite_id": invite_id, "created_at": time.time(),
                                        "browser_hash": _hash(browser)})
        query = {"client_id": self.client_id, "redirect_uri": self.redirect_uri, "response_type": "code",
                 "scope": "openid email profile", "state": state, "prompt": "select_account"}
        if len(self.signin_domains) == 1:   # account-picker hint only; callback() enforces
            query["hd"] = self.signin_domains[0]
        return f"{GOOGLE_AUTH}?{urllib.parse.urlencode(query)}"

    def id_claims(self, tokens, info, email):
        """The token endpoint's ID token, checked (OIDC Core 3.1.3.7): iss is Google, aud is this client, not expired,
        and it names the same subject and email as userinfo. Not signature-checked: it came straight from Google's
        token endpoint over TLS (3.1.3.7 step 6). Any failure refuses the sign-in."""
        bad = SignInError(401, "bad_id_token", "Google's identity token did not check out")
        try:
            claims = _id_token_claims(tokens.get("id_token"))
        except (ValueError, TypeError):
            raise bad from None
        if claims is None or claims.get("iss") not in GOOGLE_ISSUERS:
            raise bad
        aud = claims.get("aud")
        if isinstance(aud, list):
            if self.client_id not in aud or (len(aud) > 1 and "azp" not in claims):
                raise bad
        elif aud != self.client_id:
            raise bad
        if "azp" in claims and claims["azp"] != self.client_id:   # any authorized party named must be this client
            raise bad
        exp = claims.get("exp")
        if isinstance(exp, bool) or not isinstance(exp, (int, float)) or not math.isfinite(exp) or exp <= time.time():
            raise bad
        sub = claims.get("sub")
        if not isinstance(sub, str) or not sub or sub != info.get("sub"):
            raise bad
        if str(claims.get("email", "")).strip().lower() != email:
            raise bad
        return claims

    def required_domain(self, email, invited_by=None):
        """The Workspace domain whose ``hd`` this address must present on every sign-in, or None: the domain a
        person was enrolled under, or the address's own domain when it is a listed one."""
        if invited_by and str(invited_by).startswith("domain:"):
            return str(invited_by)[len("domain:"):]
        domain = email.rpartition("@")[2]
        return domain if domain in self.signin_domains else None

    def needs_google(self, person):
        """Whether this person may only sign in through the hive's own Google flow, where sub and hd are checked: anyone
        bound to a Google account, and anyone who needs the Workspace check. The webhost sign-in verifies neither."""
        return bool(person.get("google_sub")) or self.required_domain(person["email"], person.get("invited_by")) is not None

    async def callback(self, code, state, browser=""):
        """Returns (person_row, signin_token). Every failure is a SignInError; nothing is created on failure."""
        if not code or not state:
            raise SignInError(400, "bad_callback", "Google did not return a code")
        saved = self.db.one("SELECT * FROM oauth_states WHERE state_hash = ?", (_hash(state),))
        self.db.execute("DELETE FROM oauth_states WHERE state_hash = ?", (_hash(state),))  # one use
        if saved is None or saved["created_at"] < time.time() - 900:
            raise SignInError(400, "bad_state", "this sign-in link expired; start again")
        if not browser or not saved.get("browser_hash") or not hmac.compare_digest(saved["browser_hash"], _hash(browser)):
            raise SignInError(400, "state_mismatch", "this sign-in was started in another browser; start again")
        unavailable = SignInError(502, "google_unavailable", "Google could not be reached; try again")
        try:
            token_response = await self.client.post(GOOGLE_TOKEN, data={
                "code": code, "client_id": self.client_id, "client_secret": self.client_secret,
                "redirect_uri": self.redirect_uri, "grant_type": "authorization_code"})
            if token_response.status_code != 200:
                raise SignInError(401, "google_refused", "Google did not accept the sign-in")
            tokens = token_response.json()
            if not isinstance(tokens, dict):
                raise unavailable
            access = tokens.get("access_token")
            info_response = await self.client.get(GOOGLE_USERINFO, headers={"Authorization": f"Bearer {access}"})
            if info_response.status_code != 200:
                raise SignInError(401, "google_refused", "Google did not return the account")
            info = info_response.json()
            if not isinstance(info, dict):
                raise unavailable
        except (httpx.HTTPError, ValueError) as exc:   # transport failures and malformed JSON (JSONDecodeError)
            logging.getLogger("hive").warning("google sign-in endpoint failed: %s", type(exc).__name__)
            raise unavailable from None
        email = str(info.get("email", "")).strip().lower()
        if not email or info.get("email_verified") not in (True, "true"):
            raise SignInError(403, "email_unverified", "Google has not verified this account's email")
        claims = self.id_claims(tokens, info, email)
        sub = claims["sub"]
        hds = {str(v).strip().lower() for v in (info.get("hd"), claims.get("hd")) if v is not None}
        if len(hds) > 1:
            raise SignInError(401, "bad_id_token", "Google's identity token did not check out")
        hd = next(iter(hds), None)
        # One transaction for the whole decision and every write it leads to (BEGIN IMMEDIATE, connection lock held):
        # the binding check reads the row as it is now, and a refused callback rolls back, so a callback that loses a
        # concurrent binding has consumed no invitation, restored no one, enrolled no one and bound nothing.
        with self.db.transaction():
            person = self.db.one("SELECT * FROM people WHERE email = ?", (email,))
            if person is not None and person.get("google_sub") and not hmac.compare_digest(person["google_sub"], sub):
                raise SignInError(403, "identity_mismatch", "this hive person is bound to a different Google account")
            need = self.required_domain(email, person["invited_by"] if person else None)
            if need is not None and hd != need:
                raise SignInError(403, "domain_unverified", f"sign in with your {need} Google Workspace account")
            if saved["invite_id"]:
                invite = self.db.one("SELECT * FROM invites WHERE id = ?", (saved["invite_id"],))
                if invite is None or invite["revoked_at"] or invite["accepted_at"] or invite["expires_at"] <= time.time():
                    raise SignInError(410, "invite_unavailable", "this invitation has expired, been used or been withdrawn")
                if invite["email"] != email:
                    raise SignInError(403, "wrong_account", f"this invitation is for a different Google account")
                made = person is None or bool(person["disabled"])
                if person is None:
                    person = {"id": new_id("u"), "email": email, "name": str(info.get("name") or invite["name"])[:100],
                              "role": invite["role"], "invited_by": invite["created_by"], "created_at": now(),
                              "last_seen_at": None, "disabled": 0, "google_sub": sub}
                    self.db.insert("people", person)
                elif person["disabled"]:
                    self.db.update("people", person["id"], {"disabled": 0, "role": invite["role"]})
                    person = self.get(person["id"])
                self.db.execute("UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE id = ?", (now(), person["id"], invite["id"]))
                self.hive.ownhive.accepted(invite, person["id"], made)   # a use invitation: guest + its limit (H1)
            if person is None and not saved["invite_id"]:
                person = self._enrol_by_domain(email, info, hd, sub)
            if person is None and not saved["invite_id"]:
                person = self._enrol_public(email, info, sub)
            if person is None or person["disabled"]:
                raise SignInError(403, "not_invited", "this Google account has not been invited to this hive")
            person = self.promote_configured_admin(person)   # same transaction: rolls back with a refused callback
            if not person.get("google_sub"):   # trust on first use, decided above inside this same transaction
                self.db.execute("UPDATE people SET google_sub = ? WHERE id = ? AND google_sub IS NULL", (sub, person["id"]))
            if self.get(person["id"])["google_sub"] != sub:
                raise SignInError(403, "identity_mismatch", "this hive person is bound to a different Google account")
            if not person["name"] and info.get("name"):
                self.db.update("people", person["id"], {"name": str(info["name"])[:100]})
            self.db.update("people", person["id"], {"last_seen_at": now()})
            token = secrets.token_urlsafe(32)
            self.db.insert("signins", {"token_hash": _hash(token), "person_id": person["id"], "expires_at": time.time() + self.signin_ttl})
        return self.get(person["id"]), token

    def domain_for(self, email, info, hd):
        """The listed domain this verified Google account may self-enrol under, or None: email_verified, exact domain
        equality, and Google's (already cross-checked) hd claim equal to that domain."""
        if not self.signin_domains or info.get("email_verified") not in (True, "true"):
            return None
        local, at, domain = email.rpartition("@")
        if not at or not local or domain not in self.signin_domains:
            return None
        return domain if hd == domain else None

    def _enrol_by_domain(self, email, info, hd, sub):
        domain = self.domain_for(email, info, hd)
        if domain is None:
            return None
        person = {"id": new_id("u"), "email": email, "name": str(info.get("name") or "")[:100], "role": "member",
                  "invited_by": f"domain:{domain}", "created_at": now(), "last_seen_at": None, "disabled": 0,
                  "google_sub": sub}
        self.db.insert("people", person)
        view = self.view(person)   # announced only once the enrolment has committed
        self.db.after_commit(lambda: self.hive.events.publish("people.updated", person=view, change="enrolled",
                                                              via=f"domain:{domain}"))
        return person

    def _enrol_public(self, email, info, sub):
        """Own hive H1: a public hive (its owner's choice; private, the default, is invite only) lets a verified Google
        account in as a public visitor: role member, access public. Never an admin; disabled people stay refused."""
        if self.hive.ownhive.settings()["visibility"] != "public" or info.get("email_verified") not in (True, "true"):
            return None
        person = {"id": new_id("u"), "email": email, "name": str(info.get("name") or "")[:100], "role": "member",
                  "invited_by": "public", "created_at": now(), "last_seen_at": None, "disabled": 0, "google_sub": sub,
                  "access": "public"}
        self.db.insert("people", person)
        view = self.view(person)
        self.db.after_commit(lambda: self.hive.events.publish("people.updated", person=view, change="enrolled", via="public"))
        return person

    def accept_invite_for_verified_email(self, email, name=""):
        """A sign-in that already verified this Google address (the webhost sign-in, same Google client) accepts the
        address's live invitation exactly as the hive's own Google callback would. Returns the person, or None."""
        email = str(email or "").strip().lower()
        if not email:
            return None
        invite = self.db.one("SELECT * FROM invites WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL "
                             "AND expires_at > ? ORDER BY created_at DESC LIMIT 1", (email, time.time()))
        if invite is None:
            return None
        person = self.db.one("SELECT * FROM people WHERE email = ?", (email,))
        made = person is None or bool(person["disabled"])
        if person is None:
            person = {"id": new_id("u"), "email": email, "name": str(name or invite["name"])[:100], "role": invite["role"],
                      "invited_by": invite["created_by"], "created_at": now(), "last_seen_at": None, "disabled": 0}
            self.db.insert("people", person)
        elif person["disabled"]:
            self.db.update("people", person["id"], {"disabled": 0, "role": invite["role"]})
        self.db.execute("UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE id = ?", (now(), person["id"], invite["id"]))
        self.hive.ownhive.accepted(invite, person["id"], made)   # a use invitation: guest + its limit (H1)
        return self.get(person["id"])

    @staticmethod
    def signin_hash(token):
        """The stored reference for a hive_signin value (also recorded on each bearer session exchanged from it)."""
        return _hash(token) if token else None

    def end_signin(self, signin_hash):
        """Sign-out: the sign-in AND every bearer session exchanged from it stop working, together (idempotent)."""
        if signin_hash:
            with self.db.transaction():
                self.db.execute("DELETE FROM sessions WHERE signin_hash = ?", (signin_hash,))
                self.db.execute("DELETE FROM signins WHERE token_hash = ?", (signin_hash,))

    def family_person(self, email, name=""):
        """The hive person a webhost sign-in (verified Google email, no Google sub or hd) may become, or None. Decided
        before any write, against the row whether or not it is disabled: a person bound to a Google account, or one who
        needs the Workspace check, is refused (google_signin_required) with nothing changed. Otherwise an enabled
        person is used as is, or the address's live invitation is accepted. Call inside a transaction so the decision
        and its writes (and the caller's session) commit together."""
        email = str(email or "").strip().lower()
        if not email:
            return None
        existing = self.db.one("SELECT * FROM people WHERE email = ?", (email,))
        if (existing is not None and self.needs_google(existing)) or (existing is None and self.required_domain(email)):
            if existing is None:
                return None   # a listed-domain address that is no hive person: never enrolled or invited from here
            raise SignInError(403, "google_signin_required", "sign in with your Google Workspace account")
        if existing is not None and not existing["disabled"]:
            return self.promote_configured_admin(existing)
        return self.promote_configured_admin(self.accept_invite_for_verified_email(email, name))

    def person_for_signin(self, token):
        if not token:
            return None
        row = self.db.one("SELECT * FROM signins WHERE token_hash = ?", (_hash(token),))
        if row is None or row["expires_at"] <= time.time():
            return None
        person = self.db.one("SELECT * FROM people WHERE id = ? AND disabled = 0", (row["person_id"],))
        if person is None:
            return None
        return person, row["expires_at"]
