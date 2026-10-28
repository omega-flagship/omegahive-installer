import hashlib
import json
import os
import pathlib
import re
from datetime import datetime

CORE_ROOT = pathlib.Path(__file__).resolve().parents[1]
MEMORY_DIR = pathlib.Path(os.environ.get("OMEGACLAW_MEMORY_DIR", str(CORE_ROOT / "memory")))
ATTENTION_METTA = MEMORY_DIR / "attention.metta"
ATTENTION_JSON = MEMORY_DIR / "attention_ledger.json"
DEFAULT_PERSISTENT_LIMIT = 10000
CACHE_NOTE = "cache-only; canonical symbolic state is memory/attention.metta"


def _escape_metta_string(text):
    escaped = []
    for ch in str(text or ""):
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


def _metta_string(text):
    return '"' + _escape_metta_string(text) + '"'


def _coerce_int(value, default=30, low=1, high=100):
    try:
        return max(low, min(high, int(float(str(value).strip().strip('"')))))
    except Exception:
        return default


def _coerce_float(value, default=0.0, low=-100.0, high=100.0):
    try:
        return max(low, min(high, float(str(value).strip().strip('"'))))
    except Exception:
        return default


def _coerce_mode(value):
    mode = str(value or "review-only").strip().strip('"').lower()
    if mode in {"review", "review_only", "dry-run", "dryrun"}:
        return "review-only"
    if mode not in {"review-only", "cautious", "active"}:
        return "review-only"
    return mode


def _coerce_space(value):
    space = str(value or "persistent").strip().strip('"').lower()
    if space.startswith("&"):
        space = space[1:]
    return re.sub(r"[^a-z0-9_-]+", "-", space).strip("-") or "unknown"


def _split_top_level_exprs(text):
    text = str(text or "").strip()
    if not text or text in {"()", "[]"}:
        return []
    if text.startswith("(") and text.endswith(")"):
        inner = text[1:-1].strip()
        exprs = []
        start = None
        depth = 0
        in_quote = False
        escaped = False
        for idx, ch in enumerate(inner):
            if in_quote:
                if ch == '"' and not escaped:
                    in_quote = False
                escaped = (ch == "\\" and not escaped)
                if ch != "\\":
                    escaped = False
                continue
            if ch == '"':
                in_quote = True
            elif ch == "(":
                if depth == 0:
                    start = idx
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0 and start is not None:
                    exprs.append(inner[start:idx + 1].strip())
                    start = None
        if exprs:
            return exprs
    return [text] if text.startswith("(") else []


def _canonical(expr):
    return re.sub(r"\s+", " ", str(expr or "").strip())


def _hash(expr):
    return hashlib.sha256(_canonical(expr).encode("utf-8", errors="replace")).hexdigest()[:16]


def _normal_topic(expr):
    text = _canonical(expr).lower()
    text = re.sub(r'"[0-9.]+"(?=\))', '"#conf"', text)
    text = re.sub(r"\b\d{4}-\d{2}-\d{2}\b", "#date", text)
    text = re.sub(r"\b\d{2}:\d{2}(:\d{2})?\b", "#time", text)
    text = re.sub(r"\b\d+(\.\d+)?\b", "#num", text)
    return text


def _load_state():
    try:
        return json.loads(ATTENTION_JSON.read_text(encoding="utf-8"))
    except Exception:
        return {"records": {}, "last_scan": {}}


def _save_state(state):
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    ATTENTION_JSON.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")


def _severity(used, limit=DEFAULT_PERSISTENT_LIMIT):
    ratio = used / max(1, limit)
    if ratio >= 1.0:
        return "critical"
    if ratio >= 0.9:
        return "high"
    if ratio >= 0.75:
        return "elevated"
    return "normal"


def _evidence(kind, source, value, confidence):
    return {"kind": kind, "source": source, "value": value, "confidence": float(confidence)}


def _truth(confidence, evidence_count=1):
    strength = max(0.0, min(1.0, float(confidence)))
    # Confidence here is evidence confidence, not final truth. Keep it modest
    # until the agent reinforces or rejects the finding through real cognitive use.
    count_confidence = min(0.95, 0.45 + (0.08 * max(0, int(evidence_count))))
    return strength, count_confidence


