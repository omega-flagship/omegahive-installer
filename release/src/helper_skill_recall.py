"""Deterministic input signal extraction for symbolic skill recall.

This module does not choose skills. It only turns fresh user text into factual
signals that MeTTa can match against SkillTrigger atoms in the &skills space.
"""

from __future__ import annotations

import re


QUESTION_WORDS = {
    "can",
    "could",
    "do",
    "does",
    "how",
    "should",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "would",
}

FILE_SUFFIXES = {
    ".css",
    ".csv",
    ".html",
    ".js",
    ".json",
    ".md",
    ".metta",
    ".py",
    ".sh",
    ".txt",
    ".yaml",
    ".yml",
}

TOKEN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{1,48}")


def _metta_string(value: str) -> str:
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def input_skill_signals(text: str, max_words: int = 24) -> list[str]:
    """Return factual symbolic signals visible in the raw input text."""

    raw = str(text or "")
    lowered = raw.lower()
    signals: list[str] = []

    words = [match.group(0).lower() for match in TOKEN_RE.finditer(lowered)]
    if "?" in raw or any(word in QUESTION_WORDS for word in words[:4]):
        signals.append("has-question")
    if "http://" in lowered or "https://" in lowered:
        signals.append("has-url")
    if "```" in raw or any(marker in raw for marker in ("(", ")", "{", "}", "$")):
        signals.append("has-code-shape")
    if "/" in raw or any(suffix in lowered for suffix in FILE_SUFFIXES):
        signals.append("has-file-reference")

    seen = set(signals)
    mentioned = 0
    for word in words:
        signal = f"mentions-word:{word}"
        if signal not in seen:
            signals.append(signal)
            seen.add(signal)
            mentioned += 1
        if mentioned >= max_words:
            break
    return signals


def input_skill_signals_expr(text: str, max_words: int = 24) -> str:
    """Return a MeTTa list expression containing factual input signals."""

    return "(" + " ".join(_metta_string(signal) for signal in input_skill_signals(text, max_words)) + ")"
