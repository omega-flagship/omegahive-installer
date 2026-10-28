"""Agentverse/uAgents remote-agent membrane for OmegaClaw.

This organ keeps Agentverse optional and traceable. Importing the module must
not require the ``uagents`` dependency, because deployments may install the
organ before enabling the network runtime.
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import secrets
import shutil
import subprocess
import sys
import time
import urllib.request
from typing import Any


CORE_ROOT = pathlib.Path(__file__).resolve().parents[3]
TRACE_FILE = CORE_ROOT / "memory" / "runtime" / "agentverse" / "trace.jsonl"
REGISTRY_FILE = CORE_ROOT / "memory" / "runtime" / "agentverse" / "agents.json"
LISTENER_FILE = CORE_ROOT / "modules" / "agentverse" / "src" / "agentverse_listener.py"
LISTENER_STATE_FILE = CORE_ROOT / "memory" / "runtime" / "agentverse" / "listener.json"
LISTENER_INBOX_FILE = CORE_ROOT / "memory" / "runtime" / "agentverse" / "inbox.jsonl"
LISTENER_COMMAND_FILE = CORE_ROOT / "memory" / "runtime" / "agentverse" / "commands.jsonl"
LISTENER_SEED_FILE = CORE_ROOT / "memory" / "runtime" / "agentverse" / "local_seed.txt"

AGENTVERSE_SEARCH_URL = os.environ.get(
    "AGENTVERSE_SEARCH_URL",
    "https://agentverse.ai/v1/search/agents",
)

_current_module = sys.modules.get(__name__)
if _current_module is not None:
    sys.modules.setdefault("agentverse_bridge", _current_module)


def _trace(kind: str, **payload: object) -> None:
    TRACE_FILE.parent.mkdir(parents=True, exist_ok=True)
    record = {"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "kind": kind, **payload}
    with TRACE_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def _trace_records(limit: int = 20) -> list[dict]:
    if not TRACE_FILE.exists():
        return []
    records: list[dict] = []
    for line in TRACE_FILE.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]:
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            records.append({"kind": "AgentverseTraceDecodeError", "raw": line[:500]})
    return records


def _read_json_file(path: pathlib.Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _pid_running(pid: object) -> bool:
    try:
        os.kill(int(pid), 0)
    except Exception:
        return False
    return True


def _uagents():
    try:
        from uagents import Model
        from uagents.query import send_sync_message
    except Exception as exc:
        return None, None, exc
    return Model, send_sync_message, None


def _agent_chat_protocol():
    try:
        from uagents_core.contrib.protocols.chat import (
            ChatAcknowledgement,
            ChatMessage,
            TextContent,
        )
    except Exception as exc:
        return None, None, None, exc
    return ChatAcknowledgement, ChatMessage, TextContent, None


def _truncate_text(value: Any, limit: int) -> str:
    text = " ".join(str(value).split())
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


def _atom_symbol(value: object) -> str:
    text = str(value or "").strip().lower()
    out = []
    for char in text:
        if char.isalnum() or char in {"-", "_", ".", ":"}:
            out.append(char)
        elif char.isspace():
            out.append("-")
    symbol = "".join(out).strip("-")
    return symbol or "unknown"


def _atom_string(value: object) -> str:
    return json.dumps(str(value or ""), ensure_ascii=False)


def _workspace_python() -> str:
    configured = os.environ.get("OMEGACLAW_PYTHON")
    if configured:
        return configured
    try:
        workspace_root = CORE_ROOT.parents[1]
    except IndexError:
        workspace_root = CORE_ROOT.parent
    venv_python = workspace_root / ".venv" / "bin" / "python"
    if venv_python.exists():
        return str(venv_python)
    return shutil.which("python3") or sys.executable


def _listener_seed() -> str:
    configured = os.environ.get("OMEGACLAW_AGENTVERSE_SEED") or os.environ.get("AGENTVERSE_SEED_PHRASE")
    if configured:
        return configured
    LISTENER_SEED_FILE.parent.mkdir(parents=True, exist_ok=True)
    if LISTENER_SEED_FILE.exists():
        return LISTENER_SEED_FILE.read_text(encoding="utf-8").strip()
    seed = "omega agentverse local listener " + secrets.token_hex(24)
    LISTENER_SEED_FILE.write_text(seed + "\n", encoding="utf-8")
    try:
        LISTENER_SEED_FILE.chmod(0o600)
    except Exception:
        pass
    return seed


def _canonical_schema(schema: str) -> str:
    normalized = str(schema or "").strip().lower().replace("_", "-").replace(" ", "-")
    if normalized in {"message", "simple-message"}:
        return "Message"
    if normalized in {
        "agentchatprotocol",
        "agent-chat-protocol",
        "agent-chat-protocol:0.3.0",
        "chatmessage",
        "chat-message",
        "chat",
    }:
        return "AgentChatProtocol"
    return str(schema or "").strip()


def _make_model(schema: str, payload: str):
    Model, _send_sync_message, error = _uagents()
    if error is not None:
        raise RuntimeError(f"uagents unavailable: {error}")
    canonical = _canonical_schema(schema)
    if canonical == "Message":
        class Message(Model):  # type: ignore[valid-type, misc]
            message: str

        return Message(message=payload)
    if canonical == "AgentChatProtocol":
        _ChatAcknowledgement, ChatMessage, TextContent, chat_error = _agent_chat_protocol()
        if chat_error is not None:
            raise RuntimeError(f"uagents chat protocol unavailable: {chat_error}")
        return ChatMessage(content=[TextContent(text=str(payload))])
    raise ValueError(f"unsupported Agentverse schema: {schema}")


def _response_type_for_schema(schema: str):
    if _canonical_schema(schema) != "AgentChatProtocol":
        return None
    ChatAcknowledgement, _ChatMessage, _TextContent, chat_error = _agent_chat_protocol()
    if chat_error is not None:
        raise RuntimeError(f"uagents chat protocol unavailable: {chat_error}")
    return ChatAcknowledgement


async def _ask_agent(destination: str, request, response_type=None, timeout: int = 60) -> str:
    _Model, send_sync_message, error = _uagents()
    if error is not None:
        raise RuntimeError(f"uagents unavailable: {error}")
    envelope_or_status = await send_sync_message(
        destination=destination,
        message=request,
        response_type=response_type,
        timeout=timeout,
    )
    return envelope_or_status


def _format_agentverse_response(schema: str, response: Any) -> str:
    canonical = _canonical_schema(schema)
    response_type = type(response).__name__
    if canonical == "AgentChatProtocol" and response_type == "ChatAcknowledgement":
        return (
            "AGENTVERSE-ACK schema=AgentChatProtocol "
            f"acknowledged_msg_id={getattr(response, 'acknowledged_msg_id', '')} "
            f"timestamp={getattr(response, 'timestamp', '')}"
        )
    if response_type == "MsgStatus":
        return (
            "AGENTVERSE-STATUS "
            f"status={getattr(response, 'status', '')} "
            f"detail={getattr(response, 'detail', '')} "
            f"destination={getattr(response, 'destination', '')} "
            f"endpoint={getattr(response, 'endpoint', '')}"
        )
    if hasattr(response, "model_dump_json"):
        try:
            return str(response.model_dump_json())
        except Exception:
            pass
    return str(response)


def agentverse_listener_status() -> str:
    state = _read_json_file(LISTENER_STATE_FILE)
    pid = state.get("pid")
    running = _pid_running(pid)
    status = "running" if running else "stopped"
    address = state.get("address", "")
    endpoint = state.get("endpoint", "")
    _trace("AgentverseListenerObserved", status=status, pid=pid, address=address, endpoint=endpoint)
    return f"AGENTVERSE-LISTENER status={status} pid={pid or ''} address={address} endpoint={endpoint}"


def agentverse_start_listener() -> str:
    state = _read_json_file(LISTENER_STATE_FILE)
    if _pid_running(state.get("pid")):
        return agentverse_listener_status()
    endpoint = os.environ.get("OMEGACLAW_AGENTVERSE_ENDPOINT", "").strip()
    mailbox = os.environ.get("OMEGACLAW_AGENTVERSE_MAILBOX", "").lower() in {"1", "true", "yes", "on"}
    if not endpoint and not mailbox:
        return (
            "AGENTVERSE-LISTENER-NEEDS-ENDPOINT set OMEGACLAW_AGENTVERSE_ENDPOINT "
            "to a public base URL ending before /submit, or set OMEGACLAW_AGENTVERSE_MAILBOX=1 "
            "after creating an Agentverse mailbox"
        )
    env = os.environ.copy()
    env["OMEGACLAW_AGENTVERSE_SEED"] = _listener_seed()
    pythonpath = os.pathsep.join(
        part
        for part in [
            str(LISTENER_FILE.parent),
            str(CORE_ROOT),
            env.get("PYTHONPATH", ""),
        ]
        if part
    )
    env["PYTHONPATH"] = pythonpath
    process = subprocess.Popen(
        [_workspace_python(), str(LISTENER_FILE)],
        cwd=str(CORE_ROOT),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    _trace("AgentverseListenerStarted", pid=process.pid, endpoint=endpoint, mailbox=mailbox)
    return f"AGENTVERSE-LISTENER-STARTED pid={process.pid} endpoint={endpoint} mailbox={mailbox}"


def agentverse_stop_listener() -> str:
    state = _read_json_file(LISTENER_STATE_FILE)
    pid = state.get("pid")
    if not _pid_running(pid):
        return "AGENTVERSE-LISTENER status=stopped"
    try:
        os.kill(int(pid), 15)
    except Exception as exc:
        return f"AGENTVERSE-LISTENER-ERROR {type(exc).__name__}: {exc}"
    _trace("AgentverseListenerStopped", pid=pid)
    return f"AGENTVERSE-LISTENER-STOPPED pid={pid}"


def _listener_records(limit: int = 20) -> list[dict]:
    if not LISTENER_INBOX_FILE.exists():
        return []
    records: list[dict] = []
    for line in LISTENER_INBOX_FILE.read_text(encoding="utf-8", errors="replace").splitlines()[-int(limit):]:
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            item = {"kind": "AgentverseInboxDecodeError", "raw": line[:500]}
        if isinstance(item, dict):
            records.append(item)
    return records


def agentverse_inbox(limit: int = 20) -> str:
    atoms = []
    for record in _listener_records(int(limit)):
        kind = str(record.get("kind", "AgentverseInbox"))
        when = str(record.get("time", "unknown"))
        detail = _truncate_text(json.dumps(record, ensure_ascii=False, sort_keys=True), 700)
        atoms.append(f'(AgentverseInbox "{when}" {json.dumps(kind)} {json.dumps(detail, ensure_ascii=False)})')
    return "(" + " ".join(atoms) + ")" if atoms else "AGENTVERSE-INBOX empty"


def _queue_agentverse_chat(destination: str, payload: str) -> str:
    status = _read_json_file(LISTENER_STATE_FILE)
    if not _pid_running(status.get("pid")):
        return "AGENTVERSE-LISTENER-REQUIRED start agentverse-listener-start before AgentChatProtocol calls"
    command_id = f"cmd-{int(time.time() * 1000)}-{secrets.token_hex(4)}"
    LISTENER_COMMAND_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LISTENER_COMMAND_FILE.open("a", encoding="utf-8") as handle:
        handle.write(
            json.dumps(
                {
                    "id": command_id,
                    "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "destination": str(destination),
                    "schema": "AgentChatProtocol",
                    "payload": str(payload),
                },
                ensure_ascii=False,
                sort_keys=True,
            )
            + "\n"
        )
    _trace("AgentverseRequestQueued", command_id=command_id, destination=destination, schema="AgentChatProtocol", payload=_truncate_text(payload, 500))
    return f"AGENTVERSE-QUEUED command_id={command_id} check=agentverse-inbox"


def agentverse_status() -> str:
    _Model, _send_sync_message, error = _uagents()
    if error is None:
        status = "ready"
        _ChatAcknowledgement, _ChatMessage, _TextContent, chat_error = _agent_chat_protocol()
        if chat_error is None:
            detail = "uagents import ok; AgentChatProtocol import ok"
        else:
            detail = f"uagents import ok; AgentChatProtocol unavailable: {chat_error}"
    else:
        status = "missing-dependency"
        detail = str(error)
    _trace("RemoteAgentObserved", status=status, detail=detail)
    return (
        f"AGENTVERSE-STATUS status={status} detail={detail} "
        f"search={AGENTVERSE_SEARCH_URL} trace={TRACE_FILE}"
    )


def agentverse_record_agent(name: str, address: str, schema: str, capability: str) -> str:
    REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    try:
        records = json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))
        if not isinstance(records, dict):
            records = {}
    except Exception:
        records = {}
    records[str(name)] = {
        "address": str(address),
        "schema": str(schema),
        "capability": str(capability),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    tmp = REGISTRY_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(records, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(REGISTRY_FILE)
    _trace("RemoteAgentRegistered", name=name, address=address, schema=schema, capability=capability)
    return f"AGENTVERSE-AGENT-RECORDED name={name} schema={schema} capability={capability}"


def agentverse_remote_agents() -> str:
    try:
        records = json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))
    except Exception:
        records = {}
    atoms = []
    if isinstance(records, dict):
        for name, spec in sorted(records.items()):
            if not isinstance(spec, dict):
                continue
            atoms.append(
                f'(RemoteAgent {_atom_string(name)} {_atom_string(spec.get("address"))} '
                f'{_atom_string(spec.get("schema"))} {_atom_string(spec.get("capability"))})'
            )
    _trace("RemoteAgentObserved", status="listed", count=len(atoms))
    return "(" + " ".join(atoms) + ")" if atoms else "()"


def _search_payload(query: str, limit: int) -> dict:
    return {
        "search_text": query,
        "filters": {},
        "offset": 0,
        "limit": limit,
    }


def _post_json(url: str, payload: dict, timeout: int = 20) -> dict:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "OmegaClaw-Agentverse-Bridge/0.1",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = response.read()
    return json.loads(data.decode("utf-8"))


def agentverse_discover_atoms(query: str, limit: int = 5) -> str:
    try:
        data = _post_json(AGENTVERSE_SEARCH_URL, _search_payload(str(query), int(limit)))
        agents = data.get("agents", [])
        if not isinstance(agents, list):
            agents = []
        candidates = []
        for idx, agent in enumerate(agents[: int(limit)], 1):
            if not isinstance(agent, dict):
                continue
            protocols = agent.get("protocols", [])
            if isinstance(protocols, list):
                proto_names = ",".join(
                    str(proto.get("name") or proto.get("digest") or "unknown")
                    for proto in protocols
                    if isinstance(proto, dict)
                )
            else:
                proto_names = "unknown"
            candidates.append(
                "(RemoteAgentCandidate "
                f"{_atom_symbol(query)} "
                f"{idx} "
                f"{_atom_string(agent.get('name'))} "
                f"{_atom_string(agent.get('address'))} "
                f"{_atom_string(agent.get('status'))} "
                f"{_atom_string(agent.get('type'))} "
                f"{_atom_string(proto_names)} "
                f"{_atom_string(_truncate_text(agent.get('description') or agent.get('readme') or '', 500))}"
                ")"
            )
        atom = f"(AgentverseDiscovery {_atom_string(query)} {len(candidates)} {' '.join(candidates)})"
        _trace("AgentverseDiscovery", query=query, count=len(candidates))
        return atom
    except Exception as exc:
        _trace("AgentverseError", operation="discover", query=query, error=str(exc))
        return (
            f"(AgentverseDiscoveryError {_atom_string(query)} "
            f"{_atom_string(type(exc).__name__)} {_atom_string(str(exc))})"
        )


def agentverse_ask(destination: str, schema: str, payload: str, timeout: int = 60) -> str:
    try:
        canonical_schema = _canonical_schema(schema)
        request = _make_model(schema, payload)
        response_type = _response_type_for_schema(schema)
        _trace(
            "AgentverseRequest",
            destination=destination,
            schema=schema,
            canonical_schema=canonical_schema,
            payload=_truncate_text(payload, 500),
        )
        raw_response = asyncio.run(
            _ask_agent(
                destination=destination,
                request=request,
                response_type=response_type,
                timeout=int(timeout),
            )
        )
        response = _format_agentverse_response(schema, raw_response)
        _trace(
            "AgentverseResponse",
            destination=destination,
            schema=schema,
            canonical_schema=canonical_schema,
            response=_truncate_text(response, 1000),
        )
        return response
    except Exception as exc:
        _trace("AgentverseError", destination=destination, schema=schema, error=str(exc))
        return f"AGENTVERSE-ERROR {type(exc).__name__}: {exc}"


def agentverse_call(destination: str, schema: str, payload: str) -> str:
    if _canonical_schema(schema) == "AgentChatProtocol":
        return _queue_agentverse_chat(destination, payload)
    return agentverse_ask(destination, schema, payload)


def agentverse_trace(limit: int = 20) -> str:
    atoms = []
    for record in _trace_records(int(limit)):
        kind = str(record.get("kind", "AgentverseTrace"))
        when = str(record.get("time", "unknown"))
        detail = _truncate_text(json.dumps(record, ensure_ascii=False, sort_keys=True), 500)
        atoms.append(f'(AgentverseTrace "{when}" {json.dumps(kind)} {json.dumps(detail, ensure_ascii=False)})')
    return "(" + " ".join(atoms) + ")" if atoms else "AGENTVERSE-TRACE empty"
