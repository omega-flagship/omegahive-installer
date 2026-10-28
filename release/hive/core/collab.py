"""Cross-swarm requests, immutable artifact revisions and findings (C39; OmegaPlanner, OmegaReview, OmegaSocial).

A request links a goal in the requesting swarm to a goal the hive creates in the receiving swarm. It confers
nothing by itself: no claim, no source access, no execution. Receiving swarms opt in to the kinds they serve.
Nested requests share one budget root (allocation-bounded), are refused past MAX_DEPTH, and a request whose
(receiving swarm, kind, subject digest) already appears in its ancestry is refused as a cycle. Cancelling a
request cancels its receiving goal and every descendant request.

An artifact revision is immutable and digest-bound. The hive computes which steps changed and, through the
revision's dependency graph, every step that depends on them (the delta a review must cover).

A finding stays bound to the revision it was raised on. The planner's response is the planner's claim; only a
reviewer sets a disposition. A new revision clears nothing: each open finding gains 'unverified' applicability
for it. A review result grants no execution authority.
"""

import hashlib
import json
import sqlite3
import re

from .db import new_id, now
from .visibility import Viewer

MAX_DEPTH = 4
MAX_BODY = 256 * 1024
REQUEST_STATE = {"open": "queued", "claimed": "working", "waiting": "needs-approval", "submitted": "in-review", "done": "completed",
                 "failed": "failed", "cancelled": "cancelled"}
