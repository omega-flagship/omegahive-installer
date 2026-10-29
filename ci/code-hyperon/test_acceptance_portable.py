"""Invented byte fixtures and mocked subprocess controls; no Hyperon imports."""
from __future__ import annotations

import ast
import base64
import contextlib
import copy
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock
import zipfile

import qualify_hyperon_worker as q


METADATA = b'''Metadata-Version: 2.1
Name: hyperon
Version: 0.2.10
Requires-Dist: build==0.10.0; extra == "dev"
Requires-Dist: pytest==7.3.2; extra == "dev"
Provides-Extra: dev

Invented metadata fixture, never an executable distribution.
'''


def record_bytes(files):
    stream = io.StringIO()
    writer = csv.writer(stream, lineterminator="\n")
    for name, content in sorted(files.items()):
        writer.writerow([name, "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=").decode(), len(content)])
    writer.writerow([q.DIST + "/RECORD", "", ""])
    return stream.getvalue().encode()


class FakeProcess:
    pid = 987654321
    returncode = 0
    def __init__(self, stdout=b'{"invented":true}', stderr=b''):
        self.stdout, self.stderr = io.BytesIO(stdout), io.BytesIO(stderr)
    def poll(self):
        return self.returncode
    def wait(self, timeout=None):
        return self.returncode


