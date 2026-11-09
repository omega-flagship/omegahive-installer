# OmegaBench

Evidence-bounded benchmarking for OmegaHive and OmegaEvolve. Extends Hive Lab; it has no scheduler or adoption authority.

```sh
.runtime/venv312/bin/python -m omegabench catalog
.runtime/venv312/bin/python -m omegabench demo
.runtime/venv312/bin/python -m omegabench seal registration.json
.runtime/venv312/bin/python -m omegabench compare registration.json SEALED_SHA256 export.json
.runtime/venv312/bin/python -m pytest omegabench/tests -q
```

`demo` returns a complete schema example using 12 public fixtures and an answer-key comparator. No Omega subject executes; the result is held. An independent evaluator can grade supplied responses with `tasks.evaluate_responses`; public fixtures are development material.

`protocol.seal` binds the preregistration. `compare` checks all task/seed pairs, subject/scorer/dataset/environment pins, release/split, finite measurements and resource/beneficialness floors. It reports task-cluster bootstrap uncertainty, gains, failures and cost/tokens per exactly solved task. It does not authenticate source receipts, establish pre-result custody, isolate hidden data or perform adoption. Imported evidence stays unverified even when thresholds pass.

`imports.import_trials` accepts normalized externally graded industry rows with source and licence provenance. It neither launches official harnesses nor claims official scores. Each row includes `task_id`, `seed`, subject `pin`, terminal `status`, score in [0,1], actual `cost`, `tokens`, `seconds`, integer `attempts`, every protected `floor`, and a source `receipt_digest`. Do not put unknown resource values at zero. Missing/duplicate tasks are refused; unsuccessful trials score zero. Official native metrics should remain in source receipts, especially nonbinary/efficiency metrics that cannot be represented faithfully by this one primary [0,1] rubric.

The isolated host candidate vendors this package and registers `tests-omegabench` (protocol qualification) and `bench-omega-development` (synthetic fixtures) in the existing Lab UI/API/history. Evolve's protocol-receipt path accepts the qualification suite and continues to record `candidate_evaluated=false`. An imported comparison must not be sent through that path as capability proof.

See the theory review and Opus's response (internal notes) for lineage, comparison design and remaining host work. No public publication, dataset redistribution or paid experiment is performed.

## Semantic measurement and report adapters

```sh
python -m omegabench swe-arm registration.json baseline report-and-resources.json --seed 0
python -m omegabench arc-arm registration.json candidate grids-and-resources.json --seed 0 --max-attempts 2
python -m omegabench import-trials registration.json SEALED_SHA256 normalized-packet.json
python -m omegabench metrics calibration forecasts.json
python -m omegabench metrics horizons predictions.json
python -m omegabench metrics causal triplet.json
python -m omegabench metrics reliability repeated-trials.json
```

SWE packets contain `report` (official summary schema 2) and `resources` (task-keyed actual ledger, including floor assessments and receipt digests). Resolved/unresolved/error/incomplete/empty-patch categories must partition the sealed cohort. Infrastructure failures stay in that denominator. This adapter consumes the official grader's report; it does not independently validate patches or test execution. See the [official report generator](https://github.com/SWE-bench/SWE-bench/blob/main/swebench/harness/reporting.py).

ARC packets contain task-keyed `solutions`, `predictions` and `resources`. Predictions contain one mapping per test grid, with `attempt_1` and optionally `attempt_2`. Seal the exact `arc-grid-exact-pass@1` or `arc-grid-exact-pass@2` rubric. Every grid must match within that cap. This computes a local diagnostic, not an official ARC score. Actual solution visibility determines whether it is development or independently held-out evidence.

Registration also requires `task_families`: a complete task-to-generation-family map. Seed repetitions are averaged within task; the uncertainty bootstrap resamples whole families so template siblings do not inflate the evidence count. The example has twelve rows but only three independent families and is held. Five families remains an engineering minimum, not an adequate sample-size guarantee.

Semantic metrics include frequency-weighted calibration error, horizon-specific Brier scores, all-k repeat reliability, and FULL/SHAM/SEVERED consumer outcomes. A causal triplet must bind artifact, input, route, environment, task, seed and boundary; SHAM computes the same result as FULL but masks it, while SEVERED computes nothing. Logs never count as consumer outcomes. Receipt assertions remain unverified and one valid triplet does not establish statistical causality or general usefulness.

## Evolve integration

The host candidate adds owner-only `register-benchmark` and `assess-benchmark` actions to OmegaEvolve. They retain a sealed registration and a computed comparison in the existing immutable swarm registry. Existing host identity, program capabilities and graph-revision checks apply. Imports remain `unverified-import`, independent review remains pending, and `candidate_evaluated=false` means no authenticated host execution is established. Protocol Lab receipts and benchmark assessments are separate records; completion/adoption remains refused pending the existing independent-review path.

The version-2 registration schema requires task families and rejects undeclared authority/execution fields. Re-register version-1 development packets with this metadata before any new measurement; no prior seal silently migrates.
