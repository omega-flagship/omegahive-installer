#!/usr/bin/env python3
"""Reviewer-facing benchmark comparison harness.

The suite compares a baseline checkout, defaulting to HEAD, against the current
candidate tree. It measures review claims without becoming part of runtime
cognition. Live LLM/image/code workloads are represented by syntax and surface
probes by default; actual token spend is read from the local cost ledger.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]

COMMAND_CASES = [
    "send dinner is ready: plates are out",
    'remember user said "test carefully" before changing syntax',
    "pin FOCUSED | tracker rebuild: privacy repair",
    "shell find memory/web -maxdepth 2 -type f",
    'space-transform persistent (PersistentNote "omega" $note $conf) events (Event "omega" "merged" "ok" "0.9") cleanup duplicate notes',
    (
        "pin FOCUSED | tracker rebuild: privacy repair\n"
        "send Done: tracker rebuilt\n"
        "remember privacy lesson: General only contains non-private items"
    ),
    'write-file /tmp/test.txt """\nDinner is ready:\n- plates out\n- glucose checked\n"""',
    'space-transform persistent (PersistentNote "omega" $note events (Event "omega" "bad" "0.9") cleanup',
    'write-file /tmp/test.txt "<html><body>Hi: ok</body></html>"',
]

WORKLOAD_CASES = [
    ("chat", "send Status acknowledged; testing the new module surface", "send syntax"),
    ("create-image", "generate-image a warm shared workspace with soft morning light", "media affordance"),
    ("write-code", 'write-file /tmp/agent_bench.py "print(42)"', "file/code writing"),
    (
        "reason",
        'metta (|- ((--> sample-agent careful) (stv 0.9 0.8)) ((==> (--> sample-agent careful) (--> sample-agent safe)) (stv 0.8 0.7)))',
        "symbolic reasoning call",
    ),
    ("assume-predict", "assume-predict smart-habitat movie-evening", "prediction organ"),
    ("remote-agent", "agentverse-discover research agent for verified source lookup", "remote-agent discovery"),
    ("scratch", 'scratch-add (ScratchDraft bench "temporary thought, not memory")', "ephemeral scratch"),
]

OUTPUT_FORMAT_TEXT = (
    " OUTPUT_FORMAT: Up to 5 lines, do not wrap quotes around args, do not use variables:\n"
    " toolName1 arg1\n"
    " toolName2 arg2\n"
    " toolName3 arg3\n"
    " toolName4 arg4\n"
    " toolName5 arg5\n"
)

FIXED_TIME_TEXT = "2026-05-24 12:00:00"

CONTEXT_FIXTURE_PROMPT = "\n".join(
    [
        "Agent benchmark persona fixture.",
        "Maintain continuity, use skills deliberately, and preserve symbolic memory.",
        "Prefer clear MeTTa commands and report exact failures without inventing success.",
        "You are allowed to be proactive, but avoid spam and verify outcomes.",
    ]
)

CONTEXT_FIXTURE_HISTORY = "\n".join(
    f'("2026-05-24 10:{i % 60:02d}:00" HUMAN_MESSAGE: "fixture message {i}" '
    f'((remember "fixture memory {i}: shared-care, environment state, symbolic trace")) '
    f'RESULTS: (COMMAND_RETURN: ((remember "fixture memory {i}") REMEMBER-SUCCESS)))'
    for i in range(360)
)

CONTEXT_FIXTURE_PROMOTED = (
    '("fixture-promoted-1" "Residents prefer explicit confirmation before environment actions" 0.9) '
    '("fixture-promoted-2" "Use exact entity ids for delicate lighting scenes" 0.8)'
)

CONTEXT_CASES = [
    {
        "name": "idle",
        "lastresults": "",
        "lastmessage": " DO NOT RE-SEND OR SPAM!",
        "description": "autonomous cycle with no fresh inbound message",
    },
    {
        "name": "fresh-message",
        "lastresults": "",
        "lastmessage": 'HUMAN-MSG: Operator says "can you check the living room lights?"',
        "description": "fresh user message routed into the loop",
    },
    {
        "name": "tool-heavy-feedback",
        "lastresults": "\n".join(
            f'(COMMAND_RETURN: ((observe-device "living-light-{i}") '
            f'"state=on brightness={40 + i % 50} color_temp={2700 + i * 10}"))'
            for i in range(600)
        ),
        "lastmessage": 'HUMAN-MSG: Operator says "summarise the house state before acting"',
        "description": "large previous tool results trimmed by maxFeedback",
    },
]

FOOTPRINT_DIRS = ("channels", "demos", "docs", "modules", "src", "tests")
FOOTPRINT_EXCLUDE_PARTS = {".git", "__pycache__", "node_modules", "auth", "auth_omega"}


@dataclass
class Target:
    name: str
    path: Path


def run(args: list[str], *, cwd: Path | None = None, timeout: int = 120, check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=cwd,
        timeout=timeout,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=check,
    )


def make_baseline_worktree() -> Path:
    parent = Path(tempfile.mkdtemp(prefix="omegaclaw-bench-"))
    worktree = parent / "core-head"
    run(["git", "worktree", "add", "--detach", str(worktree), "HEAD"], cwd=ROOT, check=True)
    return worktree


def cleanup_baseline(worktree: Path) -> None:
    parent = worktree.parent
    run(["git", "worktree", "remove", str(worktree), "--force"], cwd=ROOT)
    shutil.rmtree(parent, ignore_errors=True)


def python_for(target: Path) -> str:
    venv_python = target / ".venv" / "bin" / "python"
    return str(venv_python) if venv_python.exists() else sys.executable


def parser_benchmark(target: Target, loops: int) -> dict:
    code = r'''
import json
import pathlib
import sys
import timeit

root = pathlib.Path(sys.argv[1])
cases = json.loads(sys.argv[2])
loops = int(sys.argv[3])
sys.path.insert(0, str(root / "src"))

try:
    import helper_command_parser as parser
    fn = parser.signature_balance_parentheses
    impl = "helper_command_parser.signature_balance_parentheses"
    signature_count = len(getattr(parser, "SIGNATURE_COMMANDS", []))
except Exception:
    import helper as parser
    fn = parser.balance_parentheses
    impl = "helper.balance_parentheses"
    signature_count = None

errors = []
for case in cases:
    try:
        fn(case)
    except Exception as exc:
        errors.append({"case": case, "error": repr(exc)})

def parse_all():
    for case in cases:
        fn(case)

elapsed = timeit.timeit(parse_all, number=loops)
print(json.dumps({
    "impl": impl,
    "loops": loops,
    "cases": len(cases),
    "total_parses": loops * len(cases),
    "total_s": elapsed,
    "us_per_parse": elapsed / (loops * len(cases)) * 1_000_000,
    "parses_per_second": (loops * len(cases)) / elapsed,
    "signature_count": signature_count,
    "errors": errors,
}, sort_keys=True))
'''
    result = run(
        [python_for(target.path), "-c", code, str(target.path), json.dumps(COMMAND_CASES), str(loops)],
        cwd=target.path,
        timeout=60,
    )
    if result.returncode != 0:
        return {"error": result.stdout.strip(), "returncode": result.returncode}
    return json.loads(result.stdout)


def parser_workload_probe(target: Target) -> dict:
    code = r'''
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
workloads = json.loads(sys.argv[2])
sys.path.insert(0, str(root / "src"))

try:
    import helper_command_parser as parser
    fn = parser.signature_balance_parentheses
    impl = "helper_command_parser.signature_balance_parentheses"
except Exception:
    import helper as parser
    fn = parser.balance_parentheses
    impl = "helper.balance_parentheses"

rows = []
for name, request, measures in workloads:
    try:
        output = str(fn(request))
        rows.append({"name": name, "measures": measures, "ok": True, "output_preview": output[:220], "error": ""})
    except Exception as exc:
        rows.append({"name": name, "measures": measures, "ok": False, "output_preview": "", "error": repr(exc)})
print(json.dumps({"impl": impl, "rows": rows}, sort_keys=True))
'''
    result = run(
        [python_for(target.path), "-c", code, str(target.path), json.dumps(WORKLOAD_CASES)],
        cwd=target.path,
        timeout=60,
    )
    if result.returncode != 0:
        return {"error": result.stdout.strip(), "returncode": result.returncode}
    return json.loads(result.stdout)


def repo_footprint(target: Target) -> dict:
    files = 0
    bytes_total = 0
    by_dir: dict[str, dict[str, int]] = {}
    for dirname in FOOTPRINT_DIRS:
        root = target.path / dirname
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            parts = set(path.relative_to(target.path).parts)
            if parts.intersection(FOOTPRINT_EXCLUDE_PARTS):
                continue
            if path.suffix in {".pyc", ".png", ".jpg", ".jpeg", ".gif", ".mp4", ".webm"}:
                continue
            try:
                size = path.stat().st_size
            except OSError:
                continue
            files += 1
            bytes_total += size
            entry = by_dir.setdefault(dirname, {"files": 0, "bytes": 0})
            entry["files"] += 1
            entry["bytes"] += size
    return {"files": files, "bytes": bytes_total, "by_dir": by_dir}


def surface_counts(target: Target) -> dict:
    signature_files = list((target.path / "src").glob("skill_signatures*.metta"))
    signature_files += list((target.path / "modules").glob("*/signatures.metta"))
    catalog_files = list((target.path / "src").glob("skill_catalog*.metta"))
    catalog_files += list((target.path / "modules").glob("*/catalog.metta"))
    skill_files = [target.path / "src" / "skills.metta"]
    skill_files += list((target.path / "src").glob("skills_*.metta"))
    skill_files += list((target.path / "modules").glob("*/skills.metta"))
    modules = list((target.path / "modules").glob("*/entry.metta"))

    def read_all(paths: list[Path]) -> str:
        return "\n".join(path.read_text(encoding="utf-8", errors="replace") for path in paths if path.exists())

    return {
        "modules": len(modules),
        "signature_files": len(signature_files),
        "skill_signatures": len(re.findall(r"\(SkillSignature\s+", read_all(signature_files))),
        "catalog_files": len(catalog_files),
        "skill_help_atoms": len(re.findall(r"\(SkillHelp\s+", read_all(catalog_files))),
        "skill_files": len([path for path in skill_files if path.exists()]),
        "skill_definitions": len(re.findall(r"\(=\s+\([A-Za-z0-9_-]+", read_all(skill_files))),
    }


def _configured_int(target: Target, name: str, default: int) -> int:
    memory = target.path / "src" / "memory.metta"
    loop = target.path / "src" / "loop.metta"
    text = ""
    for path in (memory, loop):
        if path.exists():
            text += "\n" + path.read_text(encoding="utf-8", errors="replace")
    match = re.search(rf"\(configure\s+{re.escape(name)}\s+([0-9]+)\)", text)
    return int(match.group(1)) if match else default


def _last_chars(text: str, count: int) -> str:
    text = str(text or "")
    return text[-count:] if count and len(text) > count else text


def _quoted_strings(text: str) -> list[str]:
    values = []
    escaped = False
    in_quote = False
    current = []
    for ch in text:
        if not in_quote:
            if ch == '"':
                in_quote = True
                current = []
            continue
        if ch == '"' and not escaped:
            values.append("".join(current))
            in_quote = False
            current = []
            continue
        if escaped:
            current.append({"n": "\n", "r": "\r", "t": "\t"}.get(ch, ch))
            escaped = False
        elif ch == "\\":
            escaped = True
        else:
            current.append(ch)
    return values


def _metta_getskills_literal(target: Path) -> str:
    """Return a literal getSkills body when the loop injects one directly.

    Some modular builds keep the full SkillCatalog available for discovery but
    intentionally slim the always-injected context line. Benchmark prompt
    pressure should measure what getContext actually calls, not every skill card
    that can be queried later through &skills.
    """
    path = target / "src" / "skill_catalog.metta"
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8", errors="replace")
    match = re.search('\\(=\\s+\\(getSkills\\)\\s*\\n\\s*\\"((?:\\\\.|[^\\"])*)\\"\\s*\\)', text, re.S)
    if not match:
        return ""
    return bytes(match.group(1), "utf-8").decode("unicode_escape")


def _candidate_skill_catalog_text(target: Path) -> str:
    code = r'''
import pathlib
import sys
root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root / "src"))
try:
    import helper_command_parser
    print(helper_command_parser.skill_catalog())
except Exception:
    print("")
'''
    result = run([python_for(target), "-c", code, str(target)], cwd=target, timeout=30)
    return result.stdout.strip() if result.returncode == 0 else ""


def skill_prompt_text(target: Target) -> str:
    literal = _metta_getskills_literal(target.path)
    if literal:
        return literal
    catalog = _candidate_skill_catalog_text(target.path)
    if catalog:
        return catalog
    skills = target.path / "src" / "skills.metta"
    if not skills.exists():
        return ""
    text = skills.read_text(encoding="utf-8", errors="replace")
    strings = _quoted_strings(text)
    return "\n".join(value for value in strings if value.strip())

def estimate_tokens(text: str) -> int:
    # Deliberately simple and stable: enough for regression comparison without
    # binding this review tool to a provider-specific tokenizer.
    return max(1, round(len(str(text or "")) / 4))


def context_fixture_benchmark(target: Target) -> dict:
    max_history = _configured_int(target, "maxHistory", 30000)
    max_feedback = _configured_int(target, "maxFeedback", 50000)
    has_promoted_hints = "promoted-memory-hints" in (target.path / "src" / "loop.metta").read_text(
        encoding="utf-8", errors="replace"
    ) if (target.path / "src" / "loop.metta").exists() else False
    skills = skill_prompt_text(target)
    history = _last_chars(CONTEXT_FIXTURE_HISTORY, max_history)
    promoted = CONTEXT_FIXTURE_PROMOTED if has_promoted_hints else ""
    rows = []
    for case in CONTEXT_CASES:
        feedback = _last_chars(case["lastresults"], max_feedback)
        context = (
            "PROMPT: " + CONTEXT_FIXTURE_PROMPT
            + " SKILLS: " + skills
            + OUTPUT_FORMAT_TEXT
            + " LAST_SKILL_USE_RESULTS: " + feedback
            + " HISTORY: " + history
        )
        if has_promoted_hints:
            context += " PROMOTED_MEMORY_HINTS: " + promoted
        context += " TIME: " + FIXED_TIME_TEXT
        send = context + ":-:-:-:" + case["lastmessage"]
        rows.append(
            {
                "name": case["name"],
                "description": case["description"],
                "context_chars": len(context),
                "send_chars": len(send),
                "token_estimate": estimate_tokens(send),
                "components": {
                    "prompt_chars": len(CONTEXT_FIXTURE_PROMPT),
                    "skills_chars": len(skills),
                    "feedback_chars": len(feedback),
                    "history_chars": len(history),
                    "promoted_hint_chars": len(promoted),
                    "lastmessage_chars": len(case["lastmessage"]),
                },
            }
        )
    token_estimates = [row["token_estimate"] for row in rows]
    send_chars = [row["send_chars"] for row in rows]
    return {
        "max_history": max_history,
        "max_feedback": max_feedback,
        "has_promoted_hints": has_promoted_hints,
        "rows": rows,
        "avg_token_estimate": statistics.mean(token_estimates),
        "max_token_estimate": max(token_estimates),
        "avg_send_chars": statistics.mean(send_chars),
        "max_send_chars": max(send_chars),
    }


def runtime_cost_context(target: Target, hours: float) -> dict:
    ledger = target.path / "memory" / "cost_ledger.jsonl"
    if not ledger.exists():
        return {"status": "missing"}
    now = dt.datetime.now(dt.timezone.utc)
    cutoff = now - dt.timedelta(hours=hours)
    rows = []
    for line in ledger.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            item = json.loads(line)
            when = dt.datetime.fromisoformat(str(item.get("time", "")).replace("Z", "+00:00"))
        except (json.JSONDecodeError, ValueError):
            continue
        if when >= cutoff:
            item["_time"] = when
            rows.append(item)
    if not rows:
        return {"status": "empty", "hours": hours}

    def nums(key: str) -> list[float]:
        return [float(row[key]) for row in rows if isinstance(row.get(key), (int, float))]

    costs = nums("cost_usd")
    prompt_tokens = nums("prompt_tokens")
    completion_tokens = nums("completion_tokens")
    total_tokens = nums("total_tokens")
    span_hours = max((max(row["_time"] for row in rows) - min(row["_time"] for row in rows)).total_seconds() / 3600, 1 / 3600)
    total_cost = sum(costs)
    return {
        "status": "ok",
        "hours": hours,
        "calls": len(rows),
        "models": sorted(set(str(row.get("model", "unknown")) for row in rows)),
        "total_cost_usd": total_cost,
        "cost_per_call_usd": statistics.mean(costs) if costs else 0.0,
        "cost_per_hour_usd": total_cost / span_hours,
        "projected_daily_usd": total_cost / span_hours * 24,
        "avg_prompt_tokens": statistics.mean(prompt_tokens) if prompt_tokens else 0.0,
        "p95_prompt_tokens": sorted(prompt_tokens)[max(0, int(len(prompt_tokens) * 0.95) - 1)] if prompt_tokens else 0.0,
        "max_prompt_tokens": max(prompt_tokens) if prompt_tokens else 0.0,
        "avg_completion_tokens": statistics.mean(completion_tokens) if completion_tokens else 0.0,
        "avg_total_tokens": statistics.mean(total_tokens) if total_tokens else 0.0,
        "total_tokens": sum(total_tokens),
    }


def assume_benchmark(target: Target) -> dict:
    bench = target.path / "tests" / "assume_demo_benchmark.py"
    if not bench.exists():
        return {"status": "missing"}
    result = run([python_for(target.path), str(bench)], cwd=target.path, timeout=60)
    return {"status": "ok" if result.returncode == 0 else f"exit-{result.returncode}", "output": result.stdout.strip()}


def unittest_smoke(target: Target) -> dict:
    if not (target.path / "tests").exists():
        return {"status": "missing", "summary": "No tests directory in this target."}
    result = run([python_for(target.path), "-m", "unittest", "discover", "tests"], cwd=target.path, timeout=120)
    summary = "\n".join(result.stdout.strip().splitlines()[-6:])
    return {"status": "ok" if result.returncode == 0 else f"exit-{result.returncode}", "summary": summary}


def patch_audit(target: Target) -> dict:
    audit = target.path / "docs" / "review" / "review_audit.py"
    if not audit.exists():
        return {"status": "missing"}
    result = run([python_for(target.path), str(audit)], cwd=target.path, timeout=120)
    return {"status": "ok" if result.returncode == 0 else f"exit-{result.returncode}", "output": result.stdout.strip()}


def ratio(candidate: float | None, baseline: float | None) -> str:
    if candidate is None or baseline in (None, 0):
        return "n/a"
    return f"{candidate / baseline:.3f}x"


def delta(candidate: float | int | None, baseline: float | int | None) -> str:
    if candidate is None or baseline is None:
        return "n/a"
    change = candidate - baseline
    sign = "+" if change >= 0 else ""
    return f"{sign}{change:g}"


def ratio_plain(candidate: float | int | None, baseline: float | int | None) -> float | None:
    if candidate is None or baseline in (None, 0):
        return None
    return float(candidate) / float(baseline)


def yesno(value: bool) -> str:
    return "yes" if value else "no"


def ok_status(value: str | None) -> str:
    return "PASS" if value == "ok" else str(value or "n/a")


def workload_pass_count(workloads: dict) -> tuple[int, int]:
    rows = workloads.get("rows", [])
    return sum(1 for row in rows if row.get("ok")), len(rows)


def parser_overhead_line(c_us: float | None, b_us: float | None) -> str:
    if c_us is None or b_us is None:
        return "n/a"
    extra_us = max(c_us - b_us, 0)
    return f"{extra_us:.2f} us/command extra; {extra_us / 1000:.4f}s extra per 1k commands"


def markdown(results: dict) -> str:
    baseline = results["baseline"]
    candidate = results["candidate"]
    b_parser = baseline["parser"]
    c_parser = candidate["parser"]
    b_us = b_parser.get("us_per_parse")
    c_us = c_parser.get("us_per_parse")
    b_workload_ok, b_workload_total = workload_pass_count(baseline["workloads"])
    c_workload_ok, c_workload_total = workload_pass_count(candidate["workloads"])
    b_surface_total = baseline["surface"]["skill_signatures"] + baseline["surface"]["skill_definitions"]
    c_surface_total = candidate["surface"]["skill_signatures"] + candidate["surface"]["skill_definitions"]
    surface_ratio = ratio_plain(c_surface_total, b_surface_total)
    b_parser_rate = b_parser.get("parses_per_second", 0)
    c_parser_rate = c_parser.get("parses_per_second", 0)
    b_context = baseline["context_fixture"]
    c_context = candidate["context_fixture"]

    lines = [
        "# Core Benchmark Comparison",
        "",
        f"- Baseline: `{baseline['path']}`",
        f"- Candidate: `{candidate['path']}`",
        "",
        "## Executive Comparison",
        "",
        "| Area | Core baseline | Candidate | Useful reading |",
        "|---|---:|---:|---|",
        (
            f"| Representative workloads | {b_workload_ok}/{b_workload_total} parse | "
            f"{c_workload_ok}/{c_workload_total} parse | user-facing request shapes accepted |"
        ),
        (
            f"| Skill surface | {b_surface_total} declared forms | {c_surface_total} declared forms | "
            f"{ratio(c_surface_total, b_surface_total)} larger typed command/reasoning surface |"
        ),
        (
            f"| Modules | {baseline['surface']['modules']} | {candidate['surface']['modules']} | "
            "plug-in organs available to load/share independently |"
        ),
        (
            f"| Parser throughput | {b_parser_rate:.0f}/sec | {c_parser_rate:.0f}/sec | "
            f"{parser_overhead_line(c_us, b_us)} |"
        ),
        (
            f"| Fixed avg prompt estimate | {b_context['avg_token_estimate']:.0f} tokens | "
            f"{c_context['avg_token_estimate']:.0f} tokens | deterministic context fixture, not live behavior |"
        ),
        (
            f"| Assume/Fabric demo | {baseline['assume'].get('status')} | {candidate['assume'].get('status')} | "
            "predict/audit/learn/reload path availability |"
        ),
        (
            f"| Review footprint | {baseline['footprint']['files']} files | {candidate['footprint']['files']} files | "
            "review size, not runtime prompt size |"
        ),
    ]
    if "unittest" in baseline:
        lines.append(
            f"| Unit smoke | {ok_status(baseline['unittest']['status'])} | {ok_status(candidate['unittest']['status'])} | regression gate |"
        )
    if "patch_audit" in candidate:
        lines.append(
            f"| Patch audit | n/a | {ok_status(candidate['patch_audit']['status'])} | secret scan, patch boundaries, apply check |"
        )
    lines.extend(
        [
            "",
            "## Reviewer Reading",
            "",
            "- The baseline is a smaller core loop with a minimal parser surface.",
            "- The candidate is not just a faster/slower parser; it adds typed command signatures, runtime modules, Assume/Fabric prediction, attention/immune tooling, scratch, AgentVerse, and review gates.",
            "- Parser latency should be read as absolute overhead per command, not only as a ratio. The ratio looks large because the baseline parser does much less work.",
            "- Fixed prompt/context rows use the same synthetic persona, history, feedback, and messages so token estimates are comparable across branches.",
            "- Live model cost/context is reported from the local cost ledger; the benchmark itself does not spend LLM tokens.",
            "",
            "## Capability Matrix",
            "",
            "| Capability | Core baseline | Candidate |",
            "|---|---:|---:|",
            f"| Skill signatures | {baseline['surface']['skill_signatures']} | {candidate['surface']['skill_signatures']} |",
            f"| Skill definitions | {baseline['surface']['skill_definitions']} | {candidate['surface']['skill_definitions']} |",
            f"| Skill help atoms | {baseline['surface']['skill_help_atoms']} | {candidate['surface']['skill_help_atoms']} |",
            f"| Catalog files | {baseline['surface']['catalog_files']} | {candidate['surface']['catalog_files']} |",
            f"| Signature files | {baseline['surface']['signature_files']} | {candidate['surface']['signature_files']} |",
            f"| Modules | {baseline['surface']['modules']} | {candidate['surface']['modules']} |",
        ]
    )
    if surface_ratio is not None:
        lines.append(f"| Declared surface ratio | 1.000x | {surface_ratio:.3f}x |")

    lines.extend(
        [
            "",
            "## Parser Microbenchmark",
        "",
        "| Target | Implementation | Signature count | us/parse | parses/sec | Errors |",
        "|---|---|---:|---:|---:|---:|",
        (
            f"| baseline | `{b_parser.get('impl', 'error')}` | {b_parser.get('signature_count', 'n/a')} | "
            f"{b_us:.2f} | {b_parser.get('parses_per_second', 0):.0f} | {len(b_parser.get('errors', []))} |"
            if b_us is not None
            else f"| baseline | error | n/a | n/a | n/a | {b_parser.get('error', '')} |"
        ),
        (
            f"| candidate | `{c_parser.get('impl', 'error')}` | {c_parser.get('signature_count', 'n/a')} | "
            f"{c_us:.2f} | {c_parser.get('parses_per_second', 0):.0f} | {len(c_parser.get('errors', []))} |"
            if c_us is not None
            else f"| candidate | error | n/a | n/a | n/a | {c_parser.get('error', '')} |"
        ),
        "",
        f"Candidate/baseline parser latency: **{ratio(c_us, b_us)}**",
        "",
        f"Absolute parser overhead: **{parser_overhead_line(c_us, b_us)}**",
        "",
        "## Fixed Context / Prompt Budget",
        "",
            "| Case | Core tokens est. | Candidate tokens est. | Delta | Core chars | Candidate chars | Useful reading |",
            "|---|---:|---:|---:|---:|---:|---|",
        ]
    )
    b_context_rows = {row["name"]: row for row in b_context["rows"]}
    c_context_rows = {row["name"]: row for row in c_context["rows"]}
    for case in CONTEXT_CASES:
        name = case["name"]
        b_row = b_context_rows[name]
        c_row = c_context_rows[name]
        lines.append(
            f"| {name} | {b_row['token_estimate']} | {c_row['token_estimate']} | "
            f"{delta(c_row['token_estimate'], b_row['token_estimate'])} | "
            f"{b_row['send_chars']} | {c_row['send_chars']} | {case['description']} |"
        )
    lines.extend(
        [
            (
                f"| **average** | **{b_context['avg_token_estimate']:.0f}** | "
                f"**{c_context['avg_token_estimate']:.0f}** | "
                f"**{delta(round(c_context['avg_token_estimate']), round(b_context['avg_token_estimate']))}** | "
                f"**{b_context['avg_send_chars']:.0f}** | **{c_context['avg_send_chars']:.0f}** | comparable fixed prompt pressure |"
            ),
            "",
            "| Component | Core chars | Candidate chars | Useful reading |",
            "|---|---:|---:|---|",
        ]
    )
    component_names = [
        ("prompt_chars", "persona prompt fixture"),
        ("skills_chars", "skills/catalog text injected into context"),
        ("feedback_chars", "last skill results after maxFeedback trimming"),
        ("history_chars", "history tail after maxHistory trimming"),
        ("promoted_hint_chars", "promoted memory hints, if present in loop"),
        ("lastmessage_chars", "message appended after provider delimiter"),
    ]
    for key, meaning in component_names:
        b_max = max(row["components"][key] for row in b_context["rows"])
        c_max = max(row["components"][key] for row in c_context["rows"])
        lines.append(f"| {key} | {b_max} | {c_max} | {meaning} |")
    lines.extend(
        [
            "",
            f"- Core limits: `maxHistory={b_context['max_history']}`, `maxFeedback={b_context['max_feedback']}`",
            f"- Candidate limits: `maxHistory={c_context['max_history']}`, `maxFeedback={c_context['max_feedback']}`",
            "",
        "## Representative User Requests",
        "",
            "| Workload | What it covers | Baseline parse | Candidate parse |",
            "|---|---|---:|---:|",
        ]
    )
    b_rows = {row["name"]: row for row in baseline["workloads"].get("rows", [])}
    c_rows = {row["name"]: row for row in candidate["workloads"].get("rows", [])}
    for name, _request, measures in WORKLOAD_CASES:
        b_ok = "yes" if b_rows.get(name, {}).get("ok") else "no"
        c_ok = "yes" if c_rows.get(name, {}).get("ok") else "no"
        lines.append(f"| {name} | {measures} | {b_ok} | {c_ok} |")

    lines.extend(
        [
            "",
            "## Footprint / Surface",
            "",
            "| Target | Review files | Review bytes | Modules | Skill signatures | Skill definitions |",
            "|---|---:|---:|---:|---:|---:|",
            (
                f"| baseline | {baseline['footprint']['files']} | {baseline['footprint']['bytes']} | "
                f"{baseline['surface']['modules']} | {baseline['surface']['skill_signatures']} | {baseline['surface']['skill_definitions']} |"
            ),
            (
                f"| candidate | {candidate['footprint']['files']} | {candidate['footprint']['bytes']} | "
                f"{candidate['surface']['modules']} | {candidate['surface']['skill_signatures']} | {candidate['surface']['skill_definitions']} |"
            ),
            "",
            "## Live Runtime Cost / Context",
            "",
        ]
    )
    runtime = candidate.get("runtime", {})
    if runtime.get("status") == "ok":
        cost_per_1k_tokens = runtime["total_cost_usd"] / max(runtime["total_tokens"], 1) * 1000
        lines.extend(
            [
                f"- Window: `{runtime['hours']}h`, calls: `{runtime['calls']}`, models: `{', '.join(runtime['models'])}`",
                f"- Total cost: `${runtime['total_cost_usd']:.4f}`; mean call: `${runtime['cost_per_call_usd']:.4f}`",
                f"- Cost pace: `${runtime['cost_per_hour_usd']:.4f}/h`; projected day at this pace: `${runtime['projected_daily_usd']:.2f}`",
                f"- Effective blended cost: `${cost_per_1k_tokens:.5f}/1k tokens` from the observed ledger window",
                f"- Avg prompt tokens: `{runtime['avg_prompt_tokens']:.0f}`; p95: `{runtime['p95_prompt_tokens']:.0f}`; max: `{runtime['max_prompt_tokens']:.0f}`",
                f"- Avg completion tokens: `{runtime['avg_completion_tokens']:.0f}`; avg total tokens: `{runtime['avg_total_tokens']:.0f}`",
            ]
        )
    else:
        lines.append(f"- Candidate runtime ledger: `{runtime.get('status', 'not collected')}`")

    lines.extend(
        [
            "",
            "## Assume/Fabric Demo",
            "",
            f"- Baseline: `{baseline['assume'].get('status')}`",
            f"- Candidate: `{candidate['assume'].get('status')}`",
        ]
    )
    candidate_assume_output = candidate["assume"].get("output", "")
    if candidate_assume_output:
        summary = [line for line in candidate_assume_output.splitlines() if line.startswith("SUMMARY ")]
        if summary:
            lines.append(f"- Candidate summary: `{summary[-1]}`")

    lines.extend(
        [
            "",
            "## Resource Requirements",
            "",
            "- Parser/workload probes are local CPU-only and spend no model tokens.",
            "- Assume/Fabric benchmark requires FabricPC's Python environment and measures daemon load/predict/audit/learn/writeback.",
            "- Live chat/image/code/reasoning cost is read from `memory/cost_ledger.jsonl`; the benchmark does not invoke the LLM by default.",
        ]
    )
    if "unittest" in baseline:
        lines.extend(
            [
                "",
                "## Unit Smoke",
                "",
                f"- Baseline: `{baseline['unittest']['status']}`",
                f"- Candidate: `{candidate['unittest']['status']}`",
                "",
                "```text",
                "Baseline:",
                baseline["unittest"].get("summary", ""),
                "",
                "Candidate:",
                candidate["unittest"].get("summary", ""),
                "```",
            ]
        )
    if "patch_audit" in candidate:
        lines.extend(["", "## Patch Audit", "", f"- Candidate: `{candidate['patch_audit']['status']}`"])
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, help="baseline repo path; defaults to a HEAD worktree")
    parser.add_argument("--candidate", type=Path, default=ROOT, help="candidate repo path")
    parser.add_argument("--loops", type=int, default=5000)
    parser.add_argument("--runtime-hours", type=float, default=24.0)
    parser.add_argument("--run-unit-smoke", action="store_true")
    parser.add_argument("--run-patch-audit", action="store_true")
    parser.add_argument("--json", action="store_true", help="emit JSON instead of Markdown")
    args = parser.parse_args()

    made_worktree = False
    baseline_path = args.baseline
    if baseline_path is None:
        baseline_path = make_baseline_worktree()
        made_worktree = True

    try:
        targets = {
            "baseline": Target("baseline", baseline_path.resolve()),
            "candidate": Target("candidate", args.candidate.resolve()),
        }
        results = {
            name: {
                "path": str(target.path),
                "parser": parser_benchmark(target, args.loops),
                "workloads": parser_workload_probe(target),
                "context_fixture": context_fixture_benchmark(target),
                "footprint": repo_footprint(target),
                "surface": surface_counts(target),
                "assume": assume_benchmark(target),
            }
            for name, target in targets.items()
        }
        results["candidate"]["runtime"] = runtime_cost_context(targets["candidate"], hours=args.runtime_hours)
        if args.run_unit_smoke:
            for name, target in targets.items():
                results[name]["unittest"] = unittest_smoke(target)
        if args.run_patch_audit:
            results["candidate"]["patch_audit"] = patch_audit(targets["candidate"])

        print(json.dumps(results, indent=2, sort_keys=True) if args.json else markdown(results))
        return 0
    finally:
        if made_worktree:
            cleanup_baseline(baseline_path)


if __name__ == "__main__":
    raise SystemExit(main())
