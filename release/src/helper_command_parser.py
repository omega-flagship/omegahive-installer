# Extracted from helper.py to keep command membranes reviewable.
import base64
import os
import pathlib
import re

try:
    from .helper_metta_syntax import (
        CORE_ROOT,
        _has_unescaped_quote,
        _metta_expr_syntax_error,
        _metta_string,
        test_metta_expression,
    )
except Exception:
    from helper_metta_syntax import (
        CORE_ROOT,
        _has_unescaped_quote,
        _metta_expr_syntax_error,
        _metta_string,
        test_metta_expression,
    )

class SignatureParseError(Exception):
    pass


SIGNATURE_BOOTSTRAP_SPACES = set()
SIGNATURE_KNOWN_SPACES = set(SIGNATURE_BOOTSTRAP_SPACES)
SIGNATURE_NO_ACTION_HEADS = set()


SIGNATURE_MULTILINE_LOWERING = {}
SIGNATURE_PROSE_FALLBACK = ""
SIGNATURE_SHORTHANDS = {}
SIGNATURE_RECOVERY_HINTS = {}
SIGNATURE_SKILL_CARDS = {}


SIGNATURE_ARG_TYPES = {
    "base64",
    "filepath",
    "jid",
    "metta",
    "metta-raw",
    "multiline",
    "number",
    "optional-number",
    "optional-rest-text",
    "pipe-fields",
    "base64-utf8",
    "pipe-spec",
    "rest-text",
    "shell-command",
    "space",
    "text",
}


def _signature_known_spaces_hint():
    spaces = " ".join(sorted(SIGNATURE_KNOWN_SPACES))
    return spaces or "none"


def _signature_space_error(token):
    token = str(token or "")
    hint = f"unknown space {token}; known spaces: {_signature_known_spaces_hint()}"
    if token.startswith("&"):
        hint += "; use registered space names in skill commands, not raw &handles"
        stripped = token[1:]
        if stripped in SIGNATURE_KNOWN_SPACES:
            hint += f"; try {stripped}"
    return hint


# The command surface is canonical in src/skill_signatures.metta.
# Python is only the syntax/typing membrane that reads those atoms and lowers
# natural command text into safe MeTTa calls. No skill names should be added
# here; add or remove (SkillSignature ...) atoms instead.
SIGNATURE_BOOTSTRAP_COMMANDS = {}


SIGNATURE_DECLARATIONS_PATH = CORE_ROOT / "src" / "skill_signatures.metta"
SIGNATURE_DECLARATIONS_GLOB = "skill_signatures*.metta"
SKILL_CATALOG_DECLARATIONS_PATH = CORE_ROOT / "src" / "skill_catalog.metta"
SKILL_CATALOG_DECLARATIONS_GLOB = "skill_catalog*.metta"
SKILL_AFFORDANCE_DECLARATIONS_PATH = CORE_ROOT / "src" / "skill_affordance_affordance.metta"
SKILL_AFFORDANCE_DECLARATIONS_GLOB = "skill_affordance*.metta"
MODULE_DECLARATIONS_ROOT = CORE_ROOT / "modules"
MODULE_LOADER_PATH = MODULE_DECLARATIONS_ROOT / "loader.metta"


DECLARATION_ORDER = {
    "": 0,
    "core": 1,
    "memory": 2,
    "reasoning": 3,
    "energy": 4,
    "attention": 5,
    "assume": 6,
    "channels": 7,
    "body": 8,
    "web": 9,
}


def _enabled_module_names(loader_path=MODULE_LOADER_PATH):
    loader = pathlib.Path(loader_path)
    if not loader.exists():
        return []
    names = []
    seen = set()
    pattern = re.compile(r"\./modules/([A-Za-z0-9_.-]+)/entry\.metta")
    for raw in loader.read_text(encoding="utf-8").splitlines():
        line = _strip_signature_comment(raw)
        match = pattern.search(line)
        if not match:
            continue
        name = match.group(1)
        if name not in seen:
            seen.add(name)
            names.append(name)
    return names


def _extra_module_names(modules_root=None):
    """Modules a host loads into this one mind beyond its loader (OMEGACLAW_EXTRA_MODULES, comma-separated directory names;
    the hive sets it to hive_studio while Studio sessions are on, J3 host R6.1). Unset, nothing changes. Only plain names
    of module directories that have an entry.metta count."""
    raw = os.environ.get("OMEGACLAW_EXTRA_MODULES", "").strip()
    if not raw:
        return []
    root = pathlib.Path(modules_root or MODULE_DECLARATIONS_ROOT)
    names = []
    for name in (part.strip() for part in raw.split(",")):
        if re.fullmatch(r"[A-Za-z0-9_]+", name or "") and (root / name / "entry.metta").exists() and name not in names:
            names.append(name)
    return names


def _active_module_loader_paths(declaration_root=CORE_ROOT):
    root = pathlib.Path(declaration_root)
    if root != CORE_ROOT:
        local_loader = root / "modules" / "loader.metta"
        return [local_loader] if local_loader.exists() else []
    if pathlib.Path(MODULE_DECLARATIONS_ROOT) != CORE_ROOT / "modules":
        local_loader = pathlib.Path(MODULE_DECLARATIONS_ROOT) / "loader.metta"
        return [local_loader] if local_loader.exists() else []
    env_loader = os.environ.get("OMEGACLAW_MODULE_LOADER", "").strip()
    if env_loader:
        path = pathlib.Path(env_loader).expanduser()
        if path.exists():
            return [path]
    return [MODULE_LOADER_PATH]


def _module_declaration_paths(filename, declaration_root=CORE_ROOT):
    root = pathlib.Path(declaration_root)
    modules_root = root / "modules" if root != CORE_ROOT else pathlib.Path(MODULE_DECLARATIONS_ROOT)
    if not modules_root.exists():
        return []
    paths = []
    seen = set()
    names = [name for loader in _active_module_loader_paths(root) for name in _enabled_module_names(loader)]
    if root == CORE_ROOT:
        names += _extra_module_names(modules_root)
    for name in names:
        if name in seen:
            continue
        seen.add(name)
        path = modules_root / name / filename
        if path.exists():
            paths.append(path)
    if root == CORE_ROOT and os.environ.get('OMEGACLAW_EXTRA_LOADER') and filename in ('signatures.metta','affordance.metta'):
        paths.append(pathlib.Path(os.environ['OMEGACLAW_EXTRA_LOADER']).with_name('tools-'+filename))
    return sorted(paths, key=lambda candidate: (candidate.parent.name, candidate.name))


