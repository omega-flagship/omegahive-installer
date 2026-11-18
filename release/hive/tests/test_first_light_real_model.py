"""Purpose: test that First Light's hello, sent the moment a key is saved, reaches the person's mind on the real model the
host moves it to, never on the demonstration (echo) model: the hello reads OpenRouter's catalogue first while the mind is
still on the demonstration model the host set and an OpenRouter key is here, a catalogue that can't be read leaves
the mind as it was, and with no OpenRouter key none is read.

The v0.33 Windows test: the scripted hello came within a second of the key, before the catalogue fetch the key started
had brought any price, so the mind stayed on mock/echo and the greeting was its echo. OpenRouter here is a stub
transport on the provider store (its key check and its catalogue), so nothing leaves the test.
"""
import httpx

from hive.core.model_route import held, is_demo
from hive.tests.test_model_route import HEAD, hive_app  # noqa: F401  (fixture)
from hive.tests.test_personal_mind import _person, _personal

# OpenRouter's catalogue, one entry: the roster's head with its per-token prices, as /models answers it
CATALOGUE = {"data": [{"id": HEAD.partition("/")[2], "name": "Claude Sonnet 5.5",
                       "pricing": {"prompt": "0.000003", "completion": "0.000015"}}]}


def _openrouter(hive, catalogue=True):
    """OpenRouter as the hive's provider store reaches it: the key check always answers; the catalogue answers, or
    fails as an unreachable one does. Returns the paths it was asked for."""
    asked = []

    def answer(request):
        asked.append(request.url.path)
        if request.url.path.endswith("/key"):
            return httpx.Response(200, json={"data": {"label": "invented", "limit": None, "usage": 0}})
        if request.url.path.endswith("/models") and catalogue:
            return httpx.Response(200, json=CATALOGUE)
        return httpx.Response(503, json={"error": {"message": "invented outage"}})
    hive.providers.client = httpx.AsyncClient(transport=httpx.MockTransport(answer))
    return asked


def test_a_hello_the_moment_a_key_is_saved_greets_from_the_real_model(hive_app):
    hive, c, admin, google, _ = hive_app
    asked = _openrouter(hive)
    ana, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
    mind = _personal(hive, f"user:{ana_id}")[0]
    assert is_demo(mind["model"]) and held(hive.db, mind["id"]) == mind["model"], "made on the demonstration model"
    assert c.put("/api/providers/openrouter/key", json={"key": "sk-or-invented"}, headers=admin).status_code == 200
    # at once, as the page asks: no catalogue has been read since the key
    r = c.post("/api/me/personal-mind/hello", headers=ana)
    assert r.status_code == 200, r.text
    moved = _personal(hive, f"user:{ana_id}")[0]
    assert moved["model"] == HEAD and held(hive.db, moved["id"]) == HEAD
    assert any(path.endswith("/models") for path in asked)
    # the note went to the mind on that model: its first message in the hello's conversation
    assert hive.db.one("SELECT 1 FROM messages WHERE agent_id = ? AND direction = 'in'", (moved["id"],)) is not None


def test_a_catalogue_that_cannot_be_read_leaves_the_mind_as_it_was(hive_app):
    # nothing is guessed: the hello goes on with the mind on the demonstration model, as it would with no key at all
    hive, c, admin, google, _ = hive_app
    _openrouter(hive, catalogue=False)
    ana, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
    assert c.put("/api/providers/openrouter/key", json={"key": "sk-or-invented"}, headers=admin).status_code == 200
    assert c.post("/api/me/personal-mind/hello", headers=ana).status_code == 200
    assert is_demo(_personal(hive, f"user:{ana_id}")[0]["model"])


def test_with_no_openrouter_key_here_the_hello_reads_no_catalogue(hive_app):
    # no key, no route on OpenRouter can be priced, so its catalogue isn't fetched for the hello (the First Light tests
    # that run a hello on a loop of their own had it fetched there, and the app's shutdown met a connection that loop
    # had closed)
    hive, c, admin, google, _ = hive_app
    asked = _openrouter(hive)
    ana, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
    assert c.post("/api/me/personal-mind/hello", headers=ana).status_code == 200
    assert asked == [] and is_demo(_personal(hive, f"user:{ana_id}")[0]["model"])
