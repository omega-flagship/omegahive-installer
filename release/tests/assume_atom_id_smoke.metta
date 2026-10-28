!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

; Isolated smoke for the Assume boundary membrane. the agent's command parser
; passes text arguments as strings; symbolic review must convert them back into
; the exact canonical AtomSpace IDs, including natural names with spaces.

!(bind! &assume (new-space))
!(bind! &assume_work (new-space))

!(add-atom &assume (AssumeOutcome "syntax domain" "quiet mode" "warm white" positive correct 0.9))
!(add-atom &assume (AssumeSituation "syntax domain" "quiet mode" "natural identifier smoke"))
!(add-atom &assume (AssumeContextFeature "syntax domain" "quiet mode" "house asleep" 0.95 0.85 event))
!(add-atom &assume (AssumeAction "syntax domain" "warm white" lighting))

!(println! (eval (assume-situation-status "syntax domain" "quiet mode")))
!(println! (eval (assume-learn-from-atoms "syntax domain" "quiet mode")))

!(println! (eval (assume-clear-work)))
!(println! (eval (assume-observe-evidence-summary "syntax domain" "quiet mode")))
!(println! (eval (assume-observe-growth-pressure "syntax domain" "quiet mode")))
!(println! (eval (assume-observe-growth-proposals "syntax domain" "quiet mode")))

!(println! (eval (assume-observe-growth-review "syntax domain" "quiet mode" "house asleep" "warm white")))

!(println! (eval (match-count &assume_work
      (AssumeGrowthJudgement symbolic-review "syntax domain" "quiet mode" "house asleep" "warm white" acceptable $expectation $target $confidence $conflict $pressure))))