SEVERITIES = {"blocker", "major", "minor", "note"}
STANCES = {"addressed", "partly", "disputed"}
RECOMMENDATIONS = ("proceed", "revise", "hold", "unresolved")   # a review's verdict; any explanation goes in the rationale
VERDICTS = {"confirmed-resolved", "still-open", "withdrawn"}
APPLICABILITY = {"unverified", "applies", "no-longer-applies"}

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS swarm_services (swarm_id TEXT PRIMARY KEY, kinds TEXT NOT NULL, set_by TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, from_swarm TEXT NOT NULL, from_goal TEXT, from_principal TEXT NOT NULL,
  to_swarm TEXT NOT NULL, receiving_goal TEXT, subject TEXT, context_refs TEXT NOT NULL, constraints TEXT NOT NULL,
  acceptance TEXT NOT NULL, budget_root TEXT NOT NULL, limit_usd REAL NOT NULL, allocated_usd REAL NOT NULL DEFAULT 0,
  ancestry TEXT NOT NULL, depth INTEGER NOT NULL, cancelled_at TEXT, created_at TEXT NOT NULL)""",
    """CREATE INDEX IF NOT EXISTS requests_goal ON requests(receiving_goal)""",
    """CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, owner_swarm TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS artifact_revisions (artifact_id TEXT NOT NULL, n INTEGER NOT NULL, digest TEXT NOT NULL, parent INTEGER,
  author TEXT NOT NULL, body TEXT NOT NULL, dependency_graph TEXT, changed_steps TEXT NOT NULL, affected_steps TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (artifact_id, n))""",
    """CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, artifact_id TEXT NOT NULL, raised_rev INTEGER NOT NULL,
  raised_digest TEXT NOT NULL, mandate TEXT NOT NULL, target TEXT NOT NULL, severity TEXT NOT NULL, evidence_refs TEXT NOT NULL,
  recommendation TEXT NOT NULL, reviewer TEXT NOT NULL, planner_response TEXT, disposition TEXT, applicability TEXT NOT NULL,
  created_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS finding_target_checks (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL, digest TEXT NOT NULL, target TEXT NOT NULL, program TEXT, ok INTEGER NOT NULL, reason TEXT, created_at TEXT NOT NULL)""",
]


def digest(text):
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


def _j(value):
    return json.dumps(value, sort_keys=True)


def _target_kind(target):
    """The complete first set of finding targets (r2.7); None for anything else."""
    if not isinstance(target, dict):
        return None
    text = lambda v: isinstance(v, str) and 0 < len(v) <= 200
    if set(target) == {"step"} and text(target["step"]):
        return "step"
    if set(target) == {"scene_id", "element_id"} and text(target["scene_id"]) and text(target["element_id"]):
        return "element"
    if set(target) == {"page_id"} and text(target["page_id"]):
        return "page"
    if target == {"whole": True} and target["whole"] is True:
        return "whole"
    return None


# ---- what a finding and a review result look like (mind fitness 2026-10-06) ---------------------------------------
# 108 of 244 hive-finding calls in the 2026-10-04 review trial failed as "give a JSON object", and most of the rest
# as invalid_target or evidence_scope, with nothing in the reply saying what would have worked. Every refusal of a
# finding or a review result now carries the expected shape and, where the request is known, a corrected example
# built from that very request. Harmless variants are made canonical first; nothing required is ever invented.

FINDING_SHAPE = ('{"request_id": "rq_...", "mandate": {"id": "...", "version": "..."}, "target": {"step": "s1"} or '
                 '{"whole": true}, "severity": "blocker|major|minor|note", "recommendation": "what to change and why", '
                 '"evidence_refs": ["a reference the request exhibited"] (optional)}')
REVIEW_SHAPE = ('{"recommendation": "proceed|revise|hold|unresolved", "rationale": "why (at most 4000 characters)", '
                '"finding_ids": ["fd_..."] (every finding you raised on this request, or [] if none), '
                '"coverage": ["what you checked"] (optional, at most 50 texts of 200 characters)}')
EXECUTION_FIELDS = ("execute", "approve", "approval", "run", "apply")


def _one_or_list(value):
    """A single non-empty text where a list is expected is that one item (a mind's commonest JSON slip). Anything
    else is left exactly as given, so "" or null is still refused as before."""
    return [value] if isinstance(value, str) and value.strip() else value


def relax_finding(data):
    """Canonical form of the harmless variants: severity in any case or with spaces around it, one evidence reference
    given as text. Required fields are never filled in, and the target shape stays exact (r2.7)."""
    if not isinstance(data, dict):
        return data
    out = dict(data)
    if isinstance(out.get("severity"), str):
        out["severity"] = out["severity"].strip().lower()
    if "evidence_refs" in out:
        out["evidence_refs"] = _one_or_list(out["evidence_refs"])
    return out


def finding_shape_problems(data):
    """What is wrong with a finding's shape alone (no request, mandate or step lookup); [] when it is well formed."""
    if not isinstance(data, dict):
        return ["a finding is a JSON object"]
    problems = []
    if not (isinstance(data.get("request_id"), str) and data["request_id"].strip()):
        problems.append("request_id is the review request's id (rq_...)")
    mandate = data.get("mandate")
    if not (isinstance(mandate, dict) and mandate.get("id") and mandate.get("version")):
        problems.append("mandate is {id, version}")
    if _target_kind(data.get("target")) is None:
        problems.append("target is {step}, {scene_id, element_id}, {page_id} or {whole: true}")
    if data.get("severity") not in SEVERITIES:
        problems.append(f"severity is one of {sorted(SEVERITIES)}")
    if not (isinstance(data.get("recommendation"), str) and data["recommendation"].strip()):
        problems.append("recommendation is text")
    refs = data.get("evidence_refs", [])
    if not (isinstance(refs, list) and all(isinstance(r, str) for r in refs) and len(refs) == len(set(refs))):
        problems.append("evidence_refs is a list of distinct references")
    if any(k in data for k in EXECUTION_FIELDS):
        problems.append("a finding cannot carry execution fields")
    return problems


def relax_review(data):
    """Canonical form of a review result's harmless variants: recommendation in any case, one finding id or one
    coverage text as text. The rationale and recommendation are never filled in."""
    if not isinstance(data, dict):
        return data
    out = dict(data)
    if isinstance(out.get("recommendation"), str):
        out["recommendation"] = out["recommendation"].strip().lower()
    for key in ("finding_ids", "coverage"):
        if key in out:
            out[key] = _one_or_list(out[key])
    return out


def review_shape_problems(data):
    """What is wrong with a review result's shape alone; [] when it is well formed."""
    if not isinstance(data, dict):
        return ["a review result is a JSON object"]
    problems = []
    if data.get("recommendation") not in RECOMMENDATIONS:
        problems.append(f"recommendation is one of: {', '.join(RECOMMENDATIONS)}")
    rationale = data.get("rationale")
    if not (isinstance(rationale, str) and rationale.strip() and len(rationale) <= 4000):
        problems.append("rationale is text of at most 4000 characters")
    listed = data.get("finding_ids", [])
    if not (isinstance(listed, list) and all(isinstance(i, str) for i in listed) and len(listed) == len(set(listed))):
        problems.append("finding_ids is a list of distinct finding ids")
    coverage = data.get("coverage", [])
    if not (isinstance(coverage, list) and len(coverage) <= 50 and all(isinstance(c, str) and len(c) <= 200 for c in coverage)):
        problems.append("coverage is a list of at most 50 texts of at most 200 characters")
    return problems


def _steps(body):
    """Steps of a plan-shaped body {steps: [{id, ...}]}, keyed by id; {} for anything else."""
    try:
        data = json.loads(body)
    except ValueError:
        return {}
    steps = data.get("steps") if isinstance(data, dict) else None
    return {str(s["id"]): _j(s) for s in steps if isinstance(s, dict) and "id" in s} if isinstance(steps, list) else {}


def _outside_steps(body):
    try:
        data = json.loads(body)
    except ValueError:
        return body
    return _j({k: v for k, v in data.items() if k != "steps"}) if isinstance(data, dict) else _j(data)


def dependants(graph, changed):
    """Every step that depends, directly or transitively, on a changed step. graph = {step: [depends_on...]}."""
    graph = graph or {}
    out, frontier = set(), set(changed)
    while frontier:
        nxt = {s for s, deps in graph.items() if set(deps or []) & frontier and s not in out and s not in changed}
        out |= nxt
        frontier = nxt
    return out


class Collab:
    def __init__(self, hive):
        self.hive = hive
        self.db = hive.db
        for statement in SCHEMA:
            self.db.execute(statement)
        cols = {r["name"] for r in self.db.all("PRAGMA table_info(requests)")}
        if "connection_id" not in cols:
            self.db.execute("ALTER TABLE requests ADD COLUMN connection_id TEXT")
        # A caller's idempotency key travels on the request row itself, so a crash between creating the request and
        # recording the key can never let a retry create a second request (S3 bridge receipt item 4).
        if "idem_key" not in cols:
            self.db.execute("ALTER TABLE requests ADD COLUMN idem_key TEXT")
            self.db.execute("ALTER TABLE requests ADD COLUMN idem_digest TEXT")
        self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS requests_idem ON requests(from_principal, idem_key) WHERE idem_key IS NOT NULL")
        columns = {r["name"] for r in self.db.all("PRAGMA table_info(findings)")}
        if "history" not in columns:
            self.db.execute("ALTER TABLE findings ADD COLUMN history TEXT NOT NULL DEFAULT '[]'")

        if "connection_kinds" not in {r["name"] for r in self.db.all("PRAGMA table_info(swarm_services)")}:
            self.db.execute("ALTER TABLE swarm_services ADD COLUMN connection_kinds TEXT NOT NULL DEFAULT '[]'")

    # ---- services: what a swarm accepts ----------------------------------------------------------

    def set_services(self, swarm_id, kinds, by, connection_only_kinds=None):
        self.hive.swarm(swarm_id)
        if not isinstance(kinds, list) or (connection_only_kinds is not None and not isinstance(connection_only_kinds, list)):
            raise self.hive.error(400, "bad_services", "service kinds must be lists")
        kinds = sorted({str(k).strip() for k in kinds or [] if str(k).strip()})
        private = self.connection_services(swarm_id) if connection_only_kinds is None else sorted(
            {str(k).strip() for k in connection_only_kinds if str(k).strip()})
        if set(kinds) & set(private):
            raise self.hive.error(400, "service_scope_overlap", "a service kind must have one discovery scope")
        self.db.execute("INSERT OR REPLACE INTO swarm_services (swarm_id, kinds, set_by, updated_at, connection_kinds) VALUES (?, ?, ?, ?, ?)",
                        (swarm_id, _j(kinds), by, now(), _j(private)))
        return {"swarm_id": swarm_id, "kinds": kinds, "connection_only_kinds": private}

    def connection_services(self, swarm_id):
        row = self.db.one("SELECT connection_kinds FROM swarm_services WHERE swarm_id = ?", (swarm_id,))
        return json.loads(row["connection_kinds"]) if row else []

    def requester_viewer(self, requester_swarm):
        row = self.db.one("SELECT owner FROM swarms WHERE id = ?", (requester_swarm,))
        if row is None:
            raise self.hive.error(404, "not_found", "no requester swarm")
        # Missing ownership must not inherit operator or administrator visibility.
        return Viewer(row.get("owner") or "unowned:requester", False)

    def visible_services(self, requester_swarm, swarm_id):
        provider = self.db.one("SELECT * FROM swarms WHERE id = ?", (swarm_id,))
        if not self.requester_viewer(requester_swarm).sees(provider):
            return []
        private = [k for k in self.connection_services(swarm_id)
                   if requester_swarm == swarm_id or self.hive.agreements.allows_request(requester_swarm, swarm_id, k)]
        return sorted(set(self.services(swarm_id) + private))

    def service_catalogue(self, requester_swarm):
        """Metadata projection only; advertised service kinds do not prove ability or performance."""
        offers = []
        for row in self.db.all("SELECT swarm_id FROM swarm_services ORDER BY swarm_id"):
            provider = row["swarm_id"]
            for kind in self.visible_services(requester_swarm, provider):
                offers.append({"provider_swarm": provider, "service": kind,
                               "scope": "public" if kind in self.services(provider) else "connection-only",
                               "evidence_tier": "advertised", "unknowns": ["input-contract", "output-contract", "capacity", "performance"]})
        snapshot = {"version": "service-projection/1", "requester_swarm": requester_swarm, "offers": offers}
        return dict(snapshot, digest=digest(_j(snapshot)))

    def capability_catalogue(self, requester_swarm):
        """Draft service slice: metadata only; missing source families are explicit."""
        projected = self.service_catalogue(requester_swarm)
        offers, visible_sources = [], []
        for service in projected["offers"]:
            provider, kind = service["provider_swarm"], service["service"]
            declaration = self.db.one("SELECT updated_at FROM swarm_services WHERE swarm_id = ?", (provider,))
            record = {"swarm_id": provider, "kind": kind, "scope": service["scope"],
                      "updated_at": declaration["updated_at"]}
            source_digest = digest(_j(record))
            visible_sources.append(record)
            swarm = self.db.one("SELECT visibility FROM swarms WHERE id = ?", (provider,))
            offers.append({"id": "offer:" + _j([provider, kind]),
                           "provider": {"kind": "swarm", "id": provider},
                           "capability": {"name": kind, "source": "service"},
                           "scope": {"visibility": swarm["visibility"],
                                     "connection_only": service["scope"] == "connection-only"},
                           "tier": "advertised",
                           "evidence": [{"kind": "config", "ref": "service:" + _j([provider, kind]),
                                         "digest": source_digest, "at": declaration["updated_at"]}],
                           "unknowns": service["unknowns"]})
        role_sources = []
        viewer = self.requester_viewer(requester_swarm)
        for agent in self.db.all("SELECT id, swarm_id, role_id, owner, visibility, shared_with FROM agents WHERE deleted = 0 ORDER BY id"):
            swarm = self.db.one("SELECT * FROM swarms WHERE id = ?", (agent["swarm_id"],))
            if not viewer.sees(swarm) or not viewer.sees(agent):
                continue
            role = self.db.one("SELECT id, media, mandate, updated_at FROM roles WHERE id = ?", (agent["role_id"],))
            if not role:
                continue
            media, mandate = json.loads(role["media"] or "[]"), json.loads(role["mandate"] or "null")
            capabilities = [("role.media", name) for name in media]
            if mandate:
                capabilities.append(("role.mandate", mandate["id"]))
            if not capabilities:
                continue
            record = {"agent_id": agent["id"], "swarm_id": agent["swarm_id"], "role": role}
            role_sources.append(record)
            for source, name in capabilities:
                offers.append({"id": "offer:" + _j([agent["id"], source, name]),
                               "provider": {"kind": "agent", "id": agent["id"]},
                               "capability": {"name": name, "source": source},
                               "scope": {"visibility": agent["visibility"], "connection_only": False},
                               "tier": "advertised",
                               "evidence": [{"kind": "config", "ref": "role:" + _j([agent["id"], role["id"]]),
                                             "digest": digest(_j(record)), "at": role["updated_at"]}],
                               "unknowns": ["input-contract", "output-contract", "capacity", "performance",
                                            "eligibility", "role-assignment-is-not-demonstrated-ability"]})
        program_sources = []
        for activation in self.db.all("SELECT program, swarm FROM app_activations WHERE active = 1 ORDER BY program, swarm"):
            swarm = self.db.one("SELECT * FROM swarms WHERE id = ?", (activation["swarm"],))
            if not viewer.sees(swarm):
                continue
            entry = self.hive.programs.programs.get(activation["program"])
            if not entry or entry["error"] or not entry.get("digest") or entry["id"] in self.hive.programs.disabled:
                continue
            for action in (entry.get("describe") or {}).get("actions", []):
                record = {"program": entry["id"], "swarm_id": activation["swarm"],
                          "package_digest": entry.get("digest"), "action": action["id"]}
                program_sources.append(record)
                offers.append({"id": "offer:" + _j([entry["id"], activation["swarm"], action["id"]]),
                               "provider": {"kind": "program", "id": "program:" + entry["id"]},
                               "capability": {"name": action["id"], "source": "program.action"},
                               "scope": {"visibility": swarm["visibility"], "connection_only": False,
                                         "swarm_id": activation["swarm"]},
                               "tier": "advertised",
                               "evidence": [{"kind": "config", "ref": "program-activation:" + _j([entry["id"], activation["swarm"]]),
                                             "digest": digest(_j(record)), "at": None}],
                               "unknowns": ["action-authorization", "attachment-scope", "input-contract", "output-contract",
                                            "capacity", "performance", "config-timestamp-unavailable", "activation-is-not-execution-authority"]})
        offers.sort(key=lambda offer: offer["id"])
        snapshot = {"requester_swarm": requester_swarm, "offers": offers,
                    "sources": {"services": digest(_j(visible_sources)), "roles": digest(_j(role_sources)),
                                "skills": None, "programs": digest(_j(program_sources)), "code": None},
                    "truncated": True,
                    "unknowns": ["skills-not-projected", "code-not-projected",
                                 "performance-evidence-not-derived", "semantic-witnesses-unavailable"]}
        return dict(snapshot, catalogue_digest=digest(_j(snapshot)), generated_at=now())

    def services(self, swarm_id):
        row = self.db.one("SELECT kinds FROM swarm_services WHERE swarm_id = ?", (swarm_id,))
        return json.loads(row["kinds"]) if row else []

    # ---- requests --------------------------------------------------------------------------------

    def _member_of(self, agent, swarm_id):
        return agent.get("swarm_id") == swarm_id

    def request_view(self, row):
        out = dict(row)
        for key in ("subject", "context_refs", "constraints", "acceptance", "ancestry"):
            out[key] = json.loads(row[key]) if row.get(key) else None
        goal = self.db.one("SELECT status, result_data FROM goals WHERE id = ?", (row["receiving_goal"],)) if row["receiving_goal"] else None
        out["state"] = "cancelled" if row.get("cancelled_at") else REQUEST_STATE.get((goal or {}).get("status"), "accepted")
        out["result"] = json.loads(goal["result_data"]) if goal and goal.get("result_data") else None
        out["budget"] = {"root": row["budget_root"], "limit_usd": row["limit_usd"], "allocated_usd": row["allocated_usd"]}
        minds = getattr(self.hive, "minds", None)
        lease = minds.lease_view(row["id"]) if minds is not None else None
        if lease is not None:
            out["lease"] = lease          # r2.13.1 §3: the person-issued lease bound to this request
            out["budget"].update(minds.spend_view(row["id"]))   # live: children's spend and unresolved call holds
        return out

    def review_receipts(self, agent, subject_digest):
        """Every review request to this mind's swarm on one exact subject, with each specialist's stored receipt, its
        reviewer-of-the-review decisions and their notes, verbatim, for a coordinator to aggregate without erasing
        dissent. Only minds of the receiving swarm may read it; the subject is matched by digest, never by a claim."""
        if not agent.get("swarm_id"):
            raise self.hive.error(403, "swarm_required", "a coordinator in the reviewing swarm reads its receipts")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(subject_digest or "")):
            hint = ""
            row = self.db.one("SELECT subject FROM requests WHERE id = ? AND to_swarm = ?", (str(subject_digest or ""), agent["swarm_id"]))
            if row and row.get("subject"):
                hint = f"; request {subject_digest} is on subject {json.loads(row['subject']).get('digest')}"
            raise self.hive.error(400, "bad_request", "give the subject digest (sha256:...), not a request or artifact id" + hint)
        out = []
        for row in self.db.all("SELECT * FROM requests WHERE to_swarm = ? AND kind = 'review' ORDER BY created_at", (agent["swarm_id"],)):
            subject = json.loads(row["subject"]) if row.get("subject") else {}
            if subject.get("digest") != subject_digest:
                continue
            view = self.request_view(row)
            goal = self.db.one("SELECT status, claimed_by, assignee FROM goals WHERE id = ?", (row["receiving_goal"],)) or {}
            reviews = self.db.all("SELECT at, by, action, notes, result_digest FROM goal_reviews WHERE goal_id = ? ORDER BY at, rowid",
                                  (row["receiving_goal"],))
            out.append({"request_id": row["id"], "from_swarm": row["from_swarm"], "mandate": (view["constraints"] or {}).get("mandates"),
                        "reviewer": goal.get("claimed_by") or goal.get("assignee"), "state": view["state"],
                        "receipt": (view["result"] or {}).get("review_receipt"), "qc": reviews})
        return {"subject_digest": subject_digest, "requests": out, "count": len(out)}

    def planner_review_context(self, agent, request_id, artifact_id, revision):
        """The holding planner reads the same canonical projection used by validation."""
        req = self.get_request(request_id)
        goal = self.hive.goals.get(req["receiving_goal"])
        if req["kind"] != "plan" or req["to_swarm"] != agent.get("swarm_id") or goal.get("claimed_by") != agent["id"]:
            raise self.hive.error(403, "forbidden", "only the mind holding this planning request reads its review context")
        projection = self.planning_review_context(goal, request_id, artifact_id, revision)
        if projection is None:
            raise self.hive.error(409, "review_context_unavailable", "planning request, artifact, revision or lease is unavailable; no complete projection returned")
        return projection

    def planning_review_context(self, goal, request_id, artifact_id, revision):
        """Canonical projection: a held plan request, owned artifact and its review family.

        Artifact identity is explicit because plan requests have no subject until a
        planner publishes one. This read grants no access outside the goal's swarm.
        None means unavailable/refused, never an empty successful projection.
        """
        if type(request_id) is not str or type(artifact_id) is not str or type(revision) is not int or revision < 1:
            return None
        live = self.db.one("SELECT * FROM goals WHERE id = ?", (goal.get("id"),))
        req = self.db.one("SELECT * FROM requests WHERE id = ?", (request_id,))
        if not live or not req or req["kind"] != "plan" or req["receiving_goal"] != live["id"] or req["to_swarm"] != live["swarm_id"]:
            return None
        binding = json.loads(live.get("binding") or "{}")
        if binding.get("request_id") != request_id or live["status"] not in {"claimed", "waiting"} or not live.get("claimed_by"):
            return None
        if live.get("lease_until") and live["lease_until"] < now():
            return None
        art = self.db.one("SELECT * FROM artifacts WHERE id = ?", (artifact_id,))
        if not art or art["kind"] != "plan" or art["owner_swarm"] != live["swarm_id"]:
            return None
        rev = self.db.one("SELECT * FROM artifact_revisions WHERE artifact_id = ? AND n = ?", (artifact_id, revision))
        latest = self.db.one("SELECT MAX(n) AS n FROM artifact_revisions WHERE artifact_id = ?", (artifact_id,))
        if not rev:
            return None
        findings = [self.finding_view(row) for row in self.db.all("SELECT * FROM findings WHERE artifact_id = ? ORDER BY created_at, id LIMIT 1001", (artifact_id,))]
        reviews = []
        rows = self.db.all("""SELECT * FROM requests WHERE kind = 'review'
            AND json_extract(subject, '$.artifact_id') = ?
            AND EXISTS (SELECT 1 FROM json_each(requests.ancestry) WHERE value = ?)
            ORDER BY created_at, id LIMIT 257""", (artifact_id, request_id))
        for row in rows:
            subject = json.loads(row.get("subject") or "{}")
            if request_id not in json.loads(row["ancestry"]) or subject.get("artifact_id") != artifact_id:
                continue
            view = self.request_view(row)
            reviews.append({"request_id": row["id"], "subject": subject, "state": view["state"],
                            "mandates": view["constraints"].get("mandates", []),
                            "receipt": (view["result"] or {}).get("review_receipt"),
                            "qc": self.hive.goals.reviews(row["receiving_goal"])})
        if len(findings) > 1000 or len(reviews) > 256:
            return None
        return {"request_id": request_id, "subject": {"artifact_id": artifact_id, "revision": revision, "digest": rev["digest"]},
                "latest_revision": latest["n"], "findings": findings, "reviews": reviews,
                "authority": "none"}

    def get_request(self, request_id):
        row = self.db.one("SELECT * FROM requests WHERE id = ?", (request_id,))
        if row is None:
            raise self.hive.error(404, "not_found", f"no request {request_id}")
        return row

    def _parent_request(self, goal_id):
        """The request a goal serves, walking up same-swarm parents: how a nested request finds its ancestry."""
        seen = 0
        while goal_id and seen < 20:
            row = self.db.one("SELECT * FROM requests WHERE receiving_goal = ?", (goal_id,))
            if row:
                return row
            g = self.db.one("SELECT parent_id FROM goals WHERE id = ?", (goal_id,))
            goal_id, seen = (g or {}).get("parent_id"), seen + 1
        return None

    async def create_request(self, agent, data, on_commit_record=None):
        hive = self.hive
        kind, to_swarm, title = str(data.get("kind") or ""), str(data.get("to_swarm") or ""), str(data.get("title") or "").strip()
        from_goal = data.get("from_goal")
        if not kind or not to_swarm or not title:
            raise hive.error(400, "bad_request", "kind, to_swarm and title are required")
        if not agent.get("swarm_id") or to_swarm == agent["swarm_id"]:
            raise hive.error(400, "bad_request", "a request goes to another swarm (use tasks inside your own)")
        hive.swarm(to_swarm)
        hive.require_open_swarm(to_swarm)   # a retired swarm is asked for nothing
        connection = None
        if kind not in self.services(to_swarm):
            connection = hive.agreements.allows_request(agent["swarm_id"], to_swarm, kind)
            if connection is None:
                raise hive.error(403, "not_offered", f"that swarm does not accept {kind!r} requests, and no active "
                                                     "connection allows them")
        if not from_goal:
            raise hive.error(400, "bad_request", "from_goal is required: a request is made for a task you hold")
        goal = hive.goals.get(from_goal)
        if goal["swarm_id"] != agent["swarm_id"] or goal["claimed_by"] != agent["id"]:
            raise hive.error(403, "goal_not_held", "requests are made for a task you have claimed")
        if getattr(hive,"flows",None) and hive.flows.owns_goal(from_goal):
            raise hive.error(409,"unsupported_flow_delegation","cross-swarm requests from flow tasks are outside the qualified tasks-only subset")
        constraints_in = data.get("constraints")
        if isinstance(constraints_in, dict) and "result_schema" in constraints_in:
            from .result_schema import SchemaError, check_schema
            try:
                check_schema(constraints_in["result_schema"])
            except SchemaError as exc:
                raise hive.error(400, "bad_result_schema", str(exc))
        subject = data.get("subject") or None
        if subject is not None:
            subject = self._resolve_subject(subject)
            if self.artifact(subject["artifact_id"])["owner_swarm"] != agent["swarm_id"]:
                raise hive.error(403, "not_your_artifact", "a request's subject must be an artifact your swarm owns")
        assignee = None
        if kind == "review":
            constraints = data.get("constraints")
            mandates = constraints.get("mandates") if isinstance(constraints, dict) else None
            if not isinstance(mandates, list) or len(mandates) != 1 or not isinstance(mandates[0], dict) or set(mandates[0]) != {"id", "version"}:
                raise hive.error(400, "review_mandate", "one review request assigns exactly one versioned mandate")
            roster = self.db.all("SELECT a.id, a.name, a.role_id, r.mandate FROM agents a LEFT JOIN roles r ON r.id=a.role_id WHERE a.swarm_id=? AND a.deleted=0", (to_swarm,))
            eligible = [m for m in roster if m.get("mandate") and json.loads(m["mandate"]) == mandates[0]]
            if data.get("reviewer_id") is not None:
                eligible = [m for m in eligible if m["id"] == data["reviewer_id"]]
            if len(eligible) != 1:
                raise hive.error(409, "reviewer_ambiguous", "select one eligible reviewer; no unique role-mandate match")
            selected = eligible[0]
            if sum(m["name"] == selected["name"] for m in roster) != 1:
                raise hive.error(409, "reviewer_ambiguous", "assignee name is not unique in the receiving swarm")
            assignee = selected["name"]
        parent = self._parent_request(from_goal)
        ancestry = (json.loads(parent["ancestry"]) + [parent["id"]]) if parent else []
        if len(ancestry) >= MAX_DEPTH:
            raise hive.error(400, "too_deep", f"requests nest at most {MAX_DEPTH} levels")
        key = (to_swarm, kind, (subject or {}).get("digest"))
        for ancestor_id in ancestry:
            a = self.get_request(ancestor_id)
            a_subject = json.loads(a["subject"]) if a["subject"] else {}
            if (a["to_swarm"], a["kind"], a_subject.get("digest")) == key:
                raise hive.error(409, "request_cycle", "this request repeats one already in its own ancestry")
        try:
            asked = float(data.get("budget_usd", 0))
        except (TypeError, ValueError):
            raise hive.error(400, "bad_request", "budget_usd must be a number") from None
        import math
        if not math.isfinite(asked) or asked > 1_000_000:
            raise hive.error(400, "bad_request", "budget_usd must be a finite amount")
        if asked < 0:
            raise hive.error(400, "bad_request", "budget_usd must not be negative")
        rid = new_id("rq")
        # Every write of a request (budget allocation, receiving goal, request row, and the caller's own record of it)
        # commits together or not at all; the goal is announced only after the commit (Kimi 2026-10-04: a failure
        # between these writes abandoned allocated budget and could leave an orphan receiving goal).
        try:
            with self.db.transaction():
                if parent:
                    remaining = parent["limit_usd"] - parent["allocated_usd"]
                    limit = min(asked, remaining)
                    if asked > remaining + 1e-9:
                        raise hive.error(402, "request_budget", f"the parent request has ${remaining:.2f} left to allocate")
                    root = parent["budget_root"]
                    self.db.execute("UPDATE requests SET allocated_usd = allocated_usd + ? WHERE id = ?", (limit, parent["id"]))
                else:
                    limit, root = asked, rid
                    if connection is not None:
                        hive.agreements.allocate(connection, asked)
                binding = {"request_id": rid, "kind": kind, "from_swarm": agent["swarm_id"], "subject_digest": (subject or {}).get("digest")}
                receiving = hive.goals._create_record(to_swarm, title, str(data.get("detail") or ""), data.get("priority", 0.5),
                                                      created_by=f"request:{rid}", binding=binding, assignee=assignee,
                                                      deadline_minutes=data.get("deadline_minutes"), emit=False)
                row = {"id": rid, "kind": kind, "title": title[:300], "from_swarm": agent["swarm_id"], "from_goal": from_goal,
                       "from_principal": f"agent:{agent['id']}", "to_swarm": to_swarm, "receiving_goal": receiving["id"],
                       "subject": _j(subject) if subject else None, "context_refs": _j(data.get("context_refs") or []),
                       "constraints": _j(data.get("constraints") or {}), "acceptance": _j(data.get("acceptance") or []),
                       "budget_root": root, "limit_usd": limit, "allocated_usd": 0.0, "ancestry": _j(ancestry),
                       "depth": len(ancestry), "cancelled_at": None, "created_at": now(),
                       "connection_id": connection["id"] if connection else (parent.get("connection_id") if parent else None),
                       "idem_key": data.get("idem_key"), "idem_digest": data.get("idem_digest")}
                self.db.insert("requests", row)
                if on_commit_record is not None:
                    on_commit_record(row)        # the caller's idempotency record, in the same transaction
        except sqlite3.IntegrityError:
            # Only a key that another request now holds is a race; any other integrity failure is a real error.
            if data.get("idem_key") is None or self.request_by_idempotency(f"agent:{agent['id']}", data["idem_key"]) is None:
                raise
            raise hive.error(409, "idempotency_race", "the same idempotency key was used concurrently; retry to read the answer")
        hive.goals._emit(receiving["id"])
        await hive.goals.announce(receiving)
        hive.events.publish("request.updated", request=self.request_view(row))
        return self.request_view(row)

    def request_by_idempotency(self, principal, key):
        return self.db.one("SELECT * FROM requests WHERE from_principal = ? AND idem_key = ?", (principal, key))

    def readable_request(self, agent, request_id):
        row = self.get_request(request_id)
        if agent["swarm_id"] not in (row["from_swarm"], row["to_swarm"]):
            raise self.hive.error(403, "forbidden", "only the two swarms of a request can read it")
        return self.request_view(row)

    async def cancel_request(self, request_id, by):
        row = self.get_request(request_id)
        cancelled = []
        for rid in [request_id] + [r["id"] for r in self.db.all("SELECT id, ancestry FROM requests")
                                   if request_id in json.loads(r["ancestry"])]:
            r = self.get_request(rid)
            if r["cancelled_at"]:
                continue
            self.db.update("requests", rid, {"cancelled_at": now()})
            goal = self.db.one("SELECT status FROM goals WHERE id = ?", (r["receiving_goal"],))
            if goal and goal["status"] not in ("done", "failed", "cancelled"):
                self.hive.goals.update(r["receiving_goal"], {"status": "cancelled"})
                await self.hive.goals.notify_cancelled(r["receiving_goal"])
            cancelled.append(rid)
        minds = getattr(self.hive, "minds", None)
        if minds is not None:
            for rid in cancelled:
                await minds.request_cancelled(rid)   # r2.12 §6: pause this request's children, end its lease; nothing else
        self.hive.events.publish("request.updated", request=self.request_view(self.get_request(request_id)))
        return {"cancelled": cancelled, "by": by}

    async def agent_cancel(self, agent, request_id):
        row = self.get_request(request_id)
        if row["from_swarm"] != agent["swarm_id"]:
            raise self.hive.error(403, "forbidden", "only the requesting swarm cancels a request")
        return await self.cancel_request(request_id, f"agent:{agent['id']}")

    # ---- artifacts -----------------------------------------------------------------------------

    def create_artifact(self, agent, data, *, principal=None):
        kind, title = str(data.get("kind") or ""), str(data.get("title") or "").strip()
        if not kind or not title or not agent.get("swarm_id"):
            raise self.hive.error(400, "bad_request", "kind and title are required, from a mind in a swarm")
        row = {"id": new_id("ar"), "kind": kind[:40], "title": title[:300], "owner_swarm": agent["swarm_id"],
               "created_by": principal or f"agent:{agent['id']}", "created_at": now()}
        self.db.insert("artifacts", row)
        return row

    def artifact(self, artifact_id):
        row = self.db.one("SELECT * FROM artifacts WHERE id = ?", (artifact_id,))
        if row is None:
            raise self.hive.error(404, "not_found", f"no artifact {artifact_id}")
        return row

    def add_revision(self, agent, artifact_id, data, *, principal=None):
        # J3 R3: one transaction, so a Studio session's write fence and the step binding commit with the revision or not
        with self.db.transaction():
            return self._add_revision(agent, artifact_id, data, principal=principal)

    def _add_revision(self, agent, artifact_id, data, *, principal=None):
        art = self.artifact(artifact_id)
        if art["owner_swarm"] != agent["swarm_id"]:
            raise self.hive.error(403, "forbidden", "only the owning swarm adds revisions")
        body = data.get("body")
        studio = getattr(self.hive, "studio", None)
        # J3 R3 (plan r1.1 S4, r1.3 F1.3): the bound maker, its open step's execution, once, <=32 KiB, after its read;
        # and no mind on a live session's piece source. execution_id travels outside body; body is never parsed.
        bind = studio.revision_fence(agent, art, body, principal, data.get("execution_id"),
                                     data.get("op_ids")) if studio is not None else None
        if not isinstance(body, str) or not body or len(body.encode()) > MAX_BODY:
            raise self.hive.error(400, "bad_request", "body is text of at most 256 KB")
        last = self.db.one("SELECT * FROM artifact_revisions WHERE artifact_id = ? ORDER BY n DESC LIMIT 1", (artifact_id,))
        expected = data.get("parent")
        if (last["n"] if last else None) != expected:
            raise self.hive.error(409, "stale_parent", f"the latest revision is {last['n'] if last else None}; build on that")
        graph = data.get("dependency_graph")
        if graph is not None and not (isinstance(graph, dict) and all(isinstance(v, list) for v in graph.values())):
            raise self.hive.error(400, "bad_request", "dependency_graph is {step: [steps it depends on]}")
        new, old = _steps(body), _steps(last["body"]) if last else {}
        changed = sorted(k for k in set(new) | set(old) if new.get(k) != old.get(k)) if last else []
        affected = sorted(dependants(graph, changed)) if last else []
        # a change outside the steps (goal, global constraints, assumptions) puts the whole plan in scope
        whole = bool(last) and _outside_steps(body) != _outside_steps(last["body"])
        if whole:
            affected = sorted(set(new) - set(changed))
        n = (last["n"] + 1) if last else 1
        row = {"artifact_id": artifact_id, "n": n, "digest": digest(body), "parent": last["n"] if last else None,
               "author": principal or f"agent:{agent['id']}", "body": body, "dependency_graph": _j(graph) if graph is not None else None,
               "changed_steps": _j(changed), "affected_steps": _j(affected), "created_at": now()}
        whole_plan = whole
        self.db.execute("INSERT INTO artifact_revisions VALUES (?,?,?,?,?,?,?,?,?,?)", tuple(row.values()))
        # refinement 2: nothing clears; each finding not closed gains 'unverified' for this revision
        touched = set(changed) | set(affected)
        for f in self.db.all("SELECT * FROM findings WHERE artifact_id = ?", (artifact_id,)):
            disp = json.loads(f["disposition"]) if f["disposition"] else None
            entry = {"revision": n, "state": "unverified", "by": "hive"}
            if disp and disp.get("verdict") == "withdrawn":
                continue
            if disp and disp.get("verdict") == "confirmed-resolved":
                # a resolved finding comes back for checking only when what it targeted changed
                step = (json.loads(f["target"]) or {}).get("step")
                if not whole and step is not None and step not in touched:   # non-step targets are checked again on any new revision
                    continue
                entry["reason"] = "target changed after resolution"
            app = json.loads(f["applicability"]) + [entry]
            self.db.update("findings", f["id"], {"applicability": _j(app), "history": self._append_history(f, {"type": "applicability", **entry, "at": now()})})
        # r2.8: a body-free notice for app frames that subscribed to this artifact (filtered per viewer by swarm visibility)
        # Only once the publication is durable: an enclosing transaction that rolls back sends no notice.
        notice = dict(swarm_id=art["owner_swarm"], artifact_id=artifact_id, revision=n,
                      digest=row["digest"], created_at=row["created_at"])
        self.db.after_commit(lambda: self.hive.events.publish("artifact.revision", **notice))
        if bind is not None:
            bind(row)
        out = self.revision_view(row, with_body=False)
        out["whole_plan_in_scope"] = whole_plan
        return out

    def revision_view(self, row, with_body=True):
        out = {k: v for k, v in row.items() if with_body or k != "body"}
        for key in ("dependency_graph", "changed_steps", "affected_steps"):
            out[key] = json.loads(row[key]) if row.get(key) else None
        return out

    def _resolve_subject(self, subject):
        art = self.artifact(str(subject.get("artifact_id")))
        rev = self.db.one("SELECT n, digest FROM artifact_revisions WHERE artifact_id = ? AND n = ?", (art["id"], subject.get("revision")))
        if rev is None:
            raise self.hive.error(404, "not_found", "no such artifact revision")
        if subject.get("digest") and subject["digest"] != rev["digest"]:
            raise self.hive.error(409, "digest_mismatch", "the subject's digest does not match that revision")
        return {"artifact_id": art["id"], "revision": rev["n"], "digest": rev["digest"]}

    def read_revision(self, agent, artifact_id, n):
        art = self.artifact(artifact_id)
        row = self.db.one("SELECT * FROM artifact_revisions WHERE artifact_id = ? AND n = ?", (artifact_id, int(n)))
        if row is None:
            raise self.hive.error(404, "not_found", "no such revision")
        if agent["swarm_id"] != art["owner_swarm"] and not self._review_access(agent, artifact_id, row["n"], row["digest"]):
            raise self.hive.error(403, "forbidden", "only the owning swarm, or a swarm with a live request on exactly this revision, can read it")
        return self.revision_view(row)

    def _review_access(self, agent, artifact_id, n=None, revision_digest=None):
        """A receiving swarm reads exactly the revision (and digest) its request names, and only while that
        request is live: not cancelled, and its receiving goal not finished. n=None asks 'any live request on
        this artifact' (used for listing findings)."""
        for r in self.db.all("SELECT * FROM requests WHERE to_swarm = ? AND cancelled_at IS NULL", (agent["swarm_id"],)):
            subject = json.loads(r["subject"]) if r["subject"] else {}
            if subject.get("artifact_id") != artifact_id:
                continue
            if n is not None and (subject.get("revision") != n or subject.get("digest") != revision_digest):
                continue
            goal = self.db.one("SELECT status FROM goals WHERE id = ?", (r["receiving_goal"],))
            if goal and goal["status"] in ("done", "failed", "cancelled"):
                continue
            return True
        return False

    # ---- findings ----------------------------------------------------------------------------

    def finding_view(self, row):
        out = dict(row)
        for key in ("mandate", "target", "evidence_refs", "planner_response", "disposition", "applicability", "history"):
            out[key] = json.loads(row[key]) if row.get(key) else None
        out["raised_on"] = {"artifact_id": row["artifact_id"], "revision": row["raised_rev"], "digest": row["raised_digest"]}
        return out

    def _request_by_id_or_goal(self, value, shape):
        """A request by its id or by its receiving goal's id: minds often name the review goal they hold (g_...)."""
        value = str(value or "").strip()
        row = self.db.one("SELECT * FROM requests WHERE id = ?", (value,)) if value else None
        if row is None and value.startswith("g_"):
            row = self.db.one("SELECT * FROM requests WHERE receiving_goal = ? ORDER BY created_at DESC LIMIT 1", (value,))
        if row is None:
            raise self.hive.error(404, "not_found", f"no request {value or '(none given)'}: the review request id (rq_...) "
                                                    f"is in hive-goal-get of the review task you hold. Expected: {shape}")
        return row

    @staticmethod
    def _match_mandate(mandate, assigned):
        """The assigned mandate a finding names, when it differs only by writing the version as a number."""
        if isinstance(mandate, dict) and mandate.get("id") and mandate.get("version") and mandate not in assigned:
            for a in assigned:
                if isinstance(a, dict) and str(a.get("id")) == str(mandate["id"]) and str(a.get("version")) == str(mandate["version"]):
                    return a
        return mandate

    def _finding_example(self, req, data, body):
        """A finding for exactly this request that the hive would accept, keeping what the mind got right."""
        steps = list(_steps(body)) if body else []
        target = data.get("target")
        kind = _target_kind(target)
        if not (kind == "whole" or (kind == "step" and target["step"] in steps)):
            target = {"step": steps[0]} if steps else {"whole": True}
        assigned = self._mandates(req)
        allowed = json.loads(req["context_refs"]) if req["context_refs"] else []
        refs = data.get("evidence_refs")
        recommendation = data.get("recommendation")
        return {"request_id": req["id"],
                "mandate": assigned[0] if assigned else {"id": "your mandate id", "version": "its version"},
                "target": target, "severity": data.get("severity") if data.get("severity") in SEVERITIES else "major",
                "recommendation": recommendation.strip()[:300] if isinstance(recommendation, str) and recommendation.strip()
                else "what to change, and why",
                "evidence_refs": [r for r in refs if r in allowed] if isinstance(refs, list) and isinstance(allowed, list) else []}

    def _finding_refused(self, status, code, message, req, data, body, note=""):
        example = json.dumps(self._finding_example(req, data, body), ensure_ascii=False)
        return self.hive.error(status, code, f"{message}{note}. Expected: {FINDING_SHAPE}. Corrected example: hive-finding {example}")

    async def raise_finding(self, agent, data):
        if not isinstance(data, dict):
            raise self.hive.error(400, "bad_request", f"a finding is a JSON object. Expected: {FINDING_SHAPE}")
        data = relax_finding(data)
        req = self._request_by_id_or_goal(data.get("request_id"), FINDING_SHAPE)
        if req["to_swarm"] != agent["swarm_id"] or req["cancelled_at"]:
            raise self.hive.error(403, "forbidden", "findings come from the swarm a live request was sent to")
        if not req["subject"]:
            raise self.hive.error(400, "bad_request", "this request has no artifact subject to review")
        subject = json.loads(req["subject"])
        self._held_review(agent, req, subject)
        art = self.artifact(subject["artifact_id"])
        if art["owner_swarm"] == agent["swarm_id"]:
            raise self.hive.error(403, "self_review", "a swarm cannot review its own artifact")
        # from here the mind holds this very request: refusals carry a corrected example built from it
        body = self.db.one("SELECT body FROM artifact_revisions WHERE artifact_id = ? AND n = ?", (art["id"], subject["revision"]))["body"]
        assigned = self._mandates(req)
        mandate = self._match_mandate(data.get("mandate") or {}, assigned)
        if not (isinstance(mandate, dict) and mandate.get("id") and mandate.get("version")):
            raise self._finding_refused(400, "bad_request", "mandate is {id, version}", req, data, body,
                                        f"; this request assigns {json.dumps(assigned)}")
        if mandate not in assigned:
            raise self._finding_refused(403, "mandate_unassigned", "the review request must assign this mandate and version",
                                        req, data, body, f"; it assigns {json.dumps(assigned)}")
        self._eligible(agent, mandate)
        refs, allowed = data.get("evidence_refs", []), json.loads(req["context_refs"])
        if (not isinstance(refs, list) or not all(isinstance(r, str) for r in refs) or len(refs) != len(set(refs))
                or not isinstance(allowed, list) or not all(r in allowed for r in refs)):
            raise self._finding_refused(403, "evidence_scope", "evidence must be among the references the request exhibited",
                                        req, data, body, f"; it exhibited {json.dumps(allowed)} (or give none)")
        target = data.get("target")
        kind = _target_kind(target)
        steps = f"; the steps of r{subject['revision']} are {json.dumps(list(_steps(body)))}" if art["kind"] == "plan" else ""
        if kind == "step":
            if art["kind"] != "plan" or target["step"] not in _steps(body):
                raise self._finding_refused(400, "invalid_target", "a step target names an existing step of the reviewed plan revision",
                                            req, data, body, steps)
        elif kind is None:
            raise self._finding_refused(400, "invalid_target", "a target is {step}, {scene_id, element_id}, {page_id} or {whole: true}",
                                        req, data, body, steps)
        else:
            await self._check_finding_target(agent, req, subject, body, target)
        if not isinstance(data.get("recommendation"), str) or not data["recommendation"].strip():
            raise self._finding_refused(400, "bad_request", "a finding needs its recommendation and rationale", req, data, body)
        if data.get("severity") not in SEVERITIES:
            raise self._finding_refused(400, "bad_request", f"severity is one of {sorted(SEVERITIES)}", req, data, body)
        if any(k in data for k in EXECUTION_FIELDS):
            raise self._finding_refused(400, "no_execution", "a finding recommends; it cannot carry execution fields", req, data, body)
        row = {"id": new_id("fd"), "request_id": req["id"], "artifact_id": art["id"], "raised_rev": subject["revision"],
               "raised_digest": subject["digest"], "mandate": _j(mandate), "target": _j(data.get("target") or {}),
               "severity": data["severity"], "evidence_refs": _j(data.get("evidence_refs") or []),
               "recommendation": str(data.get("recommendation") or "")[:4000], "reviewer": f"agent:{agent['id']}",
               "planner_response": None, "disposition": None, "applicability": _j([]), "created_at": now(), "history": _j([])}
        # Recheck authority at the commit boundary (found by OmegaReview 2026-10-04): the validator above may await,
        # and the request can be cancelled, its subject changed or the reviewer's eligibility withdrawn meanwhile.
        with self.db.transaction():
            live = self.get_request(req["id"])
            if live["to_swarm"] != agent["swarm_id"] or live["cancelled_at"]:
                raise self.hive.error(403, "forbidden", "findings come from the swarm a live request was sent to (it was cancelled or moved while the finding was checked)")
            if (json.loads(live["subject"]) if live["subject"] else None) != subject:
                raise self.hive.error(409, "subject_changed", "the request's subject changed while the finding was checked")
            self._held_review(agent, live, subject)
            if mandate not in self._mandates(live):
                raise self.hive.error(403, "mandate_unassigned", "the review request no longer assigns this mandate and version")
            self._eligible(agent, mandate)
            self.db.insert("findings", row)
        return self.finding_view(row)

    def swarm_artifacts(self, swarm_id, kind=None, limit=200):
        """Candidate (Studio picker): the artifacts owned by one swarm, each at its latest revision, as exact references.
        Metadata only (id, kind, title, revision, digest, times); never a body or an author. The caller has already
        checked that the viewer sees that swarm; these are exactly the revisions an app reads for that viewer there
        (ProgramContext.read_revision: the owning swarm reads its own)."""
        limit = max(1, min(int(limit), 200))
        rows = self.db.all(
            "SELECT a.id, a.kind, a.title, a.created_at, r.n, r.digest, r.created_at AS revised_at FROM artifacts a "
            "JOIN artifact_revisions r ON r.artifact_id = a.id AND r.n = (SELECT MAX(n) FROM artifact_revisions WHERE artifact_id = a.id) "
            "WHERE a.owner_swarm = ?" + (" AND a.kind = ?" if kind else "") + " ORDER BY r.created_at DESC, a.id LIMIT ?",
            (swarm_id, kind, limit) if kind else (swarm_id, limit))
        return [{"artifact_id": r["id"], "kind": r["kind"], "title": r["title"], "revision": r["n"], "digest": r["digest"],
                 "created_at": r["created_at"], "revised_at": r["revised_at"]} for r in rows]

    def subscription_access(self, swarm_id, artifact_id):
        """r2.8: the artifact a frame may subscribe to is one owned by the frame's own swarm (the caller has already
        checked that the viewer sees that swarm). Metadata only; never the body."""
        art = self.db.one("SELECT * FROM artifacts WHERE id = ?", (str(artifact_id),))
        if art is None or art["owner_swarm"] != swarm_id:
            raise self.hive.error(404, "not_found", "no such artifact in this swarm")
        return {"artifact_id": art["id"], "swarm_id": swarm_id}

    async def _check_finding_target(self, agent, req, subject, body, target):
        """r2.6/r2.7/r2.10: the host checks shape (done) and binding (the request's own revision); the app decides whether the
        element or page exists. The hook is chosen only by the receiving goal's host-stored binding.validate, never by the
        artifact. Without a usable hook only {whole: true} is accepted."""
        goal = self.hive.goals.get(req["receiving_goal"])
        chosen = self.hive.goals.validator(goal)
        program = chosen[8:] if chosen else None
        hook = self.hive.programs.finding_validator(program) if program else None
        if hook is None:
            if _target_kind(target) == "whole":
                return
            raise self.hive.error(400, "invalid_target", "element and page targets need the review request's validator "
                                                          "(binding.validate = program:<id> with validate_finding_target)")
        try:
            manifest = json.loads(body)
        except ValueError:
            manifest = {}
        manifest = manifest if isinstance(manifest, dict) else {}
        assets = [o for k in ("originals", "previews") for o in (manifest.get(k) or []) if isinstance(o, dict)]
        revision = {"artifact_id": subject["artifact_id"], "revision": subject["revision"], "digest": subject["digest"],
                   "body": body, "assets": assets}
        out = await self.hive.programs.validate_finding_target(program, agent, revision, target)
        self.db.insert("finding_target_checks", {"id": new_id("fc"), "request_id": req["id"], "artifact_id": subject["artifact_id"],
                                                  "revision": subject["revision"], "digest": subject["digest"], "target": _j(target),
                                                  "program": program, "ok": int(out["ok"]), "reason": out.get("reason"), "created_at": now()})
        if out["ok"]:
            return
        if out["reason"] == "validator_unavailable":
            raise self.hive.error(503, "validator_unavailable", f"{program} could not check this target; try again later")
        raise self.hive.error(400, "invalid_target", f"{program} refused the target: {out['reason']}")

    def get_finding(self, finding_id):
        row = self.db.one("SELECT * FROM findings WHERE id = ?", (finding_id,))
        if row is None:
            raise self.hive.error(404, "not_found", f"no finding {finding_id}")
        return row

    def respond(self, agent, finding_id, data):
        """The planner's claim about a finding (refinement 1): never closes it."""
        f = self.get_finding(finding_id)
        if self.artifact(f["artifact_id"])["owner_swarm"] != agent["swarm_id"]:
            raise self.hive.error(403, "forbidden", "only the artifact's owning swarm responds to its findings")
        if data.get("stance") not in STANCES:
            raise self.hive.error(400, "bad_request", f"stance is one of {sorted(STANCES)}")
        rev = int(data.get("revision") or 0)
        if not self.db.one("SELECT 1 FROM artifact_revisions WHERE artifact_id = ? AND n = ?", (f["artifact_id"], rev)) or rev < f["raised_rev"]:
            raise self.hive.error(400, "bad_request", "respond in a revision at or after the one the finding was raised on")
        resp = {"revision": rev, "stance": data["stance"], "note": str(data.get("note") or "")[:4000], "by": f"agent:{agent['id']}"}
        self.db.update("findings", finding_id, {"planner_response": _j(resp),
                                                "history": self._append_history(f, {"type": "planner_response", "at": now(), **resp})})
        return self.finding_view(self.get_finding(finding_id))

    def _reviewer_swarm(self, agent, f):
        req = self.get_request(f["request_id"])
        return req["to_swarm"] == agent["swarm_id"]

    def _eligible(self, agent, mandate):
        """Only a mind whose role carries exactly this mandate and version raises or judges findings under it."""
        row = self.db.one("SELECT r.mandate FROM agents a JOIN roles r ON r.id = a.role_id WHERE a.id = ?", (agent["id"],))
        held = json.loads(row["mandate"]) if row and row.get("mandate") else None
        if held != mandate:
            raise self.hive.error(403, "role_not_eligible", "your role does not carry this review mandate and version")

    @staticmethod
    def _mandates(req):
        constraints = json.loads(req["constraints"]) if req["constraints"] else {}
        return constraints.get("mandates", []) if isinstance(constraints, dict) else []

    def _held_review(self, agent, req, subject):
        """Review writes need a live review request whose goal this very mind holds, on exactly this revision."""
        goal = self.hive.goals.get(req["receiving_goal"]) if req["receiving_goal"] else {}
        if (req["kind"] != "review" or req["cancelled_at"] or req["to_swarm"] != agent["swarm_id"]
                or goal.get("status") != "claimed" or goal.get("claimed_by") != agent["id"]):
            live = [r["id"] for r in self.db.all(
                "SELECT q.id FROM requests q JOIN goals g ON g.id = q.receiving_goal WHERE q.kind = 'review' AND q.cancelled_at IS NULL"
                " AND g.status = 'claimed' AND g.claimed_by = ? ORDER BY q.created_at", (agent["id"],))]
            raise self.hive.error(403, "review_not_held", "review writes need a live review request whose task you hold"
                                  + (f"; yours now: {', '.join(live)}" if live else "; you hold none"))
        stored = json.loads(req["subject"]) if req["subject"] else None
        if stored != subject:
            raise self.hive.error(403, "review_revision", "the review request must name exactly this revision")
        self._resolve_subject(subject)

    def _append_history(self, f, entry):
        history = json.loads(f.get("history") or "[]") + [entry]
        return _j(history)

    def dispose(self, agent, finding_id, data):
        """Only a reviewer holding a live review request on exactly the revision it judges sets a disposition or
        applicability (a re-review of a later revision needs its own fresh request assigning the mandate)."""
        f = self.get_finding(finding_id)
        rev = data.get("revision", f["raised_rev"])
        if type(rev) is not int or rev < f["raised_rev"]:
            raise self.hive.error(400, "bad_request", "revision must be an existing revision at or after the one raised on")
        subject = self._resolve_subject({"artifact_id": f["artifact_id"], "revision": rev})
        req = self.get_request(str(data.get("request_id") or f["request_id"]))
        self._held_review(agent, req, subject)
        if json.loads(f["mandate"]) not in self._mandates(req):
            raise self.hive.error(403, "mandate_unassigned", "a re-review must assign the finding's mandate and version")
        self._eligible(agent, json.loads(f["mandate"]))
        changes = {}
        if "verdict" in data:
            if data["verdict"] not in VERDICTS:
                raise self.hive.error(400, "bad_request", f"verdict is one of {sorted(VERDICTS)}")
            changes["disposition"] = _j({"revision": rev, "verdict": data["verdict"], "request_id": req["id"],
                                         "by": f"agent:{agent['id']}", "at": now()})
        if "applicability" in data:
            state = data["applicability"]
            if state not in APPLICABILITY:
                raise self.hive.error(400, "bad_request", f"applicability is one of {sorted(APPLICABILITY)}")
            app = json.loads(f["applicability"]) + [{"revision": rev, "state": state, "by": f"agent:{agent['id']}", "request_id": req["id"]}]
            changes["applicability"] = _j(app)
        if not changes:
            raise self.hive.error(400, "bad_request", "give a verdict or an applicability")
        changes["history"] = self._append_history(f, {"type": "disposition", "revision": rev, "request_id": req["id"], "by": f"agent:{agent['id']}",
                                                      "at": now(), **{k: data[k] for k in ("verdict", "applicability") if k in data}})
        self.db.update("findings", finding_id, changes)
        return self.finding_view(self.get_finding(finding_id))

    def _review_refused(self, status, code, message, req, data, mine):
        """A refused review result, with the shape and a corrected example: this request's id and every finding
        this reviewer raised on it, keeping the recommendation, rationale and coverage the mind got right."""
        rationale, coverage = data.get("rationale"), data.get("coverage")
        example = {"recommendation": data.get("recommendation") if data.get("recommendation") in RECOMMENDATIONS else "revise",
                   "rationale": rationale[:300] if isinstance(rationale, str) and rationale.strip() else "why, in your own words",
                   "finding_ids": [r["id"] for r in mine],
                   "coverage": [c[:200] for c in coverage if isinstance(c, str)][:50] if isinstance(coverage, list) else []}
        return self.hive.error(status, code, f"{message}. Expected: {REVIEW_SHAPE}. Corrected example: "
                                             f"hive-review-complete {req['id']} {json.dumps(example, ensure_ascii=False)}")

    async def complete_review(self, agent, request_id, data):
        """The one way a review finishes: a structured, bound receipt built from the hive's own finding rows.
        Re-checks the live held review on the exact revision and the reviewer's mandate; an empty result is explicit;
        every finding this reviewer raised on this request must be listed (no silent omission). Grants nothing."""
        req = self._request_by_id_or_goal(request_id, REVIEW_SHAPE)
        if req["kind"] != "review" or not req["subject"]:
            raise self.hive.error(400, "bad_request", "this is not a review request")
        subject = json.loads(req["subject"])
        self._held_review(agent, req, subject)
        mandates = self._mandates(req)
        if len(mandates) != 1:
            raise self.hive.error(400, "review_mandate", "a review request assigns exactly one mandate")
        self._eligible(agent, mandates[0])
        mine = self.db.all("SELECT * FROM findings WHERE request_id = ? AND reviewer = ? ORDER BY created_at",
                           (req["id"], f"agent:{agent['id']}"))
        if not isinstance(data, dict):
            raise self._review_refused(400, "bad_request", "a review result is a JSON object", req, {}, mine)
        data = relax_review(data)
        # a receipt holds exactly what the reviewer gave: malformed input is refused, never coerced or truncated
        # (six such inputs found by OmegaReview against 57c6491); the relaxations above only make harmless variants canonical
        recommendation, rationale = data.get("recommendation"), data.get("rationale")
        if recommendation not in RECOMMENDATIONS:
            raise self._review_refused(400, "bad_request", f"recommendation is one of: {', '.join(RECOMMENDATIONS)}", req, data, mine)
        if not isinstance(rationale, str) or not rationale.strip():
            raise self._review_refused(400, "bad_request", "a review result needs its rationale as text", req, data, mine)
        if len(rationale) > 4000:
            raise self._review_refused(413, "too_large", "rationale is at most 4000 characters", req, data, mine)
        listed = data.get("finding_ids", [])
        if not isinstance(listed, list) or not all(isinstance(i, str) for i in listed) or len(listed) != len(set(listed)):
            raise self._review_refused(400, "bad_request", "finding_ids is a list of distinct finding ids", req, data, mine)
        coverage = data.get("coverage", [])
        if not isinstance(coverage, list) or len(coverage) > 50 or not all(isinstance(c, str) and len(c) <= 200 for c in coverage):
            raise self._review_refused(400, "bad_request", "coverage is a list of at most 50 texts of at most 200 characters", req, data, mine)
        if sorted(listed) != sorted(r["id"] for r in mine):
            raise self._review_refused(409, "findings_mismatch", "list exactly the findings you raised on this request (none may be left out); "
                                       f"yours here: {json.dumps([r['id'] for r in mine])}", req, data, mine)
        receipt = {"request_id": req["id"], "subject": subject, "mandate": mandates[0], "reviewer": f"agent:{agent['id']}",
                   "findings": [{"id": r["id"], "severity": r["severity"], "digest": digest(json.dumps(self.finding_view(r), sort_keys=True, default=str))} for r in mine],
                   "empty": not mine, "recommendation": recommendation, "rationale": rationale,
                   "coverage": coverage, "authority": "none", "at": now()}
        goal = self.hive.goals.get(req["receiving_goal"])
        from .goals import binding_digest
        done = await self.hive.goals.result(agent, goal["id"], "done", f"review complete: {len(mine)} finding(s); {recommendation}",
                                      {"binding_digest": binding_digest(json.loads(goal["binding"])), "review_receipt": receipt},
                                      trusted_review=True)
        return {"receipt": receipt, "goal": {"id": goal["id"], "status": done.get("status") if isinstance(done, dict) else "done"}}

    def findings(self, agent, artifact_id):
        art = self.artifact(artifact_id)
        if agent["swarm_id"] != art["owner_swarm"] and not self._review_access(agent, artifact_id):
            raise self.hive.error(403, "forbidden", "not a swarm of this artifact")
        return [self.finding_view(r) for r in self.db.all("SELECT * FROM findings WHERE artifact_id = ? ORDER BY created_at", (artifact_id,))]
