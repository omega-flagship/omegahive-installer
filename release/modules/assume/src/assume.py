"""Symbolic Assume graph parsing, scoring, and compatibility dynamics.

MeTTa / AtomSpace owns the meaningful graph. This module parses and audits
Assume atoms and retains the older dense/list dynamics for deterministic tests
and compatibility probes. The always-warm FabricPC predictive organ lives in
assume_fabricd.py and is reached through assume_client.py.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
import os
import pathlib
import subprocess
import sys
from typing import List, Sequence


# Legacy dense engine retained for deterministic tests and fallback probes.
ENGINE = "dense-list-fabric-compatible"
FABRIC_ENGINE = "fabricpc-jax"
CORE_ROOT = pathlib.Path(__file__).resolve().parents[3]
DEFAULT_FABRICPC_REPO = CORE_ROOT.parent / "FabricPC"
_current_module = sys.modules.get(__name__)
if _current_module is not None:
    sys.modules.setdefault("assume", _current_module)

MAX_ATOM_TEXT_CHARS = 200_000
MAX_ACTIVE_FEATURES = 32
MAX_ACTIONS = 32
MAX_FEATURE_EDGES = 1024


@dataclass(frozen=True)
class AssumeEdge:
    domain: str
    situation: str
    action: str
    strength: float


@dataclass(frozen=True)
class AssumeFeedback:
    domain: str
    situation: str
    action: str
    delta: float
    evidence: str
    kind: str


@dataclass(frozen=True)
class AssumeFeatureEdge:
    domain: str
    feature: str
    action: str
    weight: float
    confidence: float = 0.5
    evidence_count: float = 0.0


@dataclass(frozen=True)
class AssumeContextFeature:
    domain: str
    situation: str
    feature: str
    strength: float
    confidence: float = 0.5
    source: str = "unknown"


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def predict_best(edges: Sequence[AssumeEdge], domain: str, situation: str) -> AssumeEdge | None:
    candidates = [
        edge for edge in edges
        if edge.domain == domain and edge.situation == situation
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda edge: (edge.strength, edge.action))


def apply_feedback(
    edges: Sequence[AssumeEdge],
    feedback: Sequence[AssumeFeedback],
) -> List[AssumeEdge]:
    updated = list(edges)
    for item in feedback:
        next_edges: List[AssumeEdge] = []
        matched = False
        for edge in updated:
            if (
                edge.domain == item.domain
                and edge.situation == item.situation
                and edge.action == item.action
            ):
                next_edges.append(
                    AssumeEdge(
                        edge.domain,
                        edge.situation,
                        edge.action,
                        clamp01(edge.strength + item.delta),
                    )
                )
                matched = True
            else:
                next_edges.append(edge)
        if not matched:
            next_edges.append(
                AssumeEdge(item.domain, item.situation, item.action, clamp01(item.delta))
            )
        updated = next_edges
    return updated


def _to_float(value) -> float:
    if isinstance(value, (int, float)):
        result = float(value)
    else:
        result = float(str(value))
    if not math.isfinite(result):
        raise ValueError(f"non-finite numeric value: {value}")
    return result


def _atom_symbol(value) -> str:
    text = str(value)
    if not text:
        return '""'
    needs_quotes = any(ch.isspace() for ch in text) or any(ch in text for ch in '"()')
    needs_quotes = needs_quotes or any(ord(ch) < 32 or ord(ch) == 127 for ch in text)
    if needs_quotes:
        return '"' + _escape_atom_text(text) + '"'
    return text


def _escape_atom_text(text: str) -> str:
    escaped = []
    for ch in str(text):
        if ch == "\\":
            escaped.append("\\\\")
        elif ch == '"':
            escaped.append('\\"')
        elif ch == "\n":
            escaped.append("\\n")
        elif ch == "\r":
            escaped.append("\\r")
        elif ch == "\t":
            escaped.append("\\t")
        elif ord(ch) < 32 or ord(ch) == 127:
            escaped.append(f"\\x{ord(ch):02x}")
        else:
            escaped.append(ch)
    return "".join(escaped)


def _edge_atom(edge: AssumeEdge, name: str = "AssumeEdge") -> str:
    return (
        f"({name} {_atom_symbol(edge.domain)} {_atom_symbol(edge.situation)} "
        f"{_atom_symbol(edge.action)} {edge.strength:.12g})"
    )


def _feature_edge_atom(edge: AssumeFeatureEdge, name: str = "AssumeFeatureEdge") -> str:
    return (
        f"({name} {_atom_symbol(edge.domain)} {_atom_symbol(edge.feature)} "
        f"{_atom_symbol(edge.action)} {edge.weight:.12g} "
        f"{edge.confidence:.12g} {edge.evidence_count:.12g})"
    )


def _feedback_atom(item: AssumeFeedback) -> str:
    atom = "AssumeOutcome" if item.delta >= 0 else "AssumeError"
    amount = abs(item.delta)
    return (
        f"({atom} {_atom_symbol(item.domain)} {_atom_symbol(item.situation)} "
        f"{_atom_symbol(item.action)} {_atom_symbol(item.kind)} "
        f"{_atom_symbol(item.evidence)} {amount:.12g})"
    )


def _best_atom(edge: AssumeEdge | None, name: str) -> str:
    if edge is None:
        return f"({name} none none none 0.0)"
    return (
        f"({name} {_atom_symbol(edge.domain)} {_atom_symbol(edge.situation)} "
        f"{_atom_symbol(edge.action)} {edge.strength:.12g})"
    )


def _as_list(value):
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        return json.loads(text)
    return value


def _atom_rows(text: str, head: str) -> List[List[str]]:
    rows: List[List[str]] = []
    for form in _iter_metta_forms(str(text or "")):
        tokens = _split_metta_tokens(form)
        if tokens and tokens[0] == head:
            rows.append(tokens[1:])
    return rows


def _iter_metta_forms(text: str) -> List[str]:
    """Return flat MeTTa forms without being fooled by quoted punctuation."""
    forms: List[str] = []
    stack: list[int] = []
    in_quote = False
    escaped = False
    start: int | None = None
    for idx, ch in enumerate(str(text or "")):
        if in_quote:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_quote = False
            continue
        if ch == '"':
            in_quote = True
            continue
        if ch == "(":
            if not stack:
                start = idx + 1
            stack.append(idx)
            continue
        if ch == ")" and stack:
            stack.pop()
            if not stack and start is not None:
                inner = text[start:idx].strip()
                if _contains_unquoted_paren(inner):
                    forms.extend(_iter_metta_forms(inner))
                elif inner:
                    forms.append(inner)
                start = None
    return forms


def _contains_unquoted_paren(text: str) -> bool:
    in_quote = False
    escaped = False
    for ch in str(text or ""):
        if in_quote:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_quote = False
            continue
        if ch == '"':
            in_quote = True
        elif ch in "()":
            return True
    return False


def _split_metta_tokens(text: str) -> List[str]:
    tokens: List[str] = []
    token = []
    in_quote = False
    escaped = False
    for ch in str(text or ""):
        if in_quote:
            if escaped:
                token.append(_unescape_atom_char(ch))
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_quote = False
                tokens.append("".join(token))
                token = []
            else:
                token.append(ch)
            continue
        if ch == '"':
            in_quote = True
        elif ch.isspace():
            if token:
                tokens.append("".join(token))
                token = []
        else:
            token.append(ch)
    if token:
        tokens.append("".join(token))
    return tokens


def _unescape_atom_char(ch: str) -> str:
    if ch == "n":
        return "\n"
    if ch == "r":
        return "\r"
    if ch == "t":
        return "\t"
    return ch


def atomspace_edges_feedback(atoms_repr: str, domain: str, situation: str):
    domain = str(domain)
    situation = str(situation)
    edges = []
    feedback = []
    for row in _atom_rows(atoms_repr, "AssumeEdge"):
        if len(row) >= 4 and row[0] == domain and row[1] == situation:
            edges.append([row[0], row[1], row[2], _to_float(row[3])])
    for row in _atom_rows(atoms_repr, "AssumeOutcome"):
        if len(row) >= 6 and row[0] == domain and row[1] == situation:
            feedback.append([row[0], row[1], row[2], abs(_to_float(row[5])), row[4], row[3]])
    for row in _atom_rows(atoms_repr, "AssumeError"):
        if len(row) >= 6 and row[0] == domain and row[1] == situation:
            feedback.append([row[0], row[1], row[2], -abs(_to_float(row[5])), row[4], row[3]])
    return edges, feedback


def atomspace_feature_graph(atoms_repr: str, domain: str, situation: str):
    domain = str(domain)
    situation = str(situation)
    context: List[AssumeContextFeature] = []
    edges: List[AssumeFeatureEdge] = []
    actions = set()
    feedback = []

    for row in _atom_rows(atoms_repr, "AssumeContextFeature"):
        if len(row) >= 4 and row[0] == domain and row[1] == situation:
            context.append(
                AssumeContextFeature(
                    row[0],
                    row[1],
                    row[2],
                    _to_float(row[3]),
                    _to_float(row[4]) if len(row) > 4 else 0.5,
                    row[5] if len(row) > 5 else "unknown",
                )
            )
    for row in _atom_rows(atoms_repr, "AssumeAction"):
        if len(row) >= 2 and row[0] == domain:
            actions.add(row[1])
    for row in _atom_rows(atoms_repr, "AssumeFeatureEdge"):
        if len(row) >= 4 and row[0] == domain:
            edges.append(
                AssumeFeatureEdge(
                    row[0],
                    row[1],
                    row[2],
                    _to_float(row[3]),
                    _to_float(row[4]) if len(row) > 4 else 0.5,
                    _to_float(row[5]) if len(row) > 5 else 0.0,
                )
            )
            actions.add(row[2])
    for row in _atom_rows(atoms_repr, "AssumeOutcome"):
        if len(row) >= 6 and row[0] == domain and row[1] == situation:
            feedback.append([row[0], row[1], row[2], abs(_to_float(row[5])), row[4], row[3]])
            actions.add(row[2])
    for row in _atom_rows(atoms_repr, "AssumeError"):
        if len(row) >= 6 and row[0] == domain and row[1] == situation:
            feedback.append([row[0], row[1], row[2], -abs(_to_float(row[5])), row[4], row[3]])
            actions.add(row[2])
    return context, sorted(actions), edges, feedback


def validate_feature_graph(atoms_repr, context, actions, edges):
    if len(str(atoms_repr or "")) > MAX_ATOM_TEXT_CHARS:
        raise ValueError(f"atom text too large: {len(str(atoms_repr))}>{MAX_ATOM_TEXT_CHARS}")
    if len(context) > MAX_ACTIVE_FEATURES:
        raise ValueError(f"too many active features: {len(context)}>{MAX_ACTIVE_FEATURES}")
    if len(actions) > MAX_ACTIONS:
        raise ValueError(f"too many actions: {len(actions)}>{MAX_ACTIONS}")
    if len(edges) > MAX_FEATURE_EDGES:
        raise ValueError(f"too many feature edges: {len(edges)}>{MAX_FEATURE_EDGES}")
    if len(context) * max(1, len(actions)) > MAX_FEATURE_EDGES:
        raise ValueError(
            f"feature-action update would be too large: {len(context)}x{len(actions)}>{MAX_FEATURE_EDGES}"
        )


def feature_scores(
    context: Sequence[AssumeContextFeature],
    actions: Sequence[str],
    edges: Sequence[AssumeFeatureEdge],
) -> dict[str, float]:
    active = {item.feature: clamp01(item.strength) for item in context}
    scores = {action: 0.0 for action in actions}
    support = {action: 0.0 for action in actions}
    for edge in edges:
        if edge.feature not in active or edge.action not in scores:
            continue
        feature_strength = active[edge.feature]
        scores[edge.action] += feature_strength * edge.weight
        support[edge.action] += feature_strength
    for action in actions:
        if support[action] > 0:
            scores[action] = clamp01(scores[action] / support[action])
    return scores


def _best_feature_score_atom(domain: str, situation: str, scores: dict[str, float], name: str) -> str:
    if not scores:
        return f"({name} {_atom_symbol(domain)} {_atom_symbol(situation)} none 0.0)"
    action = max(scores, key=lambda key: (scores[key], key))
    return (
        f"({name} {_atom_symbol(domain)} {_atom_symbol(situation)} "
        f"{_atom_symbol(action)} {scores[action]:.12g})"
    )


def assume_audit(domain, situation, action, atoms_repr) -> str:
    """Return a MeTTa-readable audit of one assumption candidate.

    This is an advisory immune/epistemic layer, not an enforcement policy.
    the agent should reason over the report before choosing whether to act, ask,
    wait, gather more evidence, or ignore the assumption.
    """
    domain = str(domain)
    situation = str(situation)
    action = str(action)
    try:
        context, actions, edges, _feedback_rows = atomspace_feature_graph(
            atoms_repr, domain, situation
        )
        validate_feature_graph(atoms_repr, context, actions, edges)
    except Exception as exc:
        return (
            f"(AssumeGuardReport {_atom_symbol(domain)} {_atom_symbol(situation)} "
            f"{_atom_symbol(action)} (Verdict input-error) (Reason {_atom_symbol(exc)}))"
        )

    if not context:
        return (
            f"(AssumeGuardReport {_atom_symbol(domain)} {_atom_symbol(situation)} "
            f"{_atom_symbol(action)} (Verdict no-context) (Reason no-active-features))"
        )

    scores = feature_scores(context, actions, edges)
    score = clamp01(scores.get(action, 0.0))
    active = {item.feature: clamp01(item.strength) for item in context}
    active_total = sum(active.values()) or 1.0
    matching_edges = [
        edge for edge in edges
        if edge.action == action and edge.feature in active
    ]
    support_total = sum(active[edge.feature] for edge in matching_edges)
    coverage = clamp01(support_total / active_total)
    weighted_conf = 0.0
    weighted_evidence = 0.0
    for edge in matching_edges:
        weight = active[edge.feature]
        weighted_conf += weight * clamp01(edge.confidence)
        weighted_evidence += weight * max(0.0, edge.evidence_count)
    confidence = clamp01(weighted_conf / support_total) if support_total else 0.0
    evidence = weighted_evidence / support_total if support_total else 0.0

    positive = 0.0
    negative = 0.0
    for row in _atom_rows(atoms_repr, "AssumeOutcome"):
        if len(row) >= 6 and row[0] == domain and row[1] == situation and row[2] == action:
            positive += abs(_to_float(row[5]))
    for row in _atom_rows(atoms_repr, "AssumeError"):
        if len(row) >= 6 and row[0] == domain and row[1] == situation and row[2] == action:
            negative += abs(_to_float(row[5]))

    if positive + negative > 0:
        frequency = clamp01(positive / (positive + negative))
        nal_confidence = clamp01((positive + negative) / (positive + negative + 1.0))
    else:
        frequency = score
        nal_confidence = clamp01(evidence / (evidence + 2.0)) if evidence > 0 else 0.0

    if negative > positive and negative >= 0.15:
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

    return (
        f"(AssumeGuardReport {_atom_symbol(domain)} {_atom_symbol(situation)} {_atom_symbol(action)} "
        f"(PredictiveScore {score:.12g}) "
        f"(ContextCoverage {coverage:.12g}) "
        f"(EdgeConfidence {confidence:.12g}) "
        f"(EvidenceCount {evidence:.12g}) "
        f"(OutcomeSupport {positive:.12g}) "
        f"(ErrorPressure {negative:.12g}) "
        f"(NALTruth (stv {frequency:.12g} {nal_confidence:.12g})) "
        f"(Verdict {_atom_symbol(verdict)}) "
        f"(Reason {_atom_symbol(reason)}))"
    )


def assume_feature_step(domain, situation, atoms_repr, backend="fabricpc") -> str:
    domain = str(domain)
    situation = str(situation)
    try:
        context, actions, edges, feedback_rows = atomspace_feature_graph(atoms_repr, domain, situation)
        validate_feature_graph(atoms_repr, context, actions, edges)
    except Exception as exc:
        return (
            f"(AssumeInputError {_atom_symbol(domain)} {_atom_symbol(situation)} "
            f"{_atom_symbol(exc)})"
        )
    if not context or not actions:
        return f"(AssumeNoFeatureGraph {_atom_symbol(domain)} {_atom_symbol(situation)})"

    before_scores = feature_scores(context, actions, edges)
    if str(backend).lower() in {"fabricpc", "fabric", "jax"}:
        updated_edges, energy, engine = _feature_step_fabricpc(
            domain,
            situation,
            context,
            actions,
            edges,
            feedback_rows,
        )
    else:
        updated_edges, energy, engine = _feature_step_dense(
            domain,
            context,
            actions,
            edges,
            feedback_rows,
        )
    after_scores = feature_scores(context, actions, updated_edges)
    updated_atoms = "(" + " ".join(_feature_edge_atom(edge, "AssumeUpdatedFeatureEdge") for edge in updated_edges) + ")"
    feedback_atoms = " ".join(_feedback_atom(AssumeFeedback(*row)) for row in feedback_rows)
    return (
        f"(AssumeFeatureStepResult "
        f"(Engine {_atom_symbol(engine)}) "
        f"({_best_feature_score_atom(domain, situation, before_scores, 'AssumeBestBefore')}) "
        f"({_best_feature_score_atom(domain, situation, after_scores, 'AssumeBestAfter')}) "
        f"(Energy {energy:.12g}) "
        f"(UpdatedFeatureEdges {updated_atoms}) "
        f"(FeedbackTrace {feedback_atoms}))"
    )


def _feedback_targets(actions: Sequence[str], before_scores: dict[str, float], feedback_rows: Sequence[Sequence]) -> dict[str, float]:
    targets = {action: before_scores.get(action, 0.0) for action in actions}
    for row in feedback_rows:
        action = str(row[2])
        delta = _to_float(row[3])
        targets[action] = clamp01(targets.get(action, 0.0) + delta)
    return targets


def _feature_step_dense(domain, context, actions, edges, feedback_rows):
    before_scores = feature_scores(context, actions, edges)
    targets = _feedback_targets(actions, before_scores, feedback_rows)
    active = {item.feature: clamp01(item.strength) for item in context}
    updated = []
    for edge in edges:
        if edge.feature not in active:
            updated.append(edge)
            continue
        feature_strength = active[edge.feature]
        delta = (targets[edge.action] - before_scores.get(edge.action, 0.0)) * feature_strength
        updated.append(
            AssumeFeatureEdge(
                domain,
                edge.feature,
                edge.action,
                clamp01(edge.weight + delta),
                clamp01(max(edge.confidence, 0.5) + 0.05),
                edge.evidence_count + 1,
            )
        )
    return updated, 0.0, "dense-feature-fabric-compatible"


def _feature_action_mask(
    features: Sequence[str],
    actions: Sequence[str],
    edges: Sequence[AssumeFeatureEdge],
) -> list[list[float]]:
    feature_index = {feature: idx for idx, feature in enumerate(features)}
    action_index = {action: idx for idx, action in enumerate(actions)}
    mask = [[0.0 for _ in actions] for _ in features]
    for edge in edges:
        if edge.feature in feature_index and edge.action in action_index:
            mask[feature_index[edge.feature]][action_index[edge.action]] = 1.0
    return mask


def _feature_step_fabricpc(domain, situation, context, actions, edges, feedback_rows):
    try:
        return _feature_step_fabricpc_inprocess(domain, context, actions, edges, feedback_rows)
    except Exception as exc:
        bridged = _feature_step_fabricpc_subprocess(domain, situation, context, actions, edges, feedback_rows)
        if bridged is not None:
            return bridged
        dense_edges, energy, _engine = _feature_step_dense(domain, context, actions, edges, feedback_rows)
        return dense_edges, energy, f"{FABRIC_ENGINE}-unavailable-fallback"


def assume_step_from_atoms(domain, situation, atoms_repr, backend="fabricpc") -> str:
    edges, feedback = atomspace_edges_feedback(atoms_repr, domain, situation)
    edges_json = json.dumps(edges)
    feedback_json = json.dumps(feedback)
    if str(backend).lower() in {"fabricpc", "fabric", "jax"}:
        return assume_step_fabricpc(domain, situation, edges_json, feedback_json)
    return assume_step(domain, situation, edges_json, feedback_json)


def edges_from_json(value) -> List[AssumeEdge]:
    rows = _as_list(value)
    return [
        AssumeEdge(str(row[0]), str(row[1]), str(row[2]), _to_float(row[3]))
        for row in rows
    ]


def feedback_from_json(value) -> List[AssumeFeedback]:
    rows = _as_list(value)
    return [
        AssumeFeedback(
            str(row[0]),
            str(row[1]),
            str(row[2]),
            _to_float(row[3]),
            str(row[4]) if len(row) > 4 else "unspecified-evidence",
            str(row[5]) if len(row) > 5 else "observed",
        )
        for row in rows
    ]


def assume_step(domain, situation, edges_json, feedback_json="[]") -> str:
    """Run one assumption dynamics step and return MeTTa-readable atoms.

    Input rows:
      edges:    [domain, situation, action, strength]
      feedback: [domain, situation, action, signed_delta, evidence, kind]
    """
    domain = str(domain)
    situation = str(situation)
    edges = edges_from_json(edges_json)
    feedback = feedback_from_json(feedback_json)
    before = predict_best(edges, domain, situation)
    updated = apply_feedback(edges, feedback)
    after = predict_best(updated, domain, situation)
    trace = " ".join(_feedback_atom(item) for item in feedback)
    updated_atoms = " ".join(_edge_atom(edge, "AssumeUpdatedEdge") for edge in updated)
    return (
        f"(AssumeStepResult "
        f"(Engine {_atom_symbol(ENGINE)}) "
        f"({_best_atom(before, 'AssumeBestBefore')}) "
        f"({_best_atom(after, 'AssumeBestAfter')}) "
        f"(UpdatedEdges {updated_atoms}) "
        f"(FeedbackTrace {trace}))"
    )


def assume_step_fabricpc(
    domain,
    situation,
    edges_json,
    feedback_json="[]",
    train_steps=6,
    learning_rate=0.5,
) -> str:
    """Run one assumption step through FabricPC when available.

    AtomSpace still owns names and topology. FabricPC receives a numeric view:
    one situation node, one action node, and a learned situation->action weight
    vector. Feedback becomes a target vector for local PC training.
    """
    try:
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
        from fabricpc.graph_initialization.state_initializer import initialize_graph_state
        from fabricpc.nodes import Linear
        from fabricpc.nodes.identity import IdentityNode
        from fabricpc.training import train_step
    except Exception as exc:  # pragma: no cover - exercised in the agent env without FabricPC.
        bridged = _assume_step_fabricpc_subprocess(
            domain,
            situation,
            edges_json,
            feedback_json,
            train_steps,
            learning_rate,
        )
        if bridged is not None:
            return bridged
        return f"(AssumeBackendUnavailable {_atom_symbol(FABRIC_ENGINE)} {_atom_symbol(exc)})"

    domain = str(domain)
    situation = str(situation)
    edges = [
        edge for edge in edges_from_json(edges_json)
        if edge.domain == domain and edge.situation == situation
    ]
    feedback = [
        item for item in feedback_from_json(feedback_json)
        if item.domain == domain and item.situation == situation
    ]
    if not edges:
        return f"(AssumeNoEdges {_atom_symbol(domain)} {_atom_symbol(situation)})"

    actions = sorted({edge.action for edge in edges} | {item.action for item in feedback})
    strength_by_action = {edge.action: clamp01(edge.strength) for edge in edges}
    for action in actions:
        strength_by_action.setdefault(action, 0.0)

    before_edges = [
        AssumeEdge(domain, situation, action, strength_by_action[action])
        for action in actions
    ]
    before = predict_best(before_edges, domain, situation)

    target_by_action = dict(strength_by_action)
    for item in feedback:
        target_by_action[item.action] = clamp01(target_by_action.get(item.action, 0.0) + item.delta)

    x = IdentityNode(shape=(1,), name="situation")
    y = Linear(
        shape=(len(actions),),
        name="action",
        activation=IdentityActivation(),
        use_bias=False,
        weight_init=NormalInitializer(std=0.01),
    )
    structure = graph(
        nodes=[x, y],
        edges=[Edge(x, y.slot("in"))],
        task_map=TaskMap(x=x, y=y),
        inference=InferenceSGD(eta_infer=0.05, infer_steps=10),
    )
    key = jax.random.PRNGKey(0)
    params = initialize_params(structure, key)
    edge_key = "situation->action:in"
    weights = jnp.array(
        [[strength_by_action[action] for action in actions]],
        dtype=jnp.float32,
    )
    params = GraphParams(
        nodes={
            **params.nodes,
            "action": NodeParams(weights={edge_key: weights}, biases={}),
        }
    )

    optimizer = optax.sgd(learning_rate=float(learning_rate))
    opt_state = optimizer.init(params)
    batch = {
        "x": jnp.array([[1.0]], dtype=jnp.float32),
        "y": jnp.array([[target_by_action[action] for action in actions]], dtype=jnp.float32),
    }
    steps = max(0, min(100, int(float(train_steps))))
    energy = 0.0
    for idx in range(steps):
        params, opt_state, energy, _state = train_step(
            params,
            opt_state,
            batch,
            structure,
            optimizer,
            jax.random.fold_in(key, idx),
        )

    state = initialize_graph_state(
        structure,
        1,
        key,
        clamps={"situation": batch["x"]},
        params=params,
    )
    final_state = type(structure.config["inference"]).run_inference(
        params,
        state,
        {"situation": batch["x"]},
        structure,
    )
    vector = [float(value) for value in final_state.nodes["action"].z_mu[0]]
    updated = [
        AssumeEdge(domain, situation, action, clamp01(vector[idx]))
        for idx, action in enumerate(actions)
    ]
    after = predict_best(updated, domain, situation)
    updated_atoms = " ".join(_edge_atom(edge, "AssumeUpdatedEdge") for edge in updated)
    trace = " ".join(_feedback_atom(item) for item in feedback)
    return (
        f"(AssumeStepResult "
        f"(Engine {_atom_symbol(FABRIC_ENGINE)}) "
        f"({_best_atom(before, 'AssumeBestBefore')}) "
        f"({_best_atom(after, 'AssumeBestAfter')}) "
        f"(Energy {float(energy):.12g}) "
        f"(UpdatedEdges {updated_atoms}) "
        f"(FeedbackTrace {trace}))"
    )


def _assume_step_fabricpc_subprocess(
    domain,
    situation,
    edges_json,
    feedback_json,
    train_steps,
    learning_rate,
) -> str | None:
    repo = pathlib.Path(os.environ.get("FABRICPC_REPO", DEFAULT_FABRICPC_REPO))
    python = pathlib.Path(os.environ.get("FABRICPC_PYTHON", repo / ".venv/bin/python"))
    if not python.exists():
        return None
    payload = {
        "domain": str(domain),
        "situation": str(situation),
        "edges_json": str(edges_json),
        "feedback_json": str(feedback_json),
        "train_steps": int(float(train_steps)),
        "learning_rate": float(learning_rate),
    }
    code = (
        "import json, sys; "
        "import assume; "
        "p=json.load(sys.stdin); "
        "print(assume.assume_step_fabricpc(**p))"
    )
    env = dict(os.environ)
    paths = [
        str(pathlib.Path(__file__).resolve().parent),
        str(repo),
    ]
    env["PYTHONPATH"] = os.pathsep.join([path for path in paths if path])
    try:
        completed = subprocess.run(
            [str(python), "-c", code],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            timeout=30,
            env=env,
            check=False,
        )
    except Exception:
        return None
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip().splitlines()[-1:]
        reason = detail[0] if detail else f"exit {completed.returncode}"
        return f"(AssumeBackendUnavailable {_atom_symbol(FABRIC_ENGINE)} {_atom_symbol(reason)})"
    output = completed.stdout.strip()
    return output or None


def _feature_step_fabricpc_inprocess(domain, context, actions, edges, feedback_rows):
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

    features = sorted({item.feature for item in context} | {edge.feature for edge in edges})
    feature_index = {feature: idx for idx, feature in enumerate(features)}
    action_index = {action: idx for idx, action in enumerate(actions)}
    before_scores = feature_scores(context, actions, edges)
    targets = _feedback_targets(actions, before_scores, feedback_rows)

    x_vec = [0.0 for _ in features]
    for item in context:
        x_vec[feature_index[item.feature]] = clamp01(item.strength)
    weight_matrix = [[0.0 for _ in actions] for _ in features]
    edge_mask = _feature_action_mask(features, actions, edges)
    metadata = {(edge.feature, edge.action): edge for edge in edges}
    for edge in edges:
        if edge.feature in feature_index and edge.action in action_index:
            weight_matrix[feature_index[edge.feature]][action_index[edge.action]] = clamp01(edge.weight)

    x = IdentityNode(shape=(len(features),), name="features")
    y = Linear(
        shape=(len(actions),),
        name="actions",
        activation=IdentityActivation(),
        use_bias=False,
        weight_init=NormalInitializer(std=0.01),
    )
    structure = graph(
        nodes=[x, y],
        edges=[Edge(x, y.slot("in"))],
        task_map=TaskMap(x=x, y=y),
        inference=InferenceSGD(eta_infer=0.05, infer_steps=10),
    )
    key = jax.random.PRNGKey(0)
    params = initialize_params(structure, key)
    edge_key = "features->actions:in"
    params = GraphParams(
        nodes={
            **params.nodes,
            "actions": NodeParams(
                weights={edge_key: jnp.array(weight_matrix, dtype=jnp.float32)},
                biases={},
            ),
        }
    )
    optimizer = optax.sgd(learning_rate=0.05)
    opt_state = optimizer.init(params)
    batch = {
        "x": jnp.array([x_vec], dtype=jnp.float32),
        "y": jnp.array([[targets[action] for action in actions]], dtype=jnp.float32),
    }
    energy = 0.0
    params, opt_state, energy, _state = train_step(
        params,
        opt_state,
        batch,
        structure,
        optimizer,
        key,
    )
    learned = params.nodes["actions"].weights[edge_key]
    updated = []
    for edge in edges:
        feature_idx = feature_index[edge.feature]
        action_idx = action_index[edge.action]
        if edge_mask[feature_idx][action_idx] <= 0:
            continue
        updated.append(
            AssumeFeatureEdge(
                domain,
                edge.feature,
                edge.action,
                clamp01(float(learned[feature_idx, action_idx])),
                clamp01(max(edge.confidence, 0.5) + 0.05),
                edge.evidence_count + (1 if edge.feature in {item.feature for item in context} else 0),
            )
        )
    return updated, float(energy), FABRIC_ENGINE


def _feature_step_fabricpc_subprocess(domain, situation, context, actions, edges, feedback_rows):
    repo = pathlib.Path(os.environ.get("FABRICPC_REPO", DEFAULT_FABRICPC_REPO))
    python = pathlib.Path(os.environ.get("FABRICPC_PYTHON", repo / ".venv/bin/python"))
    if not python.exists():
        return None
    payload = {
        "domain": str(domain),
        "situation": str(situation),
        "context": [item.__dict__ for item in context],
        "actions": list(actions),
        "edges": [item.__dict__ for item in edges],
        "feedback_rows": feedback_rows,
    }
    code = r'''
import json, sys
import assume
p = json.load(sys.stdin)
context = [assume.AssumeContextFeature(**item) for item in p["context"]]
edges = [assume.AssumeFeatureEdge(**item) for item in p["edges"]]
updated, energy, engine = assume._feature_step_fabricpc_inprocess(
    p["domain"], context, p["actions"], edges, p["feedback_rows"]
)
print(json.dumps({
    "energy": energy,
    "engine": engine,
    "updated": [item.__dict__ for item in updated],
}))
'''
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([
        str(pathlib.Path(__file__).resolve().parent),
        str(repo),
    ])
    try:
        completed = subprocess.run(
            [str(python), "-c", code],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            timeout=30,
            env=env,
            check=False,
        )
    except Exception:
        return None
    if completed.returncode != 0:
        return None
    try:
        result = json.loads(completed.stdout)
        updated = [AssumeFeatureEdge(**item) for item in result["updated"]]
        return updated, float(result["energy"]), str(result["engine"])
    except Exception:
        return None
