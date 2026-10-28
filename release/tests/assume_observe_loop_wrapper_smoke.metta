!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

; Isolated smoke for the live-loop execution wrapper around Assume observation.
; The production loop uses helper.signature_balance_parentheses -> sread ->
; superpose -> eval. This verifies that observed prediction bundles atomize into
; &assume_work without touching the agent's durable &assume graph.

!(bind! &assume (new-space))
!(bind! &assume_work (new-space))

!(add-atom &assume (AssumeDomain observe-loop))
!(add-atom &assume (AssumeSituation observe-loop scratch))
!(add-atom &assume (AssumeContextFeature observe-loop scratch active-feature 1.0 0.9 smoke))
!(add-atom &assume (AssumeAction observe-loop test-action testing))
!(add-atom &assume (AssumeFeatureEdge observe-loop active-feature test-action 0.7 0.8 2))

!(println! (ASSUME-OBSERVE-LOOP-LOAD (assume-load observe-loop scratch)))

!(println!
  (let* (($raw "assume-observe-predict observe-loop scratch")
         ($response (py-call (helper.signature_balance_parentheses $raw)))
         ($sexpr (catch (sread $response))))
        (RESULTS: (command-results $sexpr))))

!(println! (ASSUME-WORK-REPORT-COUNT
   (match-count &assume_work
      (AssumePredictionReport $prediction $support $confidence $evidence $pressure $truth $verdict $reason))))

!(println! (ASSUME-WORK-PREDICTION-COUNT
   (match-count &assume_work
      (AssumePrediction observe-loop scratch test-action $score))))
