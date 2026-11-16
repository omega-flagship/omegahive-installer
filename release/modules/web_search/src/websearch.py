#!/usr/bin/env python3
"""Kept for callers of the old module: web search now goes through the hive (hive_web.py), never from the mind."""
import importlib.util
import os
import sys


def _client():
    module = sys.modules.get("hive_web")
    if module is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hive_web.py")
        spec = importlib.util.spec_from_file_location("hive_web", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        sys.modules["hive_web"] = module
    return module


def search_(query, max_results=10):
    """[{title, url, snippet}] from the hive's search route; raises when the hive refuses or cannot be reached."""
    return _client().results(query, min(int(max_results), 20))


def search(query, max_results=10):
    # A failed search says so (an empty string read as "nothing found").
    try:
        results = search_(query)
    except Exception as error:  # noqa: BLE001
        kind = type(error).__name__
        return f"WEB-SEARCH-UNAVAILABLE {kind}: this mind cannot reach the web search service from here"
    if not results:
        return "WEB-SEARCH-NO-RESULTS"
    ret = "("
    for r in results:
        url = f" URL: {r['url']}" if r.get("url") else ""
        ret += "(TITLE: " + r["title"] + url + " SNIPPET: " + r["snippet"] + ") "
    return ret + ")"
