(= (assume-atoms)
   (repr (collapse (match &assume $atom $atom))))

(= (assume-review)
   (assume-atoms))

(= (assume-work)
   (repr (collapse (match &assume_work $atom $atom))))

(= (assume-clear-work)
   (collapse (match &assume_work $atom (remove-atom &assume_work $atom))))

(= (assume-atomize-list $space $items)
   (if (== $items ())
       atomize-done
       (let* (($first (car-atom $items))
              ($rest (cdr-atom $items)))
             (progn
               (remove-atom $space $first)
               (add-atom $space $first)
               (assume-atomize-list $space $rest)))))

(= (assume-atomize-bundle $space $text)
   (let $items (sread $text)
        (assume-atomize-list $space $items)))

(= (assume-observe-bundle $bundle)
   (assume-atomize-bundle &assume_work $bundle))

(= (assume-clear-work-predict $domain $situation)
   (collapse (match &assume_work
                    (AssumePredictionReport (AssumePrediction $domain $situation $action $score) $support $confidence $evidence $pressure $truth $verdict $reason)
                    (remove-atom &assume_work (AssumePredictionReport (AssumePrediction $domain $situation $action $score) $support $confidence $evidence $pressure $truth $verdict $reason)))))

(= (assume-clear-work-audit $domain $situation)
   (collapse (match &assume_work
                    (AssumeGuardReport $domain $situation $action $score $coverage $confidence $evidence $support $pressure $truth $verdict $reason)
                    (remove-atom &assume_work (AssumeGuardReport $domain $situation $action $score $coverage $confidence $evidence $support $pressure $truth $verdict $reason)))))

(= (assume-clear-work-evidence $domain $situation)
   (progn
     (collapse (match &assume_work
                      (AssumeEvidenceSummary $domain $situation $action $positive $negative $target $confidence $conflict)
                      (remove-atom &assume_work (AssumeEvidenceSummary $domain $situation $action $positive $negative $target $confidence $conflict))))
     (collapse (match &assume_work
                      (AssumeEvidenceConflict $domain $situation $action $conflict)
                      (remove-atom &assume_work (AssumeEvidenceConflict $domain $situation $action $conflict))))
     (collapse (match &assume_work
                      (AssumeEvidenceSummaryError $domain $situation $message)
                      (remove-atom &assume_work (AssumeEvidenceSummaryError $domain $situation $message))))))

(= (assume-clear-work-growth-pressure $domain $situation)
   (progn
     (collapse (match &assume_work
                      (AssumePredictionError $domain $situation $action $target $score $error)
                      (remove-atom &assume_work (AssumePredictionError $domain $situation $action $target $score $error))))
     (collapse (match &assume_work
                      (AssumeSignedPredictionError $domain $situation $action $target $score $signed_error $abs_error)
                      (remove-atom &assume_work (AssumeSignedPredictionError $domain $situation $action $target $score $signed_error $abs_error))))
     (collapse (match &assume_work
                      (AssumeGrowthPressure $domain $situation $feature $action $strength $target $score $error $kind $pressure)
                      (remove-atom &assume_work (AssumeGrowthPressure $domain $situation $feature $action $strength $target $score $error $kind $pressure))))
     (collapse (match &assume_work
                      (AssumeGrowthPressureError $domain $situation $message)
                      (remove-atom &assume_work (AssumeGrowthPressureError $domain $situation $message))))))