def _signature_declaration_paths(path=SIGNATURE_DECLARATIONS_PATH):
    """Return the MeTTa signature files that make up the command surface.

    The default command surface is intentionally organ-local: core, memory,
    body, Assume, attention, and channel organs can each expose a neighboring
    skill_signatures_*.metta file without editing this Python membrane.
    Passing an explicit non-default file still reads only that file, which keeps
    tests and small live experiments predictable.
    """
    p = pathlib.Path(path)
    if p == SIGNATURE_DECLARATIONS_PATH:
        paths = sorted(p.parent.glob(SIGNATURE_DECLARATIONS_GLOB))
        paths = sorted(paths, key=lambda candidate: _declaration_sort_key(candidate, "skill_signatures"))
        paths.extend(_module_declaration_paths("signatures.metta"))
        return paths or [p]
    if p.is_dir():
        paths = sorted(p.glob(SIGNATURE_DECLARATIONS_GLOB), key=lambda candidate: _declaration_sort_key(candidate, "skill_signatures"))
        paths.extend(_module_declaration_paths("signatures.metta", p))
        return paths
    paths = [p]
    paths.extend(_module_declaration_paths("signatures.metta", p.parent))
    return paths


def _declaration_sort_key(path, prefix):
    name = pathlib.Path(path).stem
    suffix = name[len(prefix):].lstrip("_") if name.startswith(prefix) else name
    return (DECLARATION_ORDER.get(suffix, 100), name)


def _skill_catalog_declaration_paths(path=SKILL_CATALOG_DECLARATIONS_PATH):
    p = pathlib.Path(path)
    if p == SKILL_CATALOG_DECLARATIONS_PATH:
        paths = sorted(p.parent.glob(SKILL_CATALOG_DECLARATIONS_GLOB))
        paths = sorted(paths, key=lambda candidate: _declaration_sort_key(candidate, "skill_catalog"))
        paths.extend(_module_declaration_paths("catalog.metta"))
        return paths or [p]
    if p.is_dir():
        paths = sorted(p.glob(SKILL_CATALOG_DECLARATIONS_GLOB), key=lambda candidate: _declaration_sort_key(candidate, "skill_catalog"))
        paths.extend(_module_declaration_paths("catalog.metta", p))
        return paths
    paths = [p]
    paths.extend(_module_declaration_paths("catalog.metta", p.parent))
    return paths


def _skill_affordance_declaration_paths(path=SKILL_AFFORDANCE_DECLARATIONS_PATH):
    p = pathlib.Path(path)
    if p == SKILL_AFFORDANCE_DECLARATIONS_PATH:
        paths = sorted(p.parent.glob(SKILL_AFFORDANCE_DECLARATIONS_GLOB))
        paths = sorted(paths, key=lambda candidate: _declaration_sort_key(candidate, "skill_affordance"))
        paths.extend(_module_declaration_paths("affordance.metta"))
        return paths or [p]
    if p.is_dir():
        paths = sorted(p.glob(SKILL_AFFORDANCE_DECLARATIONS_GLOB), key=lambda candidate: _declaration_sort_key(candidate, "skill_affordance"))
        paths.extend(_module_declaration_paths("affordance.metta", p))
        return paths
    paths = [p]
    paths.extend(_module_declaration_paths("affordance.metta", p.parent))
    return paths


def _strip_signature_comment(line):
    text = str(line or "")
    in_quote = False
    escaped = False
    for index, char in enumerate(text):
        if in_quote:
            if char == '"' and not escaped:
                in_quote = False
            escaped = char == "\\" and not escaped
            if char != "\\":
                escaped = False
            continue
        if char == '"':
            in_quote = True
        elif char == ";":
            return text[:index].strip()
    return text.strip()


def _signature_decl_error(path, line_number, message, line):
    where = f"{path}:{line_number}" if line_number else str(path)
    raise SignatureParseError(f"{where}: {message}: {line}")


def _signature_decl_consume_token(text):
    text = str(text or "").strip()
    if not text:
        return "", ""
    if text.startswith('"'):
        out = []
        escaped = False
        for index in range(1, len(text)):
            ch = text[index]
            if ch == '"' and not escaped:
                return "".join(out), text[index + 1:].strip()
            if ch == "\\" and not escaped:
                escaped = True
                continue
            out.append(ch)
            escaped = False
        return "".join(out), ""
    parts = text.split(maxsplit=1)
    return parts[0], parts[1].strip() if len(parts) > 1 else ""


def _signature_arg_spans(body):
    return list(re.finditer(r"\(Arg\s+([^\s()]+)\s+([^()]*)\)", body))


def _signature_field_spans(body):
    return list(re.finditer(r"\(Field\s+([^\s()]+)\s+([^()]*)\)", body))


def _ensure_only_arg_forms(path, line_number, body, spans, line):
    residue = body
    for match in spans:
        residue = residue.replace(match.group(0), "", 1)
    if residue.strip():
        _signature_decl_error(path, line_number, "unexpected SkillSignature declaration body", line)


def _load_signature_commands(path=SIGNATURE_DECLARATIONS_PATH, fallback=None):
    fallback = fallback or {}
    commands = dict(fallback)
    loaded_commands = set()
    for signature_path in _signature_declaration_paths(path):
        try:
            text = pathlib.Path(signature_path).read_text(encoding="utf-8")
        except Exception:
            continue
        for line_number, raw_line in enumerate(text.splitlines(), 1):
            line = _strip_signature_comment(raw_line)
            if not line:
                continue
            if not line.startswith("(SkillSignature"):
                continue
            match = re.match(r"^\(SkillSignature\s+([^\s()]+)(?:\s+(.*))?\)$", line)
            if not match:
                _signature_decl_error(signature_path, line_number, "malformed SkillSignature declaration", line)
            command = match.group(1)
            body = match.group(2) or ""
            spans = _signature_arg_spans(body)
            _ensure_only_arg_forms(signature_path, line_number, body, spans, line)
            args = []
            for arg_match in spans:
                arg_type, arg_names = arg_match.group(1), arg_match.group(2)
                if arg_type not in SIGNATURE_ARG_TYPES:
                    _signature_decl_error(signature_path, line_number, f"unknown SkillSignature arg type {arg_type}", line)
                names = tuple(part for part in arg_names.split() if part)
                if not names:
                    _signature_decl_error(signature_path, line_number, "missing SkillSignature arg name", line)
                if arg_type in {"pipe-fields", "pipe-spec"}:
                    args.append((arg_type, names))
                elif arg_type == "optional-number":
                    default = names[1] if len(names) > 1 else "0"
                    args.append((arg_type, (names[0], default)))
                else:
                    args.append((arg_type, names[0]))
            if command in loaded_commands:
                _signature_decl_error(signature_path, line_number, f"duplicate SkillSignature {command}", line)
            loaded_commands.add(command)
            commands[command] = tuple(args)
    return commands


