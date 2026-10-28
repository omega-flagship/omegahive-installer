"""The suites the Lab can run."""

from __future__ import annotations

SUITES = [
    {"id": "tests-omegabench", "kind": "tests", "title": "OmegaBench evidence protocol",
     "description": "Paired comparison, seals, failures, protected floors and evidence bounds; no capability gain.",
     "estimate_s": 3, "pytest": ["omegabench/tests"]},
    {"id": "bench-omega-development", "kind": "bench", "title": "OmegaBench public development fixtures",
     "description": "Synthetic answer-key fixture plumbing only; no Omega subject or AGI measurement.",
     "estimate_s": 2},
    {"id": "tests-evolve", "kind": "tests", "title": "OmegaEvolve research protocol",
     "description": "Offline contribution, provenance, experiment-pin and authority checks; no capability gain is claimed.",
     "estimate_s": 5, "pytest": ["hive/tests/test_evolve.py", "hive/tests/test_evolve_preflight.py", "hive/tests/test_evolve_lineage.py", "hive/tests/test_evolve_seed.py"]},
    {"id": "tests-hive", "kind": "tests", "title": "Hive server tests",
     "description": "API, policy, tasks, schedule, drift guards and the Docker driver, against real PeTTa spaces.",
     "estimate_s": 10, "pytest": ["hive/tests", "--ignore=hive/tests/test_acceptance.py",
                                  "--ignore=hive/tests/test_phase2_acceptance.py",
                                  "--ignore=hive/tests/test_sharing_acceptance.py"]},
    {"id": "tests-runtime", "kind": "tests", "title": "Omega runtime tests",
     "description": "The agent runtime: command parser, memory paths, modules, attention, recall, persistence.",
     "estimate_s": 15, "pytest": ["tests", "--ignore=tests/fixtures"]},
    {"id": "tests-memory", "kind": "tests", "title": "Memory safety (boots Omega)",
     "description": "Boots the real runtime: separate memory per mind, protected atoms survive bounding, atomic saves.",
     "estimate_s": 20, "pytest": ["tests/test_memory_safety.py", "tests/test_multi_instance_memory.py"],
     "needs": ["petta", "chromadb"]},
    {"id": "tests-e2e", "kind": "tests", "title": "End to end with real Omegas",
     "description": "Three Omegas chat, publish and revise, survive a restart; approvals, tasks, memory control, "
                    "a mixed Omega + Iter swarm, and minds sharing spaces and exhibits with each other.",
     "estimate_s": 140, "pytest": ["hive/tests/test_acceptance.py", "hive/tests/test_phase2_acceptance.py",
                                    "hive/tests/test_sharing_acceptance.py"],
     "env": {"HIVE_E2E": "1"}, "needs": ["petta", "chromadb"]},
    {"id": "tests-ui", "kind": "tests", "title": "Web UI tests",
     "description": "Store, simulator and helpers of the web UI (vitest).", "estimate_s": 10, "vitest": True},
    {"id": "bench-core", "kind": "bench", "title": "Hive performance",
     "description": "Throughput and latency of the commons, gate, hub and gateway; revision accuracy; claim races.",
     "estimate_s": 40},
    {"id": "bench-drift", "kind": "bench", "title": "Drift scenarios",
     "description": "Failure modes from DRIFT.md provoked on purpose: echo storms, retry storms, spend runaway, "
                    "abandoned tasks, subtask explosions.",
     "estimate_s": 20},
    {"id": "bench-bias", "kind": "bench", "title": "Bias and invariance",
     "description": "The same evidence must get the same treatment whatever the claim is about, whoever "
                    "reports it and in whatever order; the policy gate must treat every mind alike.",
     "estimate_s": 25},
    {"id": "bench-ops", "kind": "bench", "title": "Operations: resources, power, cost, reliability",
     "description": "A live three-Omega swarm: memory, CPU and disk idle and under load; energy per reply; "
                    "projected cost per model; efficiency; task accuracy; crash, outage and restart recovery.",
     "estimate_s": 200, "needs": ["petta", "chromadb"]},
    {"id": "bench-epistemic", "kind": "bench", "title": "Epistemic Resolve",
     "description": "Crawford & Hammer's disciplined-update benchmark (AGI-26) run through the swarm commons, "
                    "next to the paper's calibration mocks.",
     "estimate_s": 10, "needs": ["epistemic-resolve"]},
    {"id": "bench-swarm", "kind": "bench", "title": "Live Omega swarm",
     "description": "Three real Omegas on the offline model: boot time, reply latency, belief propagation, "
                    "loop health.",
     "estimate_s": 150, "needs": ["petta", "chromadb"]},
]

BY_ID = {s["id"]: s for s in SUITES}