(= (assume-clear-work-adjustment $domain $situation)
   (progn
     (collapse (match &assume_work
                      (AssumeWeightDelta $domain $situation $feature $action $old $new $delta $direction)
                      (remove-atom &assume_work (AssumeWeightDelta $domain $situation $feature $action $old $new $delta $direction))))
     (collapse (match &assume_work
                      (AssumeUpdatedFeatureEdge $domain $feature $action $weight $confidence $evidence)
                      (remove-atom &assume_work (AssumeUpdatedFeatureEdge $domain $feature $action $weight $confidence $evidence))))
     (collapse (match &assume_work
                      (AssumeWeightMutation $domain $situation $feature $action $old $new $delta $old_confidence $new_confidence $old_evidence $new_evidence $direction $target $cause $topology)
                      (remove-atom &assume_work (AssumeWeightMutation $domain $situation $feature $action $old $new $delta $old_confidence $new_confidence $old_evidence $new_evidence $direction $target $cause $topology))))
     (collapse (match &assume_work
                      (AssumeMutationTarget $domain $situation $feature $action $target $cause)
                      (remove-atom &assume_work (AssumeMutationTarget $domain $situation $feature $action $target $cause))))
     (collapse (match &assume_work
                      (AssumeMutationSignedError $domain $situation $feature $action $target $score $signed_error)
                      (remove-atom &assume_work (AssumeMutationSignedError $domain $situation $feature $action $target $score $signed_error))))
     (collapse (match &assume_work
                      (AssumeMutationEvidence $domain $situation $feature $action $old_confidence $new_confidence $old_evidence $new_evidence)
                      (remove-atom &assume_work (AssumeMutationEvidence $domain $situation $feature $action $old_confidence $new_confidence $old_evidence $new_evidence))))
     (collapse (match &assume_work
                      (AssumeMutationPressurePrimitive $domain $situation $feature $action $pressure)
                      (remove-atom &assume_work (AssumeMutationPressurePrimitive $domain $situation $feature $action $pressure))))
     (collapse (match &assume_work
                      (AssumeMutationConflictPrimitive $domain $situation $feature $action $conflict)
                      (remove-atom &assume_work (AssumeMutationConflictPrimitive $domain $situation $feature $action $conflict))))
     (collapse (match &assume_work
                      (AssumeMutationTopology $domain $situation $feature $action $topology)
                      (remove-atom &assume_work (AssumeMutationTopology $domain $situation $feature $action $topology))))
     (collapse (match &assume_work
                      (AssumeMutationTruth $domain $situation $feature $action $truth)
                      (remove-atom &assume_work (AssumeMutationTruth $domain $situation $feature $action $truth))))
     (collapse (match &assume_work
                      (AssumeMutationPressure $domain $situation $feature $action $pressure $signed_error)
                      (remove-atom &assume_work (AssumeMutationPressure $domain $situation $feature $action $pressure $signed_error))))
     (collapse (match &assume_work
                      (AssumeMutationConflict $domain $situation $action $conflict)
                      (remove-atom &assume_work (AssumeMutationConflict $domain $situation $action $conflict))))
     (collapse (match &assume_work
                      (AssumeMutationVerdict $domain $situation $feature $action $verdict)
                      (remove-atom &assume_work (AssumeMutationVerdict $domain $situation $feature $action $verdict))))
     (collapse (match &assume_work
                      (AssumeMutationReason $domain $situation $feature $action $reason)
                      (remove-atom &assume_work (AssumeMutationReason $domain $situation $feature $action $reason))))
     (collapse (match &assume_work
                      (AssumeFabricMutationTruth $domain $situation $feature $action $truth)
                      (remove-atom &assume_work (AssumeFabricMutationTruth $domain $situation $feature $action $truth))))
     (collapse (match &assume_work
                      (AssumeFabricMutationVerdict $domain $situation $feature $action $verdict)
                      (remove-atom &assume_work (AssumeFabricMutationVerdict $domain $situation $feature $action $verdict))))
     (collapse (match &assume_work
                      (AssumeFabricMutationReason $domain $situation $feature $action $reason)
                      (remove-atom &assume_work (AssumeFabricMutationReason $domain $situation $feature $action $reason))))
     (collapse (match &assume_work
                      (AssumeSymbolicMutationVerdict $domain $situation $feature $action $verdict)
                      (remove-atom &assume_work (AssumeSymbolicMutationVerdict $domain $situation $feature $action $verdict))))
     (collapse (match &assume_work
                      (AssumeSymbolicMutationTruth $domain $situation $feature $action $truth)
                      (remove-atom &assume_work (AssumeSymbolicMutationTruth $domain $situation $feature $action $truth))))
     (collapse (match &assume_work
                      (AssumeSymbolicMutationReason $domain $situation $feature $action $reason)
                      (remove-atom &assume_work (AssumeSymbolicMutationReason $domain $situation $feature $action $reason))))
     (collapse (match &assume_work
                      (AssumeMutationVerdictComparison $source $domain $situation $feature $action $fabric_verdict $symbolic_verdict $agreement)
                      (remove-atom &assume_work (AssumeMutationVerdictComparison $source $domain $situation $feature $action $fabric_verdict $symbolic_verdict $agreement))))
     (collapse (match &assume_work
                      (AssumeAdjustmentPressure $domain $situation $feature $action $target $score $signed_error $pressure $direction $conflict)
                      (remove-atom &assume_work (AssumeAdjustmentPressure $domain $situation $feature $action $target $score $signed_error $pressure $direction $conflict))))
     (collapse (match &assume_work
                      (AssumeAdjustmentProposal $domain $situation $feature $action $weight $confidence $evidence $direction)
                      (remove-atom &assume_work (AssumeAdjustmentProposal $domain $situation $feature $action $weight $confidence $evidence $direction))))
     (collapse (match &assume_work
                      (AssumeAdjustmentPressureError $domain $situation $message)
                      (remove-atom &assume_work (AssumeAdjustmentPressureError $domain $situation $message))))))

