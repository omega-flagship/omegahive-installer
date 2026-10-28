# Extracted from helper.py to keep OmegaClaw membranes reviewable.
from collections import deque
import os
import pathlib
from datetime import datetime
import re

CORE_ROOT = pathlib.Path(__file__).resolve().parents[1]
MEMORY_DIR = pathlib.Path(os.environ.get("OMEGACLAW_MEMORY_DIR", CORE_ROOT / "memory"))
HISTORY_FILE = MEMORY_DIR / "history.metta"
TS_RE = re.compile(r'^\("(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})"')
EPISODE_RESULT_MAX_CHARS = 6000
DATE_ONLY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
LONG_HISTORY_TOKEN_RE = re.compile(r"[A-Za-z0-9+/=_-]{220,}")

def extract_timestamp(line):
    m = TS_RE.search(line)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None

def coerce_recall_lines(k, default=20, low=1, high=200):
    try:
        if isinstance(k, (list, tuple)):
            if len(k) == 1:
                k = k[0]
            else:
                return default
        text = str(k).strip()
        if text in {"", "[]", "()", "empty", "None", "[maxEpisodeRecallLines]", "maxEpisodeRecallLines"}:
            return default
        n = int(float(text))
        return max(low, min(high, n))
    except Exception:
        return default

def coerce_context_chars(n, default=EPISODE_RESULT_MAX_CHARS, low=500, high=50000):
    try:
        if isinstance(n, (list, tuple)):
            if len(n) == 1:
                n = n[0]
            else:
                return default
        text = str(n).strip()
        if text in {"", "[]", "()", "empty", "None", "[maxEpisodeResultChars]", "maxEpisodeResultChars"}:
            return default
        value = int(float(text))
        return max(low, min(high, value))
    except Exception:
        return default

def _raw_time_text(raw):
    return str(raw or "").replace(r'\"', '').replace('"', '').strip()

def _is_date_only(raw):
    return bool(DATE_ONLY_RE.fullmatch(_raw_time_text(raw)))

def _compact_long_history_tokens(text):
    def replace(match):
        return f"<long-token chars={len(match.group(0))}>"
    return LONG_HISTORY_TOKEN_RE.sub(replace, str(text or ""))

