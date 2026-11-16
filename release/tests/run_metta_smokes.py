#!/usr/bin/env python3
"""Run MeTTa smoke tests without accidentally touching live the agent memory.

This runner is intentionally conservative.  Many historical smoke files import
the full OmegaClaw runtime, which imports the live memory spaces used by the
running the agent instance.  Default mode only runs smoke files that are classified
as isolated.  Files that may read or mutate live memory are reported and skipped
unless the caller explicitly passes --allow-live-memory.
"""

from __future__ import annotations

import argparse
import dataclasses
import os
import pathlib
import re
import subprocess
import sys
from typing import Iterable


ROOT = pathlib.Path(__file__).resolve().parents[1]
SMOKE_DIR = ROOT / "tests"


def _default_omegaclaw_root() -> pathlib.Path:
    configured = os.environ.get("OMEGACLAW_ROOT")
    if configured:
        return pathlib.Path(configured).expanduser().resolve()
    for candidate in (ROOT, *ROOT.parents):
        if (candidate / "run.sh").exists():
            return candidate
    legacy = ROOT.parents[1] if len(ROOT.parents) > 1 else ROOT
    return legacy


OMEGACLAW_ROOT = _default_omegaclaw_root()

LIVE_SPACE_NAMES = ("persistent", "agenda", "beliefs", "world", "events", "activity", "cleanup", "attention", "assume")

LIVE_MEMORY_PATTERNS = {
    "imports-full-runtime": re.compile(r"lib_omegaclaw"),
    "mutates-persistent": re.compile(r"(?:add|remove)-atom\s+&persistent|export!\s+&persistent"),
    "mutates-world": re.compile(r"(?:add|remove)-atom\s+&world|export!\s+&world"),
    "mutates-beliefs": re.compile(r"(?:add|remove)-atom\s+&beliefs|export!\s+&beliefs"),
    "mutates-agenda": re.compile(r"(?:add|remove)-atom\s+&agenda|export!\s+&agenda"),
    "mutates-events": re.compile(r"(?:add|remove)-atom\s+&events|export!\s+&events"),
    "mutates-activity": re.compile(r"(?:add|remove)-atom\s+&activity|export!\s+&activity"),
    "mutates-cleanup": re.compile(r"(?:add|remove)-atom\s+&cleanup|export!\s+&cleanup"),
    "mutates-attention": re.compile(r"(?:add|remove)-atom\s+&attention|export!\s+&attention"),
    "mutates-assume": re.compile(r"(?:add|remove)-atom\s+&assume|export!\s+&assume"),
    "writes-files": re.compile(r"\b(?:write-file|append-file|write-file-base64|append-file-base64)\b"),
    "external-action": re.compile(
        r"\b(?:(?<!-)send(?!-)|send-whatsapp|send-telegram|send-file|use-house-affordance|"
        r"reply-whatsapp|mark-whatsapp-read|mark-whatsapp-unread|publish-artifact|unpublish-artifact)\b"
    ),
}


@dataclasses.dataclass(frozen=True)
class SmokeFile:
    path: pathlib.Path
    reasons: tuple[str, ...]
    isolated: bool


def _binds_temp_space(text: str, space: str) -> bool:
    return bool(re.search(rf"bind!\s+&{re.escape(space)}\s+\(new-space\)", text))


def classify(path: pathlib.Path) -> SmokeFile:
    text = path.read_text(encoding="utf-8", errors="replace")
    reasons = [name for name, pattern in LIVE_MEMORY_PATTERNS.items() if pattern.search(text)]

    # A file that mutates a space is still isolated if it explicitly rebinds
    # that same space to a fresh MeTTa space and does not import the full runtime.
    unresolved = []
    for reason in reasons:
        if reason.startswith("mutates-"):
            space = reason.removeprefix("mutates-")
            if not _binds_temp_space(text, space):
                unresolved.append(reason)
        else:
            unresolved.append(reason)

    isolated = not unresolved
    return SmokeFile(path=path, reasons=tuple(reasons), isolated=isolated)


def iter_smokes(selected: Iterable[str] | None = None) -> list[SmokeFile]:
    if selected:
        paths = [pathlib.Path(item) for item in selected]
        paths = [p if p.is_absolute() else ROOT / p for p in paths]
    else:
        paths = sorted(SMOKE_DIR.glob("*.metta"))
    return [classify(path) for path in paths]


def run_smoke(smoke: SmokeFile, timeout: int) -> subprocess.CompletedProcess[str]:
    runner = OMEGACLAW_ROOT / "run.sh"
    if not runner.exists():
        raise FileNotFoundError(
            f"run.sh not found under {OMEGACLAW_ROOT}; set OMEGACLAW_ROOT to a runtime checkout"
        )
    env = os.environ.copy()
    env["OMEGACLAW_RUN_INNER"] = "1"
    return subprocess.run(
        [str(runner), str(smoke.path)],
        cwd=str(OMEGACLAW_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
        timeout=timeout,
        env=env,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="*", help="Optional smoke files to classify/run")
    parser.add_argument("--list", action="store_true", help="Only list classifications")
    parser.add_argument("--allow-live-memory", action="store_true", help="Allow risky live-memory smoke files")
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args(argv)

    smokes = iter_smokes(args.files)
    exit_code = 0
    for smoke in smokes:
        state = "isolated" if smoke.isolated else "live-memory-risk"
        reason_text = ",".join(smoke.reasons) if smoke.reasons else "none"
        rel = smoke.path.relative_to(ROOT)
        print(f"{state}\t{rel}\t{reason_text}")
        if args.list:
            continue
        if not smoke.isolated and not args.allow_live_memory:
            continue
        try:
            result = run_smoke(smoke, args.timeout)
        except subprocess.TimeoutExpired as exc:
            print(f"TIMEOUT\t{rel}\t{exc}")
            exit_code = 1
            continue
        print(result.stdout[-12000:])
        if result.returncode != 0:
            print(f"FAILED\t{rel}\texit={result.returncode}")
            exit_code = 1
        if re.search(r"(?:^|\n)(?:\x1b\[[0-9;]*m)*[A-Z0-9-]*FAILED-[A-Z0-9-]*\b", result.stdout):
            print(f"FAILED\t{rel}\tsemantic-failure-sentinel")
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
