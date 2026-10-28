# Assume Demo Spaces

`SmartHabitatDemoSpace.metta` is a public, sanitized demo for the
FabricPC-backed Assume organ. It models a generalized smart habitat rather than
any real home.

The demo is intentionally small enough to run locally but large enough to show
the point:

- symbolic MeTTa atoms define situations, context features, actions, sparse
  feature edges, outcomes, and errors;
- FabricPC loads a warm executable graph view from those atoms;
- prediction returns support, confidence, evidence, error pressure, and a
  verdict;
- explicit outcome/error evidence can train the graph;
- writeback returns symbolic atoms that can be reviewed before committing;
- every learned edge update is paired with an `AssumeWeightMutation` atom so
  the neural update is inspectable as symbolic evidence.
- mutation writeback also includes primitive facts, Fabric-local judgement
  atoms, and MeTTa-reviewable pressure atoms, so the agent can reason over the
  update before accepting it.

Investor-facing story:

> An LLM may guess that a house should dim lights for a movie. Assume can show
> which symbolic signals supported that prediction, how confident it is, why
> alternatives are weaker, and exactly how the graph changes after feedback.

Reviewer commands:

FabricPC is discovered through `FABRICPC_REPO` and `FABRICPC_PYTHON`; by
default the tests look for `../FabricPC/.venv/bin/python` beside this repo.

```bash
python -B tests/assume_demo_story.py
python -B tests/assume_demo_benchmark.py
python -B -m unittest tests.test_assume_demo_space tests.test_assume_fabricd tests.test_assume
```

Claims:

- The demo graph is represented as ordinary MeTTa-shaped Assume atoms.
- FabricPC is a warm executable view of that graph, not the canonical memory.
- Prediction/audit returns symbolic reports with support, confidence, evidence,
  error pressure, verdict, reason, and NAL-style truth values.
- Learning is explicit: prediction and audit are consumptive reads; weight
  changes require `learn` or `learn-from-atoms`.
- Writeback is a mutation delta, not a whole-graph export.
- Mutation trace is symbolic and inspectable; it is not hidden inside the
  neural runtime.
- Mutation review is surfaced as explicit atoms. Fabric emits primitive facts
  such as `AssumeWeightDelta`, `AssumeMutationSignedError`,
  `AssumeMutationEvidence`, `AssumeAdjustmentPressure`, plus local judgement
  atoms such as `AssumeFabricMutationVerdict`.
- MeTTa can independently review those same facts with
  `assume-review-mutation`, emit its own truth/verdict/reason atoms, and
  compare its symbolic verdict against Fabric's local verdict.
- Canonical persistence comes before live-space mutation. A failed persistence
  commit returns an error atom and leaves `&assume` unchanged.
- Reloading from committed atoms preserves learned prediction changes.

Non-claims:

- This is not a completed AGI substrate.
- This is not a full hierarchical causal-coding cortex.
- This does not act automatically on the world.
- This does not make the LLM the agent; it exposes a prediction organ that
  OmegaClaw can reason over and choose how to use.
