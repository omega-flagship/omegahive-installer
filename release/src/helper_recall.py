# Deterministic memory recall helpers for context construction.
#
# These functions do not decide what the agent should think or do. They provide
# a bounded retrieval membrane over Chroma/promotions so the MeTTa loop can add
# relevant memory hints without creating a nondeterministic query surface.

from __future__ import annotations

import os
import pathlib
import re
import time
from datetime import datetime
from typing import Any

try:
    from . import helper_promotion as promotion
    from .helper_history import _iter_history_entries
except Exception:  # pragma: no cover - direct script import fallback
    import helper_promotion as promotion
    from helper_history import _iter_history_entries


CORE_ROOT = pathlib.Path(__file__).resolve().parents[1]
MEMORY_DIR = pathlib.Path(os.environ.get("OMEGACLAW_MEMORY_DIR", CORE_ROOT / "memory"))


def _as_int(value: Any, default: int, minimum: int = 1, maximum: int = 200) -> int:
    try:
        parsed = int(float(value))
    except Exception:
        parsed = default
    return max(minimum, min(maximum, parsed))


def _promotion_score(item_id: str, current_time: float) -> float:
    try:
        value = promotion.promotion_get_value(item_id, 0.0) or 0.0
    except Exception:
        return 0.0
    if value <= 0.0:
        return 0.0
    try:
        last_time = promotion.promotion_get_lasttime(item_id, 0.0) or 0.0
    except Exception:
        last_time = 0.0
    age_days = max(0.0, (current_time - float(last_time)) / 86400.0)
    return float(value) * ((1.0 + age_days) ** -0.7)


def _clean_dialogue_text(text: str) -> str:
    text = str(text or "")
    text = text.replace("_newline_", "\n")
    text = text.replace(r'\"', '"').replace("_quote_", '"').replace("_apostrophe_", "'")
    return re.sub(r"\s+", " ", text).strip().strip('"')


def _iso_or_epoch_to_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if hasattr(value, "timestamp"):
        return value
    try:
        return datetime.fromtimestamp(float(value))
    except Exception:
        pass
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
        return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed
    except Exception:
        return None


def _seconds_between(newer: datetime | None, older: datetime | None) -> str:
    if not newer or not older:
        return "unknown"
    return str(max(0, int((newer - older).total_seconds())))


def _message_line_from_entry(entry: str) -> str:
    text = str(entry or "")
    if "HUMAN_MESSAGE:" not in text:
        return ""
    text = text.split("HUMAN_MESSAGE:", 1)[1]
    text = re.split(r'\n\s*\(\(|\n\s*"\(\(|\n\s+"RESULTS:', text, maxsplit=1)[0]
    return _clean_dialogue_text(text)


def _chat_id_base(raw_id: str) -> str:
    raw_id = str(raw_id or "").strip()
    return raw_id.split("::", 1)[0] if raw_id else ""


def _speaker_turn_from_text(
    text: str,
    ts: datetime | None = None,
    current_time: float | None = None,
) -> dict[str, Any] | None:
    text = _clean_dialogue_text(text)
    if not text or "DO NOT RE-SEND OR SPAM" in text:
        return None
    text = re.sub(r"^\(?\s*HUMAN-MSG:\s*", "", text).strip()
    text = re.sub(r"^HUMAN_MESSAGE:\s*", "", text).strip()
    if text.endswith(")"):
        text = text[:-1].strip()

    source = "unknown"
    channel_label = "unknown"
    chat_id = ""
    speaker = "unknown"
    message = text
    turn_time = ts

    if text.startswith("WHATSAPP:"):
        source = "WHATSAPP"
        body = text[len("WHATSAPP:"):].strip()
        rich = re.match(r"^(?P<prefix>.*):\s*(?P<speaker>[^:]{1,80}):\s*(?P<message>.*)$", body)
        simple = re.match(r"^(?P<speaker>[^:]{1,80}):\s*(?P<message>.*)$", body)
        if rich and (" id=" in rich.group("prefix") or " at=" in rich.group("prefix")):
            prefix = rich.group("prefix").strip()
            speaker = rich.group("speaker").strip()
            message = rich.group("message").strip()
            channel_label = prefix.split()[0] if prefix else "unknown"
            id_match = re.search(r"\bid=([^\s]+)", prefix)
            at_match = re.search(r"\bat=([^\s]+)", prefix)
            if id_match:
                chat_id = _chat_id_base(id_match.group(1))
            if at_match:
                turn_time = _iso_or_epoch_to_datetime(at_match.group(1)) or turn_time
        elif simple:
            speaker = simple.group("speaker").strip()
            message = simple.group("message").strip()
    else:
        parts = [part.strip() for part in text.split(":") if part.strip()]
        if len(parts) >= 2 and len(parts[-2]) <= 80:
            speaker = parts[-2]
            message = parts[-1]

    if not turn_time and current_time is not None:
        turn_time = _iso_or_epoch_to_datetime(current_time)
    channel_key = f"{source}:{chat_id or channel_label}"
    return {
        "source": source,
        "channel_label": channel_label,
        "chat_id": chat_id,
        "channel_key": channel_key,
        "speaker": speaker,
        "text": message,
        "time": turn_time,
    }