(= (assume-clear-work-growth-proposals $domain $situation)
   (progn
     (collapse (match &assume_work
                      (AssumeProposedFeatureEdge $domain $situation $feature $action $weight $confidence $evidence $reason)
                      (remove-atom &assume_work (AssumeProposedFeatureEdge $domain $situation $feature $action $weight $confidence $evidence $reason))))
     (collapse (match &assume_work
                      (AssumeGrowthProposalsError $domain $situation $message)
                      (remove-atom &assume_work (AssumeGrowthProposalsError $domain $situation $message))))))

(= (assume-status)
   (py-call (assume_client.status (assume-atoms))))

(= (assume-state $domain $situation)
   (py-call (assume_client.state $domain $situation (assume-atoms))))

(= (assume-load $domain $situation)
   (py-call (assume_client.load $domain $situation (assume-atoms))))

(= (assume-reload $domain $situation)
   (py-call (assume_client.reload $domain $situation (assume-atoms))))

(= (assume-demo-list)
   (py-call (assume_client.demo_index)))

(= (assume-demo-load $demo $domain $situation)
   (py-call (assume_client.demo_load $demo $domain $situation)))

(= (assume-demo-predict $demo $domain $situation)
   (py-call (assume_client.demo_predict $demo $domain $situation)))

(= (assume-demo-audit $demo $domain $situation $action)
   (py-call (assume_client.demo_audit $demo $domain $situation $action)))

(= (assume-demo-learn $demo $domain $situation $targets)
   (py-call (assume_client.demo_learn $demo $domain $situation $targets)))

(= (assume-demo-writeback $demo $domain $situation)
   (py-call (assume_client.demo_writeback $demo $domain $situation)))

(= (assume-import-demo $demo)
   (let* (($bundle (py-call (assume_client.demo_atoms $demo)))
          ($persisted (catch (sread (py-call (assume_client.persist_demo_result $demo))))))
         (if (== (car-atom $persisted) AssumeDemoPersisted)
             (progn (assume-atomize-bundle &assume $bundle)
                    $persisted)
             $persisted)))

(= (assume-situation-status $domain $situation)
   (py-call (assume_client.situation_status $domain $situation (assume-atoms))))

(= (assume-init-situation $domain $situation $reason)
   (let* (($text (py-call (assume_client.assume_situation_atom $domain $situation $reason)))
          ($atom (sread $text)))
         (let $persisted (catch (sread (py-call (assume_client.persist_structural_atom_result $text "AssumeSituation"))))
              (if (== (car-atom $persisted) AssumeStructuralPersisted)
                  (progn (add-atom &assume $atom)
                         (trace-atom "write" "assume" $atom "assume-situation")
                         $persisted)
                  $persisted))))

(= (assume-add-context-feature $domain $situation $feature $strength $confidence $source)
   (let* (($text (py-call (assume_client.assume_context_feature_atom $domain $situation $feature $strength $confidence $source)))
          ($atom (sread $text)))
         (let $persisted (catch (sread (py-call (assume_client.persist_structural_atom_result $text "AssumeContextFeature"))))
              (if (== (car-atom $persisted) AssumeStructuralPersisted)
                  (progn (add-atom &assume $atom)
                         (trace-atom "write" "assume" $atom "assume-context-feature")
                         $persisted)
                  $persisted))))

(= (assume-add-action $domain $action $kind)
   (let* (($text (py-call (assume_client.assume_action_atom $domain $action $kind)))
          ($atom (sread $text)))
         (let $persisted (catch (sread (py-call (assume_client.persist_structural_atom_result $text "AssumeAction"))))
              (if (== (car-atom $persisted) AssumeStructuralPersisted)
                  (progn (add-atom &assume $atom)
                         (trace-atom "write" "assume" $atom "assume-action")
                         $persisted)
                  $persisted))))