class PortableAcceptanceTests(unittest.TestCase):
    def test_controller_helper_and_input_manifest_bind_same_source(self):
        pins = json.loads(Path(q.__file__).with_name("INPUT_PINS.json").read_text())
        self.assertEqual(pins["source_archive_sha256"], q.SOURCE_SHA)
        self.assertEqual(pins["source_module_digest"], q.MODULE_SHA)
        helper = ast.parse(Path(q.__file__).with_name("native_cases.py").read_text())
        digests = [node.value.value for node in helper.body
                   if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name)
                   and target.id == "SOURCE_DIGEST" for target in node.targets)
                   and isinstance(node.value, ast.Constant)]
        self.assertEqual(digests, [q.MODULE_SHA])

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="invented-hyperon-acceptance-")
        self.root = Path(self.temporary.name).resolve()
        self.root.chmod(0o700)
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(self.restore_permissions)

    def restore_permissions(self):
        for directory, dirs, files in os.walk(self.root):
            Path(directory).chmod(0o700)

    def wheel(self):
        files = {"hyperon/__init__.py": b"# invented never imported\n",
                 "hyperon/base.py": b"# invented base\n", "hyperon/atoms.py": b"# invented atoms\n",
                 "hyperonpy.so": b"invented non-executable native module bytes",
                 q.DIST + "/METADATA": METADATA}
        files[q.DIST + "/RECORD"] = record_bytes(files)
        path = self.root / q.WHEELS["x86_64"]["filename"]
        with zipfile.ZipFile(path, "w") as archive:
            for name, content in files.items():
                archive.writestr(name, content)
        pin = {"filename": path.name, "sha256": q.sha_file(path)}
        return path, pin, files

    def installed(self):
        path, pin, files = self.wheel()
        wheel = q.inspect_wheel(path, "x86_64", pin)
        root = self.root / "worker"
        (root / "bin").mkdir(parents=True)
        (root / "bin/python").write_bytes(b"invented interpreter bytes, not executable")
        site = root / "lib/python3.12/site-packages"
        for name, content in files.items():
            target = site / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        return root, wheel, site, files

    def report(self, descriptor):
        return {"schema": "omegacode-hyperon-linux-native-cases-r1", "ok": True, "architecture": "x86_64",
                "python_version": "3.12.16", "implementation": "CPython", "runtime_descriptor": descriptor,
                "checks": [{"id": name, "passed": True} for name in q.CHECKS],
                "evaluation_entrypoints_instrumented": ["hyperon.MeTTa.run"],
                "observed_boundaries": q.BOUNDARIES.copy(),
                "imported_modules": {name: {"relative": relative, "sha256": descriptor["files"][relative]}
                                     for name, relative in {
                                         "hyperon.base": "lib/python3.12/site-packages/hyperon/base.py",
                                         "hyperon.atoms": "lib/python3.12/site-packages/hyperon/atoms.py",
                                         "hyperonpy": "lib/python3.12/site-packages/hyperonpy.so"}.items()}}

    def test_architecture_is_exact_native_linux(self):
        q.architecture_check("x86_64", "Linux", "x86_64")
        q.architecture_check("aarch64", "Linux", "aarch64")
        for requested, system, machine in (("x86_64", "Darwin", "x86_64"), ("aarch64", "Linux", "x86_64"),
                                           ("arm64", "Linux", "arm64")):
            with self.assertRaises(q.Refusal):
                q.architecture_check(requested, system, machine)

    def test_metadata_dev_extras_only(self):
        self.assertEqual(q.metadata(METADATA)["active_requires_dist"], [])

    def test_metadata_active_dependency_refused(self):
        with self.assertRaises(q.Refusal):
            q.metadata(METADATA.replace(b'Provides-Extra: dev', b'Requires-Dist: requests>=2\nProvides-Extra: dev'))

    def test_metadata_wrong_dev_version_refused(self):
        with self.assertRaises(q.Refusal):
            q.metadata(METADATA.replace(b"build==0.10.0", b"build==1.0.0"))

    def test_metadata_duplicate_or_wrong_distribution_refused(self):
        for raw in (b"Name: other\n" + METADATA, METADATA.replace(b"Name: hyperon", b"Name: other")):
            with self.assertRaises(q.Refusal):
                q.metadata(raw)

    def test_wheel_fixture_inspection_does_not_import(self):
        path, pin, files = self.wheel()
        value = q.inspect_wheel(path, "x86_64", pin)
        self.assertEqual(value["members"]["hyperonpy.so"]["sha256"], hashlib.sha256(files["hyperonpy.so"]).hexdigest())

    def test_fixture_cannot_match_production_wheel_pin(self):
        path, _, _ = self.wheel()
        with self.assertRaises(q.Refusal) as raised:
            q.inspect_wheel(path, "x86_64")
        self.assertEqual(raised.exception.code, "wheel_sha256_mismatch")

    def test_wheel_wrong_architecture_filename_refused(self):
        path, _, _ = self.wheel()
        with self.assertRaises(q.Refusal):
            q.inspect_wheel(path, "aarch64")

    def test_archive_traversal_refused(self):
        for name in ("../outside", "/absolute", "x/../outside", "x\\outside", "x//outside"):
            with self.assertRaises(q.Refusal):
                q.safe_member(name)

    def test_source_fixture_staged_and_digest_verified(self):
        archive = self.root / "invented-source.zip"
        original = self.root / "invented-package"
        original.mkdir()
        (original / "__init__.py").write_bytes(b"# invented source\n")
        digest, count = q.package_digest(original)
        with zipfile.ZipFile(archive, "w") as zf:
            zf.write(original / "__init__.py", "src/omegacode/__init__.py")
        stage = q.stage_source(archive, self.root / "stage", q.sha_file(archive), digest, count)
        self.assertEqual(q.package_digest(stage / "omegacode"), (digest, 1))
        self.assertEqual(stat.S_IMODE((stage / "omegacode/__init__.py").stat().st_mode), 0o444)

    def test_fixture_cannot_match_candidate_source_archive(self):
        archive = self.root / "invented-source.zip"
        archive.write_bytes(b"invented unpinned archive")
        with self.assertRaises(q.Refusal):
            q.stage_source(archive, self.root / "stage")

    def test_installed_record_and_pinned_wheel_payload(self):
        root, wheel, site, _ = self.installed()
        result = q.installed_closure(root, wheel)
        self.assertEqual(result["distribution_count"], 1)
        self.assertEqual(result["active_requires_dist"], [])

    def test_closure_phase_distinguishes_existing_and_later_contamination(self):
        root, wheel, site, _ = self.installed()
        before = q.installed_closure_at_phase(root, wheel, "before_native")
        self.assertEqual(q.installed_closure_at_phase(root, wheel, "after_native"), before)
        cache = site / "hyperon/__pycache__/runner.cpython-312.pyc"
        cache.parent.mkdir()
        cache.write_bytes(b"invented unrecorded bytes, never imported")
        for phase in ("before_native", "after_native"):
            with self.subTest(phase=phase):
                with self.assertRaises(q.Refusal) as raised:
                    q.installed_closure_at_phase(root, wheel, phase)
                self.assertEqual(raised.exception.code, "installed_unrecorded_file")
                self.assertEqual(raised.exception.details, {
                    "closure_phase": phase,
                    "offending_relative_path": "lib/python3.12/site-packages/hyperon/__pycache__/runner.cpython-312.pyc",
                    "offending_artifact_class": "cached_bytecode"})

    def test_closure_phase_is_closed_metadata(self):
        for phase in (None, True, [], "/private/location", "before_native\nsecret", "unknown"):
            with self.subTest(phase=phase):
                with self.assertRaises(q.Refusal) as raised:
                    q.installed_closure_at_phase(self.root, {}, phase)
                self.assertEqual(raised.exception.code, "closure_phase_invalid")
                self.assertEqual(raised.exception.details, {})

    def test_installed_extra_distribution_refused(self):
        root, wheel, site, _ = self.installed()
        (site / "invented_dependency-1.dist-info").mkdir()
        with self.assertRaises(q.Refusal):
            q.installed_closure(root, wheel)

    def test_installed_record_content_drift_refused(self):
        root, wheel, site, _ = self.installed()
        (site / "hyperon/base.py").write_bytes(b"# other invented content\n")
        with self.assertRaises(q.Refusal):
            q.installed_closure(root, wheel)

    def test_installed_unrecorded_payload_refused(self):
        root, wheel, site, _ = self.installed()
        (site / "hyperon/extra.py").write_bytes(b"# invented extra\n")
        with self.assertRaises(q.Refusal):
            q.installed_closure(root, wheel)

    def test_forged_record_cannot_add_unpinned_code(self):
        root, wheel, site, files = self.installed()
        files["hyperon/extra.py"] = b"# invented extra\n"
        (site / "hyperon/extra.py").write_bytes(files["hyperon/extra.py"])
        (site / q.DIST / "RECORD").write_bytes(record_bytes({k: v for k, v in files.items() if not k.endswith("/RECORD")}))
        with self.assertRaises(q.Refusal) as raised:
            q.installed_closure(root, wheel)
        self.assertEqual(raised.exception.code, "installed_unpinned_payload")

    def test_generated_uv_metadata_is_recorded_and_inert(self):
        root, wheel, site, files = self.installed()
        generated = q.DIST + "/uv_cache.json"
        files[generated] = b'{"invented_cache_metadata":true}\n'
        (site / generated).write_bytes(files[generated])
        (site / q.DIST / "RECORD").write_bytes(record_bytes({k: v for k, v in files.items() if not k.endswith("/RECORD")}))
        self.assertEqual(q.installed_closure(root, wheel)["distribution_count"], 1)

    def test_unrecorded_generated_uv_metadata_refused(self):
        root, wheel, site, _ = self.installed()
        (site / q.DIST / "uv_cache.json").write_bytes(b'{"invented":true}\n')
        with self.assertRaises(q.Refusal) as raised:
            q.installed_closure(root, wheel)
        self.assertEqual(raised.exception.code, "installed_unrecorded_file")
        self.assertEqual(raised.exception.details, {
            "offending_relative_path": "lib/python3.12/site-packages/" + q.DIST + "/uv_cache.json",
            "offending_artifact_class": "installer_metadata"})

    def test_unrecorded_cached_bytecode_refused_with_relative_diagnostic(self):
        root, wheel, site, _ = self.installed()
        path = site / "hyperon/__pycache__/base.cpython-312.pyc"
        path.parent.mkdir()
        path.write_bytes(b"invented bytecode bytes; never executed")
        with self.assertRaises(q.Refusal) as raised:
            q.installed_closure(root, wheel)
        self.assertEqual(raised.exception.code, "installed_unrecorded_file")
        self.assertEqual(raised.exception.details, {
            "offending_relative_path": "lib/python3.12/site-packages/hyperon/__pycache__/base.cpython-312.pyc",
            "offending_artifact_class": "cached_bytecode"})

    def test_recorded_but_unpinned_bytecode_still_refused(self):
        root, wheel, site, files = self.installed()
        relative = "hyperon/__pycache__/base.cpython-312.pyc"
        files[relative] = b"invented bytecode bytes; never executed"
        path = site / relative
        path.parent.mkdir()
        path.write_bytes(files[relative])
        (site / q.DIST / "RECORD").write_bytes(record_bytes({k: v for k, v in files.items() if not k.endswith("/RECORD")}))
        with self.assertRaises(q.Refusal) as raised:
            q.installed_closure(root, wheel)
        self.assertEqual(raised.exception.code, "installed_unpinned_payload")
        self.assertEqual(raised.exception.details["offending_artifact_class"], "cached_bytecode")

    def test_venv_scaffolding_outside_site_is_not_unrecorded_site_payload(self):
        root, wheel, _, _ = self.installed()
        (root / "bin/activate").write_text("invented activation scaffolding; not executed")
        (root / "pyvenv.cfg").write_text("invented metadata; not used by this closure-only control")
        self.assertEqual(q.installed_closure(root, wheel)["distribution_count"], 1)

    def test_generated_uv_metadata_hash_drift_refused(self):
        root, wheel, site, files = self.installed()
        generated = q.DIST + "/uv_cache.json"
        files[generated] = b'{"invented_cache_metadata":true}\n'
        (site / generated).write_bytes(b'{"invented_cache_metadata":false}\n')
        (site / q.DIST / "RECORD").write_bytes(record_bytes({k: v for k, v in files.items() if not k.endswith("/RECORD")}))
        with self.assertRaises(q.Refusal) as raised:
            q.installed_closure(root, wheel)
        self.assertEqual(raised.exception.code, "installed_record_hash_mismatch")

    def test_descriptor_and_native_report_exact(self):
        root, _, _, _ = self.installed()
        descriptor = q.static_descriptor(root / "bin/python", root)
        report = self.report(descriptor)
        self.assertIs(q.native_report(report, "x86_64", descriptor), report)

    def test_native_report_drift_and_false_flags_refused(self):
        root, _, _, _ = self.installed()
        descriptor = q.static_descriptor(root / "bin/python", root)
        report = self.report(descriptor)
        mutations = [("ok", False), ("python_version", "3.12.15"), ("architecture", "aarch64"),
                     ("extra_unclaimed_field", True)]
        for key, value in mutations:
            changed = copy.deepcopy(report); changed[key] = value
            with self.assertRaises(q.Refusal):
                q.native_report(changed, "x86_64", descriptor)

    def test_native_checks_unknown_or_false_refused(self):
        root, _, _, _ = self.installed()
        descriptor = q.static_descriptor(root / "bin/python", root)
        for key, value in (("passed", False), ("passed", 1), ("id", "unreviewed_check")):
            report = self.report(descriptor)
            report["checks"][0][key] = value
            with self.assertRaises(q.Refusal):
                q.native_report(report, "x86_64", descriptor)

    def test_observed_boundary_false_is_not_zero(self):
        root, _, _, _ = self.installed()
        descriptor = q.static_descriptor(root / "bin/python", root)
        for value in (True, 0):
            report = self.report(descriptor)
            report["observed_boundaries"]["evaluated"] = value
            with self.assertRaises(q.Refusal):
                q.native_report(report, "x86_64", descriptor)

    def test_imported_module_hash_must_match_descriptor(self):
        root, _, _, _ = self.installed()
        descriptor = q.static_descriptor(root / "bin/python", root)
        report = self.report(descriptor)
        report["imported_modules"]["hyperonpy"]["sha256"] = "f" * 64
        with self.assertRaises(q.Refusal):
            q.native_report(report, "x86_64", descriptor)

    def test_swapped_imported_names_refused(self):
        root, _, _, _ = self.installed()
        descriptor = q.static_descriptor(root / "bin/python", root)
        report = self.report(descriptor)
        imported = report["imported_modules"]
        imported["hyperon.base"], imported["hyperon.atoms"] = imported["hyperon.atoms"], imported["hyperon.base"]
        with self.assertRaises(q.Refusal):
            q.native_report(report, "x86_64", descriptor)

    def test_all_imported_names_same_payload_refused(self):
        root, _, _, _ = self.installed()
        descriptor = q.static_descriptor(root / "bin/python", root)
        report = self.report(descriptor)
        record = report["imported_modules"]["hyperon.base"].copy()
        report["imported_modules"] = {name: record.copy() for name in q.IMPORTS}
        with self.assertRaises(q.Refusal):
            q.native_report(report, "x86_64", descriptor)

    def mocked_native(self, process, **changes):
        patches = {"Popen": mock.patch.object(q.subprocess, "Popen", return_value=process),
                   "current_cgroup": mock.patch.object(q, "current_cgroup", return_value=Path("/invented-cgroup")),
                   "cgroup_members": mock.patch.object(q, "cgroup_members", return_value={os.getpid()}),
                   "group_members": mock.patch.object(q, "group_members", return_value=[]),
                   "killpg": mock.patch.object(q.os, "killpg")}
        for name, replacement in changes.items():
            patches[name] = replacement
        stack = contextlib.ExitStack()
        for patch in patches.values():
            stack.enter_context(patch)
        self.addCleanup(stack.close)

    def test_bounded_native_mock_has_cleanup_metadata(self):
        self.mocked_native(FakeProcess())
        value, cleanup = q.bounded_native(["invented-worker-not-executed"])
        self.assertEqual(value, {"invented": True})
        self.assertTrue(cleanup["process_group_clean"])
        self.assertFalse(cleanup["outer_forced_termination_qualified"])
        self.assertTrue(cleanup["external_outer_gate_required"])

    def test_bounded_output_limit_refused_with_mock(self):
        self.mocked_native(FakeProcess(stdout=b"x" * (q.MAX_STREAM + 1)))
        with self.assertRaises(q.Refusal):
            q.bounded_native(["invented-worker-not-executed"])

    def test_leftover_adapter_cgroup_refused_with_mock(self):
        self.mocked_native(FakeProcess(), cgroup_members=mock.patch.object(q, "cgroup_members",
                          side_effect=[{os.getpid()}, {os.getpid(), 424242}]))
        with self.assertRaises(q.Refusal) as raised:
            q.bounded_native(["invented-worker-not-executed"])
        self.assertEqual(raised.exception.code, "native_cgroup_descendants_remain")

    def test_nonzero_native_exit_refused_with_mock(self):
        process = FakeProcess(); process.returncode = 2
        self.mocked_native(process)
        with self.assertRaises(q.Refusal) as raised:
            q.bounded_native(["invented-worker-not-executed"])
        self.assertEqual(raised.exception.code, "native_failure_report_invalid")

    def test_native_closed_failure_reason_preserved_with_mock(self):
        value = {"schema": "omegacode-hyperon-linux-native-cases-r1", "ok": False,
                 "reason": "invented_closed_refusal", "exception_type": "RuntimeError"}
        process = FakeProcess(stdout=json.dumps(value).encode()); process.returncode = 2
        self.mocked_native(process)
        with self.assertRaises(q.Refusal) as raised:
            q.bounded_native(["invented-worker-not-executed"])
        self.assertEqual(raised.exception.code, "native_case_refused_invented_closed_refusal")

    def test_native_unstructured_failure_text_not_disclosed(self):
        value = {"schema": "omegacode-hyperon-linux-native-cases-r1", "ok": False,
                 "reason": "invented raw exception /not/a/code", "exception_type": "RuntimeError"}
        process = FakeProcess(stdout=json.dumps(value).encode()); process.returncode = 2
        self.mocked_native(process)
        with self.assertRaises(q.Refusal) as raised:
            q.bounded_native(["invented-worker-not-executed"])
        self.assertEqual(raised.exception.code, "native_failure_report_invalid")

    def test_receipt_private_regular_and_no_overwrite(self):
        target = self.root / "receipt.json"
        q.receipt_write(target, {"ok": False, "reason": "invented_refusal"})
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        with self.assertRaises(q.Refusal):
            q.receipt_write(target, {"ok": True})
        self.assertFalse(json.loads(target.read_text())["ok"])

    def test_receipt_symlink_refused(self):
        protected = self.root / "invented-protected"
        protected.write_text("keep invented fixture")
        link = self.root / "receipt.json"; link.symlink_to(protected)
        with self.assertRaises(q.Refusal):
            q.receipt_write(link, {"ok": True})
        self.assertEqual(protected.read_text(), "keep invented fixture")

    def test_receipt_nonprivate_parent_refused(self):
        self.root.chmod(0o755)
        with self.assertRaises(q.Refusal):
            q.receipt_write(self.root / "receipt.json", {"ok": False})

    def test_receipt_admission_precedes_runtime_and_native(self):
        from argparse import Namespace
        args = Namespace(architecture="x86_64", source_archive=self.root / "invented.zip",
                         wheel=self.root / "invented.whl", worker_python=self.root / "worker/bin/python",
                         worker_root=self.root / "worker", receipt=self.root / "receipt.json")
        args.receipt.write_text("invented existing receipt")
        with mock.patch.object(q, "architecture_check"), mock.patch.object(q, "runtime_roots") as runtime, \
             mock.patch.object(q, "bounded_native") as native:
            with self.assertRaises(q.Refusal) as raised:
                q.qualify(args)
            self.assertEqual(raised.exception.code, "receipt_path_invalid")
            runtime.assert_not_called(); native.assert_not_called()

    def test_cli_native_gate_refuses_without_subprocess(self):
        argv = ["--source-archive", str(self.root / "invented.zip"), "--wheel", str(self.root / "invented.whl"),
                "--worker-python", str(self.root / "worker/bin/python"), "--worker-root", str(self.root / "worker"),
                "--architecture", "x86_64", "--receipt", str(self.root / "receipt.json")]
        with mock.patch.object(q.platform, "system", return_value="Darwin"), mock.patch.object(q.subprocess, "Popen") as process:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(q.main(argv), 1)
            process.assert_not_called()
        self.assertFalse(json.loads((self.root / "receipt.json").read_text())["ok"])

    def test_cli_unstructured_parser_error_is_sanitized(self):
        argv = ["--source-archive", str(self.root / "invented.zip"), "--wheel", str(self.root / "invented.whl"),
                "--worker-python", str(self.root / "worker/bin/python"), "--worker-root", str(self.root / "worker"),
                "--architecture", "x86_64", "--receipt", str(self.root / "receipt.json")]
        stream = io.StringIO()
        with mock.patch.object(q, "qualify", side_effect=csv.Error("invented raw metadata contents")):
            with contextlib.redirect_stdout(stream):
                self.assertEqual(q.main(argv), 1)
        self.assertNotIn("raw metadata", stream.getvalue())
        result = json.loads((self.root / "receipt.json").read_text())
        self.assertEqual(result["reason"], "qualification_failed")

    def test_refusal_details_exclude_unsafe_or_unbounded_paths(self):
        for relative in ("/invented/private", "../invented-private", "a/../private", "a/./b", ".", "x\nprivate", "x" * 513):
            error = q.Refusal("invented_closed_refusal", relative_path=relative)
            self.assertEqual(error.details, {})

    def test_closure_error_does_not_disclose_outside_absolute_path(self):
        outside = self.root.parent / "invented-private-not-opened"
        with self.assertRaises(q.Refusal) as raised:
            q.closure_need(False, "invented_closed_refusal", outside, self.root)
        self.assertNotIn("offending_relative_path", raised.exception.details)
        self.assertNotIn(str(outside), str(raised.exception.details))

    def test_cli_closed_closure_path_reaches_receipt_without_contents(self):
        argv = ["--source-archive", str(self.root / "invented.zip"), "--wheel", str(self.root / "invented.whl"),
                "--worker-python", str(self.root / "worker/bin/python"), "--worker-root", str(self.root / "worker"),
                "--architecture", "x86_64", "--receipt", str(self.root / "receipt.json")]
        relative = "lib/python3.12/site-packages/" + q.DIST + "/uv_cache.json"
        error = q.Refusal("installed_unrecorded_file", relative_path=relative, artifact_class="installer_metadata")
        stream = io.StringIO()
        with mock.patch.object(q, "qualify", side_effect=error), contextlib.redirect_stdout(stream):
            self.assertEqual(q.main(argv), 1)
        result = json.loads((self.root / "receipt.json").read_text())
        self.assertEqual(result["refusal_details"]["offending_relative_path"], relative)
        self.assertNotIn(str(self.root), json.dumps(result))
        self.assertNotIn(relative, stream.getvalue())


if __name__ == "__main__":
    unittest.main()