def _load_signature_spaces(path=SIGNATURE_DECLARATIONS_PATH, fallback=None):
    fallback = fallback or set()
    spaces = set(fallback)
    loaded_spaces = set()
    for signature_path in _signature_declaration_paths(path):
        try:
            text = pathlib.Path(signature_path).read_text(encoding="utf-8")
        except Exception:
            continue
        for line_number, raw_line in enumerate(text.splitlines(), 1):
            line = _strip_signature_comment(raw_line)
            if not line:
                continue
            if not line.startswith("(SignatureSpace"):
                continue
            match = re.match(r"^\(SignatureSpace\s+([^\s()]+)\)$", line)
            if not match:
                _signature_decl_error(signature_path, line_number, "malformed SignatureSpace declaration", line)
            space = match.group(1)
            if space in loaded_spaces:
                _signature_decl_error(signature_path, line_number, f"duplicate SignatureSpace {space}", line)
            loaded_spaces.add(space)
            spaces.add(space)
    return spaces


def _load_signature_lowerings(path=SIGNATURE_DECLARATIONS_PATH, fallback=None):
    fallback = fallback or {}
    lowerings = dict(fallback)
    loaded_lowerings = set()
    for signature_path in _signature_declaration_paths(path):
        try:
            text = pathlib.Path(signature_path).read_text(encoding="utf-8")
        except Exception:
            continue
        for line_number, raw_line in enumerate(text.splitlines(), 1):
            line = _strip_signature_comment(raw_line)
            if not line:
                continue
            if not line.startswith("(SignatureLowering"):
                continue
            match = re.match(r"^\(SignatureLowering\s+([^\s()]+)\s+([^\s()]+)\)$", line)
            if not match:
                _signature_decl_error(signature_path, line_number, "malformed SignatureLowering declaration", line)
            source = match.group(1)
            if source in loaded_lowerings:
                _signature_decl_error(signature_path, line_number, f"duplicate SignatureLowering {source}", line)
            loaded_lowerings.add(source)
            lowerings[source] = match.group(2)
    return lowerings


def _load_signature_prose_fallback(path=SIGNATURE_DECLARATIONS_PATH, fallback=""):
    selected = fallback or ""
    loaded = []
    for signature_path in _signature_declaration_paths(path):
        try:
            text = pathlib.Path(signature_path).read_text(encoding="utf-8")
        except Exception:
            continue
        for line_number, raw_line in enumerate(text.splitlines(), 1):
            line = _strip_signature_comment(raw_line)
            if not line:
                continue
            if not line.startswith("(SignatureProseFallback"):
                continue
            match = re.match(r"^\(SignatureProseFallback\s+([^\s()]+)\)$", line)
            if not match:
                _signature_decl_error(signature_path, line_number, "malformed SignatureProseFallback declaration", line)
            loaded.append(f"{signature_path}:{line_number}")
            selected = match.group(1)
    if len(loaded) > 1:
        _signature_decl_error(loaded[-1], 0, "duplicate SignatureProseFallback", "")
    return selected


def _load_signature_no_action_heads(path=SIGNATURE_DECLARATIONS_PATH):
    heads = set()
    for signature_path in _signature_declaration_paths(path):
        try:
            text = pathlib.Path(signature_path).read_text(encoding="utf-8")
        except Exception:
            continue
        for line_number, raw_line in enumerate(text.splitlines(), 1):
            line = _strip_signature_comment(raw_line)
            if not line:
                continue
            if not line.startswith("(SignatureNoActionHead"):
                continue
            match = re.match(r"^\(SignatureNoActionHead\s+([^\s()]+)\)$", line)
            if not match:
                _signature_decl_error(signature_path, line_number, "malformed SignatureNoActionHead declaration", line)
            heads.add(match.group(1).lower())
    return heads


def _load_signature_recovery_hints(path=SIGNATURE_DECLARATIONS_PATH):
    hints = {}
    loaded = set()
    for signature_path in _signature_declaration_paths(path):
        try:
            text = pathlib.Path(signature_path).read_text(encoding="utf-8")
        except Exception:
            continue
        for line_number, raw_line in enumerate(text.splitlines(), 1):
            line = _strip_signature_comment(raw_line)
            if not line:
                continue
            if not line.startswith("(SignatureRecoveryHint"):
                continue
            match = re.match(r"^\(SignatureRecoveryHint\s+([^\s()]+)\s+(.*)\)$", line)
            if not match:
                _signature_decl_error(signature_path, line_number, "malformed SignatureRecoveryHint declaration", line)
            kind = match.group(1)
            hint, extra = _signature_decl_consume_token(match.group(2))
            if extra:
                _signature_decl_error(signature_path, line_number, "unexpected SignatureRecoveryHint text", line)
            if kind in loaded:
                _signature_decl_error(signature_path, line_number, f"duplicate SignatureRecoveryHint {kind}", line)
            loaded.add(kind)
            hints[kind] = hint
    return hints


def _load_skill_cards(path=SKILL_AFFORDANCE_DECLARATIONS_PATH):
    cards = {}
    for affordance_path in _skill_affordance_declaration_paths(path):
        try:
            text = pathlib.Path(affordance_path).read_text(encoding="utf-8")
        except Exception:
            continue
        for raw_line in text.splitlines():
            line = _strip_signature_comment(raw_line)
            start = line.find("(SkillCardLine ")
            if start < 0:
                continue
            body = line[start + len("(SkillCardLine "):]
            if body.endswith("))"):
                body = body[:-2]
            elif body.endswith(")"):
                body = body[:-1]
            skill, rest = _signature_decl_consume_token(body)
            if not skill:
                continue
            card, extra = _signature_decl_consume_token(rest)
            if not card or extra:
                continue
            cards.setdefault(skill, []).append(card)
    return cards


def _load_signature_shorthands(path=SIGNATURE_DECLARATIONS_PATH):
    shorthands = {}
    loaded = set()
    for signature_path in _signature_declaration_paths(path):
        try:
            text = pathlib.Path(signature_path).read_text(encoding="utf-8")
        except Exception:
            continue
        for line_number, raw_line in enumerate(text.splitlines(), 1):
            line = _strip_signature_comment(raw_line)
            if not line:
                continue
            if not line.startswith("(SignatureShorthand"):
                continue
            match = re.match(r"^\(SignatureShorthand\s+([^\s()]+)\s+([^\s()]+)(?:\s+(.*))?\)$", line)
            if not match:
                _signature_decl_error(signature_path, line_number, "malformed SignatureShorthand declaration", line)
            command, mode, body = match.group(1), match.group(2), match.group(3) or ""
            if mode not in {"pipe", "collapsed"}:
                _signature_decl_error(signature_path, line_number, f"unknown SignatureShorthand mode {mode}", line)
            spans = _signature_field_spans(body)
            residue = body
            for field_match in spans:
                residue = residue.replace(field_match.group(0), "", 1)
            if residue.strip():
                _signature_decl_error(signature_path, line_number, "unexpected SignatureShorthand declaration body", line)
            fields = []
            for field_match in spans:
                field_type, field_names = field_match.group(1), field_match.group(2)
                if field_type not in SIGNATURE_ARG_TYPES:
                    _signature_decl_error(signature_path, line_number, f"unknown SignatureShorthand field type {field_type}", line)
                if field_type in {"multiline", "optional-number", "optional-rest-text", "pipe-fields", "pipe-spec"}:
                    _signature_decl_error(signature_path, line_number, f"unsupported SignatureShorthand field type {field_type}", line)
                names = tuple(part for part in field_names.split() if part)
                if len(names) != 1:
                    _signature_decl_error(signature_path, line_number, "SignatureShorthand fields need one name", line)
                fields.append((field_type, names[0]))
            key = (command, mode)
            if key in loaded:
                _signature_decl_error(signature_path, line_number, f"duplicate SignatureShorthand {command} {mode}", line)
            loaded.add(key)
            shorthands.setdefault(command, []).append((mode, tuple(fields)))
    return shorthands


