"""Closed, synchronous Google backend seam. No Google SDK is imported at startup.

Backend B uses Google's supported libraries. Backend A deliberately cannot make
requests until its separate availability and account qualification are admitted.
Only a primary-calendar read is exposed; there is no generic API/tool dispatcher.
"""

from __future__ import annotations

import importlib.metadata
import logging
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly"
SCOPES = (CALENDAR_SCOPE,)
AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URI = "https://oauth2.googleapis.com/token"
REVOKE_URI = "https://oauth2.googleapis.com/revoke"
TIMEOUT = 10.0


class BackendUnavailable(Exception):
    """An unavailable implementation, without an upstream diagnostic body."""


@dataclass(frozen=True)
class CalendarPage:
    """Private service boundary; neither event bodies nor tokens enter repr()."""

    page: dict = field(repr=False)
    refresh_token: str = field(repr=False)
    failed: bool = False


class GoogleMCPBackend:
    name = "A"
    available = False

    def __getattr__(self, name):
        if name in {"authorization_url", "exchange", "calendar_page", "revoke"}:
            raise BackendUnavailable("Google MCP is unavailable")
        raise AttributeError(name)


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _quiet_libraries():
    # OAuthlib's debug output can contain complete token responses and verifiers.
    # Sink these library namespaces before constructing a Flow, even on hosts
    # whose optional global redactor is disabled. This service emits no logs.
    prefixes = ("oauthlib", "requests_oauthlib", "google.auth", "google.oauth2", "googleapiclient",
                "google_auth_oauthlib", "google_auth_httplib2")
    names = set(prefixes) | {name for name in list(logging.root.manager.loggerDict)
                             if any(name.startswith(prefix + ".") for prefix in prefixes)}
    for name in names:
        logger = logging.getLogger(name)
        # Logger.disabled does not prevent a descendant's callHandlers() from
        # reaching this logger's handlers. Remove existing namespace handlers
        # too, including handlers on children configured before this service.
        for handler in list(logger.handlers):
            logger.removeHandler(handler)
        logger.addHandler(logging.NullHandler())
        logger.propagate = False
        logger.disabled = True


class GoogleLibraryBackend:
    name = "B"

    @property
    def available(self):
        # Distribution metadata does not import the libraries or call Google.
        try:
            for package in ("google-auth", "google-auth-oauthlib", "google-api-python-client"):
                importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            return False
        return True

    @staticmethod
    def _flow(client, redirect_uri, verifier):
        _quiet_libraries()
        from google_auth_oauthlib.flow import Flow

        _quiet_libraries()  # also cover the child loggers created by lazy imports

        config = {"web": {"client_id": client["client_id"], "client_secret": client["client_secret"],
                          "auth_uri": AUTH_URI, "token_uri": TOKEN_URI,
                          "redirect_uris": [redirect_uri]}}
        flow = Flow.from_client_config(config, scopes=SCOPES, redirect_uri=redirect_uri,
                                       code_verifier=verifier, autogenerate_code_verifier=False)
        flow.oauth2session.max_redirects = 0
        return flow

    def authorization_url(self, client, redirect_uri, state, verifier):
        flow = self._flow(client, redirect_uri, verifier)
        url, returned_state = flow.authorization_url(state=state, access_type="offline", prompt="consent",
                                                     include_granted_scopes="false")
        if returned_state != state:
            raise ValueError("invalid authorization state")
        return url

    def exchange(self, client, redirect_uri, state, code, verifier):
        flow = self._flow(client, redirect_uri, verifier)
        # No local server, browser opening, retries or redirect chosen by a caller.
        flow.fetch_token(code=code, timeout=TIMEOUT)
        credentials = flow.credentials
        token = flow.oauth2session.token
        granted = token.get("scope", SCOPES)
        if isinstance(granted, str):
            granted = granted.split()
        # Return only what the connector may persist. In particular, never
        # serialize Credentials.to_json(), access tokens or ID tokens.
        return {"refresh_token": credentials.refresh_token, "scopes": list(granted)}

    def calendar_page(self, client, refresh_token, time_min, time_max, page_token, page_size):
        _quiet_libraries()
        import httplib2
        import requests
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_httplib2 import AuthorizedHttp
        from googleapiclient.discovery import build

        _quiet_libraries()

        class BoundedRequest(Request):
            def __del__(self):
                # google-auth's Request finalizer closes even an injected
                # session. This transport borrows the outer Session instead:
                # its context is the sole cleanup owner and observes failures.
                pass

            def __call__(self, url, method="GET", body=None, headers=None, timeout=TIMEOUT, **kwargs):
                self._attempts = getattr(self, "_attempts", 0) + 1
                if self._attempts > 3:
                    raise BackendUnavailable("Google token request bound exceeded")
                return super().__call__(url, method=method, body=body, headers=headers, timeout=TIMEOUT, **kwargs)

        # Refresh in memory, afresh for this operation. The requests adapter has
        # zero transport retries; google-auth's own refresh retry is finite.
        accepted_refresh, failed, page = False, False, {}
        credentials = None
        request_transport = None  # retain the borrowed transport until operation completion
        try:
            with requests.Session() as session:
                session.max_redirects = 0
                session.mount("https://", requests.adapters.HTTPAdapter(max_retries=0))
                credentials = Credentials(token=None, refresh_token=refresh_token, token_uri=TOKEN_URI,
                                          client_id=client["client_id"], client_secret=client["client_secret"],
                                          scopes=SCOPES)
                request_transport = BoundedRequest(session=session)
                credentials.refresh(request_transport)
                granted = credentials.granted_scopes
                if granted is not None and set(granted) != set(SCOPES):
                    raise BackendUnavailable("Google read-only scope refused")
                accepted_refresh = True
                http, service = None, None
                try:
                    http = AuthorizedHttp(credentials, http=httplib2.Http(timeout=TIMEOUT), max_refresh_attempts=0)
                    # Static discovery avoids another discovery HTTP request.
                    service = build("calendar", "v3", http=http, static_discovery=True, cache_discovery=False)
                    page = service.events().list(
                        calendarId="primary", timeMin=time_min, timeMax=time_max,
                        maxResults=page_size, pageToken=page_token, singleEvents=True,
                        orderBy="startTime", showDeleted=False,
                        fields="nextPageToken,items(summary,start(date,dateTime),end(date,dateTime),transparency,status)",
                    ).execute(num_retries=0)
                    if not isinstance(page, dict):
                        failed, page = True, {}
                except Exception:
                    failed, page = True, {}
                finally:
                    try:
                        if service is not None:
                            service.close()
                        elif http is not None:
                            http.close()
                    except Exception:
                        failed, page = True, {}
        except Exception:
            if not accepted_refresh:
                raise  # no successfully refreshed, exact-scope grant to persist
            failed, page = True, {}  # includes requests-session cleanup failure
        # Even a later Calendar/build/cleanup failure must carry legitimate
        # rotation to the guarded store, without publishing a partial read.
        return CalendarPage(page, credentials.refresh_token, failed)

    def revoke(self, refresh_token):
        # Fixed HTTPS destination, form body (never a URL token), finite timeout,
        # no automatic redirects or retries, no response body in errors/logs.
        body = urllib.parse.urlencode({"token": refresh_token}).encode("ascii")
        request = urllib.request.Request(REVOKE_URI, data=body, method="POST",
                                         headers={"Content-Type": "application/x-www-form-urlencoded"})
        opener = urllib.request.build_opener(_NoRedirects())
        with opener.open(request, timeout=TIMEOUT) as response:
            return response.status == 200
