"""First Light beat 6 ("Your Ask"): a person names their own Ask and says how it should be, through the existing routes
only: POST /api/me/mind {name} and the ordinary PATCH /api/agents/{id} {persona} on the mind they own."""

from hive.tests.test_personal_mind import _client, _env, _person


def test_a_person_names_and_describes_their_own_ask_and_nobody_else_can(monkeypatch):
    app, google, _sup, _ = _env(monkeypatch)
    c, admin = _client(app)
    try:
        ana, _ana_id = _person(c, admin, google, "ana@example.com", "Ana")
        bo, _bo_id = _person(c, admin, google, "bo@example.com", "Bo")
        mind = c.get("/api/me/mind", headers=ana).json()["mind"]
        r = c.post("/api/me/mind", json={"name": "Juniper"}, headers=ana)
        assert r.status_code == 200 and r.json()["mind"]["name"] == "Juniper"
        r = c.patch(f"/api/agents/{mind['id']}", json={"persona": "Warm and brief. Plain words."}, headers=ana)
        assert r.status_code == 200, r.text
        assert app.state.hive.db.one("SELECT persona FROM agents WHERE id = ?", (mind["id"],))["persona"] == "Warm and brief. Plain words."
        # Another person cannot change it.
        r = c.patch(f"/api/agents/{mind['id']}", json={"persona": "Rude."}, headers=bo)
        assert r.status_code in (403, 404), r.text
        assert app.state.hive.db.one("SELECT persona FROM agents WHERE id = ?", (mind["id"],))["persona"] == "Warm and brief. Plain words."
    finally:
        c.__exit__(None, None, None)
