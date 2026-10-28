> **Legacy / reference.** Inherited from OmegaClaw Core or an earlier session; outdated compared with the current hive and apps. See `LEGACY.md` at the repo root.

# Reference — Remote Agent Skills

Remote agents are exposed through the optional `modules/agentverse` organ.
Agentverse is not part of cognition or identity; it is a network organ
for discovering and asking external agents.

## Core Flow

1. `agentverse-discover query` searches Agentverse/Almanac.
2. The agent inspects the returned `AgentverseDiscovery` and
   `RemoteAgentCandidate` atoms.
3. `agentverse-register-agent name address schema capability` records the chosen
   remote agent in `&agentverse`.
4. `agentverse-call name payload` sends a typed request to that registered
   agent.
5. `agentverse-trace` shows recent request, response, discovery, and error
   traces.

## Skills

```metta
(agentverse-discover "weather agent is:active")
(agentverse-register-agent "weather-london" "agent1..." "Message" "weather")
(agentverse-call "weather-london" "weather in London today")
(agentverse-ask "agent1..." "Message" "hello")
(agentverse-trace)
```

`agentverse-ask` is the raw escape hatch. Prefer discover/register/call when the
runtime is using Agentverse as an organ rather than a one-off transport.

Supported first-pass schemas are `Message`, `WebSearchRequest`, and
`TechAnalysisRequest`. More schemas should be added as module-local transport
types, not as core skills.

## Notes

- Missing `uagents` returns an `AGENTVERSE-ERROR` or status warning rather than
  breaking boot.
- Remote calls cross the VM/network boundary and leave JSONL traces under
  `memory/runtime/agentverse/`.
- Named domain skills such as Tavily search or technical analysis should be
  discovered and registered through Agentverse, not hardcoded into core.
