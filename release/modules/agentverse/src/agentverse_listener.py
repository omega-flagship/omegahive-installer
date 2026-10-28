"""Local uAgent listener for OmegaClaw's optional Agentverse module.

This process is a transport endpoint only. It receives AgentChatProtocol
messages, writes them to runtime trace files, and sends queued outbound chat
messages under the listener's stable uAgent identity.
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import time
from typing import Any

from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    TextContent,
    chat_protocol_spec,
)


CORE_ROOT = pathlib.Path(__file__).resolve().parents[3]
RUNTIME_DIR = CORE_ROOT / "memory" / "runtime" / "agentverse"
STATE_FILE = RUNTIME_DIR / "listener.json"
INBOX_FILE = RUNTIME_DIR / "inbox.jsonl"
COMMAND_FILE = RUNTIME_DIR / "commands.jsonl"


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _write_json(path: pathlib.Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def _append_record(kind: str, **payload: Any) -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    with INBOX_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"time": _now(), "kind": kind, **payload}, ensure_ascii=False, sort_keys=True) + "\n")


def _read_commands() -> list[dict[str, Any]]:
    if not COMMAND_FILE.exists():
        return []
    commands: list[dict[str, Any]] = []
    for line in COMMAND_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            commands.append(item)
    return commands


def _processed_command_ids() -> set[str]:
    if not INBOX_FILE.exists():
        return set()
    seen: set[str] = set()
    for line in INBOX_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        command_id = item.get("command_id")
        if item.get("kind") == "AgentverseOutbound" and command_id:
            seen.add(str(command_id))
    return seen


def _configured_agent() -> Agent:
    endpoint = os.environ.get("OMEGACLAW_AGENTVERSE_ENDPOINT", "").rstrip("/")
    mailbox = os.environ.get("OMEGACLAW_AGENTVERSE_MAILBOX", "").lower() in {"1", "true", "yes", "on"}
    port = int(os.environ.get("OMEGACLAW_AGENTVERSE_PORT", "8101"))
    seed = os.environ["OMEGACLAW_AGENTVERSE_SEED"]
    kwargs: dict[str, Any] = {
        "name": os.environ.get("OMEGACLAW_AGENTVERSE_AGENT_NAME", "omega-agentverse-listener"),
        "seed": seed,
        "port": port,
        "mailbox": mailbox,
        "log_level": os.environ.get("OMEGACLAW_AGENTVERSE_LOG_LEVEL", "INFO"),
        "enable_agent_inspector": True,
    }
    if endpoint:
        submit = endpoint if endpoint.endswith("/submit") else endpoint + "/submit"
        kwargs["endpoint"] = [submit]
    return Agent(**kwargs)


agent = _configured_agent()
protocol = Protocol(spec=chat_protocol_spec)


@agent.on_event("startup")
async def startup(_ctx: Context):
    endpoint = os.environ.get("OMEGACLAW_AGENTVERSE_ENDPOINT", "").rstrip("/")
    submit = endpoint if endpoint.endswith("/submit") else endpoint + "/submit" if endpoint else ""
    _write_json(
        STATE_FILE,
        {
            "address": agent.address,
            "endpoint": submit,
            "mailbox": os.environ.get("OMEGACLAW_AGENTVERSE_MAILBOX", ""),
            "pid": os.getpid(),
            "started_at": _now(),
            "status": "running",
        },
    )
    _append_record("AgentverseListenerStarted", address=agent.address, endpoint=submit, pid=os.getpid())


@protocol.on_interval(period=2.0)
async def send_queued(ctx: Context):
    processed = _processed_command_ids()
    for command in _read_commands():
        command_id = str(command.get("id", ""))
        if not command_id or command_id in processed:
            continue
        destination = str(command.get("destination", ""))
        payload = str(command.get("payload", ""))
        if not destination or not payload:
            continue
        message = ChatMessage(content=[TextContent(text=payload)])
        status = await ctx.send(destination, message)
        _append_record(
            "AgentverseOutbound",
            command_id=command_id,
            destination=destination,
            msg_id=str(message.msg_id),
            status=str(status),
        )
        processed.add(command_id)


@protocol.on_message(ChatAcknowledgement)
async def got_ack(_ctx: Context, sender: str, msg: ChatAcknowledgement):
    _append_record(
        "AgentverseAcknowledgement",
        sender=sender,
        acknowledged_msg_id=str(msg.acknowledged_msg_id),
        metadata=msg.metadata,
    )


@protocol.on_message(ChatMessage)
async def got_chat(ctx: Context, sender: str, msg: ChatMessage):
    _append_record("AgentverseInbound", sender=sender, msg_id=str(msg.msg_id), text=msg.text())
    await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=msg.msg_id))


agent.include(protocol)


if __name__ == "__main__":
    agent.run()
