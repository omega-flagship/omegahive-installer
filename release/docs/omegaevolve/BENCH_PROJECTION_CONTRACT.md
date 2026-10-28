> **Closed Source for Product Consideration.** These notes document Evolve (`hive/plugins/omegaevolve`), a closed folder in this repository. Shared privately with the SingularityNET team. Do not publish, redistribute or relicense as open source. See `hive/plugins/omegaevolve/CLOSED_SOURCE.md`.

# Evolve and Bench projection contract

`ProgramContext.evolve_snapshot(focus)` is the graph input. It carries immutable
registry records plus derived source-lineage state. Stand-in contexts in Bench
checks must implement that current interface; falling back to `evolve_records`
would silently lose correction, retraction and dependency invalidation.

For every projected item, `meta` retains the complete stored body.
`meta.assessment` retains the stored benchmark assessment, including
`independent_units`, uncertainty and `evidence_tier`. When a record has no stored
assessment, the existing contribution assessment field remains the derived state
for compatibility. `meta.lineage_assessment` always carries derived lineage state
separately. Graph status and flags come from this derived state, never from a
benchmark's capability score. Neither field grants adoption authority.

This avoids overwriting measured/imported evidence with lineage bookkeeping.
Focused graph revisions still include source changes outside the selected item.
Native lineage atoms remain data-only, contribution-specific projections; they do
not serialize or execute benchmark report bodies.

Checks retain named-owner benchmark registration and scoring, source continuity,
stale graph revision refusal, independent evidence units and the unverified-import
label. R17 result completion remains refused until independent review is wired.