def _bounded_episode_text(text, max_chars):
    text = _compact_long_history_tokens(text)
    if len(text) <= max_chars:
        return text
    head_chars = max(250, max_chars // 2)
    tail_chars = max(250, max_chars - head_chars)
    omitted = len(text) - head_chars - tail_chars
    return (
        f"EPISODES-CONTEXT-BOUNDED compacted_chars={len(text)} "
        f"shown_head_chars={head_chars} shown_tail_chars={tail_chars} "
        f"omitted_chars={max(0, omitted)}\n"
        + text[:head_chars]
        + "\n<episodes-middle-omitted>\n"
        + text[-tail_chars:]
    )

def _iter_history_entries(filename=None):
    filename = pathlib.Path(filename) if filename else HISTORY_FILE
    if not filename.exists():
        return
    current_lineno = None
    current_ts = None
    current_lines = []
    with filename.open("r", encoding="utf-8", errors="replace") as handle:
        for lineno, line in enumerate(handle, 1):
            ts = extract_timestamp(line)
            if ts is not None:
                if current_lines:
                    yield current_lineno, current_ts, "".join(current_lines)
                current_lineno = lineno
                current_ts = ts
                current_lines = [line]
            elif current_lines:
                current_lines.append(line)
    if current_lines:
        yield current_lineno, current_ts, "".join(current_lines)

def _compact_episode_entry(lineno, ts, entry, max_entry_chars):
    body = str(entry or "").replace("\n", " ")
    body = re.sub(r'^\("\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"\s*', "", body).strip()
    body = re.sub(r"\s+", " ", _compact_long_history_tokens(body))
    if len(body) > max_entry_chars:
        body = body[: max(0, max_entry_chars - 34)].rstrip() + f" <entry-tail-omitted chars={len(body)}>"
    return f"{lineno}:{ts.strftime('%Y-%m-%d %H:%M:%S')} {body}"

def around_time(needle_time_str, k, filename=None):
    needle_time_str = needle_time_str.replace(r'\"', '').replace('"', '').strip()
    k = coerce_recall_lines(k)
    filename = pathlib.Path(filename) if filename else HISTORY_FILE
    if not filename.exists():
        return None
    target = datetime.strptime(needle_time_str, "%Y-%m-%d %H:%M:%S")
    best_lineno = None
    best_line = None
    best_diff = None
    buffer = []
    best_idx = None
    with filename.open("r", encoding="utf-8", errors="replace") as f:
        for lineno, line in enumerate(f, 1):
            buffer.append((lineno, line))
            ts = extract_timestamp(line)
            if ts is None:
                continue
            diff = abs((ts - target).total_seconds())
            if best_diff is None or diff < best_diff:
                best_diff = diff
                best_lineno = lineno
                best_line = line
                best_idx = len(buffer) - 1
    if best_lineno is None:
        return
    start = max(0, best_idx - k)
    end = min(len(buffer), best_idx + k + 1)
    ret = ""
    for lineno, line in buffer[start:end]:
        ret += f"{lineno}:{line}"
    return ret

def episodes_on_date(raw_date, k=20, max_chars=EPISODE_RESULT_MAX_CHARS, filename=None):
    date = _raw_time_text(raw_date)
    if not DATE_ONLY_RE.fullmatch(date):
        return None
    k = coerce_recall_lines(k)
    max_chars = coerce_context_chars(max_chars)
    entries = [
        (lineno, ts, entry)
        for lineno, ts, entry in _iter_history_entries(filename)
        if ts.strftime("%Y-%m-%d") == date
    ]
    if not entries:
        return f"EPISODES-NOT-FOUND {date}"
    shown = entries[-k:]
    per_entry = max(180, min(650, max_chars // max(1, len(shown))))
    lines = [_compact_episode_entry(lineno, ts, entry, per_entry) for lineno, ts, entry in shown]
    omitted = len(entries) - len(shown)
    header = f"EPISODES-ON {date} entries_shown={len(shown)} total_entries={len(entries)}"
    if omitted > 0:
        header += f" older_entries_omitted={omitted}; use episodes-at YYYY-MM-DD HH:MM to inspect a precise window"
    return _bounded_episode_text(header + "\n" + "\n".join(lines), max_chars)

def normalize_episode_time(raw, now=None):
    now = now or datetime.now()
    text = str(raw or "").replace(r'\"', '').replace('"', '').strip()
    if not text:
        return None
    formats = [
        ("%Y-%m-%d %H:%M:%S", None),
        ("%Y-%m-%d %H:%M", ":00"),
        ("%Y-%m-%d", " 00:00:00"),
        ("%H:%M:%S", "today"),
        ("%H:%M", "today_seconds"),
    ]
    for fmt, suffix in formats:
        try:
            datetime.strptime(text, fmt)
        except ValueError:
            continue
        if suffix == ":00":
            return text + ":00"
        if suffix == " 00:00:00":
            return text + " 00:00:00"
        if suffix == "today":
            return now.strftime("%Y-%m-%d") + " " + text
        if suffix == "today_seconds":
            return now.strftime("%Y-%m-%d") + " " + text + ":00"
        return text
    return None

def episodes_at(raw, k=20, max_chars=EPISODE_RESULT_MAX_CHARS):
    k = coerce_recall_lines(k)
    max_chars = coerce_context_chars(max_chars)
    if _is_date_only(raw):
        return episodes_on_date(raw, k, max_chars)
    normalized = normalize_episode_time(raw)
    if not normalized:
        return "EPISODES-FORMAT-ERROR use YYYY-MM-DD HH:MM:SS, YYYY-MM-DD HH:MM, YYYY-MM-DD, or HH:MM"
    result = around_time(normalized, k)
    if not result:
        return f"EPISODES-NOT-FOUND {normalized}"
    header = "EPISODES-AT " + normalized
    if len(result) > max_chars:
        result = _bounded_episode_text(result, max_chars)
    return header + "\n" + result
