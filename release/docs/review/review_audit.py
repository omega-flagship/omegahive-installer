#!/usr/bin/env python3
"""Review gate for the OmegaClaw patch staging tree.

The important property of this audit is that it is git-aware. It only scans
tracked files and untracked files that git does not ignore, so runtime memory,
WhatsApp sessions, credentials, and dependency trees stay outside the review
surface.
"""

from __future__ import annotations

import re
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PATCH_DIR = ROOT / "docs" / "review" / "patch-series" / "patches"

EXCLUDED_PARTS = {
    ".git",
    "__pycache__",
    "node_modules",
}

EXCLUDED_PREFIXES = (
    "memory/",
    "channels/whatsapp_bridge/auth",
)

SECRET_PATTERNS = [
    re.compile(r"sk-or-v1-[A-Za-z0-9_-]{20,}"),
    re.compile(r"xai-[A-Za-z0-9_-]{20,}"),
    re.compile(r"ghp_[A-Za-z0-9_]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile("Nie" + "Yu" + "Chun", re.IGNORECASE),
    re.compile("hockey" + "123", re.IGNORECASE),
    re.compile(r"\b074631(?:18698)?\b"),
]

SOURCE_IMPORT_RE = re.compile(
    r"^!\(import! &[a-z_]+ \./repos/OmegaClaw-Core/memory/[a-z_]+\.metta\)",
    re.MULTILINE,
)

PATCH_MEMORY_IMPORT_RE = re.compile(
    r"^\+!\(import! &[a-z_]+ \./repos/OmegaClaw-Core/memory/[a-z_]+\.metta\)",
    re.MULTILINE,
)

PATCH_LIBRARY_IMPORT_RE = re.compile(
    r"\(library OmegaClaw-Core \./([^\s)]+)\)"
)

LOCAL_ONLY_PATCHES = {
    "90-local-web-ui-not-for-upstream.patch",
    "91-local-runtime-composition-not-for-upstream.patch",
}

CORE_PATCHES = {
    "01a-syntax-command-membrane.patch",
    "01b-runtime-memory-context-boundary.patch",
    "01c-provider-runtime-energy.patch",
    "01d-symbolic-reasoning-space-skills.patch",
    "02a-assume-symbolic-graph-engine.patch",
    "02b-assume-fabricpc-daemon-membrane.patch",
    "02c-assume-metta-skill-and-mutation-review.patch",
    "02d-assume-demo-space-and-tests.patch",
    "03-attention-ecan-lite-immune-organ.patch",
}

BODY_PATCHES = {
    "04b-body-skill-surface.patch",
    "04c-communication-channels.patch",
    "04d-situated-senses-and-apps.patch",
    "04e-shareable-runtime-modules.patch",
    "04f-body-composition-loader.patch",
}

FORBIDDEN_CORE_DIFF_PATHS = (
    "web/",
    "src/webhost.py",
    "channels/whatsapp_bridge/auth",
    "memory/web/",
)

FORBIDDEN_BODY_DIFF_PATHS = (
    "web/",
    "src/webhost.py",
    "tests/test_webhost_local.py",
    "tests/test_omega_surface.py",
)

FORBIDDEN_DIFF_PATH_FRAGMENTS = (
    "/node_modules/",
    "node_modules/",
    "auth_omega",
)

# Deployment-specific names and domains that must never enter source (for example a private
# webhost domain) are supplied by the operator, comma-separated, and never written into this file.
PRIVATE_DEPLOYMENT_STRINGS = tuple(
    s.strip() for s in os.environ.get("OMEGACLAW_REVIEW_PRIVATE_STRINGS", "").split(",") if s.strip()
)

FORBIDDEN_CORE_STRINGS = PRIVATE_DEPLOYMENT_STRINGS

FORBIDDEN_BODY_STRINGS = (
    "auth_" + "omega",
    "the agent" + "- ",
) + PRIVATE_DEPLOYMENT_STRINGS


@dataclass
class Finding:
    check: str
    detail: str


def run_git(args: list[str]) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=True,
    ).stdout


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def is_excluded(relpath: str) -> bool:
    parts = set(Path(relpath).parts)
    if parts.intersection(EXCLUDED_PARTS):
        return True
    if relpath.endswith(".pyc"):
        return True
    return relpath.startswith(EXCLUDED_PREFIXES)


