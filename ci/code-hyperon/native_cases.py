#!/usr/bin/env python3
"""Admitted Linux-only Hyperon syntax/metadata cases. Importing this file is inert."""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib
import json
from pathlib import Path
import platform
import sys
import tempfile

SOURCE_DIGEST = "4a5737b1296bcb49ff44a002684129c18e95a749d8ce3362cd97df18953b449d"
CHECK_IDS = ["unicode_source_ranges", "source_not_evaluated", "malformed_source_closed",
             "operator_enablement_exact", "closed_input_bounds", "runtime_drift_refused",
             "metadata_snapshot_currency", "parser_matcher_not_evaluator", "all_scratch_clean"]


class NativeCaseError(RuntimeError):
    pass


def need(value, code):
    if not value:
        raise NativeCaseError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def selected_source(package):
    files = sorted(p for p in package.rglob("*.py") if "__pycache__" not in p.parts)
    h = hashlib.sha256()
    for path in files:
        need(path.is_file() and not path.is_symlink(), "source_file_invalid")
        h.update(path.relative_to(package).as_posix().encode() + b"\0" + sha(path.read_bytes()).encode() + b"\n")
    need(len(files) == 91 and h.hexdigest() == SOURCE_DIGEST, "source_digest_mismatch")


def must_refuse(call, code):
    try:
        call()
    except ValueError:
        return
    raise NativeCaseError(code)


def flags(result):
    need(all(result.get(k) is False for k in ("evaluated", "effect_authority", "atom_publication")),
         "effect_boundary_flags")


def clean(scratch):
    need(not list(scratch.iterdir()), "scratch_cleanup_failed")


