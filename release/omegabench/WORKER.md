# Paired worker execution contract

`omegabench.worker.run(registration, pack, executors)` grades an exact-answer
cohort and produces a complete normalized paired export plus a digest-only audit.
The registered evaluator pin binds the worker source bytes; dataset pin binds the
full pack. Each task has id, family, input and expected. The pack remains with
Bench; only a deep copy of input goes to the executor, with subject/environment
pins, task/seed, remaining arm budget and a monotonic deadline. The exact rubric
and one-response/no-retry stop rule are required, not interpreted from arbitrary
prose. Arm executors must match the sealed pins before any dispatch.

The host supplies executor objects with `subject_pin`, `environment_pin` and
`execute(request)`. A return must contain exactly status, response, usage and
floors. Usage includes actual cost, tokens, seconds and attempts even for error,
timeout or cancellation. Dispatched attempts must equal one. Wall time is measured
by the worker and cannot be reduced by a host-reported value. A result arriving
past its deadline is scored as timeout. Measured overruns remain in the export;
subsequent tasks for that arm are cancelled with zero dispatch usage. Cancellation
is latched. Undispatched protected floors are zero (not established).

An exception or missing/malformed accounting raises IncompleteExecution with the
partial digest-only audit. No normalized export or receipt may then be issued.
This avoids pretending an unmetered provider failure consumed zero resources.
Accounted failure terminals stay in the paired denominator and score zero.
Raw responses are graded in memory but not included in the returned audit.
Per-trial export commitments use a fresh private nonce to resist guessing
low-entropy answers from public commitments. The nonce and response digests in
the audit are sensitive Bench-owned material: retain them inside evaluator
custody, never in host graphs, subject logs or public exports. Hashes alone are
not encryption or answer secrecy. The returned audit remains private.
Neither oracle answers nor response bodies are passed into Evolve metadata.

This worker does not run providers or arbitrary commands. It cannot interrupt a
blocking synchronous executor; the host must enforce hard deadlines, cancellation
and spend limits in the actual execution process. Reported pins and floors do not
prove the running subject or OS isolation. An in-process executor can access
same-process memory; prompt filtering alone cannot secure a hidden oracle. A real
executor must run outside the custody boundary with no oracle/key mount or read
capability, pinned immutable subject/environment and observed resource meters.
That live isolation/identity proof remains outstanding.

The worker does not configure trust or sign automatically. After a complete run,
the Bench-owned issuer may bind the export through receipts.issue(), and the
host-configured verifier can retain it in Evolve. Audit metadata is not a custody
manifest; a real custody manifest must describe the verified boundary separately.
Transport authentication still does not establish independent grading or
beneficial improvement. The disposable integration test uses public development
tasks and synthetic in-process solvers, so it remains public development evidence.
No paid or actual Omega/Iter subject run is included.
