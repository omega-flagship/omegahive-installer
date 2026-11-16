"""Check a mind program against the program contract, without running a hive.

    python -m hive.programs_check path/to/program_dir [--focus ITEM]

It loads plugin.json and the module and calls describe(), then view() in
every stage. It validates each work graph and checks:
- IDs are stable across repeated views;
- `inspect-source` (if offered) returns the sources.

Two checks only run when asked:
- `--scenario` requires the view to hold a question with supporting and
  opposing evidence. This is a check on a test scenario. A real
  investigation never has to invent counterevidence to pass.
- `--allow-mutation` runs `correct` (if offered). It changes the program's
  data, so point it only at a disposable fixture or a throwaway copy of the
  store, never at real records.

The context is a stand-in: create_goal() returns a fake goal, reads return
nothing. Exit code 0 means compatible.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import pathlib
import sys

from .core.programs import CONTRACT, STAGES, Programs, validate_graph, validate_result


class CheckError(Exception):
    pass


class StubContext:
    swarm_id = "contract-check"

    def __init__(self):
        self.goals_created = []

    def beliefs(self):
        return []

    def belief(self, statement):
        return None

    def agents(self):
        return []

    def goals(self):
        return list(self.goals_created)

    async def create_goal(self, title, detail=""):
        goal = {"id": f"g_check{len(self.goals_created) + 1}", "title": title, "detail": detail, "status": "open"}
        self.goals_created.append(goal)
        return goal


def _maybe_await(value):
    return asyncio.run(value) if hasattr(value, "__await__") else value


def check(folder, focus=None, log=print, scenario=False, allow_mutation=False):
    folder = pathlib.Path(folder)
    manifest = json.loads((folder / "plugin.json").read_text())
    spec = importlib.util.spec_from_file_location("program_under_check", folder / manifest.get("module", "program.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    desc = Programs._check_description(module.describe())
    pid = manifest.get("id", folder.name)
    fail = CheckError
    roles = {k["id"]: k["role"] for k in desc["kinds"]}
    polarity = {r["id"]: r["polarity"] for r in desc["relations"]}
    actions = {a["id"] for a in desc["actions"]}
    log(f"contract {desc['contract']} (checker {CONTRACT}); {len(roles)} kinds, {len(polarity)} relations, "
        f"actions: {', '.join(sorted(actions)) or 'none'}")
    ctx = StubContext()

    graphs = {stage: validate_graph(pid, desc, module.view(ctx, focus, stage), stage, fail) for stage in STAGES}
    log("views valid in every stage: " + ", ".join(STAGES))
    again = validate_graph(pid, desc, module.view(ctx, focus, "unfold"), "unfold", fail)
    first = graphs["unfold"]
    if {i["id"] for i in again["items"]} != {i["id"] for i in first["items"]} or again["revision"] != first["revision"]:
        raise CheckError("two views with no change in between returned different ids or revisions")
    log(f"ids stable across views (revision {first['revision']}, {len(first['items'])} items)")

    item_roles = {i["id"]: roles[i["kind"]] for i in first["items"]}
    if scenario:
        if "question" not in item_roles.values():
            raise CheckError("scenario: the view has no item whose kind has role 'question'")
        pols = {polarity[link["rel"]] for link in first["links"]}
        if not {"support", "oppose"} <= pols:
            raise CheckError("scenario: the view needs at least one supporting and one opposing link")
        log("scenario: describes a question with support and counterevidence")

    evidence = [i for i in first["items"] if item_roles[i["id"]] == "evidence"]
    if "inspect-source" in actions:
        sourced = next((i for i in evidence if i["sources"]), None)
        if sourced is None:
            raise CheckError("inspect-source is offered but no evidence item has sources")
        out = validate_result(pid, desc, _maybe_await(module.act(ctx, "inspect-source", [sourced["id"]],
                                                                 {"base_revision": first["revision"]})), fail)
        if out["status"] != "done" or not (out.get("detail") or {}).get("sources"):
            raise CheckError("inspect-source must return status done with detail.sources")
        log(f"inspect-source returns {len(out['detail']['sources'])} source(s) for {sourced['id']}")

    if "correct" in actions and not allow_mutation:
        log("correct offered but not run: it changes data; rerun with --allow-mutation against a disposable copy")
    if "correct" in actions and evidence and allow_mutation:
        target = evidence[0]["id"]
        out = validate_result(pid, desc, _maybe_await(module.act(ctx, "correct", [target], {
            "text": "corrected by the contract checker", "note": "checker", "base_revision": first["revision"]})), fail)
        after = out.get("graph") or validate_graph(pid, desc, module.view(ctx, focus, "unfold"), "unfold", fail)
        if out["status"] != "done":
            raise CheckError(f"correct returned {out['status']}: {out.get('message')}")
        if not {i["id"] for i in first["items"]} <= {i["id"] for i in after["items"]}:
            raise CheckError("a correction lost item ids")
        if after["revision"] == first["revision"]:
            raise CheckError("a correction must change the graph revision")
        fixed = next(i for i in after["items"] if i["id"] == target)
        if not fixed.get("revisions"):
            raise CheckError("the corrected item must keep its prior revision in `revisions`")
        stale = validate_result(pid, desc, _maybe_await(module.act(ctx, "correct", [target], {
            "text": "again", "base_revision": first["revision"]})), fail)
        if stale["status"] != "stale":
            raise CheckError("an action against an old base_revision must return status stale")
        flagged = [i["id"] for i in after["items"] if "affected-by-correction" in i.get("flags", [])]
        log(f"correct keeps every id, records the prior revision, moves {first['revision']} -> {after['revision']}, "
            f"flags {flagged or 'nothing'}, and refuses a stale base")
    return True


def main():
    ap = argparse.ArgumentParser(prog="python -m hive.programs_check")
    ap.add_argument("folder")
    ap.add_argument("--focus")
    ap.add_argument("--scenario", action="store_true",
                    help="also require a question with supporting and opposing evidence (test scenarios only)")
    ap.add_argument("--allow-mutation", action="store_true",
                    help="run the mutating correct action; only against a disposable fixture or copy")
    args = ap.parse_args()
    try:
        check(args.folder, args.focus, scenario=args.scenario, allow_mutation=args.allow_mutation)
    except CheckError as exc:
        print(f"NOT COMPATIBLE: {exc}")
        sys.exit(1)
    print("COMPATIBLE with program contract", CONTRACT)


if __name__ == "__main__":
    main()