def git_review_files() -> list[Path]:
    tracked = run_git(["ls-files"]).splitlines()
    untracked = run_git(["ls-files", "--others", "--exclude-standard"]).splitlines()
    files = []
    for item in [*tracked, *untracked]:
        if not item or is_excluded(item):
            continue
        path = ROOT / item
        if path.is_file():
            files.append(path)
    return sorted(dict.fromkeys(files))


def text_files(paths: list[Path]) -> list[tuple[Path, str]]:
    out: list[tuple[Path, str]] = []
    for path in paths:
        try:
            data = path.read_bytes()
        except OSError:
            continue
        if b"\0" in data:
            continue
        try:
            out.append((path, data.decode("utf-8")))
        except UnicodeDecodeError:
            out.append((path, data.decode("utf-8", errors="replace")))
    return out


def patch_files() -> list[Path]:
    if not PATCH_DIR.exists():
        return []
    patches = []
    for patch in sorted(PATCH_DIR.glob("*.patch")):
        if patch.name in LOCAL_ONLY_PATCHES:
            continue
        ignored = subprocess.run(
            ["git", "check-ignore", "--quiet", str(patch.relative_to(ROOT))],
            cwd=ROOT,
        )
        if ignored.returncode == 0:
            continue
        patches.append(patch)
    return patches


def patch_diff_paths(text: str) -> list[str]:
    paths: list[str] = []
    for line in text.splitlines():
        if not line.startswith("diff --git "):
            continue
        parts = line.split()
        if len(parts) >= 4:
            for token in parts[2:4]:
                paths.append(token.removeprefix("a/").removeprefix("b/"))
    return paths


def check_secrets(files: list[tuple[Path, str]]) -> list[Finding]:
    findings: list[Finding] = []
    for path, text in files:
        for pattern in SECRET_PATTERNS:
            match = pattern.search(text)
            if match:
                findings.append(
                    Finding(
                        "secret-scan",
                        f"{rel(path)} contains token-like/private value matching {pattern.pattern!r}",
                    )
                )
    return findings


def check_memory_imports(files: list[tuple[Path, str]]) -> list[Finding]:
    findings: list[Finding] = []
    source_files = [
        (path, text)
        for path, text in files
        if rel(path).startswith("src/") or rel(path).startswith("lib_omegaclaw")
    ]
    allowed_runtime_importers = {
        "src/memory.metta",
        "src/skills_attention.metta",
        "modules/assume/entry.metta",
    }
    for path, text in source_files:
        rpath = rel(path)
        if rpath in allowed_runtime_importers:
            continue
        if SOURCE_IMPORT_RE.search(text):
            findings.append(
                Finding(
                    "memory-import-boundary",
                    f"{rpath} imports ignored runtime memory at source load time",
                )
            )

    for patch in patch_files():
        text = patch.read_text(encoding="utf-8", errors="replace")
        if PATCH_MEMORY_IMPORT_RE.search(text):
            findings.append(
                Finding(
                    "memory-import-boundary",
                    f"{rel(patch)} adds a top-level ignored memory import",
                )
            )
    return findings


def check_patch_boundaries() -> list[Finding]:
    findings: list[Finding] = []
    for patch in patch_files():
        name = patch.name
        text = patch.read_text(encoding="utf-8", errors="replace")
        paths = patch_diff_paths(text)
        for path in paths:
            if any(fragment in path for fragment in FORBIDDEN_DIFF_PATH_FRAGMENTS):
                findings.append(
                    Finding("patch-boundary", f"{rel(patch)} includes dependency path {path}")
                )
            if name in CORE_PATCHES and any(path.startswith(prefix) for prefix in FORBIDDEN_CORE_DIFF_PATHS):
                findings.append(
                    Finding("patch-boundary", f"{rel(patch)} includes local/deployment path {path}")
                )
            if name in BODY_PATCHES and any(path.startswith(prefix) for prefix in FORBIDDEN_BODY_DIFF_PATHS):
                findings.append(
                    Finding("patch-boundary", f"{rel(patch)} includes local web path {path}")
                )
        if name in CORE_PATCHES:
            for needle in FORBIDDEN_CORE_STRINGS:
                if needle in text:
                    findings.append(
                        Finding("patch-boundary", f"{rel(patch)} contains local string {needle!r}")
                    )
        if name in BODY_PATCHES:
            for needle in FORBIDDEN_BODY_STRINGS:
                if needle in text:
                    findings.append(
                        Finding("patch-boundary", f"{rel(patch)} contains deployment-specific default {needle!r}")
                    )
        if name not in LOCAL_ONLY_PATCHES and any(path.startswith("web/omega-os/") for path in paths):
            findings.append(
                Finding("patch-boundary", f"{rel(patch)} contains the agent OS web assets outside local patch")
            )
    return findings


