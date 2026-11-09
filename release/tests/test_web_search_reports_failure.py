"""web-search never answers a failure with an empty string."""
import importlib.util, os

_p = os.path.join(os.path.dirname(__file__), "..", "modules", "web_search", "src", "websearch.py")
_spec = importlib.util.spec_from_file_location("websearch_under_test", _p)
ws = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(ws)


def test_unreachable_search_says_unavailable(monkeypatch):
    def boom(q):
        raise PermissionError("denied by sandbox")
    monkeypatch.setattr(ws, "search_", boom)
    out = ws.search("anything")
    assert out.startswith("WEB-SEARCH-UNAVAILABLE PermissionError") and '"' not in out and "(" not in out


def test_no_results_is_explicit(monkeypatch):
    monkeypatch.setattr(ws, "search_", lambda q: [])
    assert ws.search("anything") == "WEB-SEARCH-NO-RESULTS"


def test_results_unchanged(monkeypatch):
    monkeypatch.setattr(ws, "search_", lambda q: [{"title": "T", "snippet": "S"}])
    assert ws.search("x") == "((TITLE: T SNIPPET: S) )"
