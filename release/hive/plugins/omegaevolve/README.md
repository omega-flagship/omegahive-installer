> **Closed Source for Product Consideration.** Shared privately with the SingularityNET team. Do not publish, redistribute or relicense as open source. See CLOSED_SOURCE.md.

# OmegaEvolve candidate

OmegaEvolve is the hive's shared AGI research Omega. Its objective is recursive self-improvement toward Beneficial General Intelligence and beneficial superintelligence.

This first candidate implements research infrastructure: host-attributed contributions; immutable original records and predecessor links; unresolved evidence custody and explicit uncertainty; named-owner offline experiment registration; an existing-Lab protocol qualification route; and a data-only native record projection prototype. It adds no scheduler or model calls.

The built-in program exposes `contribute` to minds only through existing explicit program-action policy, authentication and retry handling. `register` and `lab-receipt` require a host-authenticated named person with owner role. The local password operator cannot supply this identity. Contributors cannot submit authority fields or executable code fields. Arbitrary text remains in JSON; native projection embeds fixed-alphabet hashes only.

The Lab suite `tests-evolve` runs the registry/preflight checks. Qualification records read the Lab's stored run and retain its digest. This confirms protocol qualification only: those runs do not evaluate the registered baseline/candidate, authenticate scientific reviewers or demonstrate an improvement. Completion through R17 deliberately refuses until candidate evaluation and independent review are wired.

Version 0.2.0 adds explicit source-authored correction/retraction and dependency links. Source revisions preserve the original immutable record. Another contributor can criticize or reference that source, but cannot revise it. Conflicting successors are refused, identical retries retain their identity, and changed sources transitively mark dependent claims for review. Focused views derive state from the stored lineage; restart does not reset a retraction. Legacy predecessor links remain references and acquire no retraction authority.

Native research projection now includes source identity, custody, status, dependency and revision relations as typed MeTTa data. The original text stays in the registry; native references use opaque hashes. The native test queries a retracted source and its dependent claim without embedding or evaluating submitted text. `current` means a source version is current, not that the claim is verified or accepted. The dependency assessment is computed by the host reducer and projected for native inspection; this is not a native reasoning algorithm or self-improvement proof.

Evidence locators remain unresolved; no remote fetch or custody verification occurs. Native shared AtomSpace publication, Omega-body integration, the live $10/day budget, reviewer routing, Updates adoption, monitoring and rollback remain platform integration work. The full theory route and gaps are described in `docs/omegaevolve/HYPERON_THEORY_REVIEW.md`.

Run qualification using the repository Python environment:

```sh
python -m pytest hive/tests/test_evolve.py hive/tests/test_evolve_preflight.py hive/tests/test_evolve_lineage.py hive/tests/test_evolve_native.py hive/tests/test_evolve_api.py hive/tests/test_programs_api.py hive/tests/test_program_actions.py -q
python -m hive.bench run tests-evolve
```

API tests use disposable local stores and the fake supervisor. They do not contact the running hive or start model-backed minds. Native representation was qualified separately in a disposable PeTTa process. Do not deploy this candidate as a complete RSI implementation.
