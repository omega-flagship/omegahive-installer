"""Read-only Hive board/service discovery candidate. No secondary task store.

Route installation requires the platform's existing admin and agent auth guards.
Cross-swarm service discovery is admin-only until a directory visibility policy
exists. Offers alone establish neither demonstrated capability nor eligibility.
"""
from fastapi import Request


class HiveBoards:
    def __init__(self, hive):
        self.hive = hive

    def board(self, kind, entity_id=None):
        if kind not in {"mind", "swarm", "grand"}:
            raise self.hive.error(400, "invalid_board", "unknown board kind")
        if kind != "grand" and not entity_id:
            raise self.hive.error(400, "entity_required", "choose a mind or swarm")
        if kind == "mind":
            self.hive.agent(entity_id)
        if kind == "swarm":
            self.hive.swarm(entity_id)
        goals = [self.hive.goals.view(row) for row in self.hive.db.all("SELECT * FROM goals ORDER BY created_at, id")]
        requests = [self.hive.collab.request_view(row) for row in self.hive.db.all("SELECT * FROM requests ORDER BY created_at, id")]
        by_id = {g["id"]: g for g in goals}
        for req in requests:
            origin = by_id.get(req["from_goal"], {})
            receiving = by_id.get(req["receiving_goal"], {})
            req["origin_owner"] = origin.get("claimed_by") or origin.get("assignee")
            req["receiving_holder"] = receiving.get("claimed_by") or receiving.get("assignee")
        if kind == "mind":
            goals = [g for g in goals if entity_id in {g.get("assignee"), g.get("claimed_by")} or g.get("created_by") == "agent:" + entity_id]
            goal_ids = {g["id"] for g in goals}
            requests = [r for r in requests if r["from_principal"] == "agent:" + entity_id or r["from_goal"] in goal_ids or r["receiving_goal"] in goal_ids]
        elif kind == "swarm":
            goals = [g for g in goals if g["swarm_id"] == entity_id]
            requests = [r for r in requests if entity_id in {r["from_swarm"], r["to_swarm"]}]
        return {"kind": kind, "entity_id": entity_id, "goals": goals, "requests": requests, "source": "canonical-hive", "execution_authorized": False}

    def matches(self, need, kind="swarm"):
        if kind not in {"mind", "swarm"}:
            raise self.hive.error(400, "invalid_kind", "choose mind or swarm")
        if not need or len(need) > 100:
            raise self.hive.error(400, "invalid_need", "name an advertised service")
        candidates = []
        if kind == "mind":
            roles = {r["id"]: r for r in self.hive.roles.list()}
            goals = [self.hive.goals.view(r) for r in self.hive.db.all("SELECT * FROM goals")]
            for mind in self.hive.agents():
                role = roles.get(mind.get("role_id"))
                if not role or role["name"].casefold() != need.casefold():
                    continue
                candidates.append({"entity_id": mind["id"], "kind": "mind", "swarm_id": mind["swarm_id"],
                    "name": mind["name"], "matched_role": {"id": role["id"], "name": role["name"]},
                    "provenance": "admin-configured-role", "status": mind["status"],
                    "verified_capabilities": [], "active_claims": sum(g.get("claimed_by") == mind["id"] and g["status"] in {"claimed", "waiting"} for g in goals),
                    "reasons": ["configured role name matches requested role"], "eligibility": "unverified", "capacity": "unknown", "cost": "unknown",
                    "uncertainties": ["role assignment is not demonstrated capability", "status is observed, not availability", "policy and review independence require assessment"]})
            candidates.sort(key=lambda c: (c["active_claims"], c["entity_id"]))
            return {"need": need, "kind": kind, "candidates": candidates, "policy_version": "configured-role-load-v1", "advisory_only": True, "execution_authorized": False}
        for swarm in self.hive.swarms():
            if need not in self.hive.collab.services(swarm["id"]):
                continue
            goals = self.hive.goals.list(swarm["id"])
            members = [a for a in self.hive.agents() if a["swarm_id"] == swarm["id"]]
            candidates.append({"entity_id": swarm["id"], "kind": "swarm", "name": swarm["name"], "advertised_services": self.hive.collab.services(swarm["id"]), "provenance": "admin-configured-swarm-services", "verified_capabilities": [], "active_claims": sum(g["status"] in {"claimed", "waiting"} for g in goals), "member_count": len(members), "reasons": ["advertises requested service"], "eligibility": "unverified", "capacity": "unknown", "cost": "unknown", "uncertainties": ["no demonstrated capability qualification", "availability and policy eligibility require assessment"]})
        candidates.sort(key=lambda c: (c["active_claims"], c["entity_id"]))
        return {"need": need, "candidates": candidates, "policy_version": "advertised-service-load-v1", "advisory_only": True, "execution_authorized": False}


def install_routes(app, hive, admin_guard, agent_guard, viewer):
    boards = HiveBoards(hive)

    @app.get("/api/boards/{kind}")
    async def operator_board(kind: str, request: Request, entity_id: str | None = None):
        session = admin_guard(request)
        result = boards.board(kind, entity_id)
        result["goals"] = hive.visibility.filter_items(viewer(session), result["goals"])
        result["requests"] = hive.visibility.filter_items(viewer(session), result["requests"])
        return result

    @app.get("/api/agent/board")
    async def own_board(request: Request):
        actor = agent_guard(request)
        board = boards.board("mind", actor["id"])
        # Requests contain cross-swarm context. Members receive their own goals
        # and request ids only; scoped detail stays behind readable_request.
        board["requests"] = [{k: row[k] for k in ("id", "kind", "state", "from_goal", "receiving_goal")} for row in board["requests"]]
        return board

    @app.get("/api/match")
    async def service_matches(request: Request, need: str = "", kind: str = "swarm"):
        session = admin_guard(request)
        result = boards.matches(need, kind)
        visible = {a["id"] for a in hive.visibility.filter_items(viewer(session), hive.agents())} if kind == "mind" else {s["id"] for s in hive.visibility.swarms(viewer(session), hive.swarms())}
        result["candidates"] = [c for c in result["candidates"] if c["entity_id"] in visible]
        return result
