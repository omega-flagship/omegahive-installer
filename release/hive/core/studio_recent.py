"""Purpose: list the signed-in person's latest creations with their open targets."""

from .my_apps import MyApps
from .visibility import Viewer


def recent_creations(hive, viewer):
    """Return three creations ranked by their saved revision or successful deployment."""
    limit = 3
    who = Viewer(viewer.principal, viewer.admin, audit=False)
    swarms = hive.visibility.swarms(who, hive.db.all("SELECT id, personal_of FROM swarms WHERE archived_at IS NULL"))
    artifacts = hive.collab.personal_studio_creations(who.principal, swarms, limit)
    rows = [
        {"kind": "design" if r["kind"] == "studio-source" else "image", "id": r["artifact_id"], "title": r["title"],
         "swarm_id": r["swarm_id"], "revision": r["revision"], "digest": r["digest"], "at": r["revised_at"]}
        for r in artifacts
    ]
    installed = hive.create_plans.installed_for(who.principal)
    if installed:
        homes = {}
        for app in MyApps(hive).list(who, who.principal)["apps"]:
            homes.setdefault(app["id"], app)
        apps = []
        for receipt in installed:
            app = homes.pop(receipt["program_id"], None)
            if app is None:
                continue
            apps.append({"kind": "app", "id": app["id"], "title": app["name"],
                         "swarm_id": app["open"].get("swarm_id"), "at": receipt["at"]})
            if len(apps) == limit:
                break
        rows.extend(apps)
    return sorted(rows, key=lambda row: (row["at"], row["id"]), reverse=True)[:limit]
