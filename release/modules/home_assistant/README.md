# Home Assistant Module

This optional body app exposes Home Assistant as a house-state sense and physical-world action affordance.

The module is off by default because it requires a local Home Assistant URL, a long-lived access token, and a real house. When enabled, it contributes its own syntax signatures, help text, skill cards, and skill topics.

The loop receives compact symbolic action summaries. Full before/after service traces are opt-in with `OMEGACLAW_HA_TRACE=1`; when enabled they are written to `memory/runtime/home_assistant/actions.jsonl` for audit and learning without flooding the context window.

## Dependencies and Install

No Python package install is required. The bridge uses only the Python standard library and requires Python 3.10 or newer.

Runtime requirements:

- A reachable Home Assistant instance.
- A Home Assistant long-lived access token.
- `HOME_ASSISTANT_URL` set to the Home Assistant base URL.
- `HOME_ASSISTANT_TOKEN` set to the token.

Enable the module by importing `modules/home_assistant/entry.metta` from `modules/loader.metta`. Leave `OMEGACLAW_HA_TRACE` unset or `0` for compact returns only; set `OMEGACLAW_HA_TRACE=1` when full before/after action traces are explicitly desired.

Use pattern:

1. Sense with `observe-house`, `observe-room`, or `observe-device`.
2. Reason over the intended effect and risk.
3. Act with `use-house-affordance`.
4. Verify with another observation.
5. Record outcome with `record-house-outcome`.