(= (assume-add-feature-edge $domain $feature $action $weight $confidence $evidence)
   (let* (($text (py-call (assume_client.assume_feature_edge_atom $domain $feature $action $weight $confidence $evidence)))
          ($atom (sread $text)))
         (let $persisted (catch (sread (py-call (assume_client.persist_structural_atom_result $text "AssumeFeatureEdge"))))
              (if (== (car-atom $persisted) AssumeStructuralPersisted)
                  (progn (add-atom &assume $atom)
                         (trace-atom "write" "assume" $atom "assume-feature-edge")
                         $persisted)
                  $persisted))))

(= (assume-reload-situation $domain $situation)
   (assume-reload $domain $situation))

(= (assume-predict $domain $situation)
   (py-call (assume_client.predict $domain $situation (assume-atoms))))

(= (assume-observe-predict $domain $situation)
   (let $bundle (py-call (assume_client.predict $domain $situation (assume-atoms)))
        (progn (assume-clear-work-predict $domain $situation)
               (assume-atomize-bundle &assume_work $bundle)
               $bundle)))

(= (assume-audit $domain $situation $action)
   (py-call (assume_client.audit $domain $situation $action (assume-atoms))))

(= (assume-observe-audit $domain $situation $action)
   (let $bundle (py-call (assume_client.audit $domain $situation $action (assume-atoms)))
        (progn (assume-clear-work-audit $domain $situation)
               (assume-atomize-bundle &assume_work $bundle)
               $bundle)))

(= (assume-outcome $domain $situation $action $polarity $strength $note)
   (let* (($text (py-call (assume_client.assume_outcome_atom $domain $situation $action $polarity $strength $note)))
          ($atom (sread $text)))
         (let $persisted (catch (sread (py-call (assume_client.persist_evidence_atom_result $text))))
              (if (== (car-atom $persisted) AssumeEvidencePersisted)
                  (progn (add-atom &assume $atom)
                         (trace-atom "write" "assume" $atom "assume-outcome")
                         $persisted)
                  $persisted))))

(= (assume-error $domain $situation $action $polarity $strength $note)
   (let* (($text (py-call (assume_client.assume_error_atom $domain $situation $action $polarity $strength $note)))
          ($atom (sread $text)))
         (let $persisted (catch (sread (py-call (assume_client.persist_evidence_atom_result $text))))
              (if (== (car-atom $persisted) AssumeEvidencePersisted)
                  (progn (add-atom &assume $atom)
                         (trace-atom "write" "assume" $atom "assume-error")
                         $persisted)
                  $persisted))))

(= (assume-learn $domain $situation $targets)
   (py-call (assume_client.learn $domain $situation (assume-atoms) $targets)))

(= (assume-learn-from-atoms $domain $situation)
   (py-call (assume_client.learn_from_atoms $domain $situation (assume-atoms))))

(= (assume-evidence-summary $domain $situation)
   (py-call (assume_client.evidence_summary $domain $situation (assume-atoms))))

(= (assume-observe-evidence-summary $domain $situation)
   (let $bundle (py-call (assume_client.evidence_summary $domain $situation (assume-atoms)))
        (progn (assume-clear-work-evidence $domain $situation)
               (assume-atomize-bundle &assume_work $bundle)
               $bundle)))

(= (assume-growth-pressure $domain $situation)
   (py-call (assume_client.growth_pressure $domain $situation (assume-atoms))))

(= (assume-observe-growth-pressure $domain $situation)
   (let $bundle (py-call (assume_client.growth_pressure $domain $situation (assume-atoms)))
        (progn (assume-clear-work-growth-pressure $domain $situation)
               (assume-atomize-bundle &assume_work $bundle)
               $bundle)))

(= (assume-adjustment-pressure $domain $situation)
   (py-call (assume_client.adjustment_pressure $domain $situation (assume-atoms))))

(= (assume-observe-adjustment-pressure $domain $situation)
   (let $bundle (py-call (assume_client.adjustment_pressure $domain $situation (assume-atoms)))
        (progn (assume-clear-work-adjustment $domain $situation)
               (assume-atomize-bundle &assume_work $bundle)
               $bundle)))

(= (assume-growth-proposals $domain $situation)
   (py-call (assume_client.growth_proposals $domain $situation (assume-atoms))))

(= (assume-observe-growth-proposals $domain $situation)
   (let $bundle (py-call (assume_client.growth_proposals $domain $situation (assume-atoms)))
        (progn (assume-clear-work-growth-proposals $domain $situation)
               (assume-atomize-bundle &assume_work $bundle)
               $bundle)))