SIGNATURE_COMMANDS = _load_signature_commands(fallback=SIGNATURE_BOOTSTRAP_COMMANDS)
SIGNATURE_KNOWN_SPACES = _load_signature_spaces(fallback=SIGNATURE_BOOTSTRAP_SPACES)
SIGNATURE_MULTILINE_LOWERING = _load_signature_lowerings()
SIGNATURE_PROSE_FALLBACK = _load_signature_prose_fallback()
SIGNATURE_NO_ACTION_HEADS = _load_signature_no_action_heads()
SIGNATURE_SHORTHANDS = _load_signature_shorthands()
SIGNATURE_RECOVERY_HINTS = _load_signature_recovery_hints()
SIGNATURE_SKILL_CARDS = _load_skill_cards()


def signature_commands_from(path=SIGNATURE_DECLARATIONS_PATH):
    """Read SkillSignature atoms from a MeTTa declaration file."""
    return _load_signature_commands(path=path, fallback=SIGNATURE_BOOTSTRAP_COMMANDS)


def signature_spaces_from(path=SIGNATURE_DECLARATIONS_PATH):
    """Read SignatureSpace atoms from a MeTTa declaration file."""
    return _load_signature_spaces(path=path, fallback=SIGNATURE_BOOTSTRAP_SPACES)


def signature_lowerings_from(path=SIGNATURE_DECLARATIONS_PATH):
    """Read SignatureLowering atoms from MeTTa declaration files."""
    return _load_signature_lowerings(path=path)


def signature_prose_fallback_from(path=SIGNATURE_DECLARATIONS_PATH):
    """Read the declared fallback command for plain human-facing prose."""
    return _load_signature_prose_fallback(path=path)


def signature_no_action_heads_from(path=SIGNATURE_DECLARATIONS_PATH):
    """Read no-action command heads from MeTTa declaration files."""
    return _load_signature_no_action_heads(path=path)


def signature_recovery_hints_from(path=SIGNATURE_DECLARATIONS_PATH):
    """Read recovery hints from MeTTa declaration files."""
    return _load_signature_recovery_hints(path=path)


def signature_shorthands_from(path=SIGNATURE_DECLARATIONS_PATH):
    """Read SignatureShorthand atoms from MeTTa declaration files."""
    return _load_signature_shorthands(path=path)


def signature_declaration_paths(path=SIGNATURE_DECLARATIONS_PATH):
    """Expose the active signature files for tests and review tooling."""
    return tuple(_signature_declaration_paths(path))


def skill_catalog_declaration_paths(path=SKILL_CATALOG_DECLARATIONS_PATH):
    """Expose the active skill catalog declaration files for tests/review."""
    return tuple(_skill_catalog_declaration_paths(path))


def skill_affordance_declaration_paths(path=SKILL_AFFORDANCE_DECLARATIONS_PATH):
    """Expose active skill affordance declaration files for tests/review."""
    return tuple(_skill_affordance_declaration_paths(path))


def _catalog_decl_string(text):
    token, rest = _signature_consume_token(str(text or "").strip())
    if rest:
        raise SignatureParseError("unexpected trailing catalog text: " + rest[:80])
    return token


def _load_skill_catalog(path=SKILL_CATALOG_DECLARATIONS_PATH):
    catalog = []
    help_by_topic = {}
    for catalog_path in _skill_catalog_declaration_paths(path):
        try:
            text = pathlib.Path(catalog_path).read_text(encoding="utf-8")
        except Exception:
            continue
        for raw_line in text.splitlines():
            line = _strip_signature_comment(raw_line)
            if line.startswith("(SkillCatalog ") and line.endswith(")"):
                catalog.append(_catalog_decl_string(line[len("(SkillCatalog "):-1]))
            elif line.startswith("(SkillHelp ") and line.endswith(")"):
                body = line[len("(SkillHelp "):-1].strip()
                topic, rest = _signature_consume_token(body)
                if not topic:
                    continue
                help_by_topic.setdefault(topic, []).append(_catalog_decl_string(rest))
    return catalog, help_by_topic


def skill_catalog(path=SKILL_CATALOG_DECLARATIONS_PATH):
    """Render the MeTTa-declared skill catalog for the LLM prompt."""
    catalog, _ = _load_skill_catalog(path)
    return "\n".join(catalog)


def skill_help(topic, path=SKILL_CATALOG_DECLARATIONS_PATH):
    """Render MeTTa-declared help for one catalog topic."""
    topic = str(topic or "").strip()
    catalog, help_by_topic = _load_skill_catalog(path)
    if topic == "all":
        return "\n".join(catalog)
    lines = help_by_topic.get(topic, [])
    if lines:
        return "\n".join(lines)
    known = ", ".join(sorted(help_by_topic))
    return f"Unknown skill-help topic {topic}. Known topics: {known}"


def _signature_quote(text):
    return _metta_string(text)


def _signature_one_line(text):
    text = str(text or "")
    text = text.replace("_newline_", " ")
    text = text.replace("\\n", " ").replace("\\r", " ")
    text = text.replace("newline_", " ").replace("_newline", " ")
    text = text.replace("\r\n", " ").replace("\n", " ").replace("\r", " ")
    return re.sub(r"\s+", " ", text).strip()


def _signature_consume_token(text):
    text = str(text or "").strip()
    if not text:
        return "", ""
    if text.startswith('"'):
        out = []
        escaped = False
        index = 1
        while index < len(text):
            ch = text[index]
            if ch == '"' and not escaped:
                return "".join(out), text[index + 1:].strip()
            if ch == "\\" and not escaped:
                escaped = True
                index += 1
                continue
            if escaped:
                out.append({"n": "\n", "r": "\r", "t": "\t"}.get(ch, ch))
                escaped = False
            else:
                out.append(ch)
            index += 1
        return "".join(out), ""
    parts = text.split(maxsplit=1)
    return parts[0], parts[1].strip() if len(parts) > 1 else ""


def _signature_validated_metta(expr):
    status = test_metta_expression(expr)
    if status != "METTA-SYNTAX-OK":
        raise SignatureParseError(status)
    return expr


