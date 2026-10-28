# Extracted from helper.py to keep OmegaClaw membranes reviewable.
import base64
import hashlib
import os
import pathlib
import re
import subprocess
import sys
import time

try:
    from .helper_history import _iter_history_entries, _compact_long_history_tokens
except Exception:  # pragma: no cover - direct script import fallback
    from helper_history import _iter_history_entries, _compact_long_history_tokens

CORE_ROOT = pathlib.Path(__file__).resolve().parents[1]
OMEGACLAW_ROOT = CORE_ROOT.parents[1]
MEMORY_DIR = pathlib.Path(os.environ.get("OMEGACLAW_MEMORY_DIR", CORE_ROOT / "memory"))
PROMPT_FILE = pathlib.Path(os.environ.get("OMEGACLAW_PROMPT_FILE", MEMORY_DIR / "prompt.txt"))
# The shipped base prompt. memory/prompt.txt is runtime state (git-ignored); in the default memory folder without one,
# the loop reads this default. An explicit OMEGACLAW_MEMORY_DIR or OMEGACLAW_PROMPT_FILE is used as given.
DEFAULT_PROMPT_FILE = CORE_ROOT / "src" / "base_prompt.txt"
_PROMPT_DEFAULTED = "OMEGACLAW_PROMPT_FILE" not in os.environ and "OMEGACLAW_MEMORY_DIR" not in os.environ
CONTEXT_VIEW_POLICY_RE = re.compile(
    r'\(SkillContextView\s+"?([^"\s()]+)"?\s+"?([^"\s()]+)"?\s*\)'
)
CONTEXT_POLICY_ARG_RE = re.compile(
    r'\(SkillContextPolicy\s+"?([^"\s()]+)"?\s+"?([^"\s()]+)"?\s+([^\s()]+)\s*\)'
)
DEFAULT_CONTEXT_COMPACT_THRESHOLD = 900
CONTEXT_HISTORY_COMPACT_WINDOW_BYTES = 300000


def _iter_skill_policy_files():
    patterns = [
        "src/skill_affordance*.metta",
        "modules/**/affordance.metta",
        "modules/**/skill_affordance*.metta",
    ]
    seen = set()
    for pattern in patterns:
        for path in CORE_ROOT.glob(pattern):
            if path in seen or not path.is_file():
                continue
            seen.add(path)
            yield path


def _skill_context_policies():
    """Return command-owned context view policies from skill/module metadata.

    Raw history remains exact. These declarations only control the view that is
    inserted into the next LLM context.
    """
    policies = {}
    for path in _iter_skill_policy_files():
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        for command, view in CONTEXT_VIEW_POLICY_RE.findall(text):
            policies.setdefault(command, {})["view"] = view
        for command, key, value in CONTEXT_POLICY_ARG_RE.findall(text):
            policies.setdefault(command, {})[key] = value.strip().strip('"')
    return policies


def _coerce_positive_int(value, default):
    try:
        n = int(float(str(value).strip().strip('"')))
        return n if n > 0 else default
    except Exception:
        return default


def _quoted_args_prefix(expr, max_scan=4000):
    return re.findall(r'"([^"\\]*(?:\\.[^"\\]*)*)"', expr[:max_scan])


def _compact_history_expr(head, expr, policy):
    threshold = _coerce_positive_int(policy.get("compact-threshold"), DEFAULT_CONTEXT_COMPACT_THRESHOLD)
    if len(expr) <= threshold:
        return expr
    args = _quoted_args_prefix(expr)
    label = args[0] if args else ""
    if len(label) > 120:
        label = label[:117] + "..."
    return f'({head} "{_escape_metta_string(label)}" "<context-omitted-payload chars={len(expr)} raw-history-preserved>")'


def compact_history_context_view(text):
    """Mechanically compact bulky command payloads for prompt context only."""
    policies = {
        command: policy
        for command, policy in _skill_context_policies().items()
        if policy.get("view") in {"compact-payload", "omit-large-payload"}
    }
    if not policies:
        return text
    out = []
    i = 0
    n = len(text)
    in_str = False
    esc = False
    while i < n:
        matched = False
        if not in_str and text[i] == "(":
            for head, policy in policies.items():
                prefix = "(" + head
                if not text.startswith(prefix, i):
                    continue
                after = i + len(prefix)
                if after < n and text[after] not in {" ", "\t", "\r", "\n", ")"}:
                    continue
                start = i
                depth = 0
                expr_in_str = False
                expr_esc = False
                j = i
                while j < n:
                    ch = text[j]
                    if expr_in_str:
                        if expr_esc:
                            expr_esc = False
                        elif ch == "\\":
                            expr_esc = True
                        elif ch == '"':
                            expr_in_str = False
                    else:
                        if ch == '"':
                            expr_in_str = True
                        elif ch == "(":
                            depth += 1
                        elif ch == ")":
                            depth -= 1
                            if depth == 0:
                                j += 1
                                break
                            if depth < 0:
                                break
                    j += 1
                expr = text[start:j]
                out.append(_compact_history_expr(head, expr, policy))
                i = max(j, start + 1)
                in_str = False
                esc = False
                matched = True
                break
        if not matched:
            ch = text[i]
            out.append(ch)
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            else:
                if ch == '"':
                    in_str = True
            i += 1
    return "".join(out)

