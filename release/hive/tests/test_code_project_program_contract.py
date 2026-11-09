"""Program contract regression only; no Hive construction or launcher execution."""

import asyncio
import hashlib
import pathlib

import pytest

from hive.core.programs import Programs, validate_graph, validate_result


PROGRAM = 'code-project-test'
FOLDER = pathlib.Path(__file__).resolve().parents[1] / 'plugins' / 'code_project_test'


class NoRuntime:
    """Any unexpected dispatch or runtime access fails this unit fixture."""

    def error(self, status, code, message):
        return ValueError(f'{status}:{code}:{message}')

    def __getattr__(self, name):
        raise AssertionError(f'no runtime access permitted: {name}')


@pytest.fixture
def launcher(monkeypatch):
    # This isolated loader fixture has no live registry, DB, grants or startup.
    monkeypatch.delenv('HIVE_APP_GRANT_RENEWAL', raising=False)
    owner = Programs.__new__(Programs)
    owner.hive = NoRuntime()
    owner.pins = {}
    owner.pins_required = False
    owner.disabled = set()
    entry = owner._load(FOLDER, FOLDER / 'plugin.json', 'built-in')
    owner.programs = {PROGRAM: entry}
    return owner, entry


def test_actual_program_loader_accepts_the_launcher_contract(launcher):
    _, entry = launcher
    assert entry['error'] is None, entry['error']
    assert entry['id'] == PROGRAM
    assert entry['capabilities'] == ['sandbox:run']
    assert entry['describe']['kinds'] == [
        {'id': 'launcher', 'label': 'Project test launcher', 'role': 'other'},
    ]
    assert entry['describe']['actions'] == []
    assert entry['describe']['reads'] == []
    assert entry['describe']['relations'] == []
    assert all(callable(getattr(entry['module'], name, None))
               for name in ('describe', 'view', 'act'))


def test_inert_view_satisfies_the_actual_graph_validator_without_runtime_access(launcher):
    _, entry = launcher
    assert entry['error'] is None, entry['error']
    graph = entry['module'].view(NoRuntime(), None, 'unfold')
    validated = validate_graph(PROGRAM, entry['describe'], graph, 'unfold', ValueError)
    assert validated['revision']
    assert validated['items'] == []
    assert validated['links'] == []
    assert validated['groups'] == []
    assert validated['focus'] is None


@pytest.mark.parametrize('action', ['run', 'invented-dispatch'])
def test_direct_action_hook_refuses_without_touching_context(launcher, action):
    _, entry = launcher
    assert entry['error'] is None, entry['error']
    result = entry['module'].act(NoRuntime(), action, ['invented-item'],
                                 {'argv': ['must-not-execute'], 'operation_id': 'synthetic'})
    validated = validate_result(PROGRAM, entry['describe'], result, ValueError)
    assert validated['status'] == 'refused'
    assert not any(k in validated for k in ('task', 'receipt', 'graph'))


def test_loading_a_builtin_does_not_supply_a_trusted_pin(launcher):
    owner, entry = launcher
    assert entry['error'] is None, entry['error']
    assert owner._pin_refusal(PROGRAM, FOLDER, 'built-in') is None
    assert owner.view_of(entry, admin=True)['enabled'] is True
    assert owner.pinned_release(PROGRAM) is None
    assert owner.verified_release(PROGRAM) is None


def test_explicit_matching_pin_still_supplies_the_existing_metadata(launcher):
    owner, entry = launcher
    assert entry['error'] is None, entry['error']
    lock_hash = hashlib.sha256((FOLDER / 'tools' / 'bundle.lock.json').read_bytes()).hexdigest()
    owner.pins = {PROGRAM: {
        'release': str(FOLDER),
        'digest': entry['digest'],
        'files': {'tools/bundle.lock.json': lock_hash},
    }}
    pinned = owner.pinned_release(PROGRAM)
    verified = owner.verified_release(PROGRAM)
    assert pinned is not None
    assert verified is not None
    assert pinned['digest'] == verified['release_digest'] == entry['digest']
    assert pinned['files'] == {'tools/bundle.lock.json': lock_hash}
    assert verified['placement'] == 'swarm'
    assert verified['capabilities'] == ['sandbox:run']


def test_host_rejects_an_unlisted_action_before_context_or_dispatch(launcher):
    owner, entry = launcher
    assert entry['error'] is None, entry['error']
    with pytest.raises(ValueError, match='^400:bad_request:'):
        asyncio.run(owner.act(PROGRAM, 's_synthetic', 'run', [], params={}))
