#!/usr/bin/env python3
"""Purpose: the owner step that turns Studio, the app the hive shows as Create, on in the hive's Create · Code swarm,
run by `omegahive.sh studio` once the hive answers: by the Mac installer after it lays Studio out, and by serve on
Linux and WSL at every start. The first time, the owner's review of the release the hive pinned turns Studio on in the
Create · Code controller's swarm, where Create opens with its Studio, Make, Code and Flow. A later release is reviewed
again and stays on in the swarms its owner has it on in, and one its owner turned off stays off. The swarm and its
controller are the hive's own (hive/core/foundation.py), so no Code service is needed. The step signs in through the
hive's control socket and signs out again: the review is an owner's, never the local operator's.

    studio-on.py <control socket> <port>
"""
import json
import pathlib
import sys
import urllib.request

APP = "/api/programs/omegadesign"
CONTROLLER = "Create · Code controller"
ON = "Create is in your hive: Studio, with its Make, Code and Flow."


def decide(entry, status, active, controller_swarm):
    """What this run does, from Studio's entry (GET APP), its install state (GET APP/install), the swarms it is on in now
    and the controller's swarm: ("install", the review's body) or ("say", a line, nothing posted). A swarm app is
    turned on only in a chosen swarm; a person app opens in each person's own space, so it names none."""
    if entry.get("error") or not entry.get("digest"):
        return "say", f"Studio did not load in your hive, so it shows no Create: {entry.get('error') or 'no pinned release'}"
    in_swarm = status.get("placement") == "swarm"
    if not status.get("installed"):
        if in_swarm and not controller_swarm:
            return "say", f"Your hive has no {CONTROLLER} yet, so Studio is not turned on; the next start turns it on."
        use_in = [controller_swarm] if in_swarm else []
    elif status.get("release_digest") != entry["digest"]:
        use_in = sorted(active) if in_swarm else []      # the owner's choice of swarms, none included, carries over
    elif active or not in_swarm:
        return "say", ON
    else:
        return "say", "Studio is in your hive and turned off, as its owner left it; Apps turns it on again."
    return "install", {"release_digest": entry["digest"], "placement": status["placement"], "use_in": use_in}


def run(api):
    """One switch-on through api(method, path, body=None), which answers the hive's JSON: read what decide needs, post
    the review it asks for, and return the line to print."""
    entry = api("GET", APP)
    status = api("GET", f"{APP}/install")
    controller = next((m for m in api("GET", "/api/agents") if m.get("name") == CONTROLLER), None)
    active = {a.get("swarm_id") for a in api("GET", f"{APP}/activations") if a.get("active")}
    kind, what = decide(entry, status, active, (controller or {}).get("swarm_id"))
    if kind == "say":
        return what
    api("POST", f"{APP}/install", what)
    return ON if what["use_in"] or what["placement"] != "swarm" else "Studio is updated and stays off, as its owner left it."


def main(argv):
    sock, port = argv[1:3]
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))   # the hive's code: install/macos/ -> app/
    from hive.core.newhive_helper import control
    base = f"http://127.0.0.1:{port}"

    def call(method, path, body=None, token=None):
        req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), method=method)
        req.add_header("Origin", base)
        req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read() or b"null")

    token = call("POST", "/api/auth/local/exchange", {"code": control(sock, {"op": "signin"})["code"]})["token"]
    try:
        print(run(lambda method, path, body=None: call(method, path, body, token)))
    finally:
        call("POST", "/api/auth/logout", {}, token)   # this session was for the step alone


if __name__ == "__main__":
    main(sys.argv)
