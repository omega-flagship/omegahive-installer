"""conftest removes every tempfile.mkdtemp folder a test makes when that test ends (fixtures included)."""
import os
import pathlib
import tempfile

import pytest

_made = []


@pytest.fixture()
def hive_like_dir():
    path = pathlib.Path(tempfile.mkdtemp(prefix="hive-test-"))
    (path / "hive.db").write_text("x")
    (path / "agents").mkdir()
    _made.append(str(path))
    yield path                                    # no cleanup here: conftest owns it


def test_a_fixture_makes_a_hive_folder(hive_like_dir):
    assert (hive_like_dir / "hive.db").exists()
    with tempfile.TemporaryDirectory(prefix="hive-personal-") as inner:
        _made.append(inner)


def test_the_previous_tests_folders_are_gone():
    assert len(_made) == 2
    assert not any(os.path.exists(path) for path in _made)
