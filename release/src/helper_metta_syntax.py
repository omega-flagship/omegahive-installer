# Small MeTTa/string utility membrane for command parsing.
#
# Keep this file narrow. It exists so the syntax command membrane can be
# reviewed without pulling in runtime memory, reboot, promotion, or provider
# helper code.

import base64
import pathlib
import re


CORE_ROOT = pathlib.Path(__file__).resolve().parents[1]
OMEGACLAW_ROOT = CORE_ROOT.parents[1]


def _escape_metta_string(text):
    text = str(text or "")
    if not text:
        return ""
    has_backslash = "\\" in text
    has_quote = '"' in text
    has_newline = "\n" in text
    has_return = "\r" in text
    has_tab = "\t" in text
    if (
        not has_backslash
        and not has_quote
        and not has_newline
        and not has_return
        and not has_tab
        and text.isprintable()
    ):
        return text
    if text.isprintable() and not has_newline and not has_return and not has_tab:
        if has_backslash:
            text = text.replace("\\", "\\\\")
        if has_quote:
            text = text.replace('"', '\\"')
        return text
    escaped = []
    for ch in text:
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
    if '"' not in str(text or ""):
        return False
    escaped = False
    for ch in str(text or ""):
        if ch == '"' and not escaped:
            return True
        escaped = ch == "\\" and not escaped
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
            escaped = ch == "\\" and not escaped
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
        return "unbalanced parentheses"
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
            escaped = ch == "\\" and not escaped
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
                return text[: idx + 1], text[idx + 1 :].strip()
            if depth < 0:
                return "", text
    return "", text


DEFAULT_KNOWN_SPACES = {"persistent", "agenda", "beliefs", "world", "events", "activity", "assume", "attention"}


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
    rest = text[source_match.end() :].strip()
    pattern, rest = _take_balanced_metta_expr(rest)
    if not pattern or _metta_expr_syntax_error(pattern):
        return []
    target_match = re.match(r"^([A-Za-z_-]+)\s+", rest)
    if not target_match:
        return []
    target = target_match.group(1)
    if target not in known_spaces:
        return []
    rest = rest[target_match.end() :].strip()
    replacement, reason = _take_balanced_metta_expr(rest)
    if not replacement or _metta_expr_syntax_error(replacement):
        return []
    reason = reason.strip()
    if not reason:
        return []
    return [source, pattern, target, replacement, reason]


def _pipe_parts(spec):
    return [part.strip() for part in str(spec or "").split("|")]


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
        escaped = ch == "\\" and not escaped
        if ch != "\\":
            escaped = False
    if in_quote:
        return "METTA-SYNTAX-ERROR unterminated quote"
    if depth != 0:
        return "METTA-SYNTAX-ERROR unbalanced parentheses"
    return "METTA-SYNTAX-OK"


def _safe_writable_path(raw):
    path = pathlib.Path(str(raw or "").strip()).expanduser()
    if not path.is_absolute():
        path = CORE_ROOT / path
    try:
        resolved = path.resolve()
    except Exception:
        resolved = path.absolute()
    allowed_roots = [
        CORE_ROOT.resolve(),
        pathlib.Path("/tmp").resolve(),
        (CORE_ROOT / "memory").resolve(),
    ]
    if not any(resolved == root or root in resolved.parents for root in allowed_roots):
        raise ValueError(f"path outside allowed writable roots: {resolved}")
    return resolved


def write_file_base64(path, payload):
    try:
        target = _safe_writable_path(path)
        data = base64.b64decode(str(payload or "").encode("ascii"), validate=True)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return f"WRITE-FILE-BASE64-SUCCESS {target}"
    except Exception as exc:
        detail = "invalid base64" if "base64" in str(exc).lower() else str(exc)
        return f"WRITE-FILE-BASE64-ERROR {detail}"


def append_file_base64(path, payload):
    try:
        target = _safe_writable_path(path)
        data = base64.b64decode(str(payload or "").encode("ascii"), validate=True)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("ab") as handle:
            handle.write(data)
        return f"APPEND-FILE-BASE64-SUCCESS {target}"
    except Exception as exc:
        detail = "invalid base64" if "base64" in str(exc).lower() else str(exc)
        return f"APPEND-FILE-BASE64-ERROR {detail}"
