# Purpose: create a task for the mind speaking in an Ask turn, with its intent receipt in the same transaction.
import datetime
import json

from .minds import parse_time
from .program_actions import named_person


def destination(hive, viewer, turn):
    mind = hive.ask._mind(turn["mind_id"])
    if mind is None:
        raise hive.error(404, "not_available", "That isn't available.")
    mind = hive.personal.speaker(viewer.principal, mind, bool(turn.get("conductor_model")))
    if mind is None or not mind.get("swarm_id"):
        raise hive.error(404, "not_available", "That isn't available.")
    # Read and participation permissions are both required, just as when the person asks this mind directly.
    hive.visibility.check_path(viewer, {"agent_id": mind["id"], "swarm_id": mind["swarm_id"]})
    if not hive.ask.participates(viewer, hive.ask._swarm(mind["swarm_id"])):
        raise hive.error(403, "not_allowed", "You can't assign work there.")
    return mind


def clean(hive, viewer, turn, request):
    if not isinstance(request, dict) or set(request) != {"title", "instruction"}:
        raise hive.error(400, "bad_request", "a task needs a title and instruction")
    from .research import REQUEST_FIELDS
    for name, field in REQUEST_FIELDS.items():
        value = request[name]
        if not isinstance(value, str) or not value.strip() or "\x00" in value or len(value.strip()) > field["max"]:
            raise hive.error(400, "bad_request", f"{name} is plain text, up to {field['max']} characters")
    mind = destination(hive, viewer, turn)
    return {**{k: v.strip() for k, v in request.items()}, "mind_id": mind["id"], "swarm_id": mind["swarm_id"]}


def admit(hive, viewer, intent, bind):
    request = json.loads(intent["body"])["request"]
    with hive.db.transaction():
        if not named_person(viewer.principal):
            raise hive.error(403, "person_required", "A signed-in person creates this task.")
        turn = hive.db.one("SELECT * FROM ask_turns WHERE id = ? AND principal = ? AND deleted_at IS NULL",
                           (intent["turn_id"], viewer.principal))
        if turn is None or datetime.datetime.now(datetime.timezone.utc) >= parse_time(intent["expires_at"]):
            raise hive.error(404, "not_available", "That isn't available.")
        # Recheck authority and the exact destination inside the admission transaction.
        mind = destination(hive, viewer, turn)
        if (mind["id"], mind["swarm_id"]) != (request["mind_id"], request["swarm_id"]):
            raise hive.error(409, "not_available", "The answering mind changed. Ask again.")
        goal = hive.goals._create_record(mind["swarm_id"], request["title"], request["instruction"],
                                         created_by=viewer.principal, assignee=mind["id"], emit=False)
        recorded = {"request_id": None, "lease_id": None, "receiving_goal": goal["id"], "state": "accepted"}
        hive.minds._record(viewer.principal, intent["request_operation_id"], intent["request_digest"], 201, recorded)
        bind(recorded)
    return goal
