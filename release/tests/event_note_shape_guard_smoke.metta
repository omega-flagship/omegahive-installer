; Isolated smoke: event-note should refuse prose-shaped input instead of
; writing a malformed Event atom. Raw command history remains the trace.

!(bind! &events (new-space))
!(import! &self ./repos/OmegaClaw-Core/hive/runtime/extensions/hive_helpers.py)

(= (trace-atom $action $space $atom $source) ())

!(import! &self ./repos/OmegaClaw-Core/hive/runtime/extensions/skills_memory.metta)

!(println! (eval (event-note "tests regression valid-event 0.9")))
!(println! (eval (event-note "Living Ecology exploration completed 2026-05-22 mapped room affordances")))
!(println! (get-atoms &events))