def _signature_clean_metta_token(token):
    token = str(token or "").strip()
    if token.startswith("'(") and token.endswith(")'"):
        return token[1:-1].strip()
    return token


def _signature_take_metta_from_text(text):
    text = str(text or "").strip()
    if not text.startswith("("):
        raise SignatureParseError("metta arg must start with (")
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
                if depth == 0:
                    expr = text[: index + 1]
                    rest = text[index + 1:].strip()
                    return _signature_validated_metta(expr), rest
                if depth < 0:
                    raise SignatureParseError("extra closing parenthesis")
        escaped = (ch == "\\" and not escaped)
        if ch != "\\":
            escaped = False
    raise SignatureParseError("missing closing parenthesis")


def _signature_consume_quoted_metta_fragments(text):
    rest = str(text or "").strip()
    fragments = []
    while rest.startswith('"'):
        token, next_rest = _signature_consume_token(rest)
        if not token:
            break
        fragments.append(token)
        candidate = " ".join(fragments).strip()
        if candidate.startswith("("):
            try:
                expr, extra = _signature_take_metta_from_text(candidate)
                if not extra:
                    return expr, next_rest
            except SignatureParseError:
                pass
        if next_rest == rest:
            break
        rest = next_rest
    raise SignatureParseError("expression should be one complete parenthesized MeTTa expression")


def _signature_consume_metta(text, consume_all=False):
    text = str(text or "").strip()
    if text.startswith('"'):
        if len(text) > 1 and text[1:].lstrip().startswith("("):
            leading_space = len(text[1:]) - len(text[1:].lstrip())
            start = 1 + leading_space
            depth = 0
            for index in range(start, len(text)):
                ch = text[index]
                if ch == "(":
                    depth += 1
                elif ch == ")":
                    depth -= 1
                    if depth == 0:
                        candidate = text[start:index + 1]
                        rest = text[index + 1:].strip()
                        if rest.startswith('"'):
                            rest = rest[1:].strip()
                        head_token = candidate[1:].lstrip().split(maxsplit=1)[0] if candidate.startswith("(") else ""
                        if '\\"' not in candidate and '"' not in head_token:
                            try:
                                return _signature_validated_metta(candidate), rest
                            except SignatureParseError:
                                break
                    if depth < 0:
                        break
        # LLMs often wrap a complete MeTTa expression in quotes without
        # escaping the quotes inside the expression. For MeTTa-typed args, the
        # outer quotes are only a transport convenience, so recover by taking
        # the outermost quoted span as the expression before normal token
        # parsing splits it at the first inner quote.
        if text.endswith('"') and len(text) > 1:
            candidate = _signature_clean_metta_token(text[1:-1].strip())
            head_token = candidate[1:].lstrip().split(maxsplit=1)[0] if candidate.startswith("(") else ""
            if candidate.startswith("(") and '\\"' not in candidate and '"' not in head_token:
                try:
                    return _signature_validated_metta(candidate), ""
                except SignatureParseError:
                    pass
        if text.startswith('"('):
            try:
                return _signature_consume_quoted_metta_fragments(text)
            except SignatureParseError:
                pass
        token, rest = _signature_consume_token(text)
        token = _signature_clean_metta_token(token)
        if not token.startswith("("):
            token = f"({token})"
        try:
            return _signature_validated_metta(token), rest
        except SignatureParseError:
            if rest:
                if rest.startswith('"'):
                    raise
                return _signature_take_metta_from_text(f"{token} {rest}")
            raise
    if consume_all and not text.startswith("("):
        return _signature_validated_metta(f"({text})"), ""
    return _signature_take_metta_from_text(text)


def _signature_split_commands(raw):
    logical = []
    current = []
    in_block = False
    in_quote = False
    escaped = False
    for line in str(raw or "").replace("_quote_", '"').replace("_newline_", "\n").strip("\n").splitlines():
        continuing = in_block or in_quote
        stripped = line.strip()
        if not stripped and not in_block and not in_quote:
            logical.append("")
            continue
        buffered = line if continuing else stripped
        current.append(buffered)
        scan = buffered
        if '"""' in scan:
            if scan.count('"""') % 2 == 1:
                in_block = not in_block
            if not in_block:
                logical.append("\n".join(current))
                current = []
            continue
        if in_block:
            continue
        for ch in scan:
            if ch == '"' and not escaped:
                in_quote = not in_quote
            escaped = (ch == "\\" and not escaped)
            if ch != "\\":
                escaped = False
        if not in_quote:
            logical.append("\n".join(current))
            current = []
    if current:
        logical.append("\n".join(current))
    return _signature_merge_continuations(logical)


def _signature_explicit_command_head(line):
    candidate = str(line or "").strip()
    if candidate.startswith("(") and candidate.endswith(")"):
        candidate = candidate[1:-1].strip()
    head, _ = _signature_consume_token(candidate)
    return head if head in SIGNATURE_COMMANDS else ""


def _signature_base64ish_text(text):
    value = str(text or "").strip().strip('"')
    return bool(value) and bool(re.fullmatch(r"[A-Za-z0-9+/=_-]+", value))


def _signature_accepts_base64_continuation(head):
    signature = SIGNATURE_COMMANDS.get(head, ())
    return bool(signature) and signature[-1][0] in {"base64", "base64-utf8"}


def _signature_accepts_unquoted_continuation(head):
    if head in {"wait", "query", "web-search", "search", "shell", "shell-confirm"}:
        return False
    signature = SIGNATURE_COMMANDS.get(head, ())
    return any(arg_type in {"rest-text", "multiline"} for arg_type, _ in signature)


def _signature_append_base64_continuation(previous, continuation):
    clean = str(continuation or "").strip().strip('"')
    prev = str(previous or "").rstrip()
    if prev.endswith('"'):
        return prev[:-1] + clean + '"'
    return prev + clean


def _signature_validate_base64_token(token, require_utf8=False):
    token = str(token or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9+/=_-]*", token):
        raise SignatureParseError("invalid base64-ish payload")
    normalized = token.replace("-", "+").replace("_", "/")
    padded = normalized + ("=" * ((4 - len(normalized) % 4) % 4))
    try:
        decoded = base64.b64decode(padded, validate=True)
    except Exception:
        raise SignatureParseError("invalid base64 payload")
    if require_utf8:
        try:
            decoded.decode("utf-8")
        except UnicodeDecodeError:
            raise SignatureParseError("base64 payload must decode as utf-8")
    return token


def _signature_looks_like_primary_prose(text):
    """Detect human-facing prose that should be sent to the control route."""
    if not SIGNATURE_PROSE_FALLBACK:
        return False
    if SIGNATURE_PROSE_FALLBACK not in SIGNATURE_COMMANDS:
        return False
    raw = str(text or "").replace("_quote_", '"').replace("_newline_", "\n").strip()
    if not raw or raw.startswith("("):
        return False
    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    if not lines:
        return False
    if any(_signature_explicit_command_head(line) for line in lines):
        return False
    return len(lines) > 1


