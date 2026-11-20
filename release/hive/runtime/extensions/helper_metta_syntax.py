# Small MeTTa/string utility membrane for command parsing.
#
# Keep this file narrow. It exists so the syntax command membrane can be
# reviewed without pulling in runtime memory, reboot, promotion, or provider
# helper code.

import base64
import pathlib
import re


CORE_ROOT = pathlib.Path(__file__).resolve().parents[3]
OMEGACLAW_ROOT = CORE_ROOT.parents[1]

# A marker-ended body, as a shell heredoc whose marker is quoted: <<'NAME' ends a command's line, and every line after
# it is the body, word for word, up to the first line that is NAME (surrounding spaces aside). Nothing in the body is
# read as syntax, so a whole file can be one argument: triple quotes, an unbalanced quote or bracket included, which a
# """ block ends on or loses. Example: hive-goal-file g_1 app.js <<'EOF_app_js' ... EOF_app_js.
# Only a command whose last argument can span lines takes one, and the parser refuses a body no line closes and one
# a later line closes again, which means one of its own lines was NAME (helper_command_parser._signature_parse_one).
_HEREDOC_OPEN = re.compile(r"<<'([A-Za-z_][A-Za-z0-9_.-]*)'[ \t]*(?:\n|$)")


def _heredoc_end(text, start, name):
    """Where a marker-ended body starting at `start` ends: just past its closing line, the first line that is `name`;
    None when no line closes it. Time: one pass over the body's lines."""
    pos = start
    while True:
        nl = text.find("\n", pos)
        line = text[pos:] if nl < 0 else text[pos:nl]
        if line.strip() == name:
            return len(text) if nl < 0 else nl + 1
        if nl < 0:
            return None
        pos = nl + 1


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
        else:
            # Any other character, a control character included, is written as itself: PeTTa's string reader decodes
            # only \n, \t and \r and reads any other escaped character as that character, so "\x01" came back as
            # the text x01 and "\f" as f, while a raw character reaches py-call unchanged (NUL, ESC and U+2028 too).
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


def _metta_expr_syntax_error(expr, *, allow_triple=False):
    text = str(expr or "").strip()
    if not text:
        return "empty expression"
    depth, quote, escaped, i = 0, None, False, 0
    while i < len(text):
        ch = text[i]
        if quote == "triple":
            if text.startswith('"""', i) and not escaped:
                quote = None
                i += 3
                continue
        elif quote == "double":
            if ch == '"' and not escaped:
                quote = None
        elif allow_triple and text.startswith('"""', i):
            quote = "triple"
            i += 3
            continue
        elif allow_triple and text.startswith("<<'", i) and _HEREDOC_OPEN.match(text, i):
            opened = _HEREDOC_OPEN.match(text, i)
            end = _heredoc_end(text, opened.end(), opened.group(1))
            if end is None:
                return "unterminated heredoc " + opened.group(1)
            i = end
            continue
        elif ch == '"':
            quote = "double"
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth < 0:
                return "too many closing parentheses"
        escaped = ch == "\\" and not escaped if quote else False
        i += 1
    if quote is not None:
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
