> **Legacy / reference.** Inherited from OmegaClaw Core or an earlier session; outdated compared with the current hive and apps. See `LEGACY.md` at the repo root.

# Agent Organ Map

The runtime should preserve a persistent symbolic self using devices, not become
a device app with an LLM inside it.

## Self

The self-model belongs in MeTTa-visible cognition and memory: goals, beliefs,
agenda, world model, events, promoted memories, demoted memories, uncertainty,
and continuity.

## Senses

Senses report observations from Telegram, WhatsApp, Home Assistant, images, webcam stills, audio, logs, files, and other channels. A sense should expose what happened; it should not decide what matters.

Example shapes:

```metta
(SenseEvent whatsapp $chat $sender $time $message_id unread)
(WorldState home $device brightness 45 $time)
```

## Voice

Voice surfaces send the agent's chosen expression through configured channels,
files, and web publishing. Voice adapters should preserve formatting and report
delivery outcomes.

## Hands

Hands execute actions such as house control, file sending, image/video generation, artifact publishing, and shell-confirm. A hand should expose affordances and outcomes, not intentions.

Example shapes:

```metta
(ActionAffordance house set-light-color $device)
(ActionOutcome whatsapp send-message $message_id success)
```

## Memory

Memory must distinguish exact trace, interpretation, belief, world state, agenda, promoted memory, temporary current events, and durable identity facts. Hallucinated or inferred summaries should never replace exact trace.

## Attention

Attention signals include unread messages, cost, energy state, memory pressure,
agenda pressure, and recent failures. Code may expose these signals, but the
agent should choose how to respond.

## Body

The body is runtime: run scripts, SWI-Prolog, bridge processes, tunnels, logs,
auth sessions, caches, and supervisors. The body keeps the process alive, but
it is not the mind.

The loop's runtime cycle is body state. The agent may inspect it through
`cycle-status` and may create a task-relative checkpoint with
`start-cycle-practice`, but it should store the meaning of a practice in
agenda/events/beliefs rather than writing ad hoc counter files.

## Habitat

Habitat includes people, rooms, devices, channels, relationships, and
public/admin surfaces. Stable habitat facts should become world/self memory
rather than hidden constants where possible.

## Immune System

The immune system warns, slows, confirms, and records risks: reboot checks, shell-confirm, self-message shielding, syntax repair, and non-spam posture. It should avoid silently hardcoding personality or agency.

## Boundary Rule

Devices may perceive, normalize, execute, and report. The symbolic self should
choose, interpret, prioritize, remember, and learn.