(= (assume-growth-decision $expectation $conflict $pressure)
   (if (>= $conflict 0.6)
       wait-conflict
       (if (and (>= $expectation 0.65) (>= $pressure 0.5))
           acceptable
           wait-evidence)))

(= (assume-atom-id $value)
   (sread (py-call (assume_client.atom_text $value))))

(= (assume-symbolic-growth-review
    (AssumeEvidenceSummary $domain $situation $action $positive $negative $target $confidence $conflict)
    (AssumeGrowthPressure $domain $situation $feature $action $strength $target $score $error missing-edge $pressure))
   (let $expectation (Truth_Expectation (stv $target $confidence))
        (let $temp (cut)
             (AssumeGrowthJudgement symbolic-review $domain $situation $feature $action
                                    (assume-growth-decision $expectation $conflict $pressure)
                                    $expectation $target $confidence $conflict $pressure))))

(= (assume-review-growth $domain $situation $feature $action)
   (assume-review-growth-native
     (assume-atom-id $domain)
     (assume-atom-id $situation)
     (assume-atom-id $feature)
     (assume-atom-id $action)))

(= (assume-review-growth-native $domain $situation $feature $action)
   (let* (($summaries (collapse (match &assume_work
                         (AssumeEvidenceSummary $domain $situation $action $positive $negative $target $confidence $conflict)
                         (AssumeEvidenceSummary $domain $situation $action $positive $negative $target $confidence $conflict))))
          ($pressures (collapse (match &assume_work
                         (AssumeGrowthPressure $domain $situation $feature $action $strength $target $score $error missing-edge $p)
                         (AssumeGrowthPressure $domain $situation $feature $action $strength $target $score $error missing-edge $p)))))
         (if (or (== $summaries ()) (== $pressures ()))
             (AssumeGrowthJudgement symbolic-review $domain $situation $feature $action wait-evidence 0 0 0 0 0)
             (assume-symbolic-growth-review (car-atom $summaries) (car-atom $pressures)))))

(= (assume-observe-growth-review $domain $situation $feature $action)
   (assume-observe-growth-review-native
     (assume-atom-id $domain)
     (assume-atom-id $situation)
     (assume-atom-id $feature)
     (assume-atom-id $action)))

(= (assume-observe-growth-review-native $domain $situation $feature $action)
   (let $judgement (assume-review-growth-native $domain $situation $feature $action)
        (progn
          (collapse (match &assume_work
                     (AssumeGrowthJudgement symbolic-review $domain $situation $feature $action $decision $expectation $target $confidence $conflict $pressure)
                     (remove-atom &assume_work
                       (AssumeGrowthJudgement symbolic-review $domain $situation $feature $action $decision $expectation $target $confidence $conflict $pressure))))
          (add-atom &assume_work $judgement)
          $judgement)))

(= (assume-adjustment-direction-ok $signed_error $delta)
   (if (and (> $signed_error 0) (> $delta 0))
       direction-ok
       (if (and (< $signed_error 0) (< $delta 0))
           direction-ok
           (if (== $delta 0)
               hold
               bad-direction))))

(= (assume-adjustment-direction-frequency $signed_error $delta)
   (if (== (assume-adjustment-direction-ok $signed_error $delta) direction-ok)
       1
       (if (== (assume-adjustment-direction-ok $signed_error $delta) hold)
           0.5
           0)))

(= (assume-symbolic-mutation-truth $signed_error $delta $pressure $conflict)
   (if (>= $conflict 0.6)
       (stv (assume-adjustment-direction-frequency $signed_error $delta) 0)
       (stv (assume-adjustment-direction-frequency $signed_error $delta) $pressure)))

(= (assume-adjustment-decision $pressure $conflict $delta $signed_error)
   (if (>= $conflict 0.6)
       wait-conflict
       (if (== (assume-adjustment-direction-ok $signed_error $delta) bad-direction)
           reject-direction
           (if (and (>= $pressure 0.3) (!= $delta 0))
               acceptable
               wait-evidence))))

(= (assume-adjustment-review-reason $pressure $conflict $delta $signed_error)
   (if (>= $conflict 0.6)
       conflict-too-high
       (if (== (assume-adjustment-direction-ok $signed_error $delta) bad-direction)
           direction-contradicts-error
           (if (== $delta 0)
               no-delta
               (if (>= $pressure 0.3)
                   pressure-meets-threshold
                   pressure-below-threshold)))))

