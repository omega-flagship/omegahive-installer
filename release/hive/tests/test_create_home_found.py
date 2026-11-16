"""Jon 11-09: "I see Create, but the swarms are not deployed. I literally never want that to be even possible."
Create (the Studio program) is active in each person's own Studio through the host (host_studio_active), never through an
app_activations row, and Programs.homes() did not consult the host, so Create's page found no home on a hive whose
foundation had made one. A person's own Studio is now always the first home Create finds. Synthetic only."""
from hive.tests.test_studio_session_r7 import PROGRAM, maker_of, p, setup  # noqa: F401
from hive.tests.test_ask_intents import a  # noqa: F401  (fixture)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import w  # noqa: F401  (fixture)
from hive.tests.test_studio_session_g1 import s  # noqa: F401  (fixture)


def test_a_persons_own_studio_is_the_first_home_create_finds(p):
    assert setup(p).status_code == 200
    studio = maker_of(p)["swarm_id"]
    assert p.hive.db.one("SELECT 1 FROM app_activations WHERE program = ?", (PROGRAM,)) is None   # host-derived only
    assert p.hive.app_attachments.active(PROGRAM, studio)
    homes = p.hive.programs.homes(PROGRAM, {studio})
    assert homes and homes[0] == {"swarm_id": studio, "why": "your own space"}


def test_create_finds_no_home_in_a_swarm_the_caller_cannot_see(p):
    assert setup(p).status_code == 200
    assert p.hive.programs.homes(PROGRAM, set()) == []


def test_the_owner_gets_the_own_mark_and_no_one_else_does(p):
    assert setup(p).status_code == 200
    maker = maker_of(p)
    studio = maker["swarm_id"]
    owner = p.hive.db.one("SELECT owner FROM swarms WHERE id = ?", (studio,))["owner"]
    mine = p.hive.programs.homes(PROGRAM, {studio}, owner)
    assert mine[0] == {"swarm_id": studio, "why": "your own space", "own": True}
    theirs = p.hive.programs.homes(PROGRAM, {studio}, "user:operator")   # e.g. an admin who can see it
    assert theirs[0] == {"swarm_id": studio, "why": "your own space"}
