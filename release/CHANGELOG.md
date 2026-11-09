# Changelog

## Unreleased - out-of-box core readiness

This branch collects the portable core-readiness layers prepared after live Omega testing. It avoids private deployment assumptions and keeps optional organs disabled until explicitly loaded.

### Added

- Typed command syntax membrane driven by `SkillSignature`, `SignatureSpace`, `SignatureLowering`, `SignatureShorthand`, and `SignatureRecoveryHint` declarations.
- Symbolic skill affordance directory with cards, topics, arguments, risks, effects, input-aware triggers, and compact context hints.
- Runtime spaces for persistent, agenda, beliefs, world, events, activity, assume, attention, skills, skill-triggers, scratch, and agentverse.
- Bounded context views for large skill payloads via `SkillContextView` and `SkillContextPolicy`; raw history remains exact.
- Core continuity skill `pin` with volatile working-state guidance.
- Portable energy loop self-regulation and restart/reboot continuity affordances.
- Canonical `web-search` surface, with legacy `search` retained as an alias.
- Symbolic memory cleanup affordances: `space-transform`, `space-merge-atoms`, `persistent-merge-atoms`, and reviewed persistent retirement.
- Optional default-off Agentverse module with discovery, registry, listener, async inbox, trace, and AgentChatProtocol call path.
- Repeatable parser and context-compaction benchmarks under `tests/`.

### Changed

- Core context now uses compact bootstrap skill hints; full help and cards remain inspectable through symbolic affordance skills.
- Parser errors now fail closed with recovery hints and relevant skill-card lines when available.
- PLN/NAL guidance now distinguishes NAL copulas from truth-valued PLN statements.
- Generated runtime memory files are ignored except curated prompt/history seed files.
- Remote-agent support moved behind the module boundary; old hardcoded Agentverse core bridge was removed.

### Validation

- Live Omega tested syntax repair, context compaction, runtime spaces, pin continuity, memory merge behavior, and Agentverse end-to-end remote call behavior before readiness branch publication.
- Clean readiness branch tests and benchmark commands are documented in the root `README.md` and `docs/review/benchmark_suite.py`.

### Not included

- Deployment-specific glue such as live webhost proxy configuration, live run-script endpoint values, WhatsApp channels, and Home Assistant body-app experiments.
