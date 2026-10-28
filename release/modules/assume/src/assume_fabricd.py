#!/usr/bin/env python3
"""Warm FabricPC organ for consumptive Assume predictions.

AtomSpace / MeTTa remains the canonical graph. This daemon is a disposable,
warm executable reflection: it can predict, audit, explicitly learn, and return
writeback atoms, but it never acts on the world.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import sys
import time
from typing import Any

import jax
import jax.numpy as jnp
import optax
from fabricpc.core.activations import IdentityActivation
from fabricpc.core.inference import InferenceSGD
from fabricpc.core.initializers import NormalInitializer
from fabricpc.core.topology import Edge
from fabricpc.core.types import GraphParams, NodeParams
from fabricpc.graph_assembly import TaskMap, graph
from fabricpc.graph_initialization import initialize_params
from fabricpc.nodes import Linear
from fabricpc.nodes.identity import IdentityNode
from fabricpc.training import train_step

import assume


def _sync_tree(tree) -> None:
    jax.tree_util.tree_map(
        lambda value: value.block_until_ready() if hasattr(value, "block_until_ready") else value,
        tree,
    )


def _topology_hash(features: list[str], actions: list[str], mask: list[list[float]]) -> str:
    payload = json.dumps(
        {"features": features, "actions": actions, "mask": mask},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


@dataclass(frozen=True)
class PredictionStats:
    action: str
    score: float
    coverage: float
    confidence: float
    evidence: float
    positive: float
    negative: float
    frequency: float
    nal_confidence: float
    verdict: str
    reason: str


class AssumeFabricGraph:
    def __init__(self, graph_id: str, domain: str, situation: str, atoms: str, learning_rate: float = 0.05):
        self.graph_id = str(graph_id)
        self.domain = str(domain)
        self.situation = str(situation)
        self.load_atoms = str(atoms)
        self.dirty = False

        context, actions, edges, _feedback = assume.atomspace_feature_graph(
            atoms,
            self.domain,
            self.situation,
        )
        assume.validate_feature_graph(atoms, context, actions, edges)
        if not context:
            raise ValueError("graph requires at least one active context feature")
        if not actions:
            raise ValueError("graph requires at least one action")

        self.features = sorted({item.feature for item in context} | {edge.feature for edge in edges})
        self.actions = sorted(actions)
        self.feature_index = {feature: idx for idx, feature in enumerate(self.features)}
        self.action_index = {action: idx for idx, action in enumerate(self.actions)}
        self.confidence: dict[tuple[str, str], float] = {}
        self.evidence: dict[tuple[str, str], float] = {}
        self.last_targets: dict[str, float] = {}
        self.last_mutation_context: dict[str, dict[str, float]] = {}

        weights = [[0.0 for _ in self.actions] for _ in self.features]
        self.mask_rows = assume._feature_action_mask(self.features, self.actions, edges)
        for edge in edges:
            feature_idx = self.feature_index[edge.feature]
            action_idx = self.action_index[edge.action]
            weights[feature_idx][action_idx] = assume.clamp01(edge.weight)
            self.confidence[(edge.feature, edge.action)] = assume.clamp01(edge.confidence)
            self.evidence[(edge.feature, edge.action)] = max(0.0, edge.evidence_count)

        self.topology_hash = _topology_hash(self.features, self.actions, self.mask_rows)
        self.mask = jnp.array(self.mask_rows, dtype=jnp.float32)

        x = IdentityNode(shape=(len(self.features),), name="features")
        y = Linear(
            shape=(len(self.actions),),
            name="actions",
            activation=IdentityActivation(),
            use_bias=False,
            weight_init=NormalInitializer(std=0.01),
        )
        self.structure = graph(
            nodes=[x, y],
            edges=[Edge(x, y.slot("in"))],
            task_map=TaskMap(x=x, y=y),
            inference=InferenceSGD(eta_infer=0.05, infer_steps=10),
        )
        self.key = jax.random.PRNGKey(0)
        self.edge_key = "features->actions:in"
        params = initialize_params(self.structure, self.key)
        self.params = GraphParams(
            nodes={
                **params.nodes,
                "actions": NodeParams(
                    weights={self.edge_key: jnp.array(weights, dtype=jnp.float32)},
                    biases={},
                ),
            }
        )
        self.optimizer = optax.sgd(learning_rate=float(learning_rate))
        self.opt_state = self.optimizer.init(self.params)

        structure = self.structure
        optimizer = self.optimizer
        mask = self.mask
        edge_key = self.edge_key
        self.jit_predict = jax.jit(
            lambda params, x_vec: (
                jnp.matmul(x_vec, params.nodes["actions"].weights[edge_key]),
                jnp.matmul(x_vec, mask),
            )
        )
        self.jit_step = jax.jit(
            lambda params, opt_state, batch, key: train_step(
                params,
                opt_state,
                batch,
                structure,
                optimizer,
                key,
            )
        )

        self.predict(atoms)
        self.clean_edges = self._edge_snapshot()

    def status(self) -> dict[str, Any]:
        return {
            "id": self.graph_id,
            "domain": self.domain,
            "situation": self.situation,
            "features": len(self.features),
            "actions": len(self.actions),
            "edges": int(sum(sum(row) for row in self.mask_rows)),
            "topology_hash": self.topology_hash,
            "dirty": self.dirty,
            "target_count": len(self.last_targets),
            "target_actions": sorted(self.last_targets),
        }

    def _edge_snapshot(self) -> dict[tuple[str, str], tuple[float, float, float]]:
        weights = self.params.nodes["actions"].weights[self.edge_key]
        weights.block_until_ready()
        snapshot = {}
        for feature in self.features:
            feature_idx = self.feature_index[feature]
            for action in self.actions:
                action_idx = self.action_index[action]
                if self.mask_rows[feature_idx][action_idx] <= 0:
                    continue
                snapshot[(feature, action)] = (
                    assume.clamp01(float(weights[feature_idx, action_idx])),
                    assume.clamp01(self.confidence.get((feature, action), 0.5)),
                    max(0.0, self.evidence.get((feature, action), 0.0)),
                )
        return snapshot

    @staticmethod
    def _edge_changed(
        before: tuple[float, float, float] | None,
        after: tuple[float, float, float],
        epsilon: float = 1e-9,
    ) -> bool:
        if before is None:
            return True
        return any(abs(left - right) > epsilon for left, right in zip(before, after))

    def context_vector(self, atoms: str) -> tuple[list[float], str]:
        context, _actions, _edges, _feedback = assume.atomspace_feature_graph(
            atoms,
            self.domain,
            self.situation,
        )
        vector = [0.0 for _ in self.features]
        for item in context:
            if item.feature in self.feature_index:
                vector[self.feature_index[item.feature]] = assume.clamp01(item.strength)
        return vector, str(atoms)

    def predict(self, atoms: str | None = None) -> dict[str, Any]:
        atoms = self.load_atoms if atoms is None else str(atoms)
        x_vec, atoms = self.context_vector(atoms)
        weighted, support = self.jit_predict(self.params, jnp.array([x_vec], dtype=jnp.float32))
        weighted = weighted[0]
        support = support[0]
        weighted.block_until_ready()
        support.block_until_ready()

        scores = {}
        reports = {}
        for action in self.actions:
            action_idx = self.action_index[action]
            denom = float(support[action_idx])
            score = assume.clamp01(float(weighted[action_idx]) / denom) if denom > 0 else 0.0
            stats = self._stats_for(action, score, x_vec, atoms)
            scores[action] = score
            reports[action] = stats
        best = max(scores, key=lambda action: (scores[action], action))
        best_stats = reports[best]
        return {
            "action": best,
            "score": scores[best],
            "coverage": best_stats.coverage,
            "confidence": best_stats.confidence,
            "evidence": best_stats.evidence,
            "error_pressure": best_stats.negative,
            "truth_frequency": best_stats.frequency,
            "truth_confidence": best_stats.nal_confidence,
            "verdict": best_stats.verdict,
            "reason": best_stats.reason,
            "scores": scores,
            "report_atoms": "(" + self._prediction_report_atom(reports[best]) + ")",
            "all_report_atoms": "(" + " ".join(self._prediction_report_atom(reports[action]) for action in self.actions) + ")",
        }

    def audit(self, action: str, atoms: str | None = None) -> dict[str, Any]:
        atoms = self.load_atoms if atoms is None else str(atoms)
        prediction = self.predict(atoms)
        scores = prediction["scores"]
        action = str(action)
        if action not in scores:
            raise ValueError(f"unknown action: {action}")
        x_vec, atoms = self.context_vector(atoms)
        stats = self._stats_for(action, scores[action], x_vec, atoms)
        return {
            "action": action,
            "score": stats.score,
            "report_atoms": "(" + self._prediction_report_atom(stats) + ")",
        }

    def learn(self, atoms: str | None, targets: dict[str, Any]) -> dict[str, Any]:
        atoms = self.load_atoms if atoms is None else str(atoms)
        self.last_targets = {
            str(action): assume.clamp01(float(value))
            for action, value in targets.items()
            if str(action) in self.actions
        }
        x_vec, _atoms = self.context_vector(atoms)
        weighted, support = self.jit_predict(self.params, jnp.array([x_vec], dtype=jnp.float32))
        weighted = weighted[0]
        support = support[0]
        weighted.block_until_ready()
        support.block_until_ready()
        conflicts = self._evidence_conflict(atoms)
        self.last_mutation_context = {}
        target_vector = []
        for action in self.actions:
            action_idx = self.action_index[action]
            if action in self.last_targets:
                score = (
                    assume.clamp01(float(weighted[action_idx]) / float(support[action_idx]))
                    if float(support[action_idx]) > 0
                    else 0.0
                )
                signed_error = self.last_targets[action] - score
                conflict = conflicts.get(action, 0.0)
                self.last_mutation_context[action] = {
                    "target": self.last_targets[action],
                    "score": score,
                    "signed_error": signed_error,
                    "pressure": abs(signed_error) * max(0.0, 1.0 - conflict),
                    "conflict": conflict,
                }
                target_vector.append(
                    self.last_targets[action] * max(0.0, float(support[action_idx]))
                )
            else:
                target_vector.append(float(weighted[action_idx]))
        batch = {
            "x": jnp.array([x_vec], dtype=jnp.float32),
            "y": jnp.array([target_vector], dtype=jnp.float32),
        }
        self.params, self.opt_state, energy, _state = self.jit_step(
            self.params,
            self.opt_state,
            batch,
            self.key,
        )
        weights = self.params.nodes["actions"].weights[self.edge_key] * self.mask
        self.params = GraphParams(
            nodes={
                **self.params.nodes,
                "actions": NodeParams(weights={self.edge_key: weights}, biases={}),
            }
        )
        _sync_tree(self.params)
        if hasattr(energy, "block_until_ready"):
            energy.block_until_ready()

        active_total = max(1.0, sum(x_vec))
        for feature, strength in zip(self.features, x_vec):
            if strength <= 0:
                continue
            for action in self.last_targets:
                if self.mask_rows[self.feature_index[feature]][self.action_index[action]] <= 0:
                    continue
                key = (feature, action)
                self.confidence[key] = assume.clamp01(self.confidence.get(key, 0.5) + 0.01)
                self.evidence[key] = self.evidence.get(key, 0.0) + strength / active_total
        self.dirty = True
        return {
            "energy": float(energy),
            "dirty": self.dirty,
            "target_count": len(self.last_targets),
            "target_actions": sorted(self.last_targets),
        }

    def _evidence_conflict(self, atoms: str | None) -> dict[str, float]:
        atoms = self.load_atoms if atoms is None else str(atoms)
        positive = {action: 0.0 for action in self.actions}
        negative = {action: 0.0 for action in self.actions}
        for row in assume._atom_rows(atoms, "AssumeOutcome"):
            if len(row) >= 6 and row[0] == self.domain and row[1] == self.situation and row[2] in positive:
                positive[row[2]] += assume.clamp01(float(row[5]))
        for row in assume._atom_rows(atoms, "AssumeError"):
            if len(row) >= 6 and row[0] == self.domain and row[1] == self.situation and row[2] in negative:
                negative[row[2]] += assume.clamp01(float(row[5]))
        conflict = {}
        for action in self.actions:
            pos = positive[action]
            neg = negative[action]
            conflict[action] = assume.clamp01(min(pos, neg) / max(pos, neg)) if max(pos, neg) > 0 else 0.0
        return conflict

    def evidence_targets(self, atoms: str | None) -> tuple[dict[str, float], list[str]]:
        atoms = self.load_atoms if atoms is None else str(atoms)
        positive = {action: 0.0 for action in self.actions}
        negative = {action: 0.0 for action in self.actions}
        found = False
        for row in assume._atom_rows(atoms, "AssumeOutcome"):
            if len(row) >= 6 and row[0] == self.domain and row[1] == self.situation and row[2] in positive:
                positive[row[2]] += assume.clamp01(float(row[5]))
                found = True
        for row in assume._atom_rows(atoms, "AssumeError"):
            if len(row) >= 6 and row[0] == self.domain and row[1] == self.situation and row[2] in negative:
                negative[row[2]] += assume.clamp01(float(row[5]))
                found = True
        if not found:
            raise ValueError("no AssumeOutcome/AssumeError atoms for graph")
        targets: dict[str, float] = {}
        summary_atoms = []
        for action in self.actions:
            pos = positive[action]
            neg = negative[action]
            total = pos + neg
            if total <= 0:
                target = 0.0
                confidence = 0.0
            else:
                target = assume.clamp01(pos / total)
                confidence = assume.clamp01(total / (total + 1.0))
                targets[action] = target
            conflict = assume.clamp01(min(pos, neg) / max(pos, neg)) if max(pos, neg) > 0 else 0.0
            summary_atoms.append(
                "(AssumeEvidenceSummary "
                f"{assume._atom_symbol(self.domain)} {assume._atom_symbol(self.situation)} "
                f"{assume._atom_symbol(action)} {pos:.12g} {neg:.12g} "
                f"{target:.12g} {confidence:.12g} {conflict:.12g})"
            )
            if conflict > 0.0:
                summary_atoms.append(
                    "(AssumeEvidenceConflict "
                    f"{assume._atom_symbol(self.domain)} {assume._atom_symbol(self.situation)} "
                    f"{assume._atom_symbol(action)} {conflict:.12g})"
                )
        return targets, summary_atoms

    def evidence_summary(self, atoms: str | None = None) -> dict[str, Any]:
        targets, rows = self.evidence_targets(atoms)
        return {
            "atoms": "(" + " ".join(rows) + ")",
            "target_count": len(targets),
            "dirty": self.dirty,
            "topology_hash": self.topology_hash,
        }

    def learn_from_atoms(self, atoms: str | None) -> dict[str, Any]:
        try:
            targets, _summary = self.evidence_targets(atoms)
        except ValueError as exc:
            return {"error": str(exc)}
        return self.learn(atoms, targets)

    def growth_proposals(self, atoms: str | None = None) -> dict[str, Any]:
        atoms = self.load_atoms if atoms is None else str(atoms)
        x_vec, _atoms = self.context_vector(atoms)
        existing = {
            (feature, action)
            for feature in self.features
            for action in self.actions
            if self.mask_rows[self.feature_index[feature]][self.action_index[action]] > 0
        }
        proposals = []
        for action, target in sorted(self.last_targets.items()):
            if target < 0.6:
                continue
            for feature, strength in zip(self.features, x_vec):
                if strength <= 0.05 or (feature, action) in existing:
                    continue
                weight = assume.clamp01(0.5 + 0.4 * target * strength)
                confidence = assume.clamp01(0.35 + 0.25 * strength)
                evidence = max(1.0, strength)
                proposals.append(
                    "(AssumeProposedFeatureEdge "
                    f"{assume._atom_symbol(self.domain)} {assume._atom_symbol(self.situation)} "
                    f"{assume._atom_symbol(feature)} {assume._atom_symbol(action)} "
                    f"{weight:.12g} {confidence:.12g} {evidence:.12g} "
                    f"{assume._atom_symbol('positive-target-missing-edge')})"
                )
        return {
            "atoms": "(" + " ".join(proposals) + ")",
            "proposal_count": len(proposals),
            "dirty": self.dirty,
            "topology_hash": self.topology_hash,
        }

    def growth_pressure(self, atoms: str | None = None) -> dict[str, Any]:
        atoms = self.load_atoms if atoms is None else str(atoms)
        x_vec, _atoms = self.context_vector(atoms)
        prediction = self.predict(atoms)
        scores = prediction["scores"]
        existing = {
            (feature, action)
            for feature in self.features
            for action in self.actions
            if self.mask_rows[self.feature_index[feature]][self.action_index[action]] > 0
        }
        rows = []
        for action, target in sorted(self.last_targets.items()):
            score = assume.clamp01(scores.get(action, 0.0))
            error = assume.clamp01(target - score)
            signed_error = assume.clamp01(target) - score
            rows.append(
                "(AssumePredictionError "
                f"{assume._atom_symbol(self.domain)} {assume._atom_symbol(self.situation)} "
                f"{assume._atom_symbol(action)} {target:.12g} {score:.12g} {error:.12g})"
            )
            rows.append(
                "(AssumeSignedPredictionError "
                f"{assume._atom_symbol(self.domain)} {assume._atom_symbol(self.situation)} "
                f"{assume._atom_symbol(action)} {target:.12g} {score:.12g} "
                f"{signed_error:.12g} {abs(signed_error):.12g})"
            )
            for feature, strength in zip(self.features, x_vec):
                missing = (feature, action) not in existing
                pressure = assume.clamp01(strength * error) if missing else 0.0
                rows.append(
                    "(AssumeGrowthPressure "
                    f"{assume._atom_symbol(self.domain)} {assume._atom_symbol(self.situation)} "
                    f"{assume._atom_symbol(feature)} {assume._atom_symbol(action)} "
                    f"{strength:.12g} {target:.12g} {score:.12g} {error:.12g} "
                    f"{assume._atom_symbol('missing-edge' if missing else 'edge-exists')} "
                    f"{pressure:.12g})"
                )
        return {
            "atoms": "(" + " ".join(rows) + ")",
            "atom_count": len(rows),
            "dirty": self.dirty,
            "topology_hash": self.topology_hash,
        }

    def adjustment_pressure(self, atoms: str | None = None) -> dict[str, Any]:
        atoms = self.load_atoms if atoms is None else str(atoms)
        x_vec, _atoms = self.context_vector(atoms)
        targets, _summary_atoms = self.evidence_targets(atoms)
        canonical_context, _actions, canonical_edges, _feedback = assume.atomspace_feature_graph(
            atoms,
            self.domain,
            self.situation,
        )
        canonical_scores = assume.feature_scores(canonical_context, self.actions, canonical_edges)
        positive = {action: 0.0 for action in self.actions}
        negative = {action: 0.0 for action in self.actions}
        for row in assume._atom_rows(atoms, "AssumeOutcome"):
            if len(row) >= 6 and row[0] == self.domain and row[1] == self.situation and row[2] in positive:
                positive[row[2]] += assume.clamp01(float(row[5]))
        for row in assume._atom_rows(atoms, "AssumeError"):
            if len(row) >= 6 and row[0] == self.domain and row[1] == self.situation and row[2] in negative:
                negative[row[2]] += assume.clamp01(float(row[5]))
        conflict = {}
        for action in self.actions:
            pos = positive[action]
            neg = negative[action]
            conflict[action] = assume.clamp01(min(pos, neg) / max(pos, neg)) if max(pos, neg) > 0 else 0.0

        weights = self.params.nodes["actions"].weights[self.edge_key]
        weights.block_until_ready()
        rows = []
        for feature, strength in zip(self.features, x_vec):
            if strength <= 0:
                continue
            feature_idx = self.feature_index[feature]
            for action, target in sorted(targets.items()):
                if action not in self.action_index:
                    continue
                action_idx = self.action_index[action]
                if self.mask_rows[feature_idx][action_idx] <= 0:
                    continue
                old_weight = 0.0
                for edge in canonical_edges:
                    if edge.feature == feature and edge.action == action:
                        old_weight = assume.clamp01(edge.weight)
                        break
                new_weight = assume.clamp01(float(weights[feature_idx, action_idx]))
                delta = new_weight - old_weight
                direction = "increase" if delta > 1e-9 else "decrease" if delta < -1e-9 else "hold"
                old_score = assume.clamp01(canonical_scores.get(action, 0.0))
                signed_error = assume.clamp01(target) - old_score
                pressure = abs(signed_error) * max(0.0, 1.0 - conflict.get(action, 0.0))
                rows.append(
                    "(AssumeWeightDelta "
                    f"{assume._atom_symbol(self.domain)} {assume._atom_symbol(self.situation)} "
                    f"{assume._atom_symbol(feature)} {assume._atom_symbol(action)} "
                    f"{old_weight:.12g} {new_weight:.12g} {delta:.12g} "
                    f"{assume._atom_symbol(direction)})"
                )
                rows.append(
                    "(AssumeAdjustmentPressure "
                    f"{assume._atom_symbol(self.domain)} {assume._atom_symbol(self.situation)} "
                    f"{assume._atom_symbol(feature)} {assume._atom_symbol(action)} "
                    f"{target:.12g} {old_score:.12g} {signed_error:.12g} "
                    f"{pressure:.12g} {assume._atom_symbol(direction)} "
                    f"{conflict.get(action, 0.0):.12g})"
                )
                rows.append(
                    "(AssumeAdjustmentProposal "
                    f"{assume._atom_symbol(self.domain)} {assume._atom_symbol(self.situation)} "
                    f"{assume._atom_symbol(feature)} {assume._atom_symbol(action)} "
                    f"{new_weight:.12g} {self.confidence.get((feature, action), 0.5):.12g} "
                    f"{self.evidence.get((feature, action), 0.0):.12g} "
                    f"{assume._atom_symbol(direction)})"
                )
        return {
            "atoms": "(" + " ".join(rows) + ")",
            "atom_count": len(rows),
            "dirty": self.dirty,
            "topology_hash": self.topology_hash,
        }

    def writeback(self) -> dict[str, Any]:
        atoms = self.writeback_atoms()
        return {
            "atoms": atoms,
            "atoms_len": len(atoms),
            "changed_edges": atoms.count("AssumeUpdatedFeatureEdge"),
            "topology_hash": self.topology_hash,
            "dirty": self.dirty,
        }

    def mark_clean(self) -> dict[str, Any]:
        self.dirty = False
        self.clean_edges = self._edge_snapshot()
        return {
            "topology_hash": self.topology_hash,
            "dirty": self.dirty,
        }

    def writeback_atoms(self) -> str:
        atoms = []
        for (feature, action), (value, confidence, evidence) in sorted(self._edge_snapshot().items()):
            before = self.clean_edges.get((feature, action))
            if not self._edge_changed(before, (value, confidence, evidence)):
                continue
            atoms.append(
                assume._feature_edge_atom(
                    assume.AssumeFeatureEdge(
                        self.domain,
                        feature,
                        action,
                        value,
                        confidence,
                        evidence,
                    ),
                    "AssumeUpdatedFeatureEdge",
                )
            )
            atoms.append(self._weight_mutation_atom(feature, action, before, (value, confidence, evidence)))
            atoms.extend(self._weight_mutation_primitive_atoms(feature, action, before, (value, confidence, evidence)))
            atoms.extend(self._weight_mutation_judgement_atoms(feature, action, before, (value, confidence, evidence)))
        return "(" + " ".join(atoms) + ")"

    def _weight_mutation_atom(
        self,
        feature: str,
        action: str,
        before: tuple[float, float, float] | None,
        after: tuple[float, float, float],
    ) -> str:
        old_weight, old_confidence, old_evidence = before or (0.0, 0.0, 0.0)
        new_weight, new_confidence, new_evidence = after
        delta = new_weight - old_weight
        if delta > 1e-9:
            direction = "increase"
        elif delta < -1e-9:
            direction = "decrease"
        else:
            direction = "metadata-only"
        target = self.last_targets.get(action)
        target_atom = "none" if target is None else f"{target:.12g}"
        cause = "explicit-target" if target is not None else "fabric-state"
        return (
            f"(AssumeWeightMutation {assume._atom_symbol(self.domain)} "
            f"{assume._atom_symbol(self.situation)} {assume._atom_symbol(feature)} "
            f"{assume._atom_symbol(action)} {old_weight:.12g} {new_weight:.12g} "
            f"{delta:.12g} {old_confidence:.12g} {new_confidence:.12g} "
            f"{old_evidence:.12g} {new_evidence:.12g} "
            f"{assume._atom_symbol(direction)} {target_atom} "
            f"{assume._atom_symbol(cause)} {assume._atom_symbol(self.topology_hash)})"
        )

    def _weight_mutation_primitive_atoms(
        self,
        feature: str,
        action: str,
        before: tuple[float, float, float] | None,
        after: tuple[float, float, float],
    ) -> list[str]:
        old_weight, old_confidence, old_evidence = before or (0.0, 0.0, 0.0)
        new_weight, new_confidence, new_evidence = after
        delta = new_weight - old_weight
        if delta > 1e-9:
            direction = "increase"
        elif delta < -1e-9:
            direction = "decrease"
        else:
            direction = "hold"
        context = self.last_mutation_context.get(action, {})
        target = context.get("target")
        score = assume.clamp01(context.get("score", old_weight))
        signed_error = context.get("signed_error", 0.0 if target is None else target - score)
        pressure = assume.clamp01(context.get("pressure", abs(signed_error)))
        conflict = assume.clamp01(context.get("conflict", 0.0))
        target_atom = "none" if target is None else f"{target:.12g}"
        cause = "explicit-target" if target is not None else "fabric-state"
        prefix = (
            f"{assume._atom_symbol(self.domain)} {assume._atom_symbol(self.situation)} "
            f"{assume._atom_symbol(feature)} {assume._atom_symbol(action)}"
        )
        return [
            f"(AssumeWeightDelta {prefix} {old_weight:.12g} {new_weight:.12g} {delta:.12g} {assume._atom_symbol(direction)})",
            f"(AssumeMutationTarget {prefix} {target_atom} {assume._atom_symbol(cause)})",
            f"(AssumeMutationSignedError {prefix} {target_atom} {score:.12g} {signed_error:.12g})",
            f"(AssumeMutationEvidence {prefix} {old_confidence:.12g} {new_confidence:.12g} {old_evidence:.12g} {new_evidence:.12g})",
            f"(AssumeMutationPressurePrimitive {prefix} {pressure:.12g})",
            f"(AssumeMutationConflictPrimitive {prefix} {conflict:.12g})",
            f"(AssumeMutationTopology {prefix} {assume._atom_symbol(self.topology_hash)})",
            f"(AssumeAdjustmentPressure {prefix} {target_atom} {score:.12g} {signed_error:.12g} {pressure:.12g} {assume._atom_symbol(direction)} {conflict:.12g})",
        ]

    def _weight_mutation_judgement_atoms(
        self,
        feature: str,
        action: str,
        before: tuple[float, float, float] | None,
        after: tuple[float, float, float],
    ) -> list[str]:
        old_weight, _old_confidence, _old_evidence = before or (0.0, 0.0, 0.0)
        new_weight, _new_confidence, new_evidence = after
        delta = new_weight - old_weight
        context = self.last_mutation_context.get(action, {})
        target = context.get("target")
        score = assume.clamp01(context.get("score", old_weight))
        signed_error = context.get("signed_error", 0.0 if target is None else target - score)
        pressure = assume.clamp01(context.get("pressure", abs(signed_error)))
        conflict = assume.clamp01(context.get("conflict", 0.0))
        if delta > 1e-9 and signed_error > 1e-9:
            direction_ok = True
        elif delta < -1e-9 and signed_error < -1e-9:
            direction_ok = True
        elif abs(delta) <= 1e-9:
            direction_ok = None
        else:
            direction_ok = False
        if direction_ok is True:
            frequency = 1.0
        elif direction_ok is None:
            frequency = 0.5
        else:
            frequency = 0.0
        truth_confidence = assume.clamp01((max(0.0, new_evidence) / (max(0.0, new_evidence) + 2.0)) * (1.0 - conflict))
        if conflict >= 0.6:
            verdict = "conflicted-adjustment"
            reason = "conflict-too-high"
        elif direction_ok is False:
            verdict = "bad-adjustment"
            reason = "direction-contradicts-error"
        elif pressure >= 0.3 and truth_confidence >= 0.5:
            verdict = "acceptable-adjustment"
            reason = "explicit-target-supported-low-conflict"
        else:
            verdict = "weak-adjustment"
            reason = "low-pressure-or-low-confidence"
        prefix = (
            f"{assume._atom_symbol(self.domain)} {assume._atom_symbol(self.situation)} "
            f"{assume._atom_symbol(feature)} {assume._atom_symbol(action)}"
        )
        return [
            f"(AssumeMutationTruth {prefix} (stv {frequency:.12g} {truth_confidence:.12g}))",
            f"(AssumeMutationPressure {prefix} {pressure:.12g} {signed_error:.12g})",
            f"(AssumeMutationConflict {assume._atom_symbol(self.domain)} {assume._atom_symbol(self.situation)} {assume._atom_symbol(action)} {conflict:.12g})",
            f"(AssumeMutationVerdict {prefix} {assume._atom_symbol(verdict)})",
            f"(AssumeMutationReason {prefix} {assume._atom_symbol(reason)})",
            f"(AssumeFabricMutationTruth {prefix} (stv {frequency:.12g} {truth_confidence:.12g}))",
            f"(AssumeFabricMutationVerdict {prefix} {assume._atom_symbol(verdict)})",
            f"(AssumeFabricMutationReason {prefix} {assume._atom_symbol(reason)})",
        ]

    def _stats_for(self, action: str, score: float, x_vec: list[float], atoms: str) -> PredictionStats:
        action = str(action)
        active_total = sum(x_vec) or 1.0
        support_total = 0.0
        weighted_conf = 0.0
        weighted_evidence = 0.0
        action_idx = self.action_index[action]
        for feature, feature_strength in zip(self.features, x_vec):
            feature_idx = self.feature_index[feature]
            if feature_strength <= 0 or self.mask_rows[feature_idx][action_idx] <= 0:
                continue
            support_total += feature_strength
            weighted_conf += feature_strength * assume.clamp01(self.confidence.get((feature, action), 0.5))
            weighted_evidence += feature_strength * max(0.0, self.evidence.get((feature, action), 0.0))
        coverage = assume.clamp01(support_total / active_total)
        confidence = assume.clamp01(weighted_conf / support_total) if support_total else 0.0
        evidence = weighted_evidence / support_total if support_total else 0.0

        positive = 0.0
        negative = 0.0
        for row in assume._atom_rows(atoms, "AssumeOutcome"):
            if len(row) >= 6 and row[0] == self.domain and row[1] == self.situation and row[2] == action:
                positive += abs(assume._to_float(row[5]))
        for row in assume._atom_rows(atoms, "AssumeError"):
            if len(row) >= 6 and row[0] == self.domain and row[1] == self.situation and row[2] == action:
                negative += abs(assume._to_float(row[5]))

        if positive + negative > 0:
            frequency = assume.clamp01(positive / (positive + negative))
            nal_confidence = assume.clamp01((positive + negative) / (positive + negative + 1.0))
        else:
            frequency = assume.clamp01(score)
            nal_confidence = assume.clamp01(evidence / (evidence + 2.0)) if evidence > 0 else 0.0

        if support_total <= 0:
            verdict = "unsupported"
            reason = "no-active-supporting-edge"
        elif negative > positive and negative >= 0.15:
            verdict = "error-pressure"
            reason = "recent-negative-evidence"
        elif coverage < 0.5:
            verdict = "thin-context"
            reason = "active-features-poorly-covered"
        elif confidence < 0.5 or evidence < 1.0:
            verdict = "ask-or-observe"
            reason = "low-confidence-or-low-evidence"
        elif score >= 0.65 and confidence >= 0.6:
            verdict = "usable-assumption"
            reason = "supported-by-active-features"
        else:
            verdict = "weak-assumption"
            reason = "support-below-action-threshold"
        return PredictionStats(
            action=action,
            score=assume.clamp01(score),
            coverage=coverage,
            confidence=confidence,
            evidence=evidence,
            positive=positive,
            negative=negative,
            frequency=frequency,
            nal_confidence=nal_confidence,
            verdict=verdict,
            reason=reason,
        )

    def _prediction_report_atom(self, stats: PredictionStats) -> str:
        return (
            f"(AssumePredictionReport "
            f"(AssumePrediction {assume._atom_symbol(self.domain)} {assume._atom_symbol(self.situation)} "
            f"{assume._atom_symbol(stats.action)} {stats.score:.12g}) "
            f"(AssumeSupport {assume._atom_symbol(self.domain)} {assume._atom_symbol(self.situation)} "
            f"{assume._atom_symbol(stats.action)} {stats.coverage:.12g}) "
            f"(AssumeConfidence {assume._atom_symbol(self.domain)} {assume._atom_symbol(self.situation)} "
            f"{assume._atom_symbol(stats.action)} {stats.confidence:.12g}) "
            f"(AssumeEvidence {assume._atom_symbol(self.domain)} {assume._atom_symbol(self.situation)} "
            f"{assume._atom_symbol(stats.action)} {stats.evidence:.12g}) "
            f"(AssumeErrorPressure {assume._atom_symbol(self.domain)} {assume._atom_symbol(self.situation)} "
            f"{assume._atom_symbol(stats.action)} {stats.negative:.12g}) "
            f"(NALTruth (stv {stats.frequency:.12g} {stats.nal_confidence:.12g})) "
            f"(Verdict {assume._atom_symbol(stats.verdict)}) "
            f"(Reason {assume._atom_symbol(stats.reason)}))"
        )


class AssumeFabricDaemon:
    def __init__(self):
        self.graphs: dict[str, AssumeFabricGraph] = {}

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        command = request.get("cmd")
        started = time.perf_counter()
        try:
            if command == "load":
                graph_id = str(request["id"])
                self.graphs[graph_id] = AssumeFabricGraph(
                    graph_id,
                    str(request["domain"]),
                    str(request["situation"]),
                    str(request["atoms"]),
                    float(request.get("learning_rate", 0.05)),
                )
                response = {"ok": True, **self.graphs[graph_id].status()}
            elif command == "status":
                response = {"ok": True, **self._graph(request).status()}
            elif command == "predict":
                graph_obj = self._graph(request)
                response = {"ok": True, **graph_obj.predict(request.get("atoms"))}
            elif command == "audit":
                graph_obj = self._graph(request)
                response = {"ok": True, **graph_obj.audit(str(request["action"]), request.get("atoms"))}
            elif command == "learn":
                graph_obj = self._graph(request)
                response = {"ok": True, **graph_obj.learn(request.get("atoms"), dict(request.get("targets", {})))}
            elif command == "learn_from_atoms":
                graph_obj = self._graph(request)
                learned = graph_obj.learn_from_atoms(request.get("atoms"))
                if "error" in learned:
                    response = {"ok": False, "error": learned["error"]}
                else:
                    response = {"ok": True, **learned}
            elif command == "evidence_summary":
                graph_obj = self._graph(request)
                response = {"ok": True, **graph_obj.evidence_summary(request.get("atoms"))}
            elif command == "writeback":
                response = {"ok": True, **self._graph(request).writeback()}
            elif command == "growth_proposals":
                response = {"ok": True, **self._graph(request).growth_proposals(request.get("atoms"))}
            elif command == "growth_pressure":
                response = {"ok": True, **self._graph(request).growth_pressure(request.get("atoms"))}
            elif command == "adjustment_pressure":
                response = {"ok": True, **self._graph(request).adjustment_pressure(request.get("atoms"))}
            elif command == "mark_clean":
                response = {"ok": True, **self._graph(request).mark_clean()}
            elif command == "stop":
                response = {"ok": True, "stopping": True}
            else:
                response = {"ok": False, "error": f"unknown command: {command}"}
        except Exception as exc:
            response = {"ok": False, "error": str(exc)}
        response["elapsed_ms"] = (time.perf_counter() - started) * 1000
        return response

    def _graph(self, request: dict[str, Any]) -> AssumeFabricGraph:
        graph_id = str(request["id"])
        if graph_id not in self.graphs:
            raise ValueError(f"unknown graph id: {graph_id}")
        return self.graphs[graph_id]


def main() -> int:
    daemon = AssumeFabricDaemon()
    print(json.dumps({"ready": True, "organ": "assume-fabricd"}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
        except Exception as exc:
            print(json.dumps({"ok": False, "error": f"invalid json: {exc}"}), flush=True)
            continue
        response = daemon.handle(request)
        print(json.dumps(response), flush=True)
        if request.get("cmd") == "stop":
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