(= (assume-symbolic-adjustment-review
    (AssumeWeightDelta $domain $situation $feature $action $old $new $delta $direction)
   (AssumeAdjustmentPressure $domain $situation $feature $action $target $score $signed_error $pressure $direction $conflict))
   (let $temp (cut)
        (AssumeAdjustmentJudgement symbolic-review $domain $situation $feature $action
                                   (assume-adjustment-decision $pressure $conflict $delta $signed_error)
                                   $old $new $delta $target $score $signed_error $pressure $direction $conflict)))

(= (assume-review-adjustment $domain $situation $feature $action)
   (assume-review-adjustment-native
     (assume-atom-id $domain)
     (assume-atom-id $situation)
     (assume-atom-id $feature)
     (assume-atom-id $action)))

(= (assume-review-adjustment-native $domain $situation $feature $action)
   (let* (($deltas (collapse (match &assume_work
                       (AssumeWeightDelta $domain $situation $feature $action $old $new $delta $direction)
                       (AssumeWeightDelta $domain $situation $feature $action $old $new $delta $direction))))
          ($pressures (collapse (match &assume_work
                         (AssumeAdjustmentPressure $domain $situation $feature $action $target $score $signed_error $pressure $direction $conflict)
                         (AssumeAdjustmentPressure $domain $situation $feature $action $target $score $signed_error $pressure $direction $conflict)))))
         (if (or (== $deltas ()) (== $pressures ()))
             (AssumeAdjustmentJudgement symbolic-review $domain $situation $feature $action wait-evidence 0 0 0 0 0 0 0 hold 0)
             (assume-symbolic-adjustment-review (car-atom $deltas) (car-atom $pressures)))))

(= (assume-symbolic-adjustment-review-detail
    (AssumeWeightDelta $domain $situation $feature $action $old $new $delta $direction)
   (AssumeAdjustmentPressure $domain $situation $feature $action $target $score $signed_error $pressure $direction $conflict))
   (let* (($decision (assume-adjustment-decision $pressure $conflict $delta $signed_error))
          ($reason (assume-adjustment-review-reason $pressure $conflict $delta $signed_error)))
         (let $temp (cut)
              ((AssumeAdjustmentJudgement symbolic-review $domain $situation $feature $action
                                          $decision $old $new $delta $target $score $signed_error $pressure $direction $conflict)
               (AssumeAdjustmentReviewReason symbolic-review $domain $situation $feature $action
                                             $decision $reason $pressure $conflict $delta)
               (AssumeAdjustmentReviewThreshold symbolic-review $domain $situation $feature $action
                                                pressure $pressure 0.3)
               (AssumeAdjustmentReviewThreshold symbolic-review $domain $situation $feature $action
                                                conflict $conflict 0.6)))))

(= (assume-fabric-verdict-decision acceptable-adjustment) acceptable)
(= (assume-fabric-verdict-decision weak-adjustment) wait-evidence)
(= (assume-fabric-verdict-decision conflicted-adjustment) wait-conflict)
(= (assume-fabric-verdict-decision bad-adjustment) reject-direction)

(= (assume-fabric-symbolic-agreement $fabric_verdict $symbolic_decision)
   (if (== (assume-fabric-verdict-decision $fabric_verdict) $symbolic_decision)
       agree
       mismatch))

(= (assume-symbolic-mutation-comparison
    (AssumeFabricMutationVerdict $domain $situation $feature $action $fabric_verdict)
   (AssumeAdjustmentJudgement symbolic-review $domain $situation $feature $action
                              $decision $old $new $delta $target $score $signed_error $pressure $direction $conflict))
   ((AssumeSymbolicMutationTruth $domain $situation $feature $action
                              (assume-symbolic-mutation-truth $signed_error $delta $pressure $conflict))
    (AssumeSymbolicMutationVerdict $domain $situation $feature $action $decision)
    (AssumeSymbolicMutationReason $domain $situation $feature $action
                               (assume-adjustment-review-reason $pressure $conflict $delta $signed_error))
    (AssumeMutationVerdictComparison fabric-vs-symbolic $domain $situation $feature $action
                                     $fabric_verdict $decision
                                     (assume-fabric-symbolic-agreement $fabric_verdict $decision))))

(= (assume-review-mutation $domain $situation $feature $action)
   (assume-review-mutation-native
     (assume-atom-id $domain)
     (assume-atom-id $situation)
     (assume-atom-id $feature)
     (assume-atom-id $action)))

