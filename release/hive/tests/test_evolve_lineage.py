from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
import pytest
from hive.core.evolve import EvolveRegistry
from hive.core.evolve_state import derive
from hive.core.evolve_preflight import digest
from hive.core.db import Database
from hive.plugins.omegaevolve import program
from hive.tests.test_evolve import actor, contribution


@pytest.fixture
def registry(tmp_path):
    return EvolveRegistry(SimpleNamespace(db=Database(tmp_path / "lineage.sqlite")))


def submit(registry, **changes):
    return registry.contribute("s1", actor(), dict(contribution(), **changes))


def test_retraction_preserves_original_and_invalidates_transitive_claims(registry):
    source = submit(registry)
    dependent = submit(registry, title="dependent", depends_on=[source["id"]])
    deeper = submit(registry, title="deeper", depends_on=[dependent["id"]])
    retraction = submit(registry, title="retraction", relation="retraction", predecessor=source["id"])
    states = derive(registry.records("s1"))
    assert states[source["id"]]["status"] == "retracted"
    for record in (dependent, deeper):
        assert states[record["id"]]["flags"] == ["needs-review"]
        assert states[record["id"]]["invalidated_by"] == [retraction["id"]]
    assert registry.records("s1", source["id"]) == [source]
    assert registry.snapshot("s1", deeper["id"])[0]["assessment"] == states[deeper["id"]]


def test_correction_preserves_source_and_successor_is_current(registry):
    source = submit(registry)
    successor = submit(registry, relation="correction", predecessor=source["id"], claim="Corrected source statement")
    states = derive(registry.records("s1"))
    assert states[source["id"]]["status"] == "corrected"
    assert states[successor["id"]]["status"] == "current"
    assert registry.records("s1", source["id"])[0]["body"]["claim"] != successor["body"]["claim"]


def test_another_author_cannot_retract_source_but_can_criticize(registry):
    source = submit(registry)
    other = dict(actor(), principal="agent:critic")
    payload = dict(contribution(), predecessor=source["id"], relation="retraction")
    with pytest.raises(PermissionError):
        registry.contribute("s1", other, payload)
    critique = registry.contribute("s1", other, dict(payload, relation="reference", claim="I disagree"))
    assert derive(registry.records("s1"))[source["id"]]["status"] == "current"
    assert critique["author"] == "agent:critic"


def test_duplicate_revision_safe_and_competing_fork_refused(registry):
    source = submit(registry)
    first = submit(registry, relation="correction", predecessor=source["id"], claim="One")
    assert submit(registry, relation="correction", predecessor=source["id"], claim="One")["id"] == first["id"]
    with pytest.raises(ValueError):
        submit(registry, relation="correction", predecessor=source["id"], claim="Two")


def test_absent_cross_swarm_dependencies_and_invalid_relations_refused(registry):
    source = submit(registry)
    for changes in ({"depends_on": ["absent"]}, {"depends_on": "not-a-list"},
                    {"relation": "retraction"}, {"relation": "adoption"}):
        with pytest.raises(ValueError):
            submit(registry, **changes)
    with pytest.raises(ValueError):
        registry.contribute("s2", actor("s2"), dict(contribution(), depends_on=[source["id"]]))


def test_focused_graph_revision_changes_when_upstream_source_changes(registry):
    source = submit(registry)
    dependent = submit(registry, title="dependent", depends_on=[source["id"]])
    ctx = SimpleNamespace(evolve_snapshot=lambda focus: registry.snapshot("s1", focus))
    before = program.view(ctx, dependent["id"], "detail")
    submit(registry, relation="retraction", predecessor=source["id"], title="retraction")
    after = program.view(ctx, dependent["id"], "detail")
    assert after["revision"] != before["revision"]
    assert after["focus"] == dependent["id"]
    assert "needs-review" in after["items"][1]["flags"]


def test_retraction_survives_restart(registry):
    source = submit(registry)
    submit(registry, relation="retraction", predecessor=source["id"])
    path = registry.db._conn.execute("PRAGMA database_list").fetchone()[2]
    registry.db._conn.close()
    reopened = EvolveRegistry(SimpleNamespace(db=Database(path)))
    assert reopened.snapshot("s1", source["id"])[0]["assessment"]["status"] == "retracted"


def test_legacy_predecessor_link_does_not_silently_retract(registry):
    source = submit(registry)
    submit(registry, predecessor=source["id"], claim="Retract", title="legacy reference")
    assert registry.snapshot("s1", source["id"])[0]["assessment"]["status"] == "current"


def test_concurrent_revisions_have_one_successor(registry):
    source = submit(registry)
    def revise(text):
        try:
            return submit(registry, relation="correction", predecessor=source["id"], claim=text)
        except ValueError:
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(revise, ("candidate-one", "candidate-two")))
    assert sum(value is not None for value in outcomes) == 1
    states = derive(registry.records("s1"))
    assert len(states[source["id"]]["invalidated_by"]) == 1
