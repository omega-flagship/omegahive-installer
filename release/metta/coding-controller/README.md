# MeTTa coding controller

A pure reducer for coding tasks. Rules choose the next action; a model supplies judgement when needed.

- A model proposal never counts as evidence.
- Every effect is journalled before dispatch and retired only by its own result.
- Unknown outcomes remain unresolved debt until the exact operation is reconciled.
- Readiness needs current tests, required checks and independent review.
- Applying needs the person's matching confirmation. The suggestion profile tests a retained candidate and waits for the person's own application.

The host supplies observations, checks authority and performs effects. This module contains the reducer and synthetic tests.

## Run the tests

Use a [PeTTa](https://github.com/patham9/PeTTa) checkout with SWI-Prolog on `PATH`. Set `PETTA_RUN` to the absolute path of its `run.sh`, then run from this directory:

```sh
PETTA_RUN=/path/to/PeTTa/run.sh sh run_tests.sh
```

The runner checks the interpreter exit status and all **183** assertion results, returning a nonzero status on a test failure or incomplete run. Fixture person IDs are invented (`person-a` and `person-b`).

Engine startup diagnostics are printed unchanged. The runner does not classify every diagnostic. These tests exercise pure MeTTa/Prolog; Python/Janus interoperation requires separate environment checks. Use PeTTa's documented dependencies for your platform.

`coding_controller.metta` defines the rules. `test_coding_controller.metta` covers both profiles, approval matching, current-generation results, duplicate events, repair limits, outstanding operations and reconciliation.