def _read_text_tail(path, max_chars):
    try:
        max_chars = max(0, int(float(max_chars)))
    except Exception:
        max_chars = 0
    try:
        text = pathlib.Path(path).read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        return f"CONTEXT-READ-ERROR {type(exc).__name__}: {exc}"
    if max_chars and len(text) > max_chars:
        return text[-max_chars:]
    return text


def _read_text_tail_bytes(path, max_bytes):
    try:
        max_bytes = max(0, int(float(max_bytes)))
    except Exception:
        max_bytes = 0
    try:
        path = pathlib.Path(path)
        with path.open("rb") as handle:
            if max_bytes:
                handle.seek(0, os.SEEK_END)
                size = handle.tell()
                handle.seek(max(0, size - max_bytes), os.SEEK_SET)
            data = handle.read()
        return data.decode("utf-8", errors="replace")
    except Exception as exc:
        return f"CONTEXT-READ-ERROR {type(exc).__name__}: {exc}"

def context_prompt(max_chars=20000):
    """Read the persona prompt as text for the loop context membrane."""
    path = PROMPT_FILE
    if not path.exists() and _PROMPT_DEFAULTED:
        path = DEFAULT_PROMPT_FILE   # a fresh checkout: the shipped default stands in for memory/prompt.txt
    if not path.exists():
        return ""
    return _read_text_tail(path, max_chars)

def context_history_tail(max_chars=30000):
    """Read the history tail as text for the loop context membrane."""
    path = MEMORY_DIR / "history.metta"
    if not path.exists():
        return ""
    try:
        max_chars = max(0, int(float(max_chars)))
    except Exception:
        max_chars = 0
    window_bytes = max(CONTEXT_HISTORY_COMPACT_WINDOW_BYTES, max_chars * 8)
    text = _read_text_tail_bytes(path, window_bytes)
    if text.startswith("CONTEXT-READ-ERROR "):
        return text
    text = compact_history_context_view(text)
    if max_chars and len(text) > max_chars:
        return text[-max_chars:]
    return text


def _read_metta_string_at(text, start, limit=240):
    if start >= len(text) or text[start] != '"':
        return "", start
    out = []
    esc = False
    i = start + 1
    while i < len(text):
        ch = text[i]
        if esc:
            out.append(ch)
            esc = False
        elif ch == "\\":
            esc = True
        elif ch == '"':
            return "".join(out)[:limit], i + 1
        else:
            out.append(ch)
        i += 1
    return "".join(out)[:limit], i


def _quoted_command_args_outside_strings(text, command, limit=240):
    text = str(text or "")
    prefix = "(" + command
    args = []
    i = 0
    in_str = False
    esc = False
    while i < len(text):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            i += 1
            continue
        if ch == '"':
            in_str = True
            i += 1
            continue
        if text.startswith(prefix, i):
            after = i + len(prefix)
            if after < len(text) and text[after] in {" ", "\t", "\r", "\n"}:
                j = after
                while j < len(text) and text[j] in {" ", "\t", "\r", "\n"}:
                    j += 1
                value, end = _read_metta_string_at(text, j, limit)
                if value:
                    args.append(value)
                    i = end
                    continue
        i += 1
    return args


def _last_history_timestamp(text):
    matches = list(re.finditer(r'\("([^"\n]{10,32})"\s', str(text or "")))
    return matches[-1].group(1) if matches else ""


def _history_entries_tail(max_entries=12, filename=None):
    try:
        entries = list(_iter_history_entries(filename))
    except Exception:
        return []
    try:
        max_entries = max(1, int(float(max_entries)))
    except Exception:
        max_entries = 12
    return entries[-max_entries:]


def _entry_before_results(entry):
    text = str(entry or "")
    marker = '\n "RESULTS: "'
    idx = text.find(marker)
    if idx >= 0:
        return text[:idx]
    marker = '"RESULTS: "'
    idx = text.find(marker)
    return text[:idx] if idx >= 0 else text


