"""Derived source lineage and dependency state; never rewrites original claims."""
def derive(records):
    contributions = {row["id"]: row for row in records if row["kind"] == "contribution"}
    states = {identifier: {"status": "current", "flags": [], "invalidated_by": [],
                           "evidence_custody": "unresolved", "adoption_authorized": False}
              for identifier in contributions}
    dependents = {identifier: [] for identifier in contributions}
    for identifier, row in contributions.items():
        body = row["body"]
        for dependency in body.get("depends_on", []):
            if dependency in dependents:
                dependents[dependency].append(identifier)
        parent = body.get("predecessor")
        relation = body.get("relation", "reference" if parent else "assertion")
        if parent in contributions and relation in ("correction", "retraction"):
            # Also check historical records: merely storing a relationship is no identity proof.
            if contributions[parent]["author"] != row["author"]:
                states[identifier]["flags"].append("invalid-source-lineage")
                continue
            states[parent]["status"] = "corrected" if relation == "correction" else "retracted"
            states[parent]["invalidated_by"].append(identifier)
    # Propagate every changed source, including through chains of dependent claims.
    for source, state in states.items():
        if state["status"] == "current":
            continue
        todo, seen = list(dependents[source]), {source}
        while todo:
            identifier = todo.pop()
            if identifier in seen:
                continue
            seen.add(identifier)
            affected = states[identifier]
            if "needs-review" not in affected["flags"]:
                affected["flags"].append("needs-review")
            affected["invalidated_by"].extend(state["invalidated_by"])
            todo.extend(dependents[identifier])
    for state in states.values():
        state["flags"] = sorted(set(state["flags"]))
        state["invalidated_by"] = sorted(set(state["invalidated_by"]))
    return states
