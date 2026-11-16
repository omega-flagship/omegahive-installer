; Pure MeTTa / AtomSpace causal-coding smoke test.
; Goal: graph topology, weights, prediction, error, and update all live as atoms.

!(bind! &causal_test (new-space))

!(add-atom &causal_test (CausalNode resident-watching-movie context))
!(add-atom &causal_test (CausalNode evening context))
!(add-atom &causal_test (CausalNode yellow-moody-scene action))
!(add-atom &causal_test (CausalNode bright-practical-scene action))
!(add-atom &causal_test (CausalNode approval outcome))
!(add-atom &causal_test (CausalEdge resident-watching-movie yellow-moody-scene 0.45))
!(add-atom &causal_test (CausalEdge resident-watching-movie bright-practical-scene 0.55))
!(add-atom &causal_test (CausalEdge evening yellow-moody-scene 0.45))

(= (scene-score $context $scene)
   (collapse (match &causal_test (CausalEdge $context $scene $weight)
                          $weight)))

(= (predict-scenes $context)
   (collapse (match &causal_test (CausalEdge $context $scene $weight)
                          (Prediction $context $scene $weight))))

(= (ranked-scenes $context)
   (msort (collapse (match &causal_test (CausalEdge $context $scene $weight)
                          (let $rank (- 0.0 $weight)
                               (RankedPrediction $rank $context $scene $weight))))))

(= (best-scene $context)
   (collapse (match &causal_test (CausalEdge $context $scene $weight)
      (let $better (collapse (match &causal_test (CausalEdge $context $other $other-weight)
                                     (if (> $other-weight $weight)
                                         (BetterCandidate $other $other-weight))))
           (if (== $better ())
               (BestPrediction $context $scene $weight))))))

(= (reinforce-causal-edge $context $scene $amount $evidence)
   (collapse (match &causal_test (CausalEdge $context $scene $old)
      (let $new (+ $old $amount)
         (progn (remove-atom &causal_test (CausalEdge $context $scene $old))
                (add-atom &causal_test (CausalEdge $context $scene $new))
                (add-atom &causal_test (CausalOutcome $context $scene approved $evidence $amount))
                (UpdatedEdge $context $scene $old $new))))))

(= (weaken-causal-edge $context $scene $amount $evidence)
   (collapse (match &causal_test (CausalEdge $context $scene $old)
      (let $new (max 0.0 (- $old $amount))
         (progn (remove-atom &causal_test (CausalEdge $context $scene $old))
                (add-atom &causal_test (CausalEdge $context $scene $new))
                (add-atom &causal_test (CausalError $context $scene rejected $evidence $amount))
                (UpdatedEdge $context $scene $old $new))))))

(= (explain-scene $context $scene)
   (collapse (match &causal_test (CausalEdge $context $scene $weight)
                          (Because $scene predicted-from $context strength $weight))))

(= (high-error-scenes)
   (collapse (match &causal_test (CausalError $context $scene $outcome $evidence $amount)
                          (HighError $context $scene $outcome evidence $evidence amount $amount))))

!(println! (BEFORE (predict-scenes resident-watching-movie)))
!(println! (BEFORE-BEST (best-scene resident-watching-movie)))
!(println! (BEFORE-YELLOW (scene-score resident-watching-movie yellow-moody-scene)))
!(println! (BEFORE-BRIGHT (scene-score resident-watching-movie bright-practical-scene)))
!(println! (LEARN-POSITIVE (reinforce-causal-edge resident-watching-movie yellow-moody-scene 0.20 resident-approved-movie-lighting)))
!(println! (LEARN-NEGATIVE (weaken-causal-edge resident-watching-movie bright-practical-scene 0.20 too-bright-for-movie)))
!(println! (AFTER (predict-scenes resident-watching-movie)))
!(println! (AFTER-BEST (best-scene resident-watching-movie)))
!(println! (EXPLAIN (explain-scene resident-watching-movie yellow-moody-scene)))
!(println! (ERRORS (high-error-scenes)))