def _classify(expr, duplicate=False):
    text = _canonical(expr)
    low = text.lower()
    findings = []
    proposal = ("keep", "not-flagged", 0.4)
    sti = 0.3
    lti = 2.0
    vlti = 0
    protected_terms = ["identity", "family", "patham", "patrick", "architecture", "pin", "reboot", "privacy", "safety", "provider", "not-self", "continuity", "flourishing", "core", "trust", "persistent stores"]
    stale_terms = ["practice", "test", "phase1", "phase2", "phase3", "cycle", "syntax", "experiment", "sandbox", "temporary", "webhost test", "metta format lesson"]
    event_terms = ["observation", "observed", "lights on", "brightness", "at 21:", "at 22:"]
    malformed_terms = ["<tool_call>", "</arg_value>", "_quote_", "_newline_", "errorfeedback"]
    stale_hits = [term for term in stale_terms if term in low]
    event_hits = [term for term in event_terms if term in low]
    malformed_hits = [term for term in malformed_terms if term in low]
    protected_hits = [term for term in protected_terms if term in low]
    evidence = []
    has_stale = bool(stale_hits)
    has_event = bool(event_hits)
    has_malformed = bool(malformed_hits)
    if protected_hits and not (has_stale or has_event or has_malformed):
        vlti = 1
        lti = 8.0
        findings.append(("protected-core", 0.72))
        evidence.append(_evidence("protected-core", "matched-core-term", ",".join(protected_hits[:5]), 0.72))
        proposal = ("keep", "likely-core-or-continuity", 0.72)
    if has_stale:
        findings.append(("stale-practice", 0.82))
        evidence.append(_evidence("stale-practice", "matched-stale-term", ",".join(stale_hits[:5]), 0.82))
        lti = min(lti, 0.8)
        proposal = ("review-retire", "practice-or-test-debris", 0.82)
    if has_event:
        findings.append(("belongs-in-events", 0.68))
        evidence.append(_evidence("belongs-in-events", "matched-event-term", ",".join(event_hits[:5]), 0.68))
        lti = min(lti, 1.2)
        proposal = ("review-move-or-retire", "dated-observation-not-core", 0.68)
    if duplicate:
        findings.append(("duplicate", 0.78))
        evidence.append(_evidence("duplicate", "normalized-shape-repeat", _normal_topic(expr)[:180], 0.78))
        lti = min(lti, 0.7)
        proposal = ("review-merge", "duplicate-normalized-shape", 0.78)
    if len(text) > 650:
        findings.append(("too-long", 0.7))
        evidence.append(_evidence("too-long", "atom-length", str(len(text)), 0.7))
        lti = min(lti, 1.0)
        proposal = ("review-summarize", "oversized-persistent-atom", 0.7)
    if has_malformed:
        findings.append(("malformed", 0.9))
        evidence.append(_evidence("malformed", "matched-malformed-term", ",".join(malformed_hits[:5]), 0.9))
        lti = min(lti, 0.3)
        proposal = ("review-retire", "malformed-parser-artifact", 0.9)
    if vlti:
        proposal = ("keep", "protected-vlti-review-only", max(proposal[2], 0.75))
    return sti, lti, vlti, findings, evidence, proposal


def _merge_prior_attention(record, prior):
    """Preserve the agent's learned attention adjustments for the same atom."""
    if not prior or prior.get("atom") != record.get("atom"):
        return record
    record["sti"] = _coerce_float(prior.get("sti"), record.get("sti", 0.0), low=0.0, high=10.0)
    record["lti"] = _coerce_float(prior.get("lti"), record.get("lti", 0.0), low=0.0, high=10.0)
    record["vlti"] = max(int(record.get("vlti", 0)), int(prior.get("vlti", 0) or 0))
    record["uses"] = list(prior.get("uses") or [])[-20:]
    return record


