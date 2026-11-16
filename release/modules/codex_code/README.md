# Codex Code Organ

This module exposes Codex CLI as a specialist coding organ for the runtime.

Default profile: `qwen-coder-next`, configured in `~/.codex/config.toml` to use OpenRouter with `qwen/qwen3-coder-next`.

Principle: the agent remains the cognitive substrate. Codex CLI is a
repo-editing hand that returns traced results for the agent to inspect, reason
over, and remember.

Core defaults are conservative. A deployment may explicitly choose VM-boundary
containment when the agent is already running inside a VM body. In that case
`codex-code-atoms` exposes the live containment state, sandbox mode, bypass
state, model, profile, working directory, and trace path as symbolic facts.
`codex-code-containment-check` gives the agent a plain runtime verdict before
using the coding hand.
