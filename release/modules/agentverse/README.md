# Agentverse Remote-Agent Organ

`omegaclaw.remote.agentverse` exposes Agentverse/uAgents as an optional remote
agent orchestration organ. It lets the agent maintain an inspectable registry of
remote agents and ask specialist agents through the uAgents message surface
while keeping cognition, identity, and memory inside the core runtime.

This optional module replaces the older proof-of-concept pattern where Agentverse was
imported directly into core skills. Agentverse is now declared like any other
module by importing `./modules/agentverse/entry.metta` from `modules/loader.metta`:

- MeTTa atoms describe the organ, capabilities, endpoints, dependencies, trace
  writes, and known remote-agent registry.
- Python is a transport membrane for uAgents calls.
- Missing `uagents` is reported through `agentverse-status` rather than failing
  runtime boot.
- Remote calls write local JSONL traces under `memory/runtime/agentverse/`.
- AgentChatProtocol calls can use a local uAgent listener so async replies have
  a real endpoint or mailbox to return to.
- Discovery uses Agentverse search/Almanac metadata instead of hardcoded remote
  skills. The agent can inspect candidates, register a selected agent, and then
  call it.

Useful skills:

- `agentverse-status`
- `agentverse-listener-status`
- `agentverse-listener-start`
- `agentverse-listener-stop`
- `agentverse-discover`
- `agentverse-remote-agents`
- `agentverse-register-agent`
- `agentverse-call`
- `agentverse-ask`
- `agentverse-trace`
- `agentverse-inbox`

Listener configuration:

- `OMEGACLAW_AGENTVERSE_ENDPOINT`: public base URL for the local uAgent endpoint.
  The module appends `/submit` unless the value already ends with `/submit`.
- `OMEGACLAW_AGENTVERSE_MAILBOX=1`: use an Agentverse mailbox instead of a public
  endpoint, after a mailbox has been created for the listener address.
- `OMEGACLAW_AGENTVERSE_PORT`: local listener port, default `8101`.
- `OMEGACLAW_AGENTVERSE_SEED` or `AGENTVERSE_SEED_PHRASE`: stable listener seed.
  If omitted, a private runtime seed is generated under `memory/runtime/agentverse/`.

Agentverse concepts used by this module by importing `./modules/agentverse/entry.metta` from `modules/loader.metta`:

- Mailbox: stores messages while an agent is offline or behind a firewall.
- Agent Chat Protocol: the external-agent protocol surface expected by
  Agentverse/ASI:One integration.
- Discovery: registered agents can be found through Agentverse/ASI:One.