def _render_metta(state):
    last = state.get("last_scan") or {}
    records = state.get("records") or {}
    lines = [
        f"(AttentionLedgerRole {_metta_string(str(ATTENTION_METTA))} {_metta_string('canonical-symbolic-attention-space')})",
        f"(AttentionCacheRole {_metta_string(str(ATTENTION_JSON))} {_metta_string(CACHE_NOTE)})",
        f"(SpacePressure {_metta_string(last.get('space', 'persistent'))} {int(last.get('used', 0))} {int(last.get('limit', DEFAULT_PERSISTENT_LIMIT))} {_metta_string(last.get('severity', 'unknown'))})",
        f"(AttentionScanSummary {_metta_string(last.get('space', 'persistent'))} {_metta_string(last.get('at', 'unknown'))} {int(last.get('scanned', 0))} {int(last.get('candidate_count', 0))} {int(last.get('protected_count', 0))})",
    ]
    for key, rec in sorted(records.items()):
        lines.append(f"(AtomRef {_metta_string(rec['space'])} {_metta_string(key)} {_metta_string(rec['atom'])})")
        lines.append(f"(AttentionValue {_metta_string(key)} {rec['sti']:.3f} {rec['lti']:.3f} {int(rec['vlti'])})")
        for kind, confidence in rec.get("findings", []):
            lines.append(f"(ImmuneFinding {_metta_string(key)} {_metta_string(kind)} {float(confidence):.3f})")
            evidence_count = len([ev for ev in rec.get("evidence", []) if ev.get("kind") == kind])
            strength, truth_confidence = _truth(confidence, evidence_count)
            lines.append(f"(TruthValue {_metta_string(key)} {_metta_string(kind)} {strength:.3f} {truth_confidence:.3f})")
        for ev in rec.get("evidence", []):
            lines.append(f"(SupportedBy {_metta_string(key)} {_metta_string(ev.get('kind', 'unknown'))} {_metta_string(ev.get('source', 'unknown'))} {_metta_string(ev.get('value', ''))} {float(ev.get('confidence', 0.5)):.3f})")
        action, reason, confidence = rec.get("proposal", ["keep", "not-flagged", 0.0])
        lines.append(f"(ImmuneProposal {_metta_string(key)} {_metta_string(action)} {_metta_string(reason)} {float(confidence):.3f})")
        if action != "keep":
            lines.append(f"(AttentionCandidate {_metta_string(key)} {_metta_string(action)} {_metta_string(reason)} {float(confidence):.3f})")
        for use in rec.get("uses", [])[-5:]:
            lines.append(f"(AttentionUse {_metta_string(key)} {_metta_string(use.get('source', 'omega'))} {_metta_string(use.get('outcome', 'noted'))} {float(use.get('confidence', 0.5)):.3f})")
    for pass_id, run in sorted((state.get("passes") or {}).items()):
        lines.append(f"(ECANPass {_metta_string(pass_id)} {_metta_string(run.get('target', 'unknown'))} {_metta_string(run.get('mode', 'review-only'))} {_metta_string(run.get('at', 'unknown'))})")
        lines.append(
            f"(ECANPassSummary {_metta_string(pass_id)} "
            f"{int(run.get('scanned', 0))} {int(run.get('protected', 0))} "
            f"{int(run.get('candidates', 0))} {int(run.get('target_mutations', 0))} "
            f"{int(run.get('attention_mutations', 0))})"
        )
        for action in run.get("actions", [])[:100]:
            lines.append(
                f"(ECANAction {_metta_string(pass_id)} {_metta_string(action.get('hash', 'unknown'))} "
                f"{_metta_string(action.get('action', 'none'))} {_metta_string(action.get('reason', 'unknown'))} "
                f"{float(action.get('confidence', 0.0)):.3f})"
            )
            lines.append(
                f"(ECANOutcome {_metta_string(pass_id)} {_metta_string(action.get('hash', 'unknown'))} "
                f"{_metta_string(action.get('outcome', 'not-applied'))} {_metta_string(action.get('detail', ''))})"
            )
    ATTENTION_METTA.write_text("\n".join(lines) + "\n", encoding="utf-8")


