!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

; Assume AtomSpace/FabricPC writeback smoke test.
; This is the stronger research reviewer/architecture reviewer shape:
; - MeTTa owns a first-class &assume space
; - context is compositional feature atoms, not one opaque label
; - FabricPC receives only a numeric view
; - updated assumptions are written back into &assume
; - no live house action occurs

!(bind! &assume (new-space))

!(add-atom &assume (AssumeDomain house))
!(add-atom &assume (AssumeSituation house resident-movie-evening))
!(add-atom &assume (AssumeContextFeature house resident-movie-evening resident-watching-movie 0.95))
!(add-atom &assume (AssumeContextFeature house resident-movie-evening evening 0.80))
!(add-atom &assume (AssumeContextFeature house resident-movie-evening tv-active 0.90))
!(add-atom &assume (AssumeContextFeature house resident-movie-evening living-room-occupied 0.85))
!(add-atom &assume (AssumeAction house yellow-moody-scene lighting))
!(add-atom &assume (AssumeAction house bright-practical-scene lighting))
!(add-atom &assume (AssumeAction house ask-before-changing communication))
!(add-atom &assume (AssumeEdge house resident-movie-evening yellow-moody-scene 0.48))
!(add-atom &assume (AssumeEdge house resident-movie-evening bright-practical-scene 0.58))
!(add-atom &assume (AssumeEdge house resident-movie-evening ask-before-changing 0.52))
!(add-atom &assume (AssumeOutcome house resident-movie-evening yellow-moody-scene approved resident-approved-movie-lighting 0.24))
!(add-atom &assume (AssumeError house resident-movie-evening bright-practical-scene rejected too-bright-for-movie 0.22))

(= (assume-atoms)
   (repr (collapse (match &assume $atom $atom))))

(= (assume-fabric-result)
   (sread (py-call (assume.assume_step_from_atoms house resident-movie-evening (assume-atoms) fabricpc))))

(= (writeback-assume-updated-edges $result)
   (collapse (let (AssumeStepResult $_ $_ $_ $_ (UpdatedEdges $edge1 $edge2 $edge3) $_) $result
                   (let (AssumeUpdatedEdge house resident-movie-evening $action $strength) (superpose ($edge1 $edge2 $edge3))
                        (progn (collapse (match &assume (AssumeEdge house resident-movie-evening $action $old)
                                                     (remove-atom &assume (AssumeEdge house resident-movie-evening $action $old))))
                               (add-atom &assume (AssumeEdge house resident-movie-evening $action $strength))
                               (WroteBack house resident-movie-evening $action $strength))))))

!(println! (ASSUME-CONTEXT (collapse (match &assume (AssumeContextFeature house resident-movie-evening $feature $strength)
                                             (Feature $feature $strength)))))
!(println! (ASSUME-BEFORE (collapse (match &assume (AssumeEdge house resident-movie-evening $action $strength)
                                            (Edge $action $strength)))))
!(println! (ASSUME-FABRIC-RESULT (assume-fabric-result)))
!(println! (ASSUME-WRITEBACK (writeback-assume-updated-edges (assume-fabric-result))))
!(println! (ASSUME-AFTER (collapse (match &assume (AssumeEdge house resident-movie-evening $action $strength)
                                           (Edge $action $strength)))))
!(println! (ASSUME-TRACE (collapse (match &assume $atom
                                    (case $atom
                                      (((AssumeOutcome house resident-movie-evening $action $kind $evidence $amount)
                                        (Trace outcome $action $kind $evidence $amount))
                                       ((AssumeError house resident-movie-evening $action $kind $evidence $amount)
                                        (Trace error $action $kind $evidence $amount))))))))
