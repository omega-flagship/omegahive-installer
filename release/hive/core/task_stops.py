# Purpose: let a person read and acknowledge their own stopped tasks.
from fastapi import Request

from .db import now


def install_routes(app, hive, operator, viewer):
    @app.get("/api/me/task-stops")
    async def read(request: Request):
        person = viewer(operator(request))
        rows = hive.db.all("SELECT id, goal_id, mind_id, title, status, reason, stopped_at FROM goal_stops "
                           "WHERE principal = ? AND acknowledged_at IS NULL ORDER BY stopped_at, id", (person.principal,))
        return {"stops": rows}

    @app.post("/api/me/task-stops/{stop_id}/acknowledge")
    async def acknowledge(stop_id: str, request: Request):
        person = viewer(operator(request))
        with hive.db.transaction():
            row = hive.db.one("SELECT id FROM goal_stops WHERE id = ? AND principal = ?", (stop_id, person.principal))
            if row is None:
                raise hive.error(404, "not_found", "That isn't available.")
            hive.db.execute("UPDATE goal_stops SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?",
                            (now(), stop_id))
        return {"ok": True}