def _signature_render_prose_fallback(text):
    payload = base64.b64encode(str(text or "").encode("utf-8")).decode("ascii")
    return f"(({SIGNATURE_PROSE_FALLBACK} {_signature_quote(payload)}))"


def _signature_merge_continuations(lines):
    merged = []
    current_head = ""
    for line in lines:
        head = _signature_explicit_command_head(line)
        if merged and not head and _signature_accepts_unquoted_continuation(current_head):
            merged[-1] = merged[-1] + "\n" + line
            continue
        if merged and not head and _signature_accepts_base64_continuation(current_head) and _signature_base64ish_text(line):
            merged[-1] = _signature_append_base64_continuation(merged[-1], line)
            continue
        merged.append(line)
        current_head = head
    return merged


def _signature_extract_block(rest):
    if '"""' not in rest:
        return None
    before, after = rest.split('"""', 1)
    if '"""' in after:
        content, tail = after.rsplit('"""', 1)
    else:
        content, tail = after, ""
    return before.strip(), content.strip("\n"), tail.strip()


def _signature_outer_parens_wrap_whole(text):
    text = str(text or "").strip()
    if not (text.startswith("(") and text.endswith(")")):
        return False
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
                if depth == 0 and index != len(text) - 1:
                    return False
                if depth < 0:
                    return False
        escaped = (ch == "\\" and not escaped)
        if ch != "\\":
            escaped = False
    return depth == 0 and not in_quote


def _signature_unwrap_command_form(text):
    text = str(text or "").strip()
    while _signature_outer_parens_wrap_whole(text):
        inner = text[1:-1].strip()
        if not inner:
            break
        text = inner
    return text


def _signature_split_top_level_forms(text):
    text = str(text or "").strip()
    if not text:
        return []
    candidate = text
    if _signature_outer_parens_wrap_whole(candidate):
        candidate = candidate[1:-1].strip()
    forms = []
    start = None
    last_end = 0
    depth = 0
    in_quote = False
    escaped = False
    for index, ch in enumerate(candidate):
        if ch == '"' and not escaped:
            in_quote = not in_quote
        elif not in_quote:
            if ch == "(":
                if depth == 0:
                    if candidate[last_end:index].strip():
                        return [text]
                    start = index
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0 and start is not None:
                    forms.append((start, index))
                    last_end = index + 1
                    start = None
                if depth < 0:
                    return [text]
        escaped = (ch == "\\" and not escaped)
        if ch != "\\":
            escaped = False
    if depth != 0 or in_quote or not forms:
        return [text]
    if candidate[last_end:].strip():
        return [text]
    if len(forms) == 1:
        return [text]
    return [candidate[start:end + 1] for start, end in forms]


def _signature_parse_prefix_args(signature, rest):
    args = []
    for index, (arg_type, name) in enumerate(signature):
        if arg_type in {"rest-text", "shell-command", "multiline", "pipe-fields", "pipe-spec"}:
            break
        if arg_type in {"text", "jid", "filepath"}:
            token, rest = _signature_consume_token(rest)
            if not token:
                raise SignatureParseError(f"missing {name}")
            args.append(_signature_quote(token))
        elif arg_type == "base64":
            token, rest = _signature_consume_token(rest)
            args.append(_signature_quote(_signature_validate_base64_token(token)))
        elif arg_type == "base64-utf8":
            token, rest = _signature_consume_token(rest)
            args.append(_signature_quote(_signature_validate_base64_token(token, require_utf8=True)))
        elif arg_type == "number":
            token, rest = _signature_consume_token(rest)
            if not re.fullmatch(r"-?\d+(\.\d+)?", token or ""):
                raise SignatureParseError(f"{name} must be number")
            args.append(token)
        elif arg_type == "optional-number":
            arg_name, default = name
            if not rest.strip():
                token = default
            else:
                token, rest = _signature_consume_token(rest)
            if not re.fullmatch(r"-?\d+(\.\d+)?", token or ""):
                raise SignatureParseError(f"{arg_name} must be number")
            args.append(token)
        elif arg_type == "optional-rest-text":
            break
        elif arg_type == "space":
            token, rest = _signature_consume_token(rest)
            if token not in SIGNATURE_KNOWN_SPACES:
                raise SignatureParseError(_signature_space_error(token))
            args.append(_signature_quote(token))
        elif arg_type == "metta":
            if not rest.strip():
                raise SignatureParseError(f"missing {name}")
            expr, rest = _signature_consume_metta(rest, consume_all=index == len(signature) - 1)
            args.append(_signature_quote(expr))
        elif arg_type == "metta-raw":
            if not rest.strip():
                raise SignatureParseError(f"missing {name}")
            expr, rest = _signature_consume_metta(rest, consume_all=index == len(signature) - 1)
            args.append(expr)
        else:
            raise SignatureParseError(f"unknown arg type {arg_type}")
    return args, rest.strip()


def _signature_lowered_multiline_call(lowered, signature, rest, content):
    payload = base64.b64encode(content.encode("utf-8")).decode("ascii")
    args, extra = _signature_parse_prefix_args(signature, rest)
    if extra:
        raise SignatureParseError("unexpected text outside multiline body")
    rendered = args + [_signature_quote(payload)]
    return f"({lowered} {' '.join(rendered)})"


def _signature_syntax_error(head, message, raw):
    message = _signature_recovery_message(head, message)
    return (
        f"(syntax-error {_signature_quote(head)} "
        f"{_signature_quote(message)} {_signature_quote(raw)})"
    )


def _signature_error_kind(message):
    text = str(message or "")
    if text.startswith("missing "):
        return "missing-argument"
    if "unexpected trailing text" in text or "unexpected text outside multiline body" in text:
        return "unexpected-trailing"
    if text.startswith("unknown space"):
        return "unknown-space"
    if "METTA-SYNTAX-ERROR" in text or "missing closing parenthesis" in text or "unbalanced parentheses" in text:
        return "metta-syntax"
    if "must be number" in text:
        return "invalid-number"
    if "pipe fields" in text:
        return "pipe-shape"
    return "syntax-error"


def _signature_compact_card(head):
    cards = SIGNATURE_SKILL_CARDS.get(str(head or ""), [])
    if not cards:
        return ""
    return "card: " + cards[0]


def _signature_recovery_message(head, message):
    parts = [str(message or "")]
    card = _signature_compact_card(head)
    if card:
        parts.append(card)
    hint = SIGNATURE_RECOVERY_HINTS.get(_signature_error_kind(message), SIGNATURE_RECOVERY_HINTS.get("syntax-error", ""))
    if hint:
        parts.append(hint)
    return "; ".join(part for part in parts if part)