(= (assume-review-mutation-native $domain $situation $feature $action)
   (let* (($fabric_verdicts (collapse (match &assume_work
                         (AssumeFabricMutationVerdict $domain $situation $feature $action $fabric_verdict)
                         (AssumeFabricMutationVerdict $domain $situation $feature $action $fabric_verdict))))
          ($native_review (assume-review-adjustment-native $domain $situation $feature $action)))
         (if (== $fabric_verdicts ())
             ((AssumeSymbolicMutationVerdict $domain $situation $feature $action missing-fabric-verdict)
              (AssumeMutationVerdictComparison fabric-vs-symbolic $domain $situation $feature $action
                                               missing-fabric-verdict missing-symbolic-review mismatch))
             (assume-symbolic-mutation-comparison (car-atom $fabric_verdicts) $native_review))))

(= (assume-review-adjustment-detail $domain $situation $feature $action)
   (assume-review-adjustment-detail-native
     (assume-atom-id $domain)
     (assume-atom-id $situation)
     (assume-atom-id $feature)
     (assume-atom-id $action)))

(= (assume-review-adjustment-detail-native $domain $situation $feature $action)
   (let* (($deltas (collapse (match &assume_work
                       (AssumeWeightDelta $domain $situation $feature $action $old $new $delta $direction)
                       (AssumeWeightDelta $domain $situation $feature $action $old $new $delta $direction))))
          ($pressures (collapse (match &assume_work
                         (AssumeAdjustmentPressure $domain $situation $feature $action $target $score $signed_error $pressure $direction $conflict)
                         (AssumeAdjustmentPressure $domain $situation $feature $action $target $score $signed_error $pressure $direction $conflict)))))
         (if (or (== $deltas ()) (== $pressures ()))
             ((AssumeAdjustmentJudgement symbolic-review $domain $situation $feature $action wait-evidence 0 0 0 0 0 0 0 hold 0)
              (AssumeAdjustmentReviewReason symbolic-review $domain $situation $feature $action
                                            wait-evidence missing-work-atoms 0 0 0)
              (AssumeAdjustmentReviewThreshold symbolic-review $domain $situation $feature $action
                                               pressure 0 0.3)
              (AssumeAdjustmentReviewThreshold symbolic-review $domain $situation $feature $action
                                               conflict 0 0.6))
             (assume-symbolic-adjustment-review-detail (car-atom $deltas) (car-atom $pressures)))))

(= (assume-accept-growth-edge
    $domain
    (AssumeProposedFeatureEdge $domain $situation $feature $action $weight $confidence $evidence $proposal_reason)
    (AssumeGrowthJudgement symbolic-review $domain $situation $feature $action $decision $expectation $target $review_confidence $conflict $pressure)
    $reason)
   (let* (($review (AssumeGrowthJudgement symbolic-review $domain $situation $feature $action $decision $expectation $target $review_confidence $conflict $pressure))
          ($commit_text (py-call (assume_client.commit_growth_edge_explicit
                                  $domain $situation
                                  $feature $action $weight $confidence $evidence $proposal_reason
                                  $decision $expectation $target $review_confidence $conflict $pressure
                                  (assume-atoms)
                                  $reason)))
          ($commit (catch (sread $commit_text))))
         (if (== (car-atom $commit) AssumeGrowthCommitted)
             (progn (add-atom &assume (AssumeFeatureEdge $domain $feature $action $weight $confidence $evidence))
                    (add-atom &assume (AssumeAcceptedFeatureEdge $domain $situation $feature $action $weight $confidence $evidence $proposal_reason $reason))
                    (add-atom &assume $review)
                    (add-atom &events (Event "omega" "assume-growth" "accepted structural assume growth edge" "0.9"))
                    $commit)
             $commit)))

(= (assume-accept-growth $domain $situation $feature $action $reason)
   (assume-accept-growth-native
     (assume-atom-id $domain)
     (assume-atom-id $situation)
     (assume-atom-id $feature)
     (assume-atom-id $action)
     $reason))

(= (assume-accept-growth-native $domain $situation $feature $action $reason)
   (let* (($proposals (collapse (match &assume_work
                          (AssumeProposedFeatureEdge $domain $situation $feature $action $weight $confidence $evidence $proposal_reason)
                          (AssumeProposedFeatureEdge $domain $situation $feature $action $weight $confidence $evidence $proposal_reason))))
          ($review (assume-review-growth-native $domain $situation $feature $action)))
         (if (== $proposals ())
             (AssumeGrowthCommitError $domain $situation "missing matching proposal in &assume_work")
             (assume-accept-growth-edge $domain (car-atom $proposals) $review $reason))))

