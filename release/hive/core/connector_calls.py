# Purpose: the calls the hive makes for a mind to Home Assistant and LibreLinkUp with the mind owner's own secret, so no
# mind holds it: Home Assistant's few paths the bridge uses, LibreLinkUp's login, connections and graph, no redirects.
"""Outbound calls for connectors the hive calls itself (hive/core/connectors.py decides who may ask).

Home Assistant: the bridge module (modules/home_assistant/bridge/home_assistant.py) makes every call through one request
function, to GET /api/states, GET /api/states/<entity_id>, POST /api/template and POST /api/services/<domain>/<service>.
The hive allows exactly those, adds the owner's token, and answers HA's own status and text, which the module reads as it
read a direct answer.

LibreLinkUp: the glucose reader's protocol (modules/health_glucose/src/glucose.py), moved here: log in at
/llu/auth/login on the owner's base or each regional base in turn, keep the session, read /llu/connections and
/llu/connections/<patient>/graph with its token and account id, and log in again once when a read fails. A service error
answers in the module's own words ("LibreLinkUp HTTP 429: ..."), so its classification of rate limits and lockouts holds.

No redirect is followed: a token goes only to the address its owner entered.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.error
import urllib.request

MAX_BODY = 8 * 1024 * 1024
HOME_ASSISTANT_TIMEOUT = 10   # the bridge's own timeout for a call
LIBRELINKUP_TIMEOUT = 15      # the glucose reader's own timeout for a call

HOME_ASSISTANT_PATHS = (
    ("GET", re.compile(r"/api/states")),
    ("GET", re.compile(r"/api/states/[A-Za-z0-9_]+\.[A-Za-z0-9_]+")),
    ("POST", re.compile(r"/api/template")),
    ("POST", re.compile(r"/api/services/[A-Za-z0-9_]+/[A-Za-z0-9_]+")),
)
LIBRELINKUP_BASES = ("https://api-eu2.libreview.io", "https://api-eu.libreview.io", "https://api.libreview.io")
LIBRELINKUP_VERSION = "4.16.0"
PATIENT = re.compile(r"[A-Za-z0-9-]{1,128}")


class NotAllowed(Exception):
    """A request outside what the connector's module makes."""


class Unreachable(Exception):
    """The service did not answer, answered too much, or answered with an error; the message says which."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is refused rather than followed, so a token never goes to an address its owner didn't enter."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(_NoRedirect)


def _read(response):
    body = response.read(MAX_BODY + 1)
    if len(body) > MAX_BODY:
        raise Unreachable("the service answered more than 8 MiB")
    return body.decode("utf-8", errors="replace")


def _send(opener, url, method, headers, payload, timeout):
    """(status, text) of one call; a refused redirect answers its own status."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, _read(response)
    except urllib.error.HTTPError as exc:
        return exc.code, _read(exc)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise Unreachable(f"{url.split('/', 3)[2] if '://' in url else url} did not answer ({getattr(exc, 'reason', exc)})") \
            from None


def home_assistant(settings, method, path, payload, opener=OPENER):
    """{"status", "text"} of one Home Assistant call the bridge makes."""
    if not isinstance(path, str) or not any(method == m and rx.fullmatch(path) for m, rx in HOME_ASSISTANT_PATHS):
        raise NotAllowed("Home Assistant calls are GET /api/states[/<entity_id>], POST /api/template and POST "
                         "/api/services/<domain>/<service>")
    if payload is not None and (method != "POST" or not isinstance(payload, dict)):
        raise NotAllowed("only a POST carries a payload, and it is a JSON object")
    status, text = _send(opener, settings["url"] + path, method,
                         {"Authorization": f"Bearer {settings['token']}", "Content-Type": "application/json"},
                         payload, HOME_ASSISTANT_TIMEOUT)
    return {"status": status, "text": text}


def librelinkup_public(settings):
    """What the reader needs beside the calls: its unit, the person-to-patient map and the app version. No login."""
    return {"unit": settings.get("unit") or "mmol/L", "connections": settings.get("connections") or {},
            "version": settings.get("version") or LIBRELINKUP_VERSION}


def _llu(opener, base, method, path, version, payload=None, token=None, account_id=None):
    headers = {"Content-Type": "application/json", "Accept": "application/json", "product": "llu.android",
               "version": version}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if account_id:
        headers["Account-ID"] = account_id
    status, text = _send(opener, base.rstrip("/") + path, method, headers, payload, LIBRELINKUP_TIMEOUT)
    if status >= 400:
        raise Unreachable(f"LibreLinkUp HTTP {status}: {text[:400]}")
    try:
        return json.loads(text) if text else {}
    except ValueError:
        raise Unreachable("LibreLinkUp answered something other than JSON") from None


def _valid(session):
    try:
        expires = int((session or {}).get("expires") or 0)
    except (TypeError, ValueError):
        expires = 0
    return bool(session and session.get("token") and session.get("account_id") and session.get("base_url")
                and expires > time.time() + 300)


def _login(settings, opener):
    """A new session from the owner's login, trying the owner's base or each regional base in turn."""
    bases = [settings["url"]] if settings.get("url") else list(LIBRELINKUP_BASES)
    version = librelinkup_public(settings)["version"]
    last = None
    for base in bases:
        try:
            response = _llu(opener, base, "POST", "/llu/auth/login", version,
                            payload={"email": settings["username"], "password": settings["password"]})
            data = response.get("data") or {}
            ticket = data.get("authTicket") or data.get("ticket") or response.get("ticket") or {}
            user_id = (data.get("user") or {}).get("id")
            if not ticket.get("token") or not user_id:
                raise Unreachable("LibreLinkUp's login answer held no token and user id")
            digest = hashlib.sha256(str(user_id).encode("utf-8")).hexdigest()
            return {"base_url": base, "token": ticket["token"], "expires": int(ticket.get("expires") or time.time() + 3600),
                    "account_id": digest, "user_id_hash": digest[:12],
                    "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        except Unreachable as exc:
            last = exc
    raise Unreachable(f"LibreLinkUp login failed: {last}")


def librelinkup(settings, op, patient_id, session, keep, opener=OPENER):
    """One LibreLinkUp read: op "connections" answers {"data": [...]}, op "graph" the patient's graph answer.
    `session()` reads the owner's kept session and `keep(new)` keeps a new one."""
    if op == "connections":
        path = "/llu/connections"
    elif op == "graph" and isinstance(patient_id, str) and PATIENT.fullmatch(patient_id):
        path = f"/llu/connections/{patient_id}/graph"
    else:
        raise NotAllowed("LibreLinkUp reads are settings, connections and graph with a patient id")
    version = librelinkup_public(settings)["version"]
    current = session()
    if not _valid(current):
        current = _login(settings, opener)
        keep(current)
    try:
        response = _llu(opener, current["base_url"], "GET", path, version, token=current["token"],
                        account_id=current["account_id"])
    except Unreachable:
        current = _login(settings, opener)
        keep(current)
        response = _llu(opener, current["base_url"], "GET", path, version, token=current["token"],
                        account_id=current["account_id"])
    if op == "connections":
        data = response.get("data")
        return {"data": data if isinstance(data, list) else []}
    return response
