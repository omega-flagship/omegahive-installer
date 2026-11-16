"""web-search and web-fetch for a mind: thin calls to its hive, never to the internet.

A sandboxed mind may reach only its hive (HIVE_API_URL, normally 127.0.0.1:<hive port>). The hive searches and fetches
on the host (hive/core/webtools.py), where the safety rules, limits, provider keys and audit live. This file only asks
and formats the answer for the mind. Its name is its own (not ``websearch``) so the upstream core's module of that name
can never stand in for it.
"""

import json
import os
import urllib.error
import urllib.request

TIMEOUT = 25            # the hive's own deadline is 10 seconds a fetch; this leaves room for the answer
SEARCH_PATH = "/api/agent/web/search"
FETCH_PATH = "/api/agent/web/fetch"
FETCH_CHARS = 6000      # what one fetch shows the mind
MAX_RESULTS = 8


class HiveWebError(Exception):
    """The hive refused or could not answer; the message is plain words."""


def _text(value):
    text = str(value).strip()
    if len(text) >= 2 and text[0] == text[-1] == '"':
        text = text[1:-1].replace('\\"', '"')
    return text


def _call(path, payload):
    base = os.environ.get("HIVE_API_URL", "").rstrip("/")
    token = os.environ.get("HIVE_WS_TOKEN", "")
    if not base or not token:
        raise HiveWebError("this mind is not connected to a hive")
    request = urllib.request.Request(base + path, data=json.dumps(payload).encode(), method="POST", headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        try:
            message = json.loads(exc.read().decode()).get("error", {}).get("message", "")
        except ValueError:
            message = ""
        raise HiveWebError(message or f"the hive answered with status {exc.code}") from None
    except OSError as exc:
        raise HiveWebError(f"the hive could not be reached ({type(exc).__name__})") from None


def results(query, max_results=MAX_RESULTS):
    """[{title, url, snippet}] from the hive's search route."""
    answer = _call(SEARCH_PATH, {"query": _text(query), "max_results": int(max_results)})
    return list(answer.get("results") or [])


def _one_line(value):
    return " ".join(str(value or "").split())


def search(query, max_results=MAX_RESULTS):
    try:
        rows = results(query, max_results)
    except HiveWebError as exc:
        return f"web-search refused: {_one_line(exc)}"
    if not rows:
        return "WEB-SEARCH-NO-RESULTS"
    out = "("
    for r in rows:
        out += f"(TITLE: {_one_line(r.get('title'))} URL: {_one_line(r.get('url'))} SNIPPET: {_one_line(r.get('snippet'))}) "
    return out + ")"


def fetch(url):
    """One page as readable text, headed by what a report cites: the final URL and the fetch time (UTC)."""
    try:
        page = _call(FETCH_PATH, {"url": _text(url), "max_chars": FETCH_CHARS})
    except HiveWebError as exc:
        return f"web-fetch refused: {_one_line(exc)}"
    head = (f"WEB-FETCH url={page.get('final_url')} fetched_at={page.get('fetched_at')} "
            f"type={page.get('content_type')} title={_one_line(page.get('title'))}")
    if page.get("truncated"):
        head += " (text cut short)"
    return head + "\n" + str(page.get("text") or "")
