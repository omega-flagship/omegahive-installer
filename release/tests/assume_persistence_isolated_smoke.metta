!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core ./src/helper.py))
!(import! &self (library OmegaClaw-Core ./modules/assume/entry.metta))
!(import! &self (library OmegaClaw-Core ./src/skills_core.metta))
!(import! &self (library OmegaClaw-Core ./src/skills_runtime_spaces.metta))
!(import! &self (library OmegaClaw-Core ./src/skills_memory.metta))
!(bind! &assume (new-space))
!(bind! &assume_reload_test (new-space))

; Isolated persistence smoke.
; This deliberately tests symbolic space export/import only. It should fail if
; export! is not loaded, if no file is written, or if reload produces no edges.

!(add-atom &assume (AssumeDomain house))
!(add-atom &assume (AssumeSituation house ctx))
!(add-atom &assume (AssumeContextFeature house ctx movie-night 0.9 0.8 observation))
!(add-atom &assume (AssumeContextFeature house ctx resident-present 0.8 0.8 observation))
!(add-atom &assume (AssumeAction house yellow-moody-scene lighting))
!(add-atom &assume (AssumeFeatureEdge house movie-night yellow-moody-scene 0.70 0.80 4))
!(add-atom &assume (AssumeFeatureEdge house resident-present yellow-moody-scene 0.68 0.80 4))

!(println! ASSUME-PERSISTENCE-BEFORE)
!(println! (collapse (match &assume (AssumeFeatureEdge house $feature yellow-moody-scene $weight $confidence $evidence)
                    (ReloadedEdge $feature $weight $confidence $evidence))))

!(if (== (collapse (match &assume (AssumeFeatureEdge house $feature yellow-moody-scene $weight $confidence $evidence)
                          (ReloadedEdge $feature $weight $confidence $evidence))) ())
     (println! FAILED-ASSUME-PERSISTENCE-BEFORE-EMPTY)
     (println! ASSUME-PERSISTENCE-BEFORE-PASS))

!(println! ASSUME-PERSISTENCE-EXPORT)
!(println! (eval (export! &assume /tmp/omega-assume-persistence-export.metta)))
!(import! &assume_reload_test /tmp/omega-assume-persistence-export.metta)

!(println! ASSUME-PERSISTENCE-RELOADED)
!(println! (collapse (match &assume_reload_test (AssumeFeatureEdge house $feature yellow-moody-scene $weight $confidence $evidence)
                    (ReloadedEdge $feature $weight $confidence $evidence))))

!(if (== (collapse (match &assume_reload_test (AssumeFeatureEdge house $feature yellow-moody-scene $weight $confidence $evidence)
                          (ReloadedEdge $feature $weight $confidence $evidence))) ())
     (println! FAILED-ASSUME-PERSISTENCE-RELOAD-EMPTY)
     (println! ASSUME-PERSISTENCE-RELOAD-PASS))