def _compact_history_entry_for_context(lineno, ts, entry, max_entry_chars=2600):
    pre_results = compact_history_context_view(_entry_before_results(entry))
    pre_results = _compact_long_history_tokens(pre_results)
    result_match = re.search(r'"RESULTS: "\s+"((?:[^"\\]|\\.)*)"', str(entry or ""), re.DOTALL)
    result_status = "results=absent"
    if result_match:
        raw_result = result_match.group(1)
        result_status = f"results=present raw_result_chars={len(raw_result)}"
    body = pre_results.strip()
    if len(body) > max_entry_chars:
        body = body[: max(0, max_entry_chars - 80)].rstrip() + f" <entry-view-omitted chars={len(body)}>"
    stamp = ts.strftime("%Y-%m-%d %H:%M:%S") if hasattr(ts, "strftime") else str(ts or "unknown")
    return f"ENTRY line={lineno} time={stamp} {result_status}\n{body}"


def context_current_frame(current_input="", last_results="", max_chars=2200):
    """Return a mechanical, decision-local continuity view for the LLM prompt.

    This function must not interpret task state or choose what matters. It only
    exposes recent raw continuity signals so Omega can think over them herself.
    """
    entries = _history_entries_tail(24, MEMORY_DIR / "history.metta")
    command_regions = [_entry_before_results(entry) for _, _, entry in entries]
    command_view = "\n".join(command_regions)
    pin_args = _quoted_command_args_outside_strings(command_view, "pin", 500)
    wait_args = _quoted_command_args_outside_strings(command_view, "wait", 300)
    pin = pin_args[-1] if pin_args else ""
    wait_reason = wait_args[-1] if wait_args else ""
    timestamp = entries[-1][1].strftime("%Y-%m-%d %H:%M:%S") if entries else ""
    current_input = str(current_input or "").strip()
    if not current_input:
        input_kind = "empty"
    elif "DO NOT RE-SEND OR SPAM" in current_input:
        input_kind = "quiet-sentinel"
    else:
        input_kind = "inbound-or-runtime-input"
    result_view = context_last_results(last_results, 700)
    lines = [
        "view_kind=mechanical-continuity-signals",
        f"current_input_kind={input_kind}",
        f"current_input={current_input[:500] if current_input else '<none>'}",
        f"latest_pin={pin or '<none>'}",
        f"latest_wait_reason={wait_reason[:180] if wait_reason else '<none>'}",
        f"latest_history_time={timestamp or '<unknown>'}",
        f"last_result_tail={result_view}",
        "view_policy=no interpretation, no task selection, no semantic summary; Omega must reason from these signals",
    ]
    frame = "\n".join(lines)
    try:
        max_chars = max(0, int(float(max_chars)))
    except Exception:
        max_chars = 2200
    if max_chars and len(frame) > max_chars:
        return frame[-max_chars:]
    return frame


