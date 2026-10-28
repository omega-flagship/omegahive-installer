!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

; Isolated smoke for the exact shape the agent hit:
; outcome evidence exists, then a situation is born, then growth review should
; become acceptable only after evidence, pressure, and proposals are atomized.

!(bind! &assume (new-space))
!(bind! &assume_work (new-space))

!(add-atom &assume (AssumeOutcome birth-review sleep-transition observe-full-house positive verified-full-house 0.9))
!(add-atom &assume (AssumeOutcome birth-review sleep-transition quiet-listening-mode positive quiet-night-success 0.9))
!(add-atom &assume (AssumeError birth-review sleep-transition ask-optional-question negative opened-thread 0.7))

!(add-atom &assume (AssumeSituation birth-review sleep-transition "evidence existed before graph"))
!(add-atom &assume (AssumeContextFeature birth-review sleep-transition house-asleep 0.95 0.85 event))
!(add-atom &assume (AssumeContextFeature birth-review sleep-transition resident-going-to-sleep 0.95 0.9 event))
!(add-atom &assume (AssumeContextFeature birth-review sleep-transition no-disturbance 0.9 0.85 belief))
!(add-atom &assume (AssumeContextFeature birth-review sleep-transition safety-watch-needed 0.75 0.8 care))

!(add-atom &assume (AssumeAction birth-review observe-full-house sensing))
!(add-atom &assume (AssumeAction birth-review quiet-listening-mode attention))
!(add-atom &assume (AssumeAction birth-review monitor-safety sensing))
!(add-atom &assume (AssumeAction birth-review ask-optional-question communication))

!(println! (BIRTH-STATUS (assume-situation-status birth-review sleep-transition)))
!(println! (BIRTH-LOAD (assume-reload-situation birth-review sleep-transition)))
!(println! (BIRTH-LEARN (assume-learn-from-atoms birth-review sleep-transition)))

!(println! (BIRTH-WORKSPACE
  (progn
    (assume-clear-work)
    (assume-observe-evidence-summary birth-review sleep-transition)
    (assume-observe-growth-pressure birth-review sleep-transition)
    (assume-observe-growth-proposals birth-review sleep-transition))))

!(println! (BIRTH-REVIEW-HOUSE-OBSERVE
  (assume-observe-growth-review "birth-review" "sleep-transition" "house-asleep" "observe-full-house")))

!(println! (BIRTH-REVIEW-HOUSE-QUIET
  (assume-observe-growth-review "birth-review" "sleep-transition" "house-asleep" "quiet-listening-mode")))

!(println! (BIRTH-REVIEW-ASK
  (assume-observe-growth-review "birth-review" "sleep-transition" "house-asleep" "ask-optional-question")))

!(println! (BIRTH-WORK-JUDGEMENT-COUNT
   (match-count &assume_work
      (AssumeGrowthJudgement symbolic-review birth-review sleep-transition house-asleep observe-full-house acceptable $expectation $target $confidence $conflict $pressure))))

!(println! (BIRTH-WORK-EVIDENCE-COUNT
   (match-count &assume_work
      (AssumeEvidenceSummary birth-review sleep-transition observe-full-house $positive $negative $target $confidence $conflict))))

!(println! (BIRTH-WORK-PRESSURE-COUNT
   (match-count &assume_work
      (AssumeGrowthPressure birth-review sleep-transition house-asleep observe-full-house $strength $target $score $error missing-edge $pressure))))

!(println! (BIRTH-WORK-PROPOSAL-COUNT
   (match-count &assume_work
      (AssumeProposedFeatureEdge birth-review sleep-transition house-asleep observe-full-house $weight $confidence $evidence $reason))))