def _quote_field(text: str, limit: int = 500) -> str:
    text = _clean_dialogue_text(text)[:limit]
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def recent_dialogue_turns(
    current_input: str = "",
    max_turns: int = 6,
    current_time: float | None = None,
) -> list[dict[str, Any]]:
    """Return recent human dialogue turns without resolving pronouns or topics."""
    max_turns = _as_int(max_turns, 6, 1, 20)
    history_turns: list[dict[str, Any]] = []
    try:
        entries = list(_iter_history_entries(MEMORY_DIR / "history.metta"))
    except Exception:
        entries = []
    for _lineno, ts, entry in entries:
        turn = _speaker_turn_from_text(_message_line_from_entry(entry), ts=ts)
        if turn:
            history_turns.append(turn)
    current_turn = _speaker_turn_from_text(current_input, current_time=current_time)
    if current_turn:
        current_key = current_turn.get("channel_key")
        if current_key and current_key != "unknown:unknown":
            history_turns = [turn for turn in history_turns if turn.get("channel_key") == current_key]
        history_turns.append(current_turn)
    turns = history_turns[-max_turns:]

    last_by_channel: dict[str, datetime] = {}
    last_by_channel_speaker: dict[tuple[str, str], datetime] = {}
    reference_time = turns[-1].get("time") if turns else None
    for turn in turns:
        channel_key = str(turn.get("channel_key") or "unknown:unknown")
        speaker = str(turn.get("speaker") or "unknown")
        turn_time = turn.get("time")
        turn["channel_gap_seconds"] = _seconds_between(turn_time, last_by_channel.get(channel_key))
        turn["same_speaker_gap_seconds"] = _seconds_between(
            turn_time, last_by_channel_speaker.get((channel_key, speaker))
        )
        turn["age_seconds"] = _seconds_between(reference_time, turn_time)
        if turn_time:
            last_by_channel[channel_key] = turn_time
            last_by_channel_speaker[(channel_key, speaker)] = turn_time
    return turns[-max_turns:]


def dialogue_frame(
    current_input: str = "",
    max_turns: int = 6,
    max_chars: int = 1600,
    current_time: float | None = None,
) -> str:
    """Render a mechanical recent-turn frame for pronoun/reference grounding."""
    turns = recent_dialogue_turns(current_input, max_turns, current_time=current_time)
    if not turns:
        return ""
    current_speaker = turns[-1]["speaker"]
    current_channel = turns[-1].get("channel_key", "unknown:unknown")
    lines = [
        f"DIALOGUE_FRAME view_kind=recent-speaker-turns-no-resolution current_speaker={_quote_field(current_speaker, 80)} current_channel={_quote_field(current_channel, 160)}",
        "meaning=literal recent dialogue turns for Omega to infer current referents",
        "policy=no pronoun resolution, no topic selection, no durable preference update",
        "speaker_context=same-speaker turns are evidence, not automatic referents",
        "channel_policy=when current chat id is known, include only turns from that chat",
    ]
    start_rel = 1 - len(turns)
    for offset, turn in enumerate(turns):
        speaker = turn["speaker"]
        rel = start_rel + offset
        if rel == 0:
            relation = "current"
        elif speaker == current_speaker:
            relation = "same-speaker"
        else:
            relation = "other-speaker"
        lines.append(
            f"TURN rel={rel} speaker_relation={relation} "
            f"source={_quote_field(turn.get('source', 'unknown'), 80)} "
            f"channel={_quote_field(turn.get('channel_key', 'unknown:unknown'), 160)} "
            f"time={_quote_field(turn.get('time').strftime('%Y-%m-%d %H:%M:%S') if turn.get('time') else 'unknown', 40)} "
            f"age_seconds={turn.get('age_seconds', 'unknown')} "
            f"channel_gap_seconds={turn.get('channel_gap_seconds', 'unknown')} "
            f"same_speaker_gap_seconds={turn.get('same_speaker_gap_seconds', 'unknown')} "
            f"speaker={_quote_field(speaker, 80)} text={_quote_field(turn['text'], 500)}"
        )
    rendered = "\n".join(lines)
    try:
        max_chars = max(0, int(float(max_chars)))
    except Exception:
        max_chars = 1600
    if max_chars and len(rendered) > max_chars:
        return rendered[-max_chars:]
    return rendered


