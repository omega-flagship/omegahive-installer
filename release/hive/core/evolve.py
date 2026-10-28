"""Immutable, swarm-scoped OmegaEvolve claims and experiment registrations.

No scheduler, grants, evaluator or adoption mechanism lives here.
"""
import json
from .db import new_id, now
from .evolve_preflight import digest, seal
from .evolve_state import derive

SCHEMA = """CREATE TABLE IF NOT EXISTS evolve_records (
 id TEXT PRIMARY KEY, swarm_id TEXT NOT NULL, kind TEXT NOT NULL,
 author TEXT NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL,
 created_at TEXT NOT NULL
)"""


def _named(principal):
    return isinstance(principal, str) and principal.startswith("user:") and principal != "user:operator"


class EvolveRegistry:
    @staticmethod
    def named_owner(actor, swarm_id):
        """The hive owner who seals experiments is a named admin person (the owner, 2026-10-04): no person holds a role
        called "owner", so an admin signed in by name stands for it. The loopback operator and minds never do."""
        return bool(actor and actor.get("swarm_id") == swarm_id and actor.get("kind") == "person"
                    and actor.get("role") in ("owner", "admin") and not actor.get("local_operator")
                    and _named(actor.get("principal")))

    def __init__(self, hive):
        self.hive, self.db = hive, hive.db
        self.db.execute(SCHEMA)

    def records(self, swarm_id, focus=None):
        if focus and focus != "objective":
            row = self.db.one("SELECT * FROM evolve_records WHERE swarm_id = ? AND id = ?", (swarm_id, focus))
            return [self.decode(row)] if row else []
        count = self.db.one("SELECT count(*) AS n FROM evolve_records WHERE swarm_id = ?", (swarm_id,))["n"]
        if count > 399:
            raise ValueError("too many records for one view; request a record by its id")
        return [self.decode(row) for row in self.db.all(
            "SELECT * FROM evolve_records WHERE swarm_id = ? ORDER BY created_at, id", (swarm_id,))]

    @staticmethod
    def decode(row):
        return dict(row, body=json.loads(row["body"]))

    def snapshot(self, swarm_id, focus=None):
        # Derive from full stored lineage even when displaying one focused item.
        rows = [self.decode(row) for row in self.db.all(
            "SELECT * FROM evolve_records WHERE swarm_id = ? ORDER BY created_at, id", (swarm_id,))]
        states = derive(rows)
        selected = [row for row in rows if row["id"] == focus] if focus and focus != "objective" else rows
        if len(selected) > 399:
            raise ValueError("too many records for one view; request a record by its id")
        return [{"record": row, "assessment": states.get(row["id"], {})} for row in selected]

    def append(self, swarm_id, kind, author, body):
        value = {"swarm_id": swarm_id, "kind": kind, "author": author, "body": body}
        pin = digest(value)
        # Deduplication also makes direct person retries safe at the registry boundary.
        with self.db._lock:
            prior = self.db.one("SELECT * FROM evolve_records WHERE swarm_id = ? AND digest = ?", (swarm_id, pin))
            if prior:
                return self.decode(prior)
            identifier, at = new_id("ev"), now()
            self.db.execute("INSERT INTO evolve_records VALUES (?, ?, ?, ?, ?, ?, ?)",
                            (identifier, swarm_id, kind, author, json.dumps(body, allow_nan=False), pin, at))
            return self.decode(self.db.one("SELECT * FROM evolve_records WHERE id = ?", (identifier,)))

    def contribute(self, swarm_id, actor, payload):
        if not actor or not actor.get("principal") or actor.get("swarm_id") != swarm_id:
            raise PermissionError("trusted host actor required")
        allowed = {"title", "claim", "method", "evidence", "uncertainty", "affected_revision", "predecessor", "relation", "depends_on"}
        if set(payload) - allowed:
            raise ValueError("contributions cannot carry authority or executable fields")
        for field in ("title", "claim", "method", "affected_revision"):
            if not isinstance(payload.get(field), str) or not payload[field].strip():
                raise ValueError(f"missing {field}")
        uncertainty = payload.get("uncertainty")
        if not isinstance(uncertainty, dict) or not uncertainty.get("method") or not uncertainty.get("status"):
            raise ValueError("explicit uncertainty method and status required")
        evidence = payload.get("evidence")
        if not isinstance(evidence, list) or not evidence:
            raise ValueError("evidence locators required")
        refs = []
        for entry in evidence:
            if not isinstance(entry, dict) or set(entry) != {"source", "locator", "origin"} or not all(isinstance(v, str) and v.strip() for v in entry.values()):
                raise ValueError("each reference needs source, locator and origin")
            refs.append(dict(entry, custody="unresolved", verified=False))
        parent = payload.get("predecessor")
        relation = payload.get("relation", "reference" if parent else "assertion")
        if relation not in ("assertion", "reference", "correction", "retraction"):
            raise ValueError("unknown contribution relation")
        if relation in ("correction", "retraction") and not parent:
            raise ValueError("correction or retraction needs a predecessor")
        dependencies = payload.get("depends_on", [])
        if not isinstance(dependencies, list) or any(not isinstance(d, str) or d == "objective" for d in dependencies):
            raise ValueError("dependencies must name contribution records")
        dependencies = sorted(set(dependencies))
        for dependency in dependencies:
            known = self.records(swarm_id, dependency)
            if not known or known[0]["kind"] != "contribution":
                raise ValueError("dependency contribution absent from this swarm")
        if parent:
            if not isinstance(parent, str) or parent == "objective":
                raise ValueError("predecessor must identify a contribution")
            parents = self.records(swarm_id, parent)
            if not parents or parents[0]["kind"] != "contribution":
                raise ValueError("predecessor contribution absent from this swarm")
            if relation in ("correction", "retraction") and parents[0]["author"] != actor["principal"]:
                raise PermissionError("only the original source author may revise its contribution")
        body = dict(payload, evidence=refs, relation=relation, depends_on=dependencies,
                    state="recorded-claim", adoption_authorized=False)
        if len(json.dumps(body)) > 32000:
            raise ValueError("contribution exceeds 32KB")
        # Serialize duplicate and fork checks with the immutable append.
        with self.db._lock:
            if relation in ("correction", "retraction"):
                prior = self.db.one("SELECT * FROM evolve_records WHERE swarm_id = ? AND digest = ?",
                    (swarm_id, digest({"swarm_id": swarm_id, "kind": "contribution", "author": actor["principal"], "body": body})))
                if prior:
                    return self.decode(prior)
                state = self.snapshot(swarm_id, parent)[0]["assessment"]
                if state["status"] != "current":
                    raise ValueError("predecessor already revised; use its current successor")
            return self.append(swarm_id, "contribution", actor["principal"], body)

    def register(self, swarm_id, actor, registration):
        if not self.named_owner(actor, swarm_id):
            raise PermissionError("named hive owner must seal this experiment")
        pin = seal(registration)
        return self.append(swarm_id, "experiment", actor["principal"],
                           {"registration": registration, "registration_pin": pin,
                            "state": "registered-offline", "adoption_authorized": False})

    def lab_receipt(self, swarm_id, actor, experiment_id, run_id):
        # Lab runs have no swarm ACL on this base: only the named owner can read them here.
        if not self.named_owner(actor, swarm_id):
            raise PermissionError("named hive owner required for Lab receipt")
        rows = self.records(swarm_id, experiment_id)
        if not rows or rows[0]["kind"] != "experiment":
            raise ValueError("registered experiment required")
        experiment = rows[0]
        run = self.hive.lab.run(run_id)
        if run["suite"] not in ("tests-evolve", "tests-omegabench") or run["status"] != "passed" or not run["cases"]:
            raise ValueError("completed OmegaEvolve protocol Lab run required")
        if any(case["status"] != "passed" for case in run["cases"]):
            raise ValueError("every qualification case must pass")
        # This suite qualifies the mechanism, not the candidate's capability or beneficialness.
        return self.append(swarm_id, "qualification", actor["principal"],
                           {"experiment_id": experiment_id, "registration_pin": experiment["body"]["registration_pin"],
                            "lab_run_id": run_id, "lab_digest": digest(run), "lab_commit": run["commit_sha"],
                            "state": "protocol-qualified", "candidate_evaluated": False,
                            "independent_review": "pending", "beneficialness": "unassessed",
                            "live_improvement": "unproven", "recursive_improvement": "unproven",
                            "adoption_authorized": False})
