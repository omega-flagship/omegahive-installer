; Isolated smoke: structured memory writers should fail closed on nonnumeric
; numeric slots. The raw command remains in history; no error atom is written
; into the target cognitive space.

!(bind! &persistent (new-space))
!(bind! &world (new-space))
!(bind! &beliefs (new-space))
!(bind! &events (new-space))
!(import! &self ./repos/OmegaClaw-Core/src/helper.py)

(= (trace-atom $action $space $atom $source) ())

!(import! &self ./repos/OmegaClaw-Core/src/skills_memory.metta)

!(println! (eval (persistent-note "syntax use-test-metta high")))
!(println! (eval (persistent-fact "the agent learned wait-skill high")))
!(println! (eval (world-fact "TestPerson primary-human the agent likely")))
!(println! (eval (belief-claim "omega attention-mode pin-is-working-memory often 0.9")))
!(println! (eval (assimilate-event "audio | obs123 | profile-data | TestPerson shared preference | sure")))
!(println! (eval (assimilate-world "audio | obs123 | TestPerson | preference | warm-light | likely")))
!(println! (eval (assimilate-persistent "audio | obs123 | family-health | exact health facts need immediate assimilation | sure")))

!(println! (get-atoms &persistent))
!(println! (get-atoms &world))
!(println! (get-atoms &beliefs))
!(println! (get-atoms &events))