def dialogue_recall_basis_text(
    current_input: str = "",
    max_turns: int = 6,
    current_time: float | None = None,
) -> str:
    turns = recent_dialogue_turns(current_input, max_turns, current_time=current_time)
    return "\n".join(
        f"[{turn.get('channel_key', 'unknown:unknown')}] {turn['speaker']}: {turn['text']}"
        for turn in turns
    )


def context_input_recall(
    query_embedding: list[float],
    max_items: int = 8,
    promotion_inflation_factor: int = 10,
    max_recall_items: int = 20,
    current_time: float | None = None,
) -> str:
    """Return a bounded, deterministic text block of relevant memory hints.

    The underlying memory store remains Chroma plus the promotion map. This
    helper only performs retrieval/ranking for prompt context; it does not create
    beliefs, mutate memories, or choose actions.
    """
    import lib_chromadb

    k = _as_int(max_items, 8, 0, 50)
    if k <= 0:
        return ""

    recall_items = _as_int(max_recall_items, 20, 1, 200)
    inflation = _as_int(promotion_inflation_factor, 10, 1, 50)
    query_count = max(k, recall_items * inflation)
    now = float(current_time if current_time is not None else time.time())

    rows = lib_chromadb.query_with_ids_and_dists(query_embedding, query_count)
    if not rows:
        return ""

    promoted = sorted(
        (row for row in rows if _promotion_score(row[0], now) > 0.0),
        key=lambda row: (-_promotion_score(row[0], now), float(row[3])),
    )
    closest = sorted(rows, key=lambda row: float(row[3]))

    selected: list[tuple[str | None, str]] = []
    seen: set[str] = set()
    for row in [*promoted, *closest]:
        item_id, timestamp, content, _distance = row
        if item_id in seen:
            continue
        seen.add(item_id)
        selected.append((timestamp, content))
        if len(selected) >= k:
            break

    return repr(selected)


def context_input_recall_text(
    query_text: str,
    max_items: int = 8,
    promotion_inflation_factor: int = 10,
    max_recall_items: int = 20,
    current_time: float | None = None,
    embedding_provider: str = "Local",
) -> str:
    """Embed text and return bounded memory hints as one deterministic value.

    Uses the same embedding source as the rest of memory (``embeddingprovider``).
    Recall is a hint: if embedding fails it returns "" so the message itself
    still reaches the model instead of the whole loop iteration failing.
    """
    import lib_llm_ext

    if not isinstance(query_text, str) or not query_text.strip():
        return ""
    frame = dialogue_frame(query_text, current_time=current_time)
    recall_basis = dialogue_recall_basis_text(query_text, current_time=current_time) or query_text

    def embed(text: str) -> list[float]:
        if str(embedding_provider) != "Local":
            import openai

            model = os.environ.get("OMEGACLAW_OPENAI_EMBEDDING_MODEL", "text-embedding-3-large")
            return openai.OpenAI().embeddings.create(model=model, input=text).data[0].embedding
        try:
            return lib_llm_ext.useLocalEmbedding(text)
        except RuntimeError:
            lib_llm_ext.initLocalEmbedding()
            return lib_llm_ext.useLocalEmbedding(text)

    try:
        query_embedding = embed(query_text)
    except Exception as exc:
        print(f"[helper_recall] input recall skipped: {type(exc).__name__}: {exc}")
        return ""
    raw_recall = context_input_recall(
        query_embedding,
        max_items=max_items,
        promotion_inflation_factor=promotion_inflation_factor,
        max_recall_items=max_recall_items,
        current_time=current_time,
    )
    if not frame:
        return raw_recall

    dialogue_recall = context_input_recall(
        embed(recall_basis),
        max_items=max_items,
        promotion_inflation_factor=promotion_inflation_factor,
        max_recall_items=max_recall_items,
        current_time=current_time,
    )
    return (
        frame
        + "\nLANE current_utterance_semantic meaning=embedding search using current input only\n"
        + raw_recall
        + "\nLANE dialogue_context_semantic meaning=embedding search using recent dialogue turns\n"
        + dialogue_recall
    )
