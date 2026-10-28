!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

; Compositional Assume feature-graph smoke test.
; Features, actions, predictive weights, outcomes, and errors are atoms.
; FabricPC receives a numeric feature->action matrix and writes updated
; AssumeFeatureEdge atoms back into the temporary &assume space.

!(bind! &assume (new-space))

!(add-atom &assume (AssumeDomain house))
!(add-atom &assume (AssumeSituation house resident-movie-evening))
!(add-atom &assume (AssumeContextFeature house resident-movie-evening resident-watching-movie 0.95 0.90 observation))
!(add-atom &assume (AssumeContextFeature house resident-movie-evening evening 0.80 0.80 clock))
!(add-atom &assume (AssumeContextFeature house resident-movie-evening tv-active 0.90 0.85 home-assistant))
!(add-atom &assume (AssumeContextFeature house resident-movie-evening living-room-occupied 0.85 0.80 observation))
!(add-atom &assume (AssumeAction house yellow-moody-scene lighting))
!(add-atom &assume (AssumeAction house bright-practical-scene lighting))
!(add-atom &assume (AssumeAction house ask-before-changing communication))
!(add-atom &assume (AssumeFeatureEdge house resident-watching-movie yellow-moody-scene 0.50 0.70 2))
!(add-atom &assume (AssumeFeatureEdge house resident-watching-movie bright-practical-scene 0.60 0.70 2))
!(add-atom &assume (AssumeFeatureEdge house resident-watching-movie ask-before-changing 0.48 0.60 1))
!(add-atom &assume (AssumeFeatureEdge house evening yellow-moody-scene 0.45 0.60 1))
!(add-atom &assume (AssumeFeatureEdge house evening bright-practical-scene 0.56 0.60 1))
!(add-atom &assume (AssumeFeatureEdge house evening ask-before-changing 0.52 0.60 1))
!(add-atom &assume (AssumeFeatureEdge house tv-active yellow-moody-scene 0.48 0.60 1))
!(add-atom &assume (AssumeFeatureEdge house tv-active bright-practical-scene 0.58 0.60 1))
!(add-atom &assume (AssumeFeatureEdge house tv-active ask-before-changing 0.50 0.60 1))
!(add-atom &assume (AssumeFeatureEdge house living-room-occupied yellow-moody-scene 0.46 0.60 1))
!(add-atom &assume (AssumeFeatureEdge house living-room-occupied bright-practical-scene 0.57 0.60 1))
!(add-atom &assume (AssumeFeatureEdge house living-room-occupied ask-before-changing 0.53 0.60 1))
!(add-atom &assume (AssumeOutcome house resident-movie-evening yellow-moody-scene approved resident-approved-movie-lighting 0.24))
!(add-atom &assume (AssumeError house resident-movie-evening bright-practical-scene rejected too-bright-for-movie 0.22))

(= (assume-atoms)
   (repr (collapse (match &assume $atom $atom))))

(= (assume-feature-fabric-result)
   (sread (py-call (assume.assume_feature_step house resident-movie-evening (assume-atoms) fabricpc))))

(= (writeback-assume-feature-edges $result)
   (collapse (let (AssumeFeatureStepResult $_ $_ $_ $_ (UpdatedFeatureEdges $edges) $_) $result
                   (let (AssumeUpdatedFeatureEdge house $feature $action $weight $confidence $evidence) (superpose $edges)
                        (progn (collapse (match &assume (AssumeFeatureEdge house $feature $action $oldw $oldc $olde)
                                                     (remove-atom &assume (AssumeFeatureEdge house $feature $action $oldw $oldc $olde))))
                               (add-atom &assume (AssumeFeatureEdge house $feature $action $weight $confidence $evidence))
                               (WroteBack house $feature $action $weight $confidence $evidence))))))

!(println! (ASSUME-FEATURE-CONTEXT (collapse (match &assume (AssumeContextFeature house resident-movie-evening $feature $strength $confidence $source)
                                                     (Feature $feature $strength $confidence $source)))))
!(println! (ASSUME-FEATURE-BEFORE (collapse (match &assume (AssumeFeatureEdge house $feature $action $weight $confidence $evidence)
                                                    (Edge $feature $action $weight $confidence $evidence)))))
!(println! (ASSUME-FEATURE-FABRIC (assume-feature-fabric-result)))
!(println! (ASSUME-FEATURE-WRITEBACK (writeback-assume-feature-edges (assume-feature-fabric-result))))
!(println! (ASSUME-FEATURE-AFTER (collapse (match &assume (AssumeFeatureEdge house $feature $action $weight $confidence $evidence)
                                                   (Edge $feature $action $weight $confidence $evidence)))))
