"""A PeTTa start-up that fails takes its path back off sys.path and says so in the error. Synthetic, no PeTTa needed."""
import sys

import pytest

from hive.spaces.service import SpaceError, _Interpreter


def test_a_failed_start_removes_its_path_from_sys_path(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "petta", None)       # the import fails as it would with a wrong PeTTa path
    entry = str(tmp_path / "python")
    before = list(sys.path)
    with pytest.raises(SpaceError) as caught:
        _Interpreter(str(tmp_path))
    assert "PeTTa failed to start" in str(caught.value)
    assert "path cleanup" not in str(caught.value)       # cleanup went through, so the error carries no note
    assert entry not in sys.path
    assert sys.path == before


def test_cleanup_reports_why_it_could_not_remove_the_path():
    interp = object.__new__(_Interpreter)
    assert interp._remove_failed_startup_path(None, None) == "NOT_INSERTED"
    assert interp._remove_failed_startup_path(["elsewhere"], "x") == "REPLACED"   # not sys.path itself
    entry = "/nonexistent/petta-test-entry"
    assert interp._remove_failed_startup_path(sys.path, entry) == "MISSING"


def test_cleanup_notes_are_added_to_the_start_up_error(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "petta", None)
    monkeypatch.setattr(_Interpreter, "_remove_failed_startup_path", lambda self, paths, entry: "REPLACED")
    try:
        with pytest.raises(SpaceError, match=r"\(path cleanup: REPLACED\)"):
            _Interpreter(str(tmp_path))
    finally:
        entry = str(tmp_path / "python")
        while entry in sys.path:
            sys.path.remove(entry)
