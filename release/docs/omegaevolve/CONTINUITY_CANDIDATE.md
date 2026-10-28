> **Closed Source for Product Consideration.** These notes document Evolve (`hive/plugins/omegaevolve`), a closed folder in this repository. Shared privately with the SingularityNET team. Do not publish, redistribute or relicense as open source. See `hive/plugins/omegaevolve/CLOSED_SOURCE.md`.

# Source continuity and native research representation

This candidate extends the installed 0.1.0 contribution registry to 0.2.0 on base `433c699f58d49d0998f57caec78b49dc3bd80567`, without modifying the active platform checkout.

Contributions may now include `relation` (`assertion`, `reference`, `correction`, `retraction`), `predecessor` and `depends_on`. The author comes from the host token route. A correction/retraction requires a contribution predecessor in the same swarm and the same author. Critics can use `reference` without changing the source's state. Evidence and uncertainty remain required; custody remains unresolved. Knowledge changes confer no effect authority.

Source bodies remain immutable. A separate reducer computes source status and transitively marks claims depending on corrected/retracted versions as `needs-review`. Dependents are not automatically rewritten to point to a replacement: that is a new, explicit contribution. Fork checks and appends share the single hive Database lock; duplicate revision retries return the original record. This does not claim distributed multi-process concurrency guarantees.

Focused views still reflect upstream changes because they derive from the complete swarm lineage. The native representation carries source, unresolved custody, status and typed relationship atoms with fixed-alphabet identifiers. PeTTa query tests check native source status and dependency access; projection is not installed in the shared hive here.

The existing `tests-evolve` Lab suite adds lineage qualification. API tests exercise author-only retraction through the actual member policy route in disposable stores. Tests cover preservation, transitive invalidation, restart, identity, legacy compatibility, wrong-swarm references, retry/fork behavior and two concurrent revisions.

This is a functional research-memory improvement, not a held-out intelligence experiment. No measured model capability gain, recursive research acceleration, beneficialness review, deployment, paid calls or auto-adoption is claimed by this candidate.

Remaining first-loop work: actual sealed baseline/candidate execution and evaluator custody, independent reviewer goals and authenticated receipts, owner Updates adoption and observed rollback, plus shared-knowledge publication and the Omega body route. Keep the broader Hyperon theory route in `HYPERON_THEORY_REVIEW.md`.
