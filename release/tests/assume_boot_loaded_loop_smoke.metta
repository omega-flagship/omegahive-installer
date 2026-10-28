!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

; Smoke that the production boot wiring exposes canonical &assume plus a
; transient &assume_work, and that a real loaded graph can be observed through
; the same execution wrapper used by the agent's loop.

!(println! (ASSUME-BOOT-STATUS (assume-status)))
!(println! (ASSUME-BOOT-LOAD (assume-load social family-reachout)))

!(println!
  (let* (($raw "assume-observe-predict social family-reachout")
         ($response (py-call (helper.signature_balance_parentheses $raw)))
         ($sexpr (catch (sread $response))))
        (RESULTS: (command-results $sexpr)))

!(println! (ASSUME-BOOT-WORK-REPORT-COUNT
   (match-count &assume_work
      (AssumePredictionReport $prediction $support $confidence $evidence $pressure $truth $verdict $reason))))
