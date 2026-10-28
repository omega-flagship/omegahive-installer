"""VM boundary policy organ for OmegaClaw.

This is an immune/habitat membrane. It observes the VM boundary and reports
which exits exist; it does not replace the agent's reasoning or hide policy from her.
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import sys
import time
import re


ROOT = pathlib.Path(__file__).resolve().parents[3]
TRACE_FILE = ROOT / "memory" / "runtime" / "vm_policy" / "trace.jsonl"
MAX_OUTPUT = 5000
VALID_EXIT_DECISIONS = {
    "allowed",
    "blocked",
    "approved",
    "rejected",
    "temporary",
    "observed",
}

# MeTTa import! may load this file by path; py-call addresses the stable name.
sys.modules.setdefault("vm_policy", sys.modules[__name__])


EXIT_PRESETS = [
    {
        "name": "model",
        "purpose": "LLM cognition providers",
        "hosts": ["openrouter.ai", "openrouter.ai:443"],
        "risk": "conversation and code context can leave the VM",
        "necessity": "required",
        "access": "high",
    },
    {
        "name": "messaging",
        "purpose": "WhatsApp and Telegram channels",
        "hosts": ["web.whatsapp.com", "*.web.whatsapp.com", "*.whatsapp.net", "api.telegram.org"],
        "risk": "messages and media can leave through social channels",
        "necessity": "required",
        "access": "high",
    },
    {
        "name": "house",
        "purpose": "Home Assistant and local smart-home APIs",
        "hosts": ["selected LAN smart-home hosts", "homeassistant.local"],
        "risk": "physical-world actions and local network visibility",
        "necessity": "required",
        "access": "high",
    },
    {
        "name": "webhost",
        "purpose": "Cloudflare tunnel and public the agent site",
        "hosts": ["*.cloudflare.com", "*.argotunnel.com"],
        "risk": "published artifacts become externally visible",
        "necessity": "required",
        "access": "medium",
    },
    {
        "name": "github",
        "purpose": "repo review, patch sharing, upstream collaboration",
        "hosts": ["github.com", "api.github.com", "raw.githubusercontent.com"],
        "risk": "code and credentials can be pushed or fetched",
        "necessity": "optional",
        "access": "temporary",
    },
    {
        "name": "packages",
        "purpose": "explicit dependency installation/update windows",
        "hosts": ["pypi.org", "files.pythonhosted.org", "registry.npmjs.org", "deb.debian.org", "archive.ubuntu.com"],
        "risk": "supply-chain execution and arbitrary code download",
        "necessity": "optional",
        "access": "temporary",
    },
    {
        "name": "search",
        "purpose": "web research when the agent needs current information",
        "hosts": ["search provider endpoints"],
        "risk": "queries can disclose intent or private context",
        "necessity": "allowed",
        "access": "ongoing",
    },
]

RISK_ATOMS = {
    "host-like shared mounts visible": ("host-shared-mounts", "host-filesystem-exposure", "high"),
    "user is in sudo group": ("sudo-group", "privilege-escalation", "high"),
    "user is in lxd group": ("lxd-group", "container-escape", "high"),
    "no active firewall service detected": ("no-firewall", "unbounded-egress", "high"),
    "Home Assistant exposed on LAN": ("home-assistant-lan", "local-service-exposure", "medium"),
}


def _run(command: list[str], timeout: int = 8) -> tuple[int, str]:
    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            timeout=timeout,
        )
        return result.returncode, result.stdout.strip()
    except Exception as exc:
        return 125, f"{type(exc).__name__}: {exc}"


def _trace(kind: str, payload: dict) -> None:
    TRACE_FILE.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "kind": kind,
        **payload,
    }
    with TRACE_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def _trace_records(limit: int = 80) -> list[dict]:
    if not TRACE_FILE.exists():
        return []
    records = []
    for line in TRACE_FILE.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]:
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            records.append({"kind": "VMPolicyTraceDecodeError", "raw": line[:500]})
    return records


def _tail(text: str, limit: int = MAX_OUTPUT) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[: limit // 2] + "\n...<vm-policy-truncated>...\n" + text[-limit // 2 :]


def _atom_symbol(value: object) -> str:
    text = str(value).strip().lower()
    text = re.sub(r"[^a-z0-9_.:/-]+", "-", text)
    text = text.strip("-")
    return text or "unknown"


def _atom_string(value: object) -> str:
    return json.dumps(str(value), ensure_ascii=False)


def _groups() -> list[str]:
    return sorted([part for part in os.popen("id -nG 2>/dev/null").read().split() if part])


def _shared_mounts() -> list[str]:
    rc, output = _run(["findmnt", "-R", "-o", "TARGET,SOURCE,FSTYPE,OPTIONS"])
    if rc != 0:
        return [f"findmnt-error:{output}"]
    host_share_fstypes = {"9p", "virtiofs", "sshfs", "vboxsf", "hgfs", "osxfs", "fuse.sshfs"}
    host_share_sources = ("spice", "utm", "shared", "host", "mac")
    lines = []
    for line in output.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 3:
            continue
        source = parts[1].lower()
        fstype = parts[2].lower()
        if fstype in host_share_fstypes or any(term in source for term in host_share_sources):
            lines.append(" ".join(line.split()))
    return lines


def _listeners() -> list[str]:
    rc, output = _run(["ss", "-tulpen"], timeout=8)
    if rc != 0:
        return [f"ss-error:{output}"]
    interesting = []
    for line in output.splitlines():
        if "LISTEN" not in line:
            continue
        if any(port in line for port in (":22", ":8088", ":8123", ":3056", ":5580", ":18555")):
            interesting.append(" ".join(line.split()))
    return interesting[:20]


def _connections() -> list[dict]:
    rc, output = _run(["ss", "-tunp"], timeout=8)
    if rc != 0:
        return [{"state": "error", "detail": output}]
    connections = []
    for line in output.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 5:
            continue
        proto, state, _recv, _send, local, peer = parts[:6]
        if state == "LISTEN" or peer in {"0.0.0.0:*", "[::]:*"}:
            continue
        process = " ".join(parts[6:]) if len(parts) > 6 else ""
        connections.append(
            {
                "proto": proto,
                "state": state,
                "local": local,
                "peer": peer,
                "process": process[:160],
            }
        )
    return connections[:40]


def _routes() -> list[str]:
    rc, output = _run(["ip", "route"])
    if rc != 0:
        return [f"route-error:{output}"]
    return [" ".join(line.split()) for line in output.splitlines()[:10]]


def _tool_status() -> dict:
    return {
        "nft": bool(shutil.which("nft")),
        "ufw": bool(shutil.which("ufw")),
        "iptables": bool(shutil.which("iptables")),
        "cloudflared_service": _run(["systemctl", "is-active", "cloudflared"], timeout=4)[1],
        "ufw_service": _run(["systemctl", "is-active", "ufw"], timeout=4)[1],
        "nftables_service": _run(["systemctl", "is-active", "nftables"], timeout=4)[1],
    }


def _disk_summary() -> dict:
    rc, output = _run(["df", "-P", "/"])
    if rc != 0:
        return {"error": output}
    lines = output.splitlines()
    if len(lines) < 2:
        return {"error": "df output missing"}
    parts = lines[1].split()
    if len(parts) < 6:
        return {"error": output}
    return {
        "filesystem": parts[0],
        "blocks_1k": parts[1],
        "used_1k": parts[2],
        "available_1k": parts[3],
        "use_percent": parts[4],
        "mount": parts[5],
    }


def _memory_summary() -> dict:
    data = {}
    try:
        for line in pathlib.Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            name, value = line.split(":", 1)
            if name in {"MemTotal", "MemAvailable", "SwapTotal", "SwapFree"}:
                data[name] = value.strip()
    except OSError as exc:
        data["error"] = str(exc)
    return data


def _load_summary() -> dict:
    try:
        one, five, fifteen = os.getloadavg()
        return {"load1": round(one, 2), "load5": round(five, 2), "load15": round(fifteen, 2)}
    except OSError as exc:
        return {"error": str(exc)}


def _assessment() -> dict:
    groups = _groups()
    shared_mounts = _shared_mounts()
    tools = _tool_status()
    risks = []
    if shared_mounts:
        risks.append("host-like shared mounts visible")
    if "sudo" in groups:
        risks.append("user is in sudo group")
    if "lxd" in groups:
        risks.append("user is in lxd group")
    if tools.get("ufw_service") != "active" and tools.get("nftables_service") != "active":
        risks.append("no active firewall service detected")
    listeners = _listeners()
    if any("0.0.0.0:8123" in line or "[::]:8123" in line for line in listeners):
        risks.append("Home Assistant exposed on LAN")
    return {
        "mode": os.environ.get("OMEGACLAW_VM_POLICY_MODE", "audit"),
        "groups": groups,
        "shared_mounts": shared_mounts,
        "tools": tools,
        "listeners": listeners,
        "routes": _routes(),
        "risks": risks,
    }


def _risk_atoms(state: dict) -> list[str]:
    atoms = []
    for risk in state["risks"]:
        name, kind, severity = RISK_ATOMS.get(risk, (_atom_symbol(risk), "boundary-risk", "medium"))
        atoms.append(f"(VMBoundaryRisk {name} {kind} {severity})")
    return atoms


def _exit_atoms() -> list[str]:
    atoms = []
    for item in EXIT_PRESETS:
        name = _atom_symbol(item["name"])
        atoms.append(f"(VMExit {name} {item['necessity']} {item['access']})")
        atoms.append(f"(VMExitPurpose {name} {_atom_string(item['purpose'])})")
        atoms.append(f"(VMExitRisk {name} {_atom_string(item['risk'])})")
        for host in item["hosts"]:
            atoms.append(f"(VMExitHost {name} {_atom_string(host)})")
    return atoms


def _metric_atoms(state: dict) -> list[str]:
    tools = state["tools"]
    disk = _disk_summary()
    mem = _memory_summary()
    load = _load_summary()
    atoms = [
        f"(VMPolicyMode {_atom_symbol(state['mode'])})",
        f"(VMSharedMountCount {len(state['shared_mounts'])})",
        f"(VMFirewallService ufw {_atom_symbol(tools.get('ufw_service', 'unknown'))})",
        f"(VMFirewallService nftables {_atom_symbol(tools.get('nftables_service', 'unknown'))})",
        f"(VMRuntimeTool nft {_atom_symbol(tools.get('nft'))})",
        f"(VMRuntimeTool ufw {_atom_symbol(tools.get('ufw'))})",
        f"(VMRuntimeTool iptables {_atom_symbol(tools.get('iptables'))})",
    ]
    if "use_percent" in disk:
        atoms.append(f"(VMMetric disk-root-use-percent {_atom_string(disk['use_percent'])})")
        atoms.append(f"(VMMetric disk-root-available-1k {disk['available_1k']})")
    for key, value in mem.items():
        atoms.append(f"(VMMetric {_atom_symbol(key)} {_atom_string(value)})")
    for key, value in load.items():
        atoms.append(f"(VMMetric {_atom_symbol(key)} {value})")
    return atoms


def _exit_decision_atoms(records: list[dict]) -> list[str]:
    atoms = []
    for index, record in enumerate(records, start=1):
        kind = record.get("kind")
        if kind == "VMPolicyExitDecision":
            rid = f"exit-decision-{index}"
            service = _atom_symbol(record.get("service", "unknown"))
            decision = _atom_symbol(record.get("decision", "unknown"))
            atoms.append(f"(VMExitDecision {rid} {service} {decision})")
            atoms.append(f"(VMExitDecisionTime {rid} {_atom_string(record.get('time', 'unknown'))})")
            atoms.append(f"(VMExitDecisionReason {rid} {_atom_string(record.get('reason', ''))})")
            atoms.append(f"(VMExitDecisionSource {rid} {_atom_string(record.get('source', 'omega'))})")
        elif kind == "VMPolicyMaintenanceWindowRequested":
            rid = f"maintenance-window-{index}"
            service = _atom_symbol(record.get("service", "unknown"))
            duration = _atom_symbol(record.get("duration", "unspecified"))
            atoms.append(f"(VMMaintenanceWindowTrace {rid} {service} {duration})")
            atoms.append(f"(VMMaintenanceWindowTime {rid} {_atom_string(record.get('time', 'unknown'))})")
            atoms.append(f"(VMMaintenanceWindowReason {rid} {_atom_string(record.get('reason', ''))})")
            atoms.append(f"(VMMaintenanceWindowStatus {rid} {_atom_symbol(record.get('status', 'unknown'))})")
    return atoms


def _exit_summary_atoms(records: list[dict]) -> list[str]:
    counts: dict[tuple[str, str], int] = {}
    last: dict[str, dict] = {}
    for record in records:
        if record.get("kind") != "VMPolicyExitDecision":
            continue
        service = _atom_symbol(record.get("service", "unknown"))
        decision = _atom_symbol(record.get("decision", "unknown"))
        counts[(service, decision)] = counts.get((service, decision), 0) + 1
        last[service] = record

    atoms = []
    for (service, decision), count in sorted(counts.items()):
        atoms.append(f"(VMExitDecisionCount {service} {decision} {count})")
    for service, record in sorted(last.items()):
        atoms.append(
            f"(VMExitLastDecision {service} {_atom_symbol(record.get('decision', 'unknown'))} "
            f"{_atom_string(record.get('time', 'unknown'))} {_atom_string(record.get('reason', ''))})"
        )
    return atoms or ["(VMExitDecisionCount none none 0)"]


def vm_policy_status() -> str:
    state = _assessment()
    _trace("VMPolicyObserved", {"mode": state["mode"], "risks": state["risks"]})
    return _tail(
        "VM-POLICY-STATUS "
        f"mode={state['mode']} "
        f"groups={','.join(state['groups']) or 'none'} "
        f"shared_mounts={len(state['shared_mounts'])} "
        f"ufw={state['tools'].get('ufw_service')} "
        f"nftables={state['tools'].get('nftables_service')} "
        f"risks={'; '.join(state['risks']) or 'none'}\n"
        f"listeners={json.dumps(state['listeners'], ensure_ascii=False)}\n"
        f"routes={json.dumps(state['routes'], ensure_ascii=False)}"
    )


def vm_policy_exits() -> str:
    _trace("VMPolicyObserved", {"exits": [item["name"] for item in EXIT_PRESETS]})
    lines = ["VM-POLICY-EXITS"]
    for item in EXIT_PRESETS:
        lines.append(
            f"{item['name']}: purpose={item['purpose']} hosts={','.join(item['hosts'])} risk={item['risk']}"
        )
    return _tail("\n".join(lines))


def vm_policy_atoms() -> str:
    state = _assessment()
    atoms = [
        "(VMRuntime omega-vm local-utm)",
        "(VMBoundary vm-boundary vm)",
        "(VMContainmentPrimary vm-boundary true)",
        "(CodexInnerSandbox primary-containment false)",
    ]
    atoms.extend(_exit_atoms())
    atoms.extend(_risk_atoms(state))
    atoms.extend(_metric_atoms(state))
    _trace("VMPolicyAtoms", {"atom_count": len(atoms), "risks": state["risks"]})
    return "VM-POLICY-ATOMS\n" + "\n".join(atoms)


def vm_policy_connections() -> str:
    connections = _connections()
    atoms = []
    for index, item in enumerate(connections, start=1):
        if item.get("state") == "error":
            atoms.append(f"(VMConnectionError {_atom_string(item.get('detail', 'unknown'))})")
            continue
        cid = f"conn-{index}"
        atoms.append(
            f"(VMConnection {cid} {_atom_symbol(item['proto'])} {_atom_symbol(item['state'])} "
            f"{_atom_string(item['local'])} {_atom_string(item['peer'])})"
        )
        if item.get("process"):
            atoms.append(f"(VMConnectionProcess {cid} {_atom_string(item['process'])})")
    _trace("VMPolicyConnectionsObserved", {"connection_count": len(connections)})
    return _tail("VM-POLICY-CONNECTIONS\n" + "\n".join(atoms))


def vm_policy_metrics() -> str:
    state = _assessment()
    atoms = _metric_atoms(state)
    _trace("VMPolicyMetrics", {"metric_count": len(atoms)})
    return "VM-POLICY-METRICS\n" + "\n".join(atoms)


def vm_policy_audit() -> str:
    state = _assessment()
    recommendations = [
        "keep Codex full-power inside VM; treat VM as containment boundary",
        "remove or avoid using host shared folders",
        "preserve administrator SSH access before enabling egress deny",
        "move toward deny-by-default egress with named presets",
        "make package/github access temporary windows where possible",
        "surface policy blocks to the agent as boundary facts, not moral rules",
    ]
    if "sudo" in state["groups"] or "lxd" in state["groups"]:
        recommendations.append("review sudo/lxd group membership once recovery access is confirmed")
    _trace("VMPolicyAudit", {"risks": state["risks"], "recommendations": recommendations})
    return _tail(
        "VM-POLICY-AUDIT\n"
        f"risks={json.dumps(state['risks'], ensure_ascii=False)}\n"
        f"shared_mounts={json.dumps(state['shared_mounts'], ensure_ascii=False)}\n"
        f"recommendations={json.dumps(recommendations, ensure_ascii=False)}"
    )


def vm_policy_enforcement_plan() -> str:
    plan = [
        "1. Snapshot current network state and confirm local console/UTM access.",
        "2. Preserve required administrator SSH/LAN access and local loopback services.",
        "3. Preserve established/related traffic, DNS, NTP, Cloudflare tunnel, WhatsApp, Telegram, OpenRouter, Home Assistant, GitHub, and package repos.",
        "4. Add logging counters for denied egress before hard deny.",
        "5. Run the agent for a supervised window and record which exits she actually uses.",
        "6. Convert observed stable exits into named presets; keep search allowed/observed, and make GitHub/package temporary windows where possible.",
        "7. Only then switch outbound default deny.",
    ]
    _trace("VMPolicyPlan", {"steps": plan})
    return "VM-POLICY-ENFORCEMENT-PLAN review-only\n" + "\n".join(plan)


def vm_policy_maintenance_window(service: str, reason_and_duration: str) -> str:
    service_atom = _atom_symbol(service)
    text = str(reason_and_duration).strip()
    duration = "unspecified"
    reason = text
    if " duration=" in f" {text}":
        before, _, after = text.partition("duration=")
        reason = before.strip() or text
        duration = after.split()[0] if after.split() else "unspecified"
    elif " for " in f" {text} ":
        before, _, after = text.rpartition(" for ")
        reason = before.strip() or text
        duration = after.strip().split()[0] if after.strip().split() else "unspecified"
    duration_atom = _atom_symbol(duration)
    record = {
        "service": service_atom,
        "reason": reason[:500],
        "duration": duration_atom,
        "status": "requested-review-only",
    }
    _trace("VMPolicyMaintenanceWindowRequested", record)
    return (
        "VM-POLICY-MAINTENANCE-WINDOW review-only\n"
        f"(VMMaintenanceWindowRequest {service_atom} {duration_atom} {_atom_string(reason)})\n"
        "(VMMaintenanceWindowStatus requested-review-only)\n"
        "No firewall or network policy was changed."
    )


def vm_policy_record_exit(service: str, decision_and_reason: str) -> str:
    service_atom = _atom_symbol(service)
    text = str(decision_and_reason).strip()
    decision_text, _, reason_text = text.partition(" ")
    decision = _atom_symbol(decision_text or "observed")
    reason = reason_text.strip() or "no reason supplied"
    if decision not in VALID_EXIT_DECISIONS:
        _trace(
            "VMPolicyExitDecisionInvalid",
            {"service": service_atom, "decision": decision, "reason": reason[:500]},
        )
        return (
            "VM-POLICY-RECORD-EXIT invalid-decision\n"
            f"(VMExitDecisionRejected {service_atom} {decision} {_atom_string(reason)})\n"
            f"Valid decisions: {', '.join(sorted(VALID_EXIT_DECISIONS))}\n"
            "No firewall or network policy was changed."
        )

    record = {
        "service": service_atom,
        "decision": decision,
        "reason": reason[:500],
        "source": "omega",
        "status": "recorded-review-evidence",
    }
    _trace("VMPolicyExitDecision", record)
    return (
        "VM-POLICY-RECORD-EXIT recorded\n"
        f"(VMExitDecision current {service_atom} {decision})\n"
        f"(VMExitDecisionReason current {_atom_string(reason)})\n"
        "(VMExitDecisionStatus current recorded-review-evidence)\n"
        "No firewall or network policy was changed."
    )


def vm_policy_exit_history() -> str:
    records = [
        record
        for record in _trace_records()
        if record.get("kind") in {"VMPolicyExitDecision", "VMPolicyMaintenanceWindowRequested"}
    ]
    atoms = _exit_decision_atoms(records)
    _trace("VMPolicyExitHistoryObserved", {"event_count": len(records)})
    return _tail("VM-POLICY-EXIT-HISTORY\n" + "\n".join(atoms))


def vm_policy_exit_summary() -> str:
    records = [record for record in _trace_records(200) if record.get("kind") == "VMPolicyExitDecision"]
    atoms = _exit_summary_atoms(records)
    _trace("VMPolicyExitSummaryObserved", {"event_count": len(records)})
    return "VM-POLICY-EXIT-SUMMARY\n" + "\n".join(atoms)


def vm_policy_last_trace() -> str:
    if not TRACE_FILE.exists():
        return "VM-POLICY-TRACE empty"
    lines = TRACE_FILE.read_text(encoding="utf-8", errors="replace").splitlines()[-8:]
    return "VM-POLICY-TRACE\n" + "\n".join(lines)