def _signature_unknown_head_message(cmd):
    parts = [f"ignored unknown command head {cmd}", "use only commands listed in SKILLS"]
    hint = SIGNATURE_RECOVERY_HINTS.get("unknown-head", "")
    if hint:
        parts.append(hint)
    return "; ".join(parts)


def _signature_render_typed_value(arg_type, name, value):
    value = str(value or "").strip()
    if arg_type == "space":
        if value not in SIGNATURE_KNOWN_SPACES:
            raise SignatureParseError(_signature_space_error(value))
        return _signature_quote(value)
    if arg_type == "metta":
        return _signature_quote(_signature_validated_metta(value))
    if arg_type == "metta-raw":
        return _signature_validated_metta(value)
    if arg_type == "number":
        if not re.fullmatch(r"-?\d+(\.\d+)?", value):
            raise SignatureParseError(f"{name} must be number")
        return value
    if arg_type == "base64":
        return _signature_quote(_signature_validate_base64_token(value))
    if arg_type == "base64-utf8":
        return _signature_quote(_signature_validate_base64_token(value, require_utf8=True))
    if arg_type == "rest-text":
        return _signature_quote(_signature_one_line(value))
    if arg_type in {"text", "jid", "filepath", "shell-command"}:
        if not value:
            raise SignatureParseError(f"missing {name}")
        return _signature_quote(value)
    raise SignatureParseError(f"unsupported shorthand field type {arg_type}")


def _signature_parse_pipe_shorthand(rest, fields):
    spec = str(rest or "").strip()
    if spec.startswith('"'):
        spec, extra = _signature_consume_token(spec)
        if extra:
            raise SignatureParseError("unexpected trailing text: " + extra[:80])
    parts = [part.strip() for part in spec.split("|")]
    if len(parts) != len(fields) or not all(parts):
        raise SignatureParseError(f"expected {len(fields)} pipe fields")
    return [_signature_render_typed_value(arg_type, name, value) for (arg_type, name), value in zip(fields, parts)]


def _signature_parse_collapsed_shorthand(rest, fields):
    source = str(rest or "").strip()
    if source.startswith('"'):
        source, extra = _signature_consume_token(source)
        if extra:
            raise SignatureParseError("unexpected trailing text: " + extra[:80])
    rendered = []
    for index, (arg_type, name) in enumerate(fields):
        is_last = index == len(fields) - 1
        if arg_type == "space":
            token, source = _signature_consume_token(source)
            rendered.append(_signature_render_typed_value(arg_type, name, token))
        elif arg_type in {"text", "jid", "filepath", "base64", "number"}:
            token, source = _signature_consume_token(source)
            rendered.append(_signature_render_typed_value(arg_type, name, token))
        elif arg_type in {"metta", "metta-raw"}:
            expr, source = _signature_consume_metta(source, consume_all=is_last)
            rendered.append(_signature_render_typed_value(arg_type, name, expr))
        elif arg_type in {"rest-text", "shell-command"}:
            rendered.append(_signature_render_typed_value(arg_type, name, source))
            source = ""
        else:
            raise SignatureParseError(f"unsupported shorthand field type {arg_type}")
    if source.strip():
        raise SignatureParseError("unexpected trailing text: " + source[:80])
    return rendered


def _signature_parse_shorthand(cmd, rest):
    for mode, fields in SIGNATURE_SHORTHANDS.get(cmd, ()):
        if mode == "pipe" and "|" in str(rest or ""):
            return _signature_parse_pipe_shorthand(rest, fields)
        if mode == "collapsed" and str(rest or "").strip().startswith('"'):
            _, extra = _signature_consume_token(rest)
            if extra:
                continue
            return _signature_parse_collapsed_shorthand(rest, fields)
    return None


