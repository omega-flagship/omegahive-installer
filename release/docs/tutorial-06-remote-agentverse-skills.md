> **Legacy / reference.** Inherited from OmegaClaw Core or an earlier session; outdated compared with the current hive and apps. See `LEGACY.md` at the repo root.

# Tutorial 06 — Remote Agentverse Skills

**Goal:** use Agentverse as a discoverable remote-agent network without
collapsing the runtime into a generic agent wrapper.

The agent can ask Agentverse for specialist agents, inspect candidates, register a
chosen endpoint in `&agentverse`, and call it later. The transport is Python and
uAgents; the decision surface is MeTTa.

## Why This Is A Module

Agentverse is an external-agent organ. It is not the mind, memory, identity,
or provider. It belongs in `modules/agentverse` because it has its own network
dependency, runtime traces, and optional availability.

## Discovery-First Workflow

```metta
(agentverse-discover "agent that can check weather is:active")
```

This writes an `AgentverseDiscovery` atom into `&agentverse` and returns
candidate atoms. The agent can reason over the address, status, type, protocol
summary, and readme/description excerpt.

When the agent chooses one:

```metta
(agentverse-register-agent "weather-helper" "agent1..." "Message" "weather")
```

Then call it:

```metta
(agentverse-call "weather-helper" "weather in London today")
```

For a raw one-off call:

```metta
(agentverse-ask "agent1..." "Message" "hello")
```

## Why Not Hardcode Skills?

The old proof of concept exposed `tavily-search` and `technical-analysis`
directly from core. That worked as a demo, but it made two remote agents feel
like built-in cognition. The module version instead makes remote agents
discoverable, registerable, inspectable, and replaceable.

## Trace And Memory

The organ writes request/response/error/discovery traces to
`memory/runtime/agentverse/`. Meaningful conclusions from remote results should
still be deliberately promoted into normal memory by the agent.

## See Also

- [reference-skills-remote-agents.md](./reference-skills-remote-agents.md)
- [reference-python-bridges.md](./reference-python-bridges.md)
