#!/usr/bin/env python3
"""Replay recent agent command shapes through the current and signature parsers."""

import pathlib
import sys
from collections import Counter


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import helper_command_parser as parser  # noqa: E402
import helper_metta_syntax as metta  # noqa: E402


def iter_top_level_forms(text):
    start = None
    depth = 0
    in_quote = False
    escaped = False
    for index, ch in enumerate(text):
        if in_quote:
            if ch == '"' and not escaped:
                in_quote = False
            escaped = ch == "\\" and not escaped
            if ch != "\\":
                escaped = False
            continue
        if ch == '"':
            in_quote = True
        elif ch == "(":
            if depth == 0:
                start = index
            depth += 1
        elif ch == ")":
            if depth:
                depth -= 1
            if depth == 0 and start is not None:
                yield text[start : index + 1]
                start = None


def top_level_children(expr):
    inner = expr.strip()[1:-1].strip()
    return list(iter_top_level_forms(inner))


def history_command_forms(text, recent_entries=2000):
    """Yield only direct command forms recorded as a cycle output.

    Old history contains provider prose, syntax-error atoms, and raw nested
    MeTTa examples. Replaying every nested S-expression creates false
    failures, so this fixture only inspects the direct command list stored in
    each top-level history entry: ("timestamp" ... ((cmd ...) ...)).
    """
    entries = list(iter_top_level_forms(text))
    if recent_entries and recent_entries > 0:
        entries = entries[-recent_entries:]
    skipped_rejected = 0
    for index, entry in enumerate(entries):
        if "ERROR_FEEDBACK:" in entry:
            continue
        next_entry = entries[index + 1] if index + 1 < len(entries) else ""
        if "ERROR_FEEDBACK:" in next_entry:
            skipped_rejected += 1
            continue
        for child in top_level_children(entry):
            grandchildren = top_level_children(child)
            if grandchildren:
                for command in grandchildren:
                    if command_head(command) in parser.SIGNATURE_COMMANDS:
                        yield command
            elif command_head(child) in parser.SIGNATURE_COMMANDS:
                yield child
    history_command_forms.skipped_rejected = skipped_rejected


def consume_token(text):
    text = text.strip()
    if not text:
        return "", ""
    if text.startswith('"'):
        out = []
        escaped = False
        for index in range(1, len(text)):
            ch = text[index]
            if ch == '"' and not escaped:
                return "".join(out), text[index + 1 :].strip()
            if ch == "\\" and not escaped:
                escaped = True
                continue
            out.append(ch)
            escaped = False
        return "".join(out), ""
    parts = text.split(maxsplit=1)
    return parts[0], parts[1].strip() if len(parts) > 1 else ""


def quote_arg(text):
    return '"' + str(text).replace("\\", "\\\\").replace('"', '\\"') + '"'


def command_head(expr):
    inner = expr.strip()[1:-1].strip()
    head, _ = consume_token(inner)
    return head


def sexpr_to_command_line(expr):
    inner = expr.strip()[1:-1].strip()
    head, rest = consume_token(inner)
    if head not in parser.SIGNATURE_COMMANDS:
        return None
    args = []
    while rest:
        token, rest = consume_token(rest)
        if token:
            args.append(quote_arg(token))
    return " ".join([head, *args])


def main():
    history = ROOT / "memory" / "history.metta"
    recent_entries = 2000
    if len(sys.argv) > 1:
        history = pathlib.Path(sys.argv[1])
    if len(sys.argv) > 2:
        recent_entries = int(sys.argv[2])
    if not history.exists():
        print(f"history={history}")
        print("SKIP live history replay: history file is not present in this checkout")
        return
    text = history.read_text(encoding="utf-8", errors="replace")
    seen = []
    for expr in history_command_forms(text, recent_entries=recent_entries):
        raw = sexpr_to_command_line(expr)
        if raw:
            seen.append((expr, raw))
    skipped_rejected = getattr(history_command_forms, "skipped_rejected", 0)

    failures = []
    deltas = []
    for expr, raw in seen:
        try:
            current = parser.balance_parentheses(raw)
        except Exception as exc:
            failures.append(("current-exception", raw, repr(exc)))
            continue
        try:
            signature = parser.signature_balance_parentheses(raw)
        except Exception as exc:
            failures.append(("signature-exception", raw, repr(exc)))
            continue
        if "(syntax-error " in signature:
            failures.append(("signature-syntax-error", raw, signature))
            continue
        status = metta.test_metta_expression(signature)
        if status != "METTA-SYNTAX-OK":
            failures.append(("signature-metta-invalid", raw, status))
            continue
        if current != signature:
            deltas.append((raw, current, signature))

    unique_heads = sorted({raw.split(maxsplit=1)[0] for _, raw in seen})
    failure_heads = Counter(raw.split(maxsplit=1)[0] for _, raw, _ in failures)
    delta_heads = Counter(raw.split(maxsplit=1)[0] for raw, _, _ in deltas)
    print(f"history={history}")
    print(f"recent_entries={recent_entries if recent_entries else 'all'}")
    print(f"commands_seen={len(seen)}")
    print(f"rejected_cycles_skipped={skipped_rejected}")
    print(f"unique_heads={len(unique_heads)} {', '.join(unique_heads)}")
    print(f"failures={len(failures)}")
    if failures:
        print(
            "failure_heads="
            + ", ".join(f"{head}:{count}" for head, count in failure_heads.most_common(20))
        )
        first_by_head = {}
        for kind, raw, detail in failures:
            first_by_head.setdefault(raw.split(maxsplit=1)[0], (kind, raw, detail))
        for head, (kind, raw, detail) in sorted(first_by_head.items())[:40]:
            print(f"FAIL_SAMPLE {head} {kind}: {raw}\n  {detail}")
    for kind, raw, detail in failures[:20]:
        print(f"FAIL {kind}: {raw}\n  {detail}")
    print(f"deltas={len(deltas)}")
    if deltas:
        print(
            "delta_heads="
            + ", ".join(f"{head}:{count}" for head, count in delta_heads.most_common(20))
        )
    for raw, current, signature in deltas[:20]:
        print(f"DELTA raw={raw}\n  current={current}\n  signature={signature}")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
