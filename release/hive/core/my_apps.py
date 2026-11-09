"""GET /api/me/apps: the apps this person can open, for the awake state of every look (Ask-and-apps contract R1 §3).

One list, computed here so the client never filters. An app is listed only when it is both discoverable and openable:
- a person app passes `person_apps._authorized` (audience first, even for an admin; off, unreviewed or a changed release
  is not listed);
- a swarm app is active in a swarm this viewer sees and that default lists do not hide (another person's personal swarm
  is never listed, even for an admin), is not archived, and its release is ready.
Listing never opens a context, runs an app view or writes anything. The local operator has no apps.
"""

from __future__ import annotations

import json
import logging

from .hive import HiveError
from .program_actions import named_person
from .visibility import Viewer

log = logging.getLogger("hive")

#: Never shown to people as apps (Jon 11-04: "clean up the UI to what is actually supposed to be visible"): host test
#: scaffolding that ships in the release so its contract tests can run.
NOT_APPS = frozenset({"contract-fixture", "code-project-test"})
#: Create is one app (Jon 10-31; 11-05 "the create UI, with code and studio together"): the Studio app is shown as
#: Create, once, and the creation apps Create opens as benches (its Code and Flow benches) are not separate tiles.
CREATE, CREATE_NAME = "omegadesign", "Create"
BENCHES = frozenset({"omegacode", "omegaflow"})


def listed(entry):
    """Whether a loaded app is ever shown in a person's app list (host test scaffolding is not)."""
    return entry.get("id") not in NOT_APPS


def in_audience(hive, principal, program_id):
    """Whether this person is in a person app's audience (the review's, else the manifest's). Swarm apps: always."""
    entry = hive.programs.programs.get(program_id)
    if entry is None or entry.get("placement") != "person":
        return True
    row = hive.person_apps._review(program_id)
    allowed = json.loads(row["audience"]) if row is not None and not row["revoked_at"] else entry.get("person_allow", "all")
    return allowed == "all" or principal in allowed


class MyApps:
    def __init__(self, hive):
        self.hive, self.db = hive, hive.db

    def list(self, viewer, principal):
        if not (named_person(principal) and str(principal).startswith("user:u_")):
            return {"apps": []}
        # discovery always uses the default view: an admin's ?include=personal audit never widens this list
        viewer = Viewer(viewer.principal, viewer.admin, audit=False)
        programs = self.hive.programs
        out = []
        for pid, entry in list(programs.programs.items()):
            if entry.get("placement") != "person" or not listed(entry):
                continue
            try:
                self.hive.person_apps._authorized(principal, pid, ready=False)
            except HiveError:              # a fixed refusal: not openable, so not listed (the code never leaves)
                continue
            except Exception:              # noqa: BLE001  an unexpected failure is logged, never silently hidden
                log.exception("me/apps: person app %s could not be checked", pid)
                continue
            ctx = self.db.one("SELECT created_at FROM app_person_contexts WHERE principal = ? AND program_id = ?",
                              (principal, pid))
            out.append(self._row(entry, "person", {"kind": "person"}, (0, ctx["created_at"] if ctx else "~", pid)))
        acts = self.db.all("SELECT program, swarm FROM app_activations WHERE active = 1 ORDER BY rowid")
        sids = sorted({a["swarm"] for a in acts})
        swarms = {r["id"]: r for r in self.db.all(
            f"SELECT * FROM swarms WHERE id IN ({','.join('?' * len(sids))})", tuple(sids))} if sids else {}
        hidden = self.hive.visibility.hidden_ids(viewer)
        n = 0
        for act in acts:
            pid, sid = act["program"], act["swarm"]
            entry = programs.programs.get(pid)
            # discovery reads the loaded state only (no integrity re-hash, no events): opening still runs the full check
            if entry is None or entry.get("placement") == "person" or entry.get("error") or pid in programs.disabled:
                continue
            if not listed(entry) or (pid == CREATE and any(r["id"] == CREATE for r in out)):
                continue                   # scaffolding never; Create once (its page switches swarm and bench itself)
            swarm = swarms.get(sid)
            if swarm is None or swarm.get("archived_at") or not viewer.sees(swarm) or sid in hidden:
                continue
            n += 1
            out.append(self._row(entry, "swarm", {"kind": "swarm", "swarm_id": sid, "swarm_name": swarm.get("name")},
                                 (1, n, pid)))
        if any(r["id"] == CREATE for r in out):
            out = [r for r in out if r["id"] not in BENCHES]      # Code and Flow are opened inside Create
        out.sort(key=lambda r: r.pop("_order"))
        for i, r in enumerate(out):
            r["order"] = i
        return {"apps": out}

    @staticmethod
    def _row(entry, placement, open_, order):
        return {"id": entry["id"], "name": CREATE_NAME if entry["id"] == CREATE else entry["name"], "icon": entry.get("icon"), "placement": placement,
                "open": open_, "pinned": False, "_order": order}