def scan_persistent(atoms_repr, limit=30):
    limit = _coerce_int(limit)
    atoms = _split_top_level_exprs(atoms_repr)[:limit]
    previous_records = (_load_state().get("records") or {})
    normalized_counts = {}
    for atom in atoms:
        norm = _normal_topic(atom)
        normalized_counts[norm] = normalized_counts.get(norm, 0) + 1
    state = {"records": {}, "last_scan": {}}
    protected_count = 0
    candidate_count = 0
    for atom in atoms:
        key = _hash(atom)
        sti, lti, vlti, findings, evidence, proposal = _classify(atom, duplicate=normalized_counts.get(_normal_topic(atom), 0) > 1)
        if vlti:
            protected_count += 1
        if proposal[0] != "keep":
            candidate_count += 1
        record = {"space": "persistent", "atom": _canonical(atom), "sti": sti, "lti": lti, "vlti": vlti, "findings": findings, "evidence": evidence, "proposal": proposal, "uses": []}
        state["records"][key] = _merge_prior_attention(record, previous_records.get(key))
    used = len(str(atoms_repr or ""))
    state["last_scan"] = {"space": "persistent", "at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "used": used, "limit": DEFAULT_PERSISTENT_LIMIT, "severity": _severity(used), "scanned": len(atoms), "candidate_count": candidate_count, "protected_count": protected_count, "cache_note": CACHE_NOTE}
    _save_state(state)
    _render_metta(state)
    return f"ATTENTION-SCAN persistent scanned={len(atoms)} candidates={candidate_count} protected={protected_count} pressure={used}/{DEFAULT_PERSISTENT_LIMIT} severity={_severity(used)} non_destructive=true"


def _scan_atoms(atoms_repr, target, budget, previous_records=None):
    budget = _coerce_int(budget, default=50, high=250)
    previous_records = previous_records or {}
    atoms = _split_top_level_exprs(atoms_repr)[:budget]
    normalized_counts = {}
    for atom in atoms:
        norm = _normal_topic(atom)
        normalized_counts[norm] = normalized_counts.get(norm, 0) + 1
    records = {}
    protected_count = 0
    candidate_count = 0
    for atom in atoms:
        key = _hash(atom)
        sti, lti, vlti, findings, evidence, proposal = _classify(atom, duplicate=normalized_counts.get(_normal_topic(atom), 0) > 1)
        if vlti:
            protected_count += 1
        if proposal[0] != "keep":
            candidate_count += 1
        record = {
            "space": target,
            "atom": _canonical(atom),
            "sti": sti,
            "lti": lti,
            "vlti": vlti,
            "findings": findings,
            "evidence": evidence,
            "proposal": proposal,
            "uses": [],
        }
        records[key] = _merge_prior_attention(record, previous_records.get(key))
    return atoms, records, candidate_count, protected_count


def _action_for_mode(rec, mode):
    action, reason, confidence = rec.get("proposal", ["keep", "not-flagged", 0.0])
    confidence = float(confidence)
    if action == "keep" or int(rec.get("vlti", 0)):
        return None
    if mode == "review-only":
        return {
            "hash": None,
            "action": action,
            "reason": reason,
            "confidence": confidence,
            "outcome": "proposed-only",
            "detail": "review-only mode; target space unchanged",
        }
    if mode == "cautious":
        if confidence >= 0.9 and action == "review-retire":
            outcome = "ready-for-explicit-retire"
            detail = "high-confidence candidate; use exact retire/transform affordance after review"
        else:
            outcome = "skipped-cautious"
            detail = "below cautious mutation threshold or requires merge/summarize judgment"
        return {"hash": None, "action": action, "reason": reason, "confidence": confidence, "outcome": outcome, "detail": detail}
    return {
        "hash": None,
        "action": action,
        "reason": reason,
        "confidence": confidence,
        "outcome": "active-not-enabled",
        "detail": "active mode records intent only until target-space mutation is separately approved",
    }


def ecan_pass(atoms_repr, target="persistent", mode="review-only", budget=50):
    target = _coerce_space(target)
    mode = _coerce_mode(mode)
    budget = _coerce_int(budget, default=50, high=250)
    state = _load_state()
    atoms, records, candidate_count, protected_count = _scan_atoms(
        atoms_repr,
        target,
        budget,
        state.get("records") or {},
    )
    used = len(str(atoms_repr or ""))
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    pass_id = "ecan-" + datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + target
    state["records"] = records
    state["last_scan"] = {
        "space": target,
        "at": now,
        "used": used,
        "limit": DEFAULT_PERSISTENT_LIMIT,
        "severity": _severity(used),
        "scanned": len(atoms),
        "candidate_count": candidate_count,
        "protected_count": protected_count,
        "cache_note": CACHE_NOTE,
    }
    actions = []
    proposed = {}
    for key, rec in sorted(records.items()):
        action = _action_for_mode(rec, mode)
        if not action:
            continue
        action["hash"] = key
        actions.append(action)
        proposed[action["action"]] = proposed.get(action["action"], 0) + 1
    attention_mutations = 1 if records or actions else 0
    target_mutations = 0
    state.setdefault("passes", {})[pass_id] = {
        "target": target,
        "mode": mode,
        "at": now,
        "scanned": len(atoms),
        "protected": protected_count,
        "candidates": candidate_count,
        "target_mutations": target_mutations,
        "attention_mutations": attention_mutations,
        "actions": actions,
    }
    _save_state(state)
    _render_metta(state)
    action_bits = " ".join(f"{name}={count}" for name, count in sorted(proposed.items())) or "none=0"
    return (
        "ECAN-PASS complete\n"
        f"target={target}\n"
        f"mode={mode}\n"
        f"budget={budget}\n"
        f"scanned={len(atoms)}\n"
        f"protected={protected_count}\n"
        f"candidates={candidate_count}\n"
        f"proposed={action_bits}\n"
        f"target_mutations={target_mutations}\n"
        f"attention_mutations={attention_mutations}\n"
        "non_destructive_target=true\n"
        f"audit_id={pass_id}"
    )


def status():
    state = _load_state()
    last = state.get("last_scan") or {}
    records = state.get("records") or {}
    if not last:
        return "ATTENTION-LEDGER empty run attention-scan-persistent first"
    return f"ATTENTION-LEDGER space={last.get('space')} scanned={last.get('scanned')} records={len(records)} candidates={last.get('candidate_count')} protected={last.get('protected_count')} pressure={last.get('used')}/{last.get('limit')} severity={last.get('severity')} metta={ATTENTION_METTA} cache={ATTENTION_JSON} cache_role=helper-only"


def _candidate_records(limit=10):
    state = _load_state()
    candidates = []
    for key, rec in (state.get("records") or {}).items():
        action, _reason, confidence = rec.get("proposal", ["keep", "", 0.0])
        if action != "keep":
            candidates.append((float(confidence), rec.get("lti", 0.0), key, rec))
    candidates.sort(key=lambda row: (-row[0], row[1], row[2]))
    return candidates[:_coerce_int(limit, default=10, high=50)]


def candidates(limit=10):
    rows = _candidate_records(limit)
    if not rows:
        return "IMMUNE-CANDIDATES empty run attention-scan-persistent or no non-keep proposals"
    lines = ["IMMUNE-CANDIDATES non_destructive=true"]
    for confidence, _lti, key, rec in rows:
        action, reason, _proposal_conf = rec.get("proposal", ["review", "unknown", confidence])
        preview = rec.get("atom", "")[:180].replace("\n", " ")
        findings = ",".join(kind for kind, _conf in rec.get("findings", [])) or "none"
        lines.append(f"{key} action={action} reason={reason} confidence={confidence:.2f} sti={rec.get('sti', 0):.2f} lti={rec.get('lti', 0):.2f} vlti={rec.get('vlti', 0)} findings={findings} preview={preview}")
    return "\n".join(lines)


def review(key):
    key = str(key or "").strip().strip('"')
    rec = (_load_state().get("records") or {}).get(key)
    if not rec:
        return f"ATTENTION-REVIEW not-found hash={key}"
    action, reason, confidence = rec.get("proposal", ["keep", "unknown", 0.0])
    findings = ", ".join(f"{kind}:{conf:.2f}" for kind, conf in rec.get("findings", [])) or "none"
    evidence = ", ".join(f"{ev.get('kind')}:{ev.get('source')}={ev.get('value')}" for ev in rec.get("evidence", [])[:5]) or "none"
    return f"ATTENTION-REVIEW hash={key} space={rec.get('space')} sti={rec.get('sti'):.2f} lti={rec.get('lti'):.2f} vlti={rec.get('vlti')} proposal={action} reason={reason} confidence={float(confidence):.2f} findings={findings} evidence={evidence}\nATOM {rec.get('atom')}"


def _adjust(key, amount, reason, direction):
    key = str(key or "").strip().strip('"')
    amount = abs(_coerce_float(amount, default=0.0, high=10.0))
    state = _load_state()
    rec = (state.get("records") or {}).get(key)
    if not rec:
        return f"ATTENTION-{direction.upper()} not-found hash={key}"
    delta = amount if direction == "wage" else -amount
    rec["sti"] = max(0.0, min(10.0, float(rec.get("sti", 0.0)) + delta))
    rec["lti"] = max(0.0, min(10.0, float(rec.get("lti", 0.0)) + delta))
    rec.setdefault("uses", []).append({
        "at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "source": direction,
        "amount": amount,
        "outcome": str(reason or "manual-adjustment"),
        "confidence": 0.9,
    })
    state["records"][key] = rec
    _save_state(state)
    _render_metta(state)
    return f"ATTENTION-{direction.upper()} hash={key} amount={amount:.2f} sti={rec['sti']:.2f} lti={rec['lti']:.2f} reason={reason}"


def wage(key, amount, reason="manual-useful"):
    return _adjust(key, amount, reason, "wage")


def rent(key, amount, reason="manual-stale"):
    return _adjust(key, amount, reason, "rent")


def focus(limit=10):
    records = list((_load_state().get("records") or {}).items())
    if not records:
        return "ATTENTION-FOCUS empty run attention-scan-persistent first"
    records.sort(key=lambda item: (-(float(item[1].get("sti", 0.0)) + float(item[1].get("lti", 0.0))), item[0]))
    lines = ["ATTENTION-FOCUS"]
    for key, rec in records[:_coerce_int(limit, default=10, high=50)]:
        preview = rec.get("atom", "")[:160].replace("\n", " ")
        lines.append(f"{key} sti={rec.get('sti', 0):.2f} lti={rec.get('lti', 0):.2f} vlti={rec.get('vlti', 0)} preview={preview}")
    return "\n".join(lines)
