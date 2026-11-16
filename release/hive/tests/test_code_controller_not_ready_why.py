"""While the work is still moving, Apply's reason says where it is, not only "nothing is ready to apply".

Mesto, flagship #38 (2026-11-11): on a fresh install the card said "Nothing is ready to apply" all through the
controller's test and review, with no sign of progress.
"""
from types import SimpleNamespace

from hive.core import code_controller_engine as cce


def _why(status, copy_apply=True):
    engine = object.__new__(ENGINE)
    engine.hive = SimpleNamespace(settings=SimpleNamespace(copy_apply_claims=copy_apply))
    run = {"member": None, "request_id": "rq_x", "status": status, "phase": "edited"}
    return {a["name"]: a for a in engine._actions(run)}["apply"]["why_not"]


ENGINE = next(v for v in vars(cce).values() if isinstance(v, type) and hasattr(v, "_actions"))


def test_each_moving_state_says_where_the_work_is():
    assert _why("testing") == "it is being tested on a copy first"
    assert _why("reviewing") == "a second mind is reviewing it first"
    assert _why("repairing") == "a test failed and a mind is fixing it"
    assert _why("writing") == "a mind is still writing the change"


def test_ready_and_stopped_keep_their_reasons():
    assert _why("ready_for_you") is None
    assert _why("ready_for_you", copy_apply=False) == "applying is off on this hive"
    assert _why("needs_you") == "nothing is ready to apply"
