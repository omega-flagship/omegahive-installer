import os
import pathlib
import subprocess
import re
from types import SimpleNamespace
import pytest
from hive.core.db import Database
from hive.core.evolve import EvolveRegistry
from hive.core.evolve_projection import project_snapshot
from hive.core.evolve_preflight import digest
from hive.tests.test_evolve import actor, contribution


def test_native_source_status_and_dependency_queries(tmp_path):
    petta = pathlib.Path(os.environ.get("PETTA_PATH", pathlib.Path.home() / "PeTTa"))
    if not (petta / "run.sh").exists():
        pytest.skip("requires pinned PeTTa")
    registry = EvolveRegistry(SimpleNamespace(db=Database(tmp_path / "native.sqlite")))
    payload = dict(contribution(), claim='\") !(py-call ("os.system" "echo unsafe")) ;')
    source = registry.contribute("s1", actor(), payload)
    dependent = registry.contribute("s1", actor(), dict(contribution(), title="dependent", depends_on=[source["id"]]))
    registry.contribute("s1", actor(), dict(contribution(), title="retract", relation="retraction", predecessor=source["id"]))
    atoms = [atom for entry in registry.snapshot("s1") for atom in project_snapshot(entry)]
    assert not any("py-call" in atom or "unsafe" in atom for atom in atoms)
    source_key = digest({"id": source["id"], "swarm": "s1"})
    dependent_key = digest({"id": dependent["id"], "swarm": "s1"})
    library = pathlib.Path(__file__).resolve().parents[1] / "spaces" / "lib_evolve.metta"
    main = tmp_path / "native.metta"
    main.write_text(library.read_text() + "\n" + "\n".join(atoms) +
        f'\n!(evolve-status "{source_key}")\n!(evolve-needs-review? "{dependent_key}")\n'
        f'!(match &self (EvolveDepends "{dependent_key}" $source) $source)\n')
    run = subprocess.run(["sh", str(petta / "run.sh"), str(main), "--silent"], capture_output=True, text=True, timeout=15)
    assert run.returncode == 0 and not run.stderr.strip(), run.stderr
    output = re.sub(r"\x1b\[[0-9;]*m", "", run.stdout).splitlines()
    # PeTTa serializes its Bool value as lowercase true.
    assert [line.strip() for line in output][-3:] == ["Retracted", "true", f'"{source_key}"']