def check_patch_library_imports() -> list[Finding]:
    findings: list[Finding] = []
    patch_paths = patch_files()
    diff_paths: set[str] = set()
    imports: list[tuple[Path, str]] = []
    for patch in patch_paths:
        text = patch.read_text(encoding="utf-8", errors="replace")
        diff_paths.update(patch_diff_paths(text))
        for line in text.splitlines():
            if line.startswith("+++") or line.startswith("---"):
                continue
            if not (line.startswith("+") or line.startswith(" ")):
                continue
            for match in PATCH_LIBRARY_IMPORT_RE.finditer(line):
                imports.append((patch, match.group(1)))

    for patch, imported in imports:
        if imported.startswith("/"):
            continue
        if imported.startswith("memory/"):
            # Runtime memory files are intentionally ignored source artifacts.
            # The runtime helper creates them before live load; patches should
            # not need placeholder files merely to satisfy review tooling.
            continue
        candidates = [imported]
        if "." not in Path(imported).name:
            candidates.extend([imported + ".metta", imported + ".py"])
        if any((ROOT / candidate).exists() or candidate in diff_paths for candidate in candidates):
            continue
        if any(run_git(["ls-files", "--", candidate]).strip() for candidate in candidates):
            continue
        findings.append(
            Finding(
                "patch-library-imports",
                f"{rel(patch)} imports missing local library path {imported}",
            )
        )
    return findings


def check_review_surface_coverage() -> list[Finding]:
    findings: list[Finding] = []
    if not os.environ.get("OMEGACLAW_REVIEW_STRICT_PATCH_SERIES"):
        return findings
    changed = set(run_git(["diff", "--name-only", "HEAD"]).splitlines())
    changed.update(run_git(["ls-files", "--others", "--exclude-standard"]).splitlines())

    review_tooling_prefixes = (
        "docs/review/patch-series/",
        "docs/review/review_audit.py",
    )
    changed = {
        path
        for path in changed
        if path
        and not is_excluded(path)
        and not path.startswith(review_tooling_prefixes)
    }

    patch_paths: set[str] = set()
    for patch in patch_files():
        text = patch.read_text(encoding="utf-8", errors="replace")
        patch_paths.update(patch_diff_paths(text))
        for line in text.splitlines():
            if line.startswith("+++ b/") or line.startswith("--- a/"):
                patch_paths.add(line[6:])

    missing = sorted(changed - patch_paths)
    if missing:
        findings.append(
            Finding(
                "review-surface-coverage",
                "changed review-surface files are not owned by any generated patch: "
                + ", ".join(missing[:40]),
            )
        )
    return findings


def check_patch_apply() -> list[Finding]:
    findings: list[Finding] = []
    patches = patch_files()
    if not patches:
        return [Finding("patch-apply", "no generated patch files found")]
    baseline_ref = os.environ.get("OMEGACLAW_REVIEW_PATCH_BASELINE")
    if not baseline_ref:
        return findings
    tmp_parent = Path(tempfile.mkdtemp(prefix="omega-review-audit-"))
    worktree = tmp_parent / "worktree"
    try:
        subprocess.run(
            ["git", "worktree", "add", "--detach", str(worktree), baseline_ref],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=True,
        )
        for patch in patches:
            result = subprocess.run(
                ["git", "apply", "--index", str(patch)],
                cwd=worktree,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            if result.returncode != 0:
                findings.append(
                    Finding(
                        "patch-apply",
                        f"{rel(patch)} does not apply cleanly: {result.stdout.strip()}",
                    )
                )
    finally:
        subprocess.run(
            ["git", "worktree", "remove", str(worktree), "--force"],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        shutil.rmtree(tmp_parent, ignore_errors=True)
    return findings


def main() -> int:
    files = text_files(git_review_files())
    checks = [
        ("secret-scan", check_secrets(files)),
        ("memory-import-boundary", check_memory_imports(files)),
        ("patch-boundary", check_patch_boundaries()),
        ("patch-library-imports", check_patch_library_imports()),
        ("review-surface-coverage", check_review_surface_coverage()),
        ("patch-apply", check_patch_apply()),
    ]

    failed = False
    for name, findings in checks:
        if findings:
            failed = True
            print(f"FAIL {name}")
            for finding in findings:
                print(f"  - {finding.detail}")
        else:
            print(f"PASS {name}")

    if failed:
        print("review-audit: FAIL")
        return 1
    print("review-audit: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
