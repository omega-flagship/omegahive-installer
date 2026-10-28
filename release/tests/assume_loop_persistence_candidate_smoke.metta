!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library lib_spaces))
!(import! &self (library OmegaClaw-Core ./src/helper.py))
!(import! &self (library OmegaClaw-Core ./modules/assume/entry.metta))
!(import! &self (library OmegaClaw-Core ./src/skills_core.metta))
!(import! &self (library OmegaClaw-Core ./src/skills_runtime_spaces.metta))
!(import! &self (library OmegaClaw-Core ./src/skills_memory.metta))

; Isolated candidate smoke for the proposed loop behavior:
; - &assume remains a symbolic space.
; - assume-observe-predict creates confidence-bearing report atoms.
; - bound/export persists the graph.
; - a fresh space can import and reason over the exported graph.

!(bind! &assume (new-space))
!(bind! &assume_work (new-space))
!(bind! &assume_reload_test (new-space))
!(bind! &events (new-space))

!(add-atom &assume (AssumeDomain house))
!(add-atom &assume (AssumeSituation house ctx))
!(add-atom &assume (AssumeContextFeature house ctx movie-night 0.9 0.8 observation))
!(add-atom &assume (AssumeContextFeature house ctx resident-present 0.8 0.8 observation))
!(add-atom &assume (AssumeAction house yellow-moody-scene lighting))
!(add-atom &assume (AssumeFeatureEdge house movie-night yellow-moody-scene 0.70 0.80 4))
!(add-atom &assume (AssumeFeatureEdge house resident-present yellow-moody-scene 0.68 0.80 4))

!(println! ASSUME-LOOP-PERSISTENCE-PREDICT)
!(println! (eval (assume-observe-predict house ctx)))

!(println! ASSUME-LOOP-PERSISTENCE-PREDICT-ATOMS)
!(println! (collapse (match &assume_work
                    (AssumePredictionReport (AssumePrediction house ctx $action $score) $support $confidence $evidence $pressure $truth $verdict $reason)
                    (ObservedPrediction $action $score $confidence $verdict))))

!(if (== (collapse (match &assume_work
                          (AssumePredictionReport (AssumePrediction house ctx $action $score) $support $confidence $evidence $pressure $truth $verdict $reason)
                          (ObservedPrediction $action $score $confidence $verdict))) ())
     (println! FAILED-ASSUME-LOOP-PREDICT-EMPTY)
     (println! ASSUME-LOOP-PREDICT-PASS))

!(println! ASSUME-LOOP-PERSISTENCE-EXPORT)
!(println! (eval (bound-space! &assume 50000)))
!(println! (eval (export! &assume /tmp/omega-assume-persistence-export.metta)))

!(import! &assume_reload_test /tmp/omega-assume-persistence-export.metta)

!(println! ASSUME-LOOP-PERSISTENCE-RELOADED)
!(println! (collapse (match &assume_reload_test (AssumeFeatureEdge house $feature yellow-moody-scene $weight $confidence $evidence)
                    (ReloadedEdge $feature $weight $confidence $evidence))))

!(if (== (collapse (match &assume_reload_test (AssumeFeatureEdge house $feature yellow-moody-scene $weight $confidence $evidence)
                          (ReloadedEdge $feature $weight $confidence $evidence))) ())
     (println! FAILED-ASSUME-LOOP-RELOAD-EMPTY)
     (println! ASSUME-LOOP-RELOAD-PASS))
