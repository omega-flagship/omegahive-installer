import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE = ROOT / "modules" / "vm_policy" / "src" / "vm_policy.py"
spec = importlib.util.spec_from_file_location("vm_policy_under_test", MODULE)
vm_policy = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = vm_policy
spec.loader.exec_module(vm_policy)


class VMPolicyModuleTests(unittest.TestCase):
    def test_exits_are_named_and_include_required_body_channels(self):
        exits = vm_policy.vm_policy_exits()
        self.assertIn("VM-POLICY-EXITS", exits)
        for name in ("model", "messaging", "house", "webhost", "github", "packages", "search"):
            self.assertIn(f"{name}:", exits)

    def test_atoms_surface_vm_boundary_as_metta(self):
        fake_state = {
            "mode": "audit",
            "groups": ["user", "sudo"],
            "shared_mounts": [],
            "tools": {"ufw_service": "active", "nftables_service": "inactive", "nft": True, "ufw": True, "iptables": True},
            "listeners": [],
            "routes": [],
            "risks": ["user is in sudo group"],
        }
        with mock.patch.object(vm_policy, "_assessment", return_value=fake_state), \
             mock.patch.object(vm_policy, "_disk_summary", return_value={"use_percent": "10%", "available_1k": "100"}), \
             mock.patch.object(vm_policy, "_memory_summary", return_value={"MemAvailable": "1024 kB"}), \
             mock.patch.object(vm_policy, "_load_summary", return_value={"load1": 0.1}), \
             mock.patch.object(vm_policy, "_trace"):
            atoms = vm_policy.vm_policy_atoms()
        self.assertIn("(VMRuntime omega-vm local-utm)", atoms)
        self.assertIn("(VMExit model required high)", atoms)
        self.assertIn("(VMExit search allowed ongoing)", atoms)
        self.assertIn('(VMExitHost messaging "web.whatsapp.com")', atoms)
        self.assertIn("(VMBoundaryRisk sudo-group privilege-escalation high)", atoms)
        self.assertIn("(VMPolicyMode audit)", atoms)

    def test_connections_are_reported_as_atoms(self):
        fake_connections = [
            {"proto": "tcp", "state": "ESTAB", "local": "10.0.0.2:123", "peer": "1.2.3.4:443", "process": "users:node"},
        ]
        with mock.patch.object(vm_policy, "_connections", return_value=fake_connections), \
             mock.patch.object(vm_policy, "_trace"):
            result = vm_policy.vm_policy_connections()
        self.assertIn("VM-POLICY-CONNECTIONS", result)
        self.assertIn('(VMConnection conn-1 tcp estab "10.0.0.2:123" "1.2.3.4:443")', result)
        self.assertIn('(VMConnectionProcess conn-1 "users:node")', result)

    def test_metrics_are_reported_as_atoms(self):
        fake_state = {
            "mode": "audit",
            "groups": [],
            "shared_mounts": [],
            "tools": {"ufw_service": "active", "nftables_service": "inactive", "nft": True, "ufw": True, "iptables": True},
            "listeners": [],
            "routes": [],
            "risks": [],
        }
        with mock.patch.object(vm_policy, "_assessment", return_value=fake_state), \
             mock.patch.object(vm_policy, "_disk_summary", return_value={"use_percent": "10%", "available_1k": "100"}), \
             mock.patch.object(vm_policy, "_memory_summary", return_value={"MemAvailable": "1024 kB"}), \
             mock.patch.object(vm_policy, "_load_summary", return_value={"load1": 0.1}), \
             mock.patch.object(vm_policy, "_trace"):
            metrics = vm_policy.vm_policy_metrics()
        self.assertIn("(VMMetric disk-root-use-percent \"10%\")", metrics)
        self.assertIn("(VMMetric memavailable \"1024 kB\")", metrics)
        self.assertIn("(VMMetric load1 0.1)", metrics)

    def test_audit_reports_privileged_groups_without_enforcing(self):
        fake_state = {
            "mode": "audit",
            "groups": ["user", "sudo", "lxd"],
            "shared_mounts": [],
            "tools": {"ufw_service": "active", "nftables_service": "inactive"},
            "listeners": [],
            "routes": [],
            "risks": ["user is in sudo group", "user is in lxd group"],
        }
        with mock.patch.object(vm_policy, "_assessment", return_value=fake_state), \
             mock.patch.object(vm_policy, "_trace"):
            audit = vm_policy.vm_policy_audit()
        self.assertIn("VM-POLICY-AUDIT", audit)
        self.assertIn("sudo", audit)
        self.assertIn("lxd", audit)
        self.assertIn("review sudo/lxd group membership", audit)

    def test_plan_is_review_only_and_does_not_emit_commands(self):
        with mock.patch.object(vm_policy, "_trace"):
            plan = vm_policy.vm_policy_enforcement_plan()
        self.assertIn("review-only", plan)
        self.assertIn("Only then switch outbound default deny", plan)
        self.assertNotIn("iptables -P OUTPUT DROP", plan)
        self.assertNotIn("ufw default deny outgoing", plan)

    def test_maintenance_window_is_trace_only(self):
        with mock.patch.object(vm_policy, "_trace") as trace:
            result = vm_policy.vm_policy_maintenance_window("github", "patch review duration=15m")
        self.assertIn("review-only", result)
        self.assertIn("(VMMaintenanceWindowRequest github 15m \"patch review\")", result)
        self.assertIn("No firewall or network policy was changed.", result)
        trace.assert_called_once()

    def test_record_exit_writes_symbolic_review_evidence_only(self):
        with mock.patch.object(vm_policy, "_trace") as trace:
            result = vm_policy.vm_policy_record_exit("github", "temporary patch review")
        self.assertIn("VM-POLICY-RECORD-EXIT recorded", result)
        self.assertIn("(VMExitDecision current github temporary)", result)
        self.assertIn("(VMExitDecisionReason current \"patch review\")", result)
        self.assertIn("No firewall or network policy was changed.", result)
        trace.assert_called_once_with(
            "VMPolicyExitDecision",
            {
                "service": "github",
                "decision": "temporary",
                "reason": "patch review",
                "source": "omega",
                "status": "recorded-review-evidence",
            },
        )

    def test_record_exit_rejects_unknown_decision_without_enforcement(self):
        with mock.patch.object(vm_policy, "_trace") as trace:
            result = vm_policy.vm_policy_record_exit("github", "forever because I said so")
        self.assertIn("invalid-decision", result)
        self.assertIn("(VMExitDecisionRejected github forever \"because I said so\")", result)
        self.assertIn("No firewall or network policy was changed.", result)
        trace.assert_called_once()

    def test_exit_history_and_summary_return_reasonable_atoms(self):
        records = [
            {
                "time": "2026-05-23T06:00:00Z",
                "kind": "VMPolicyExitDecision",
                "service": "github",
                "decision": "temporary",
                "reason": "patch review",
                "source": "omega",
            },
            {
                "time": "2026-05-23T06:01:00Z",
                "kind": "VMPolicyMaintenanceWindowRequested",
                "service": "packages",
                "duration": "10m",
                "reason": "dependency check",
                "status": "requested-review-only",
            },
        ]
        with mock.patch.object(vm_policy, "_trace_records", return_value=records), \
             mock.patch.object(vm_policy, "_trace"):
            history = vm_policy.vm_policy_exit_history()
            summary = vm_policy.vm_policy_exit_summary()
        self.assertIn("(VMExitDecision exit-decision-1 github temporary)", history)
        self.assertIn("(VMMaintenanceWindowTrace maintenance-window-2 packages 10m)", history)
        self.assertIn("(VMExitDecisionCount github temporary 1)", summary)
        self.assertIn('(VMExitLastDecision github temporary "2026-05-23T06:00:00Z" "patch review")', summary)

    def test_shared_mount_detector_ignores_kernel_fusectl(self):
        findmnt = """TARGET SOURCE FSTYPE OPTIONS
/ sysfs sysfs rw
/sys/fs/fuse/connections fusectl fusectl rw,nosuid
/run/qemu tmpfs tmpfs rw,nosuid
/mnt/hostshare macshare virtiofs rw
"""
        with mock.patch.object(vm_policy, "_run", return_value=(0, findmnt)):
            mounts = vm_policy._shared_mounts()
        self.assertEqual(mounts, ["/mnt/hostshare macshare virtiofs rw"])

    def test_trace_records_are_typed_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            trace_file = pathlib.Path(tmp) / "trace.jsonl"
            with mock.patch.object(vm_policy, "TRACE_FILE", trace_file):
                vm_policy._trace("VMPolicyAudit", {"risks": ["x"]})
            record = json.loads(trace_file.read_text(encoding="utf-8"))
        self.assertEqual(record["kind"], "VMPolicyAudit")
        self.assertEqual(record["risks"], ["x"])


if __name__ == "__main__":
    unittest.main()
