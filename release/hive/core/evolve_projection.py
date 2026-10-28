"""Data-only native projection: opaque digest identifiers, no contribution code."""
from .evolve_preflight import digest


def project(record):
    identifier = digest({"id": record["id"], "swarm": record["swarm_id"]})
    body_pin = digest(record["body"])
    # All variable content is fixed-alphabet hashes. Original source content stays in the registry.
    return f'(EvolveClaim "{identifier}" "{body_pin}")'


def project_snapshot(entry):
    record, assessment = entry["record"], entry["assessment"]
    if record["kind"] != "contribution":
        raise ValueError("native lineage projection requires a contribution")
    def key(identifier):
        return digest({"id": identifier, "swarm": record["swarm_id"]})
    identifier = key(record["id"])
    status = {"current": "Current", "corrected": "Corrected", "retracted": "Retracted"}[assessment["status"]]
    atoms = [project(record), f'(EvolveSource "{identifier}" "{digest(record["author"])}")',
             f'(EvolveStatus "{identifier}" {status})', f'(EvolveCustody "{identifier}" Unresolved)']
    if "needs-review" in assessment.get("flags", []):
        atoms.append(f'(EvolveNeedsReview "{identifier}")')
    for dependency in record["body"].get("depends_on", []):
        atoms.append(f'(EvolveDepends "{identifier}" "{key(dependency)}")')
    parent = record["body"].get("predecessor")
    relation = record["body"].get("relation", "reference")
    if parent:
        native_relation = {"correction": "Correction", "retraction": "Retraction", "reference": "Reference", "assertion": "Reference"}[relation]
        atoms.append(f'(EvolveLineage "{identifier}" "{key(parent)}" {native_relation})')
    return atoms
