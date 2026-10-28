!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

; Observe-* Assume commands must return reason-over-able error atoms when the
; graph lacks explicit outcome evidence. They should not throw command-format
; errors into the loop just because Fabric has nothing to summarize yet.

!(bind! &assume (new-space))
!(bind! &assume_work (new-space))

!(add-atom &assume (AssumeDomain no-evidence-loop))
!(add-atom &assume (AssumeSituation no-evidence-loop scratch))
!(add-atom &assume (AssumeContextFeature no-evidence-loop scratch active-feature 1.0 0.9 smoke))
!(add-atom &assume (AssumeAction no-evidence-loop old-action testing))
!(add-atom &assume (AssumeFeatureEdge no-evidence-loop active-feature old-action 0.25 0.5 1))

!(println! (ASSUME-NO-EVIDENCE-LOAD (assume-load no-evidence-loop scratch)))
!(println! (ASSUME-NO-EVIDENCE-SUMMARY (assume-observe-evidence-summary no-evidence-loop scratch)))
!(println! (ASSUME-NO-EVIDENCE-ADJUSTMENT (assume-observe-adjustment-pressure no-evidence-loop scratch)))
!(println! (ASSUME-MISSING-WRITEBACK (assume-observe-writeback missing-domain missing-situation)))

!(println! (ASSUME-NO-EVIDENCE-SUMMARY-ERROR-COUNT
   (match-count &assume_work
      (AssumeEvidenceSummaryError no-evidence-loop scratch $message))))

!(println! (ASSUME-NO-EVIDENCE-ADJUSTMENT-ERROR-COUNT
   (match-count &assume_work
      (AssumeAdjustmentPressureError no-evidence-loop scratch $message))))

!(println! (ASSUME-MISSING-WRITEBACK-ERROR-COUNT
   (match-count &assume_work
      (AssumeSaveError missing-domain missing-situation $message))))