def run(args):
    need(platform.system() == "Linux" and platform.machine() == args.architecture, "native_linux_architecture_required")
    need(sys.implementation.name == "cpython" and tuple(sys.version_info[:3]) == (3, 12, 16), "worker_python_version")
    need(sys.flags.isolated == 1 and sys.flags.no_user_site == 1, "worker_isolation_flags")
    need(Path(sys.executable).absolute() == args.worker_python.absolute()
         and Path(sys.prefix).resolve() == args.worker_root.resolve(), "worker_interpreter_identity")
    source = args.source_root.resolve(strict=True)
    selected_source(source / "omegacode")
    # Only the hash-bound selected source enters sys.path. No checkout/runtime fallback.
    sys.path.insert(0, str(source))
    from omegacode import metta_facts_process as process
    config = {"kind": "hyperon", "source_search_enabled": True, "root": str(args.worker_root.resolve()),
              "executable": str(args.worker_python.absolute())}
    initial = process.runtime_identity(config)
    for name in ("omegacode.metta_facts_process", "omegacode.symbolic", "omegacode.runner"):
        need(Path(sys.modules[name].__file__).resolve().is_relative_to(source), "selected_module_origin")
    import hyperon
    from omegacode import metta_source_facts as facts
    loaded = {}
    for name in ("hyperon.base", "hyperon.atoms", "hyperonpy"):
        module = importlib.import_module(name)
        path = Path(module.__file__).resolve(strict=True)
        need(path.is_relative_to(args.worker_root.resolve()), "imported_module_escape")
        relative = path.relative_to(args.worker_root.resolve()).as_posix()
        digest = sha(path.read_bytes())
        need(initial["files"].get(relative) == digest, "imported_module_digest")
        loaded[name] = {"relative": relative, "sha256": digest}
    need(process.runtime_identity(config) == initial, "runtime_import_drift")
    done = []
    with tempfile.TemporaryDirectory(prefix="hyperon-code-acceptance-") as tmp:
        root = Path(tmp)
        scratch = root / "scratch"
        scratch.mkdir(mode=0o700)
        marker = root / "invented-not-created"
        raw = ('(: Ω (-> Atom Atom))\n(= (Ω $x) $x)\n!(py-atom os.system)\n'
               + f'!(write-file "{marker}" "invented")\n').encode()
        sources = {"invented/math.metta": raw}
        result = process.search(sources, "equation_subject", "Ω", config, scratch)
        flags(result)
        need(result.get("cleanup_observed") is True and len(result["matches"]) == 1, "native_query_result")
        row = result["matches"][0]
        need(raw[row["start_byte"]:row["end_byte"]] == "Ω".encode()
             and row["source_digest"] == sha(raw)
             and row["range_digest"] == sha("Ω".encode())
             and result["sources"] == {"invented/math.metta": sha(raw)}, "unicode_range_binding")
        clean(scratch)
        done.append(CHECK_IDS[0])
        need(not marker.exists() and result.get("semantic_call_resolution") is False, "source_was_evaluated")
        done.append(CHECK_IDS[1])

        malformed = process.search({"broken.metta": b"(= (x $a) $a"}, "equation_subject", "x", config, scratch)
        flags(malformed)
        need(not malformed["matches"] and malformed["diagnostics"] and malformed["cleanup_observed"] is True,
             "malformed_partial_facts")
        clean(scratch)
        done.append(CHECK_IDS[2])
        for value in (False, 1, "true", None):
            must_refuse(lambda value=value: process.search({"x.metta": b"(x)"}, "expression_head", "x",
                        {**config, "source_search_enabled": value}, scratch), "enablement_not_exact")
        must_refuse(lambda: process.search({"x.metta": b"(x)"}, "expression_head", "x",
                    {**config, "kind": "other"}, scratch), "kind_not_closed")
        clean(scratch)
        done.append(CHECK_IDS[3])
        invalid = [({"../x.metta": b"(x)"}, "expression_head", "x"),
                   ({"x.py": b"(x)"}, "expression_head", "x"),
                   ({"x.metta": b"x" * (1024 * 1024 + 1)}, "expression_head", "x"),
                   ({"x.metta": b"(x)"}, "run", "x"), ({"x.metta": b"(x)"}, "expression_head", "")]
        for source_map, kind, symbol in invalid:
            must_refuse(lambda: process.search(source_map, kind, symbol, config, scratch), "closed_input_accepted")
            clean(scratch)
        done.append(CHECK_IDS[4])

        original = process.runtime_identity
        calls = 0
        def drifting(configuration):
            nonlocal calls
            calls += 1
            current = original(configuration)
            if calls == 2:
                current = {**current, "executable_digest": "0" * 64}
            return current
        try:
            process.runtime_identity = drifting
            must_refuse(lambda: process.search({"x.metta": b"(x)"}, "expression_head", "x", config, scratch),
                        "runtime_drift_accepted")
            need(calls == 2, "runtime_drift_probe_incomplete")
        finally:
            process.runtime_identity = original
        clean(scratch)
        done.append(CHECK_IDS[5])

        snapshot = facts.build(sources)
        flags(snapshot)
        positive = facts.query(snapshot, "equation_subject", "Ω", sources)
        flags(positive)
        need(len(positive["matches"]) == 1, "snapshot_query_missing")
        must_refuse(lambda: facts.query(snapshot, "equation_subject", "Ω",
                    {"invented/math.metta": raw + b"\n(new invented)"}), "stale_snapshot_accepted")
        forged = copy.deepcopy(snapshot)
        forged["facts"][0]["symbol"] = "invented-forgery"
        forged["digest"] = sha(facts.canonical({k: v for k, v in forged.items() if k != "digest"}))
        must_refuse(lambda: facts.query(forged, "equation_subject", "Ω", sources), "redigested_forgery_accepted")
        bad = {**snapshot, "digest": "0" * 64}
        must_refuse(lambda: facts.query(bad, "equation_subject", "Ω", sources), "corrupt_snapshot_accepted")
        done.append(CHECK_IDS[6])

        entry = hyperon.MeTTa.run
        evaluations = 0
        def forbidden_evaluator(*unused_args, **unused_kwargs):
            nonlocal evaluations
            evaluations += 1
            raise NativeCaseError("evaluator_entry_reached")
        try:
            hyperon.MeTTa.run = forbidden_evaluator
            observed = facts.build(sources)
            matched = facts.query(observed, "equation_subject", "Ω", sources)
            flags(observed)
            flags(matched)
            need(evaluations == 0 and len(matched["matches"]) == 1 and not marker.exists(), "evaluator_trap_failed")
        finally:
            hyperon.MeTTa.run = entry
        done.append(CHECK_IDS[7])
        clean(scratch)
        need(not marker.exists() and process.runtime_identity(config) == initial, "final_effect_or_runtime_drift")
        done.append(CHECK_IDS[8])
    need(done == CHECK_IDS, "native_case_set_incomplete")
    return {"schema": "omegacode-hyperon-linux-native-cases-r1", "ok": True, "architecture": args.architecture,
            "python_version": "3.12.16", "implementation": "CPython", "runtime_descriptor": initial,
            "imported_modules": loaded, "checks": [{"id": value, "passed": True} for value in done],
            "observed_boundaries": {"evaluated": False, "effect_authority": False, "atom_publication": False,
                                    "semantic_call_resolution": False,
                                    "evaluator_trap_scope": "in-process hyperon.MeTTa.run only"},
            "evaluation_entrypoints_instrumented": ["hyperon.MeTTa.run"]}


def main():
    parser = argparse.ArgumentParser()
    for name in ("source-root", "worker-root", "worker-python"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--architecture", choices=("x86_64", "aarch64"), required=True)
    args = parser.parse_args()
    try:
        report = run(args)
    except Exception as error:
        # Native messages may contain temporary source paths; emit fixed diagnostics only.
        code = str(error) if isinstance(error, NativeCaseError) else "native_case_failed"
        report = {"schema": "omegacode-hyperon-linux-native-cases-r1", "ok": False,
                  "reason": code, "exception_type": type(error).__name__}
    print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