def _signature_parse_one(line):
    original = str(line or "").strip()
    line = original
    if line.startswith("(-"):
        line = "pin -" + line[2:]
    elif line.startswith("-"):
        line = "pin " + line
    line = _signature_unwrap_command_form(line)
    cmd, rest = _signature_consume_token(line)
    if cmd not in SIGNATURE_COMMANDS:
        if cmd.lower() in SIGNATURE_NO_ACTION_HEADS:
            return f"(wait {_signature_quote(_signature_one_line(original))})"
        return (
            f"(wait {_signature_quote(_signature_unknown_head_message(cmd))})"
        )
    signature = SIGNATURE_COMMANDS[cmd]
    block = _signature_extract_block(rest)
    if block and any(arg_type in {"multiline", "rest-text", "shell-command"} for arg_type, _ in signature):
        before, content, tail = block
        rest = (before + " " + tail).strip()
        lowered = SIGNATURE_MULTILINE_LOWERING.get(cmd)
        if lowered:
            return _signature_lowered_multiline_call(lowered, signature, rest, content)
    shorthand_args = _signature_parse_shorthand(cmd, rest)
    if shorthand_args is not None:
        return f"({cmd} {' '.join(shorthand_args)})"
    if (
        len(signature) > 1
        and not any(arg_type in {"rest-text", "shell-command", "multiline", "pipe-spec"} for arg_type, _ in signature)
        and not any(arg_type in {"optional-number", "optional-rest-text"} for arg_type, _ in signature)
        and rest.startswith('"')
    ):
        token, extra = _signature_consume_token(rest)
        if not extra:
            rest = token
    args = []
    for index, (arg_type, name) in enumerate(signature):
        if arg_type in {"rest-text", "shell-command"}:
            if rest.startswith('"'):
                token, extra = _signature_consume_token(rest)
                if not extra:
                    value = token if arg_type == "rest-text" else token
                    lowered = SIGNATURE_MULTILINE_LOWERING.get(cmd)
                    if arg_type == "rest-text" and lowered and "\n" in value:
                        payload = base64.b64encode(value.encode("utf-8")).decode("ascii")
                        if args:
                            return f"({lowered} {' '.join(args)} {_signature_quote(payload)})"
                        return f"({lowered} {_signature_quote(payload)})"
                    value = _signature_one_line(value) if arg_type == "rest-text" else value
                    args.append(_signature_quote(value))
                    rest = ""
                else:
                    value = rest
                    lowered = SIGNATURE_MULTILINE_LOWERING.get(cmd)
                    if arg_type == "rest-text" and lowered and "\n" in value:
                        payload = base64.b64encode(value.encode("utf-8")).decode("ascii")
                        if args:
                            return f"({lowered} {' '.join(args)} {_signature_quote(payload)})"
                        return f"({lowered} {_signature_quote(payload)})"
                    value = _signature_one_line(value) if arg_type == "rest-text" else value
                    args.append(_signature_quote(value))
                    rest = ""
            else:
                value = rest
                lowered = SIGNATURE_MULTILINE_LOWERING.get(cmd)
                if arg_type == "rest-text" and lowered and "\n" in value:
                    payload = base64.b64encode(value.encode("utf-8")).decode("ascii")
                    if args:
                        return f"({lowered} {' '.join(args)} {_signature_quote(payload)})"
                    return f"({lowered} {_signature_quote(payload)})"
                value = _signature_one_line(value) if arg_type == "rest-text" else value
                args.append(_signature_quote(value))
                rest = ""
        elif arg_type == "multiline":
            if rest.startswith('"'):
                token, extra = _signature_consume_token(rest)
                if not extra:
                    value = token
                    rest = ""
                else:
                    value = rest
                    rest = ""
            else:
                value = rest
                rest = ""
            lowered = SIGNATURE_MULTILINE_LOWERING.get(cmd)
            if lowered:
                payload = base64.b64encode(value.encode("utf-8")).decode("ascii")
                if args:
                    return f"({lowered} {' '.join(args)} {_signature_quote(payload)})"
                return f"({lowered} {_signature_quote(payload)})"
            args.append(_signature_quote(value))
        elif arg_type in {"text", "jid", "filepath"}:
            token, rest = _signature_consume_token(rest)
            if not token:
                raise SignatureParseError(f"missing {name}")
            args.append(_signature_quote(token))
        elif arg_type == "base64":
            token, rest = _signature_consume_token(rest)
            args.append(_signature_quote(_signature_validate_base64_token(token)))
        elif arg_type == "base64-utf8":
            token, rest = _signature_consume_token(rest)
            args.append(_signature_quote(_signature_validate_base64_token(token, require_utf8=True)))
        elif arg_type == "number":
            token, rest = _signature_consume_token(rest)
            if not re.fullmatch(r"-?\d+(\.\d+)?", token or ""):
                raise SignatureParseError(f"{name} must be number")
            args.append(token)
        elif arg_type == "optional-number":
            arg_name, default = name
            if not rest.strip():
                token = default
            else:
                token, rest = _signature_consume_token(rest)
            if not re.fullmatch(r"-?\d+(\.\d+)?", token or ""):
                raise SignatureParseError(f"{arg_name} must be number")
            args.append(token)
        elif arg_type == "optional-rest-text":
            if rest.strip():
                if rest.startswith('"'):
                    token, extra = _signature_consume_token(rest)
                    if extra:
                        token = rest
                else:
                    token = rest
                args.append(_signature_quote(_signature_one_line(token)))
            rest = ""
        elif arg_type == "space":
            token, rest = _signature_consume_token(rest)
            if token not in SIGNATURE_KNOWN_SPACES:
                raise SignatureParseError(_signature_space_error(token))
            args.append(_signature_quote(token))
        elif arg_type == "metta":
            if not rest.strip():
                raise SignatureParseError(f"missing {name}")
            expr, rest = _signature_consume_metta(rest, consume_all=index == len(signature) - 1)
            args.append(_signature_quote(expr))
        elif arg_type == "metta-raw":
            if not rest.strip():
                raise SignatureParseError(f"missing {name}")
            expr, rest = _signature_consume_metta(rest, consume_all=index == len(signature) - 1)
            args.append(expr)
        elif arg_type == "pipe-fields":
            fields = [part.strip() for part in rest.split("|")]
            expected = len(name)
            if len(fields) != expected or not all(fields):
                raise SignatureParseError(f"expected {expected} pipe fields")
            args.extend(_signature_quote(field) for field in fields)
            rest = ""
            break
        elif arg_type == "pipe-spec":
            if rest.startswith('"'):
                spec, extra = _signature_consume_token(rest)
                if extra:
                    raise SignatureParseError("unexpected trailing text: " + extra[:80])
            else:
                spec = rest
            fields = [part.strip() for part in spec.split("|")]
            expected = len(name)
            if len(fields) != expected or not all(fields):
                raise SignatureParseError(f"expected {expected} pipe fields")
            args.append(_signature_quote(spec))
            rest = ""
            break
        else:
            raise SignatureParseError(f"unknown arg type {arg_type}")
    if rest.strip():
        raise SignatureParseError("unexpected trailing text: " + rest[:80])
    return f"({cmd}{(' ' + ' '.join(args)) if args else ''})"


def _signature_source_text(s):
    s = str(s or "").replace("_quote_", '"').replace("_newline_", "\n")
    if '\\"' in s and not _has_unescaped_quote(s):
        s = re.sub(r'\\+"', '"', s)
    return s


def signature_raw_batch_complete(s):
    """Check exactly these bytes as text, before any encoded-quote decoding or escape repair."""
    return not _metta_expr_syntax_error(str(s or ""), allow_triple=True)


def signature_balance_parentheses(s):
    s = _signature_source_text(s)
    stripped = s.strip()
    if _signature_looks_like_primary_prose(stripped):
        return _signature_render_prose_fallback(stripped)
    if stripped and "\n" not in stripped and '"""' not in stripped and not stripped.startswith("(("):
        try:
            return "(" + _signature_parse_one(stripped) + ")"
        except Exception:
            pass
    sexprs = []
    for logical_line in _signature_split_commands(s):
        for line in _signature_split_top_level_forms(logical_line):
            try:
                sexprs.append(_signature_parse_one(line))
            except Exception as exc:
                head = str(line or "").strip().split(maxsplit=1)[0] if str(line or "").strip() else ""
                sexprs.append(_signature_syntax_error(head, str(exc), line))
    return "(" + " ".join(sexprs) + ")"


def reload_signature_commands(path=SIGNATURE_DECLARATIONS_PATH):
    """Reload command signatures from MeTTa declarations.

    This is primarily for tests and live development: optional organs should be
    able to expose new SkillSignature atoms without editing this parser module.
    """
    global SIGNATURE_COMMANDS, SIGNATURE_KNOWN_SPACES, SIGNATURE_MULTILINE_LOWERING
    global SIGNATURE_PROSE_FALLBACK, SIGNATURE_NO_ACTION_HEADS, SIGNATURE_SHORTHANDS
    global SIGNATURE_RECOVERY_HINTS, SIGNATURE_SKILL_CARDS
    SIGNATURE_COMMANDS = _load_signature_commands(path=path, fallback=SIGNATURE_BOOTSTRAP_COMMANDS)
    SIGNATURE_KNOWN_SPACES = _load_signature_spaces(path=path, fallback=SIGNATURE_BOOTSTRAP_SPACES)
    SIGNATURE_MULTILINE_LOWERING = _load_signature_lowerings(path=path)
    SIGNATURE_PROSE_FALLBACK = _load_signature_prose_fallback(path=path)
    SIGNATURE_NO_ACTION_HEADS = _load_signature_no_action_heads(path=path)
    SIGNATURE_SHORTHANDS = _load_signature_shorthands(path=path)
    SIGNATURE_RECOVERY_HINTS = _load_signature_recovery_hints(path=path)
    SIGNATURE_SKILL_CARDS = _load_skill_cards()
    return SIGNATURE_COMMANDS


def balance_parentheses(s):
    """Compatibility wrapper for the canonical SkillSignature parser."""
    return signature_balance_parentheses(s)
