"""A mind's boot imports its host loader less each module it lacks a requirement for, checked through PeTTa itself.

lib_omegaclaw.metta imports whatever hive_services.module_loader returns. With no OmegaCode client a mind gets a copy
of the loader without code_workspace, so PeTTa never declares its module or defines its skills, and the mind's log
says why; with the client it gets the loader as it is. Run on a host loader naming code and code_workspace, after the
runtime prelude hive/tests/test_metta_reach.py loads."""
import os
import pathlib
import re
import subprocess

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
PETTA = pathlib.Path(os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa")))
needs_petta = pytest.mark.skipif(not (PETTA / "run.sh").exists(), reason="set PETTA_PATH to a PeTTa checkout")

BOOT = """!(import! &self (library lib_import))
!(import_prolog_functions_from_file ./repos/OmegaClaw-Core/hive/runtime/register.pl (register-hive-core))
!(register-hive-core)
!(import! &self (library OmegaClaw-Core ./hive/runtime/extensions/substrate))
!(register-default-runtime-spaces)
!(import! &self (py-call (hive_services.module_loader)))
!(let $modules (collapse (match &self (Module $m) $m)) (println! (BOOTED-MODULES $modules)))
"""


def _boot(tmp_path, **env_extra):
    """PeTTa's output for a mind booting on a host loader naming code and code_workspace."""
    (tmp_path / "repos").mkdir()
    (tmp_path / "repos" / "OmegaClaw-Core").symlink_to(ROOT)
    loader = tmp_path / "host-loader.metta"
    loader.write_text("!(import! &self (library OmegaClaw-Core ./modules/code/entry.metta))\n"
                      "!(import! &self (library OmegaClaw-Core ./modules/code_workspace/entry.metta))\n")
    (tmp_path / "run.metta").write_text(BOOT)
    python = [ROOT / "hive" / "runtime" / "extensions", ROOT / "hive" / "runtime", ROOT]
    env = {k: v for k, v in os.environ.items() if k != "OMEGACODE_SRC"}
    env.update(LANG="C.UTF-8", OMEGACLAW_MEMORY_DIR=str(tmp_path / "memory"), OMEGACLAW_MODULE_LOADER=str(loader),
               PYTHONPATH=os.pathsep.join(map(str, python)), **env_extra)
    run = subprocess.run(["sh", str(PETTA / "run.sh"), str(tmp_path / "run.metta"), "--silent"], cwd=tmp_path, env=env,
                         capture_output=True, text=True)
    return run.stdout + run.stderr


def _code_modules(output):
    """The Code module ids the booted space declares."""
    found = re.search(r"\(BOOTED-MODULES \(([^()]*)\)\)", output)
    assert found, output[-3000:]
    return {m for m in found.group(1).split() if m.startswith("omegahive.code")}


@needs_petta
def test_without_the_client_the_boot_never_loads_code_workspace(tmp_path):
    output = _boot(tmp_path)
    assert _code_modules(output) == {"omegahive.code"}
    assert "module code_workspace left out: requires service:omegacode" in output
    assert "code_workspace" not in (tmp_path / "memory" / "modules-loader.metta").read_text().split("\n", 1)[1]


@needs_petta
def test_with_the_client_the_boot_loads_both_code_modules(tmp_path, omegacode_client):
    output = _boot(tmp_path, OMEGACODE_SRC=str(omegacode_client))
    assert _code_modules(output) == {"omegahive.code", "omegahive.code.workspace"}
    assert "left out" not in output
    assert not (tmp_path / "memory" / "modules-loader.metta").exists()