(= (assume-accept-adjustment-edge
    $domain
    (AssumeAdjustmentProposal $domain $situation $feature $action $weight $confidence $evidence $proposal_direction)
    (AssumeAdjustmentJudgement symbolic-review $domain $situation $feature $action $decision $old $new $delta $target $score $signed_error $pressure $review_direction $conflict)
    $reason)
   (let* (($commit_text (py-call (assume_client.commit_adjustment_explicit
                                  $domain $situation
                                  $feature $action $weight $confidence $evidence $proposal_direction
                                  $decision $old $new $delta $target $score $signed_error $pressure $review_direction $conflict
                                  (assume-atoms)
                                  $reason)))
          ($commit (catch (sread $commit_text))))
         (if (== (car-atom $commit) AssumeAdjustmentCommitted)
             (progn (collapse (match &assume (AssumeFeatureEdge $domain $feature $action $oldw $oldc $olde)
                                     (remove-atom &assume (AssumeFeatureEdge $domain $feature $action $oldw $oldc $olde))))
                    (add-atom &assume (AssumeFeatureEdge $domain $feature $action $weight $confidence $evidence))
                    (add-atom &assume (AssumeAcceptedAdjustment $domain $situation $feature $action $weight $confidence $evidence $proposal_direction $reason))
                    (add-atom &assume (AssumeAdjustmentReview symbolic-review $domain $situation $feature $action acceptable $old $new $delta $target $score $signed_error $pressure $review_direction $conflict))
                    (add-atom &events (Event "omega" "assume-adjustment" "accepted assume edge adjustment" "0.9"))
                    $commit)
             $commit)))

(= (assume-accept-adjustment $domain $situation $feature $action $reason)
   (assume-accept-adjustment-native
     (assume-atom-id $domain)
     (assume-atom-id $situation)
     (assume-atom-id $feature)
     (assume-atom-id $action)
     $reason))

(= (assume-accept-adjustment-native $domain $situation $feature $action $reason)
   (let* (($proposals (collapse (match &assume_work
                          (AssumeAdjustmentProposal $domain $situation $feature $action $weight $confidence $evidence $proposal_direction)
                          (AssumeAdjustmentProposal $domain $situation $feature $action $weight $confidence $evidence $proposal_direction))))
          ($review (assume-review-adjustment-native $domain $situation $feature $action)))
         (if (== $proposals ())
             (AssumeAdjustmentCommitError $domain $situation "missing matching adjustment proposal in &assume_work")
             (assume-accept-adjustment-edge $domain (car-atom $proposals) $review $reason))))

(= (assume-writeback $domain $situation)
   (py-call (assume_client.validated_writeback $domain $situation (assume-atoms))))

(= (assume-observe-writeback $domain $situation)
   (let $bundle (py-call (assume_client.validated_writeback $domain $situation (assume-atoms)))
        (progn (assume-clear-work-adjustment $domain $situation)
               (assume-atomize-bundle &assume_work $bundle)
               $bundle)))

(= (assume-trace $count)
   (py-call (assume_client.trace $count)))

(= (assume-apply-writeback-edge $domain (AssumeUpdatedFeatureEdge $domain $feature $action $weight $confidence $evidence))
   (progn (collapse (match &assume (AssumeFeatureEdge $domain $feature $action $oldw $oldc $olde)
                           (remove-atom &assume (AssumeFeatureEdge $domain $feature $action $oldw $oldc $olde))))
          (add-atom &assume (AssumeFeatureEdge $domain $feature $action $weight $confidence $evidence))
          (AssumeApplied $domain $feature $action $weight $confidence $evidence)))

(= (assume-apply-writeback $domain $situation)
   (let* (($candidate (py-call (assume_client.validated_writeback $domain $situation (assume-atoms))))
          ($parsed (catch (sread $candidate))))
         (if (== (car-atom $parsed) Error)
             (AssumeWritebackError $candidate)
             (let $commit (catch (sread (py-call (assume_client.commit_writeback_delta_result $domain $situation $candidate))))
                  (if (== (car-atom $commit) AssumeWritebackCommitSucceeded)
                      (let $writes (collapse (let $edge (superpose $parsed)
                                                   (assume-apply-writeback-edge $domain $edge)))
                           (progn (add-atom &events (Event "omega" "assume-writeback" "applied assume fabric writeback" "0.9"))
                                  (AssumeWritebackApplied $writes $commit)))
                      $commit)))))
