# Assume / FabricPC predictive reasoning organ

Assume is an optional OmegaClaw module for explicit assumption graphs. Omega owns
and edits the symbolic graph in `&assume`; FabricPC is only a warm numeric
reflection used for prediction, audit, learning pressure, and reviewed writeback
proposals.

The intended loop is:

1. Inspect readiness with `assume-status` or `assume-situation-status`.
2. Birth a domain/situation with `assume-init-situation`.
3. Add explicit context features, actions, and feature/action edges.
4. Predict or audit with `assume-predict` / `assume-audit`.
5. Add explicit positive or negative evidence.
6. Observe learning pressure and growth proposals.
7. Review a proposed edge or adjustment before accepting it.

This module should not be treated as hidden cognition. Empty or mismatched graphs
return readiness atoms and next actions instead of invented predictions. Canonical
mutation happens through MeTTa skills and persistence first; FabricPC can be
restarted or discarded without losing the symbolic graph.

Enable by importing `./modules/assume/entry.metta` from `modules/loader.metta`.
`FABRICPC_REPO` and `FABRICPC_PYTHON` may override the default sibling FabricPC
checkout and virtualenv.
