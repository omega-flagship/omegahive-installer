"""How the hive picks the Python an Iter worker runs in (hive/supervisor/workspace.py, iter_python).

Iter imports openai, chromadb and ddgs. An installed hive keeps them in its own venv and the image in its system
python3, so the worker runs the first interpreter that can import all three: the hive's own, then each python3 on
PATH in order. When none can, the start is refused with what each interpreter lacks. HIVE_ITER_PYTHON still names
one outright. The worker's PATH and VIRTUAL_ENV follow the interpreter chosen, so the MeTTa loop's workers (python3
from PATH) and janus see the same packages.
"""

import os
import sys

import pytest

from hive.supervisor import workspace

ABSENT = "omegahive_test_module_nobody_installs"


def fake_python(folder, lacks=(), runs=True):
    """A python3 in folder that answers the import probe the way an interpreter lacking `lacks` does, or that fails."""
    folder.mkdir(parents=True, exist_ok=True)
    exe = folder / "python3"
    exe.write_text("#!/bin/sh\n" + ("".join(f"echo {m}\n" for m in lacks) if runs else "exit 1\n"))
    exe.chmod(0o755)
    return exe


@pytest.fixture
def needs(monkeypatch):
    """Sets the modules an Iter worker needs, for one test."""
    monkeypatch.delenv("HIVE_ITER_PYTHON", raising=False)
    return lambda *modules: monkeypatch.setattr(workspace, "ITER_IMPORTS", modules)


def on_path(monkeypatch, *pythons):
    monkeypatch.setenv("PATH", os.pathsep.join(str(p.parent) for p in pythons))


def test_the_hives_own_interpreter_when_it_can_import_them(needs, monkeypatch, tmp_path):
    needs("json", "sqlite3")
    on_path(monkeypatch, fake_python(tmp_path / "elsewhere"))
    assert workspace.iter_python() == sys.executable


def test_else_the_first_python3_on_path_that_can(needs, monkeypatch, tmp_path):
    needs(ABSENT)
    lacking = fake_python(tmp_path / "a", lacks=[ABSENT])
    broken = fake_python(tmp_path / "b", runs=False)
    first = fake_python(tmp_path / "c")
    later = fake_python(tmp_path / "d")
    on_path(monkeypatch, lacking, broken, first, later)
    assert workspace.iter_python() == str(first)


def test_with_none_that_can_the_start_is_refused_naming_what_each_lacks(needs, monkeypatch, tmp_path):
    needs(ABSENT, "json")
    lacking = fake_python(tmp_path / "a", lacks=[ABSENT])
    broken = fake_python(tmp_path / "b", runs=False)
    on_path(monkeypatch, lacking, broken)
    with pytest.raises(RuntimeError) as refused:
        workspace.iter_python()
    message = str(refused.value)
    assert f"{sys.executable} lacks {ABSENT};" in message      # json is found here, so only the absent one is named
    assert f"{lacking} lacks {ABSENT}" in message
    assert f"{broken} does not run" in message


def test_the_probe_asks_a_real_interpreter_what_it_cannot_find(needs, tmp_path):
    needs("json", ABSENT)
    assert workspace.iter_missing(sys.executable) == [ABSENT]
    assert workspace.iter_missing(str(tmp_path / "no-such-python")) is None


def test_hive_iter_python_names_the_interpreter_outright(needs, monkeypatch, tmp_path):
    needs(ABSENT)
    named = fake_python(tmp_path / "named", lacks=[ABSENT])   # unchecked: the operator chose it
    monkeypatch.setenv("HIVE_ITER_PYTHON", str(named))
    assert workspace.iter_interpreter() == str(named)
    on_path(monkeypatch, named)
    monkeypatch.setenv("HIVE_ITER_PYTHON", "python3")          # a name is looked up on PATH
    assert workspace.iter_interpreter() == str(named)
    monkeypatch.setenv("HIVE_ITER_PYTHON", str(tmp_path / "gone" / "python3"))
    with pytest.raises(RuntimeError, match="HIVE_ITER_PYTHON"):
        workspace.iter_interpreter()


def test_a_venvs_interpreter_brings_its_folder_and_its_venv(monkeypatch, tmp_path):
    venv = tmp_path / "venv"
    python = fake_python(venv / "bin")
    (venv / "pyvenv.cfg").write_text("home = /usr/bin\n")
    monkeypatch.delenv("VIRTUAL_ENV", raising=False)
    monkeypatch.setenv("PATH", "/usr/bin")
    assert workspace.iter_environment(str(python)) == {"PATH": os.pathsep.join([str(venv / "bin"), "/usr/bin"]),
                                                       "VIRTUAL_ENV": str(venv)}


def test_an_interpreter_in_no_venv_clears_virtual_env_and_the_hives_venv_stays_off_path(monkeypatch, tmp_path):
    hive_venv = tmp_path / "hive-venv"
    (hive_venv / "bin").mkdir(parents=True)
    python = fake_python(tmp_path / "system" / "bin")
    monkeypatch.setenv("VIRTUAL_ENV", str(hive_venv))
    monkeypatch.setenv("PATH", os.pathsep.join([str(hive_venv / "bin"), "/usr/bin"]))
    assert workspace.iter_environment(str(python)) == {
        "PATH": os.pathsep.join([str(python.parent), "/usr/bin"]), "VIRTUAL_ENV": ""}


def test_the_hives_own_venv_leads_path_when_its_interpreter_is_chosen(monkeypatch, tmp_path):
    hive_venv = tmp_path / "hive-venv"
    python = fake_python(hive_venv / "bin")
    (hive_venv / "pyvenv.cfg").write_text("home = /usr/bin\n")
    monkeypatch.setenv("VIRTUAL_ENV", str(hive_venv))
    monkeypatch.setenv("PATH", os.pathsep.join([str(hive_venv / "bin"), "/usr/bin"]))
    assert workspace.iter_environment(str(python)) == {
        "PATH": os.pathsep.join([str(hive_venv / "bin"), "/usr/bin"]), "VIRTUAL_ENV": str(hive_venv)}
