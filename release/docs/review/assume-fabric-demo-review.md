# Assume / FabricPC Demo Review Notes

This note defines the review boundary for the public `SmartHabitatDemoSpace`
demo. It is written for reviewers who care about the neural-symbolic contract,
not just whether a command returns plausible text.

## Architecture Claim

`&assume` owns the canonical symbolic graph. The graph is represented as
MeTTa-shaped atoms: situations, active context features, possible actions,
sparse feature/action edges, explicit outcomes, and explicit errors.

FabricPC is a warm executable view of that symbolic graph. It predicts from the
loaded topology and can learn from explicit targets, but it does not own
identity, memory, policy, or world action. Writeback returns symbolic mutation
deltas for review and persistence.

## Demonstrated Round Trip

The demo and tests exercise this loop:

1. Load sanitized MeTTa atoms from `SmartHabitatDemoSpace.metta`.
2. Reconstruct a sparse FabricPC predictive graph from those atoms.
3. Predict a likely action and return score, support, confidence, evidence,
   error pressure, verdict, reason, and NAL-style truth.
4. Audit a risky action and expose negative evidence as error pressure.
5. Learn from explicit target/outcome evidence.
6. Emit only changed edges as `AssumeUpdatedFeatureEdge` atoms.
7. Pair every changed edge with `AssumeWeightMutation`, including old weight,
   new weight, delta, confidence/evidence movement, direction, target, cause,
   and topology hash.
8. Pair each mutation with primitive facts: `AssumeWeightDelta`,
   `AssumeMutationTarget`, `AssumeMutationSignedError`,
   `AssumeMutationEvidence`, `AssumeMutationPressurePrimitive`,
   `AssumeMutationConflictPrimitive`, `AssumeMutationTopology`, and
   `AssumeAdjustmentPressure`.
9. Pair each mutation with Fabric-local judgement atoms:
   `AssumeFabricMutationTruth`, `AssumeFabricMutationVerdict`, and
   `AssumeFabricMutationReason`.
10. Allow MeTTa to derive its own native adjustment judgement from the same
   primitive atoms and compare it with Fabric's local judgement.
11. Persist the delta into canonical atoms before mutating the live `&assume`
   view.
12. Reload and verify the prediction changed.

## What Is Intentionally Not Hidden

The mutation is not a black-box side effect. Reviewers can inspect:

- `AssumePredictionReport`
- `AssumeSupport`
- `AssumeConfidence`
- `AssumeEvidence`
- `AssumeErrorPressure`
- `NALTruth`
- `AssumeUpdatedFeatureEdge`
- `AssumeWeightMutation`
- `AssumeWeightDelta`
- `AssumeMutationTarget`
- `AssumeMutationSignedError`
- `AssumeMutationEvidence`
- `AssumeMutationPressurePrimitive`
- `AssumeMutationConflictPrimitive`
- `AssumeMutationTopology`
- `AssumeAdjustmentPressure`
- `AssumeMutationTruth`
- `AssumeMutationPressure`
- `AssumeMutationConflict`
- `AssumeMutationVerdict`
- `AssumeMutationReason`
- `AssumeFabricMutationTruth`
- `AssumeFabricMutationVerdict`
- `AssumeFabricMutationReason`
- `AssumeSymbolicMutationTruth`
- `AssumeSymbolicMutationVerdict`
- `AssumeSymbolicMutationReason`
- `AssumeMutationVerdictComparison`
- `AssumeMutationTrace`
- `AssumeMutation`

The trace atoms are kept as trace/history, not inserted back into the live
prediction graph as feature edges. This keeps the graph clean while preserving
auditability.

Fabric judgement atoms are not the final word. They are the Fabric organ's
self-report. `assume-observe-writeback` atomizes the same mutation facts into
`&assume_work`; `assume-review-mutation` then derives a MeTTa-side verdict and
returns an explicit agreement or mismatch atom. That gives the agent both a numeric
organ report and a native symbolic cross-check.

The native MeTTa review path is intentionally named and inspectable:
`assume-adjustment-direction-ok` checks whether the update direction matches
the signed prediction error, and `assume-symbolic-mutation-truth` derives the
MeTTa-side truth value from signed error, delta, pressure, and conflict.

Writeback is canonical-first. MeTTa skills persist the delta before adding the
updated edge atoms to live `&assume`; if persistence fails, the live space is
left unchanged and the error is returned as an explicit `AssumeWritebackCommitError`.
The same rule applies to structural/evidence/demo import helpers: the canonical
file succeeds first, then the live space is warmed.

## Acceptance Tests

FabricPC is an executable organ dependency. The tests discover it through:

- `FABRICPC_REPO`, defaulting to `../FabricPC`
- `FABRICPC_PYTHON`, defaulting to `../FabricPC/.venv/bin/python`

If that interpreter is absent, Fabric-specific unit tests skip rather than
silently pretending the neural organ was exercised.

The intended reviewer suite is:

```bash
python -B tests/assume_demo_story.py
python -B tests/assume_demo_benchmark.py
python -B -m unittest tests.test_assume_demo_space tests.test_assume_fabricd tests.test_assume
```

The full test suite should also remain green:

```bash
python -B -m unittest discover -s tests
```

## Non-Claims

This demo does not claim to be a completed AGI architecture, a finished cortex,
or a general replacement for PLN/NAL/MeTTa reasoning. It demonstrates a narrow
but real neural-symbolic membrane: symbolic graph in, predictive execution,
inspectable error/learning, symbolic mutation out, and reloadable persistence.

The next research step would be deeper causal-coding dynamics and richer
hierarchical prediction. That belongs on top of this membrane, not as a reason
to collapse the architecture into an opaque neural module.