def context_recent_history_entries(max_chars=30000, max_entries=12):
    """Render recent history as whole top-level entries, not an arbitrary tail."""
    try:
        max_entries = max(1, int(float(max_entries)))
    except Exception:
        max_entries = 12
    try:
        all_entries = list(_iter_history_entries(MEMORY_DIR / "history.metta"))
    except Exception:
        all_entries = []
    if not all_entries:
        return context_history_tail(max_chars)
    entries = all_entries[-max_entries:]
    older_omitted_by_count = max(0, len(all_entries) - len(entries))
    try:
        max_chars = max(0, int(float(max_chars)))
    except Exception:
        max_chars = 30000
    per_entry = max(700, min(4000, max_chars // max(1, len(entries)))) if max_chars else 2600
    entry_views = [
        _compact_history_entry_for_context(lineno, ts, entry, per_entry)
        for lineno, ts, entry in entries
    ]

    dropped_for_budget = 0

    def render(shown):
        older_omitted = older_omitted_by_count + dropped_for_budget
        header = (
            "RECENT-HISTORY view_kind=whole-top-level-entries "
            f"entries_shown={len(shown)} selected_entries={len(entry_views)} "
            f"older_entries_omitted={older_omitted} max_chars={max_chars} "
            "truncation_policy=drop-oldest-whole-entry"
        )
        return header + ("\n" + "\n---\n".join(shown) if shown else "")

    shown = list(entry_views)
    rendered = render(shown)
    while max_chars and shown and len(rendered) > max_chars:
        shown.pop(0)
        dropped_for_budget += 1
        rendered = render(shown)
    return rendered

def context_last_results(results, max_chars=8000):
    """Return a bounded view of previous command results for prompt context.

    Full command results remain in the history trace.  This is only the loop
    context membrane, so large inspect/history/file results cannot recursively
    dominate the next cognition cycle.
    """
    try:
        max_chars = max(0, int(float(max_chars)))
    except Exception:
        max_chars = 8000
    text = str(results or "")
    if max_chars and len(text) > max_chars:
        # Keep the head as well as the tail: a result's identifying header (e.g. "HIVE-REVISION ar_x r1 sha256:...")
        # comes first, and a tail-only cut hid it, so a mind re-read the same revision until it timed out.
        head = min(max_chars // 3, 1500)
        tail = max_chars - head
        omitted = len(text) - max_chars
        return (
            f"RESULTS-CONTEXT-TRUNCATED original_chars={len(text)} "
            f"shown_head_chars={head} shown_tail_chars={tail} omitted_chars={omitted}\n"
            + text[:head] + f"\n...[{omitted} chars omitted]...\n" + text[-tail:]
        )
    return text

_SAFE_MEMORY_NAME = re.compile(r"^[A-Za-z0-9_-]+$")


_SAFE_MEMORY_FILE = re.compile(r"^[A-Za-z0-9_-]+\.(metta|txt|jsonl|json)$")


def memory_file(name):
    """Absolute path of a runtime memory file under the configured memory dir.

    MeTTa persistence declarations call this instead of a fixed library path,
    so each agent's OMEGACLAW_MEMORY_DIR keeps its memory separate.
    """
    name = str(name or "").strip()
    if not _SAFE_MEMORY_FILE.fullmatch(name):
        raise ValueError(f"unsafe memory file name: {name!r}")
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    path = MEMORY_DIR / name
    # append-file requires an existing file; a fresh agent's memory dir has none.
    path.touch(exist_ok=True)
    return str(path)


# Atoms that space bounding never drops: identity, pins, goals and commitments.
# Losing them silently is how a full persistent space loses who the agent is.
_PROTECTED_ATOM = re.compile(r"^\(\s*(Pin|Pinned|Protected|Identity|Persona|Goal|Commitment)\b")


def protected_atom(text):
    """True when bound-space! must keep this atom whatever the limit."""
    return bool(_PROTECTED_ATOM.match(str(text or "").strip()))


def evict_receipt(text):
    """Record an atom that bound-space! removed, so the drop can be audited or undone."""
    path = MEMORY_DIR / "evicted.metta"
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(f'(Evicted "{stamp}" {str(text).strip()})\n')
    return True


def save_begin(path):
    """Start an atomic save: an empty temp file next to ``path``."""
    tmp = f"{path}.saving"
    with open(tmp, "w", encoding="utf-8"):
        pass
    return tmp


def save_commit(tmp, path):
    """Finish an atomic save: flush the temp file to disk, then rename it over ``path``.

    A crash before the rename leaves the previous file intact, so a failed
    export can no longer leave a space empty on disk.
    """
    with open(tmp, "rb+") as handle:
        os.fsync(handle.fileno())
    os.replace(tmp, path)
    try:
        directory = os.open(os.path.dirname(os.path.abspath(path)) or ".", os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except OSError:
        pass
    return True


def ensure_runtime_memory_files(names=""):
    """Create empty ignored runtime MeTTa memory files when absent.

    Persistence policy lives in MeTTa/module declarations.  This helper is only
    the filesystem membrane: it creates requested safe filenames under the
    configured memory directory and refuses path-like names.
    """
    requested = [part.strip() for part in str(names or "").replace(",", " ").split() if part.strip()]
    created = []
    existing = []
    rejected = []
    memory_dir = MEMORY_DIR
    memory_dir.mkdir(parents=True, exist_ok=True)
    for name in requested:
        if not _SAFE_MEMORY_NAME.fullmatch(name):
            rejected.append(name)
            continue
        path = memory_dir / f"{name}.metta"
        if path.exists():
            existing.append(name)
            continue
        path.write_text("", encoding="utf-8")
        created.append(name)
    return (
        f"RUNTIME-MEMORY-FILES existing={','.join(existing)} "
        f"created={','.join(created)} rejected={','.join(rejected)}"
    )

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

def _has_unescaped_quote(text):
    escaped = False
    for ch in str(text or ""):
        if ch == '"' and not escaped:
            return True
        escaped = (ch == "\\" and not escaped)
        if ch != "\\":
            escaped = False
    return False

def _metta_expr_syntax_error(expr):
    text = str(expr or "").strip()
    if not text:
        return "empty expression"
    depth = 0
    in_quote = False
    escaped = False
    for ch in text:
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
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth < 0:
                return "too many closing parentheses"
    if in_quote:
        return "unterminated string"
    if depth > 0:
        return "missing closing parenthesis"
    return ""

def _take_balanced_metta_expr(text):
    text = str(text or "").strip()
    if not text.startswith("("):
        return "", text
    depth = 0
    in_quote = False
    escaped = False
    for idx, ch in enumerate(text):
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
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return text[:idx + 1], text[idx + 1:].strip()
            if depth < 0:
                return "", text
    return "", text

DEFAULT_KNOWN_SPACES = {"persistent", "agenda", "beliefs", "world", "events", "activity", "cleanup", "assume", "attention"}


def _split_collapsed_space_transform_args(spec, known_spaces=None):
    text = str(spec or "").strip()
    if not _has_unescaped_quote(text):
        text = re.sub(r'\\+"', '"', text)
    if not text:
        return []
    known_spaces = set(known_spaces or DEFAULT_KNOWN_SPACES)
    source_match = re.match(r"^([A-Za-z_-]+)\s+", text)
    if not source_match:
        return []
    source = source_match.group(1)
    if source not in known_spaces:
        return []
    rest = text[source_match.end():].strip()
    pattern, rest = _take_balanced_metta_expr(rest)
    if not pattern or _metta_expr_syntax_error(pattern):
        return []
    target_match = re.match(r"^([A-Za-z_-]+)\s+", rest)
    if not target_match:
        return []
    target = target_match.group(1)
    if target not in known_spaces:
        return []
    rest = rest[target_match.end():].strip()
    replacement, reason = _take_balanced_metta_expr(rest)
    if not replacement or _metta_expr_syntax_error(replacement):
        return []
    reason = reason.strip()
    if not reason:
        return []
    return [source, pattern, target, replacement, reason]

def _split_with_confidence(spec, minimum_parts):
    parts = str(spec or "").strip().split()
    if len(parts) < minimum_parts:
        return None
    confidence = parts[-1]
    return parts, confidence

def persistent_fact_atom(spec):
    parsed = _split_with_confidence(spec, 4)
    if not parsed:
        return '(PersistentFactError "expected: subject relation object confidence")'
    parts, confidence = parsed
    if _numeric_text(confidence) is None:
        return '(PersistentFactError "expected: subject relation object confidence; confidence must be numeric")'
    subject = parts[0]
    relation = parts[1]
    obj = " ".join(parts[2:-1])
    return f"(PersistentFact {_metta_string(subject)} {_metta_string(relation)} {_metta_string(obj)} {_metta_string(confidence)})"

def persistent_note_atom(spec):
    parsed = _split_with_confidence(spec, 3)
    if not parsed:
        return '(PersistentNoteError "expected: topic note confidence")'
    parts, confidence = parsed
    if _numeric_text(confidence) is None:
        return '(PersistentNoteError "expected: topic note confidence; confidence must be numeric")'
    topic = parts[0]
    note = " ".join(parts[1:-1])
    return f"(PersistentNote {_metta_string(topic)} {_metta_string(note)} {_metta_string(confidence)})"

def persistent_rule_atom(spec):
    text = str(spec or "").strip()
    parts = [part.strip() for part in text.split("|")]
    if len(parts) == 4 and all(parts):
        premise, relation, conclusion, confidence = parts
    else:
        parsed = _split_with_confidence(text, 4)
        if not parsed:
            return '(PersistentRuleError "expected: premise | relation | conclusion | confidence")'
        raw_parts, confidence = parsed
        premise = raw_parts[0]
        relation = raw_parts[1]
        conclusion = " ".join(raw_parts[2:-1])
    if _numeric_text(confidence) is None:
        return '(PersistentRuleError "expected: premise | relation | conclusion | confidence; confidence must be numeric")'
    return f"(PersistentRule {_metta_string(premise)} {_metta_string(relation)} {_metta_string(conclusion)} {_metta_string(confidence)})"

def world_fact_atom(spec):
    parsed = _split_with_confidence(spec, 4)
    if not parsed:
        return '(WorldFactError "expected: subject relation object confidence")'
    parts, confidence = parsed
    if _numeric_text(confidence) is None:
        return '(WorldFactError "expected: subject relation object confidence; confidence must be numeric")'
    subject = parts[0]
    relation = parts[1]
    obj = " ".join(parts[2:-1])
    return f"(Relation {_metta_string(subject)} {_metta_string(relation)} {_metta_string(obj)} {_metta_string(confidence)} \"omega\")"


def belief_claim_atom(spec):
    parts = str(spec or "").strip().split()
    if len(parts) < 5:
        return '(BeliefClaimError "expected: domain relation value frequency confidence")'
    domain = parts[0]
    relation = parts[1]
    frequency = parts[-2]
    confidence = parts[-1]
    if _numeric_text(frequency) is None or _numeric_text(confidence) is None:
        return '(BeliefClaimError "expected: domain relation value frequency confidence; frequency and confidence must be numeric")'
    value = " ".join(parts[2:-2])
    return f"(Belief {_metta_string(domain)} {_metta_string(relation)} {_metta_string(value)} (stv {frequency} {confidence}) \"omega\")"


def agenda_goal_atom(spec):
    parts = str(spec or "").strip().split()
    if len(parts) < 4:
        return '(AgendaGoalError "expected: name status priority next")'
    name = parts[0]
    status = parts[1]
    priority = parts[2]
    next_step = " ".join(parts[3:])
    allowed_status = {"active", "waiting", "blocked", "scheduled", "dormant"}
    allowed_priority = {"low", "medium", "high"}
    if status not in allowed_status:
        return f'(AgendaGoalError {_metta_string("status must be active, waiting, blocked, scheduled, or dormant")})'
    if priority not in allowed_priority:
        return f'(AgendaGoalError {_metta_string("priority must be low, medium, or high")})'
    return f"(Goal {_metta_string(name)} {status} {priority} {_metta_string(next_step)})"

def agenda_goal_name(spec):
    parts = str(spec or "").strip().split()
    if len(parts) < 4:
        return ""
    status = parts[1]
    allowed = {"active", "waiting", "blocked", "scheduled", "dormant"}
    if status not in allowed:
        return ""
    return parts[0]

def agenda_goal_name_atom(spec):
    name = agenda_goal_name(spec)
    return _metta_string(name)


def event_note_atom(spec):
    parsed = _split_with_confidence(spec, 4)
    if not parsed:
        return '(EventNoteError "expected: source kind summary confidence")'
    parts, confidence = parsed
    if _numeric_text(confidence) is None:
        return '(EventNoteError "expected: source kind summary confidence; confidence must be numeric")'
    source = parts[0]
    kind = parts[1]
    summary = " ".join(parts[2:-1])
    return f"(Event {_metta_string(source)} {_metta_string(kind)} {_metta_string(summary)} {_metta_string(confidence)})"


def cleanup_candidate_id(expr):
    text = str(expr or "").strip()
    digest = hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:16]
    return f"pc-{digest}"


def cleanup_proposal_id(candidate_id, action, reason=""):
    text = "|".join([str(candidate_id or "").strip(), str(action or "").strip(), str(reason or "").strip()])
    digest = hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:16]
    return f"pp-{digest}"


def cleanup_preview(expr, limit=140):
    text = " ".join(str(expr or "").strip().split())
    try:
        limit = int(limit)
    except Exception:
        limit = 140
    limit = max(40, min(limit, 400))
    if len(text) > limit:
        return text[: limit - 3] + "..."
    return text


def _pipe_parts(spec):
    return [part.strip() for part in str(spec or "").strip().split("|")]


def _source_trace(source, trace):
    source = str(source or "").strip()
    trace = str(trace or "").strip()
    return f"{source}:{trace}" if trace else source


def _numeric_text(value):
    text = str(value or "").strip()
    try:
        float(text)
    except Exception:
        return None
    return text


_METTA_SYMBOL_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")


def _config_override(name):
    key = str(name or "").strip()
    if not key:
        return None
    prefix = key + "="
    for arg in sys.argv[1:]:
        text = str(arg)
        if text.startswith(prefix):
            return text[len(prefix):]
    return os.environ.get(key)


def _config_value_expr(value):
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, float):
        return str(value)

    text = str(value or "").strip()
    if not text:
        return '""'
    if _numeric_text(text) is not None:
        return text
    if text.lower() == "true":
        return "True"
    if text.lower() == "false":
        return "False"
    if _METTA_SYMBOL_RE.match(text):
        return text
    return _metta_string(text)


def config_assignment_atom(name, default):
    """Build the MeTTa assignment used by `(configure name default)`.

    The lookup is deliberately mechanical: command-line `name=value` first,
    then environment variable `name`, then the MeTTa default supplied by the
    caller. Keeping this in Python avoids PeTTa specialization warnings for
    dynamic env/argv predicates while preserving the symbolic configure atom.
    """
    key = str(name or "").strip()
    if not _METTA_SYMBOL_RE.match(key):
        safe = _escape_metta_string(key or "<empty>")
        return f'(ConfigError "invalid configure key: {safe}")'
    override = _config_override(key)
    value = default if override is None else override
    return f"(= ({key}) {_config_value_expr(value)})"


def assimilation_event_atom(spec):
    parts = _pipe_parts(spec)
    if len(parts) < 5 or not all(parts[:3]) or not parts[-1]:
        return '(AssimilationEventError "expected: source | trace_id | kind | summary | confidence")'
    confidence = parts[-1]
    if _numeric_text(confidence) is None:
        return '(AssimilationEventError "expected: source | trace_id | kind | summary | confidence; confidence must be numeric")'
    source, trace, kind = parts[:3]
    summary = " | ".join(parts[3:-1]).strip()
    if not summary:
        return '(AssimilationEventError "summary cannot be empty")'
    return f"(ObservationEvent {_metta_string(source)} {_metta_string(trace)} {_metta_string(kind)} {_metta_string(summary)} {_metta_string(confidence)})"


def assimilation_world_atom(spec):
    parts = _pipe_parts(spec)
    if len(parts) < 6 or not all(parts[:4]) or not parts[-1]:
        return '(AssimilationWorldError "expected: source | trace_id | subject | relation | object | confidence")'
    confidence = parts[-1]
    if _numeric_text(confidence) is None:
        return '(AssimilationWorldError "expected: source | trace_id | subject | relation | object | confidence; confidence must be numeric")'
    source, trace, subject, relation = parts[:4]
    obj = " | ".join(parts[4:-1]).strip()
    if not obj:
        return '(AssimilationWorldError "object cannot be empty")'
    return f"(Relation {_metta_string(subject)} {_metta_string(relation)} {_metta_string(obj)} {_metta_string(confidence)} {_metta_string(_source_trace(source, trace))})"


def assimilation_belief_atom(spec):
    parts = _pipe_parts(spec)
    if len(parts) < 7 or not all(parts[:4]) or not parts[-2] or not parts[-1]:
        return '(AssimilationBeliefError "expected: source | trace_id | domain | relation | value | frequency | confidence")'
    source, trace, domain, relation = parts[:4]
    frequency = _numeric_text(parts[-2])
    confidence = _numeric_text(parts[-1])
    value = " | ".join(parts[4:-2]).strip()
    if not value:
        return '(AssimilationBeliefError "value cannot be empty")'
    if frequency is None or confidence is None:
        return '(AssimilationBeliefError "frequency and confidence must be numeric")'
    return f"(Belief {_metta_string(domain)} {_metta_string(relation)} {_metta_string(value)} (stv {frequency} {confidence}) {_metta_string(_source_trace(source, trace))})"


def assimilation_persistent_atom(spec):
    parts = _pipe_parts(spec)
    if len(parts) < 5 or not all(parts[:3]) or not parts[-1]:
        return '(AssimilationPersistentError "expected: source | trace_id | topic | note | confidence")'
    confidence = parts[-1]
    if _numeric_text(confidence) is None:
        return '(AssimilationPersistentError "expected: source | trace_id | topic | note | confidence; confidence must be numeric")'
    source, trace, topic = parts[:3]
    note = " | ".join(parts[3:-1]).strip()
    if not note:
        return '(AssimilationPersistentError "note cannot be empty")'
    return f"(PersistentObservation {_metta_string(source)} {_metta_string(trace)} {_metta_string(topic)} {_metta_string(note)} {_metta_string(confidence)})"


def space_transform_spec_atom(spec):
    parts = _pipe_parts(spec)
    if len(parts) != 5 or not all(parts):
        return '(SpaceTransformSpecError "expected: source_space | pattern_expression | target_space | replacement_expression | reason")'
    source, pattern, target, replacement, reason = parts
    pattern_error = _metta_expr_syntax_error(pattern)
    if pattern_error:
        return f'(SpaceTransformSpecError "bad pattern expression: {pattern_error}")'
    replacement_error = _metta_expr_syntax_error(replacement)
    if replacement_error:
        return f'(SpaceTransformSpecError "bad replacement expression: {replacement_error}")'
    return (
        f"(SpaceTransformSpec {_metta_string(source)} {_metta_string(pattern)} "
        f"{_metta_string(target)} {_metta_string(replacement)} {_metta_string(reason)})"
    )


def test_metta_expression(expr):
    text = str(expr or "").strip()
    if not text:
        return "METTA-SYNTAX-ERROR empty expression"
    if not (text.startswith("(") and text.endswith(")")):
        return "METTA-SYNTAX-ERROR expression should be one complete parenthesized MeTTa expression"
    depth = 0
    in_quote = False
    escaped = False
    for index, ch in enumerate(text):
        if ch == '"' and not escaped:
            in_quote = not in_quote
        elif not in_quote:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth < 0:
                    return f"METTA-SYNTAX-ERROR extra closing parenthesis near offset {index}"
        escaped = (ch == "\\" and not escaped)
        if ch != "\\":
            escaped = False
    if in_quote:
        return "METTA-SYNTAX-ERROR unterminated quote"
    if depth != 0:
        return "METTA-SYNTAX-ERROR unbalanced parentheses"
    return "METTA-SYNTAX-OK"

def persistent_expression_atom(expr):
    text = str(expr or "").strip()
    if not text:
        return '(PersistentExpressionError "empty expression")'
    if not text.startswith("("):
        text = "(" + text + ")"
    elif not text.endswith(")"):
        text = text + ")"
    status = test_metta_expression(text)
    if status != "METTA-SYNTAX-OK":
        return f'(PersistentExpressionError {_metta_string(status)})'
    return text

def run_metta_file(path, timeout_seconds=20, max_chars=12000):
    raw = str(path or "").strip().strip('"')
    if not raw:
        return "RUN-METTA-FILE-ERROR empty filepath"
    raw_is_tmp = raw == "/tmp" or raw.startswith("/tmp/")
    candidate = pathlib.Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = (OMEGACLAW_ROOT / candidate).resolve()
    else:
        candidate = candidate.resolve()
    try:
        candidate.relative_to(OMEGACLAW_ROOT)
    except ValueError:
        if not raw_is_tmp:
            return f"RUN-METTA-FILE-ERROR path outside OmegaClaw or /tmp: {candidate}"
    if candidate.suffix != ".metta":
        return f"RUN-METTA-FILE-ERROR expected .metta file: {candidate}"
    if not candidate.exists():
        return f"RUN-METTA-FILE-ERROR file not found: {candidate}"
    env = os.environ.copy()
    env["OMEGACLAW_RUN_INNER"] = "1"
    try:
        proc = subprocess.run(
            ["./run.sh", str(candidate)],
            cwd=str(OMEGACLAW_ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            timeout=int(timeout_seconds),
        )
        output = proc.stdout or ""
        if len(output) > int(max_chars):
            output = output[-int(max_chars):]
            output = "[output truncated to tail]\n" + output
        return f"RUN-METTA-FILE-EXIT {proc.returncode}\n{output}"
    except subprocess.TimeoutExpired as exc:
        output = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
        if len(output) > int(max_chars):
            output = output[-int(max_chars):]
        return f"RUN-METTA-FILE-TIMEOUT after {timeout_seconds}s\n{output}"
    except Exception as exc:
        return f"RUN-METTA-FILE-ERROR {type(exc).__name__}: {exc}"

def _safe_writable_path(raw):
    raw = str(raw or "").strip().strip('"')
    if not raw:
        return None, "empty filepath"
    raw_is_tmp = raw == "/tmp" or raw.startswith("/tmp/")
    candidate = pathlib.Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = (OMEGACLAW_ROOT / candidate).resolve()
    else:
        candidate = candidate.resolve()
    try:
        candidate.relative_to(OMEGACLAW_ROOT)
    except ValueError:
        if not raw_is_tmp:
            return None, f"path outside OmegaClaw or /tmp: {candidate}"
    return candidate, None

def write_file_base64(path, payload):
    target, error = _safe_writable_path(path)
    if error:
        return f"WRITE-FILE-BASE64-ERROR {error}"
    text = str(payload or "").strip().replace(" ", "").replace("\n", "")
    if not text:
        return "WRITE-FILE-BASE64-ERROR empty payload"
    try:
        data = base64.b64decode(text, validate=True)
    except Exception as exc:
        return f"WRITE-FILE-BASE64-ERROR invalid base64: {exc}"
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + f".tmp-{os.getpid()}")
        tmp.write_bytes(data)
        os.replace(tmp, target)
        return f"WRITE-FILE-BASE64-SUCCESS path={target} bytes={len(data)}"
    except Exception as exc:
        return f"WRITE-FILE-BASE64-ERROR {type(exc).__name__}: {exc}"

def append_file_base64(path, payload):
    target, error = _safe_writable_path(path)
    if error:
        return f"APPEND-FILE-BASE64-ERROR {error}"
    text = str(payload or "").strip().replace(" ", "").replace("\n", "")
    if not text:
        return "APPEND-FILE-BASE64-ERROR empty payload"
    try:
        data = base64.b64decode(text, validate=True)
    except Exception as exc:
        return f"APPEND-FILE-BASE64-ERROR invalid base64: {exc}"
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("ab") as f:
            f.write(data)
        return f"APPEND-FILE-BASE64-SUCCESS path={target} bytes={len(data)}"
    except Exception as exc:
        return f"APPEND-FILE-BASE64-ERROR {type(exc).__name__}: {exc}"

def normalize_string(x):
    try:
        if isinstance(x, bytes):
            return x.decode("utf-8", errors="ignore")
        return str(x).encode("utf-8", errors="ignore").decode("utf-8", errors="ignore")
    except Exception:
        return str(x)
