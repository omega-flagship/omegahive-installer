!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

; Isolated closed-loop smoke for Assume outcome evidence.
; This verifies closed-loop learning from explicit outcome/error atoms, pressure
; inspection, and growth review without committing into durable Assume memory.

!(bind! &assume (new-space))
!(bind! &assume_work (new-space))

!(add-atom &assume (AssumeDomain outcome-loop))
!(add-atom &assume (AssumeSituation outcome-loop scratch))
!(add-atom &assume (AssumeContextFeature outcome-loop scratch active-feature 1.0 0.9 smoke))
!(add-atom &assume (AssumeAction outcome-loop old-action testing))
!(add-atom &assume (AssumeAction outcome-loop new-action testing))
!(add-atom &assume (AssumeFeatureEdge outcome-loop active-feature old-action 0.25 0.5 1))

!(println! (ASSUME-OUTCOME-LOAD (assume-load outcome-loop scratch)))
!(println! (ASSUME-OUTCOME-BEFORE (assume-observe-predict outcome-loop scratch)))

!(println! (OUTCOME-ATOM (add-atom &assume
  (AssumeOutcome outcome-loop scratch new-action approved "wanted new action" 1))))

!(println! (ERROR-ATOM (add-atom &assume
  (AssumeError outcome-loop scratch old-action rejected "old action missed" 0.7))))

!(println! (ASSUME-OUTCOME-COUNT
   (match-count &assume
      (AssumeOutcome outcome-loop scratch new-action approved $note $strength))))

!(println! (ASSUME-ERROR-COUNT
   (match-count &assume
      (AssumeError outcome-loop scratch old-action rejected $note $strength))))

!(println! (ASSUME-OUTCOME-LEARN (assume-learn-from-atoms outcome-loop scratch)))
!(println! (ASSUME-OUTCOME-EVIDENCE (assume-observe-evidence-summary outcome-loop scratch)))
!(println! (ASSUME-OUTCOME-GROWTH-PRESSURE (assume-observe-growth-pressure outcome-loop scratch)))
!(println! (ASSUME-OUTCOME-GROWTH-PROPOSALS (assume-observe-growth-proposals outcome-loop scratch)))
!(println! (ASSUME-OUTCOME-GROWTH-REVIEW (assume-review-growth outcome-loop scratch active-feature new-action)))

!(println! (ASSUME-WORK-GROWTH-PRESSURE-COUNT
   (match-count &assume_work
      (AssumeGrowthPressure outcome-loop scratch active-feature new-action $strength $target $score $error missing-edge $pressure))))

!(println! (ASSUME-WORK-GROWTH-PROPOSAL-COUNT
   (match-count &assume_work
      (AssumeProposedFeatureEdge outcome-loop scratch active-feature new-action $weight $confidence $evidence $reason))))
