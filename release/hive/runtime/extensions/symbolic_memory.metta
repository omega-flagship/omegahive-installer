; Purpose: a mind's recall of its own memory on a hive, weighted by the hive's promotions: input recall and
; hive-memory-query, which a mind's own query is rewritten to (hive/runtime/hive_services.py command_expr).
;Configured at runtime memory and history in amount of characters:
(= (maxFeedback) (empty))
(= (maxRecallItems) (empty))
(= (maxInputRecallItems) (empty))
(= (maxSimilarityRecall) (empty))
(= (maxEpisodeRecallLines) (empty))
(= (maxEpisodeResultChars) (empty))
(= (maxHistory) (empty))
(= (maxHistoryResultChars) (empty))
(= (maxLastResultsContext) (empty))
(= (embeddingprovider) (empty))
(= (promotionInflationFactor) (empty))
(= (mostPromotedMemories) (empty))
!(change-state! &runtimeMemoryLoaded False)

(= (hive-initMemory)
   (progn (initMemory)
          (if (== (get-state &runtimeMemoryLoaded) True)
              RUNTIME-MEMORY-ALREADY-LOADED
              (progn (register-default-runtime-spaces)
                     (load-runtime-spaces-by-role memory)
                     (change-state! &runtimeMemoryLoaded True)))
          (configure maxInputRecallItems 8)
          (configure maxSimilarityRecall 10)
          (configure maxEpisodeResultChars 4000)
          (configure maxHistoryResultChars 12000)
          (configure maxLastResultsContext 5000)
          (configure promotionInflationFactor 10)
          (configure mostPromotedMemories 10)
          (py-call (hive_helpers.promotion_open_map))))

(= (getPrompt)
   (py-call (hive_helpers.context_prompt)))

(= (hive-history)
   (py-call (hive_helpers.context_recent_history_entries (maxHistory) 12)))

(= (historyResults $results)
   (last_chars (string-safe (repr $results)) (maxHistoryResultChars)))

(= (hive-add-history $lastmessage $response $sexpr $msgnew $results)
   (if $msgnew
       (if (== (get-state &error) ())
           (appendToHistory ((get_time_as_string) (newline) "HUMAN_MESSAGE: " $lastmessage (newline) $response (newline) "RESULTS: " (historyResults $results) (newline)))
           (appendToHistory ((get_time_as_string) (newline) "HUMAN_MESSAGE: " $lastmessage (newline) $response (newline) "RESULTS: " (historyResults $results) (newline) ERROR_FEEDBACK: (get-state &error))))
       (if (== (get-state &error) ())
           (appendToHistory ((get_time_as_string) (newline) $response (newline) "RESULTS: " (historyResults $results) (newline)))
           (appendToHistory ((get_time_as_string) (newline) $response (newline) "RESULTS: " (historyResults $results) (newline) ERROR_FEEDBACK: (get-state &error))))))







(= (best-promoted-memory-ids)
   (let* (($current_time (get_time))
          ($uuids (py-call (hive_helpers.promotion_get_all_keys)))
          ($ranked (takeK (mostPromotedMemories)
                          (msort (collapse (let* (($uuid (superpose $uuids))
                                                  ($promotion (get-promotion $current_time $uuid)))
                                                 (if (> $promotion 0.0) ((- 0.0 $promotion) $uuid))))))))
         (collapse (let ($p $uuid) (superpose $ranked) $uuid))))

(= (promoted-memory-hints)
   (let $uuids (best-promoted-memory-ids)
        (let $ret (py-call (lib_chromadb.query_by_ids $uuids))
             (repr (collapse (let ($uuid $t $c) (superpose $ret)
                                  ($t $c)))))))

(= (best-promoted-memories)
   (promoted-memory-hints))

(= (input-recall $msgnew $msg)
   (if $msgnew
       (car-atom (collapse (once (py-call (hive_helpers.context_input_recall_text (string-safe $msg) (maxInputRecallItems) (promotionInflationFactor) (maxRecallItems) (get_time) (embeddingprovider))))))
       ""))

(= (get-promotion $current_time $uuid)
   (let* (($promotion (py-call (hive_helpers.promotion_get_value $uuid 0.0)))
          ($last_time (py-call (hive_helpers.promotion_get_lasttime $uuid 0.0)))
          ($t (- $current_time $last_time)))
         (* $promotion (pow-math (+ 1.0 (/ $t 86400.0)) (- 0.0 0.7)))))

(= (hive-memory-query $str)
   (let* (($embedding (embed $str))
          ($queryresults (py-call (lib_chromadb.query_with_ids_and_dists $embedding (* (promotionInflationFactor) (maxRecallItems)))))
          ($candidates (collapse (let* (($current_time (get_time))
                                        (($uuid $time $message $distance) (superpose $queryresults))
                                        ($promotion (get-promotion $current_time $uuid)))
                                       (if (> $promotion 0.0)
                                           ((- 0.0 $promotion) $distance $uuid $time $message))))))
                 (let* (($best (takeK (maxRecallItems) (msort $candidates)))
                        ($bestpromoted (collapse (let ($_ $_ $uuid $time $message) (superpose $best)
                                                      ($time $message))))
                        ($closest (collapse (let ($uuid $time $message $distance) (superpose $queryresults)
                                  ($time $message)))))
                       (takeK (+ (maxRecallItems) (maxSimilarityRecall)) (unique-atom (append $bestpromoted $closest))))))



(= (promote $time)
   (let* (($current_time (get_time))
          ($uuids (py-call (lib_chromadb.ids_by_time $time))))
         (progn (collapse (let* (($uuid (superpose $uuids))
                                 ($v (get-promotion $current_time $uuid)))
                                (progn (py-call (hive_helpers.promotion_set_value $uuid (min 10.0 (+ 1.0 $v))))
                                       (py-call (hive_helpers.promotion_set_lasttime $uuid $current_time)))))
                (py-call (hive_helpers.promotion_commit))
                PROMOTE-SUCCESS)))

(= (demote $time)
   (let* (($current_time (get_time))
          ($uuids (py-call (lib_chromadb.ids_by_time $time))))
         (progn (collapse (let* (($uuid (superpose $uuids))
                                 ($v (get-promotion $current_time $uuid)))
                                (progn (py-call (hive_helpers.promotion_set_value $uuid (max 0.0 (- $v 1.0))))
                                       (py-call (hive_helpers.promotion_set_lasttime $uuid $current_time)))))
                (py-call (hive_helpers.promotion_commit))
                DEMOTE-SUCCESS)))

; Hive extends native episode lookup with tolerant dates and bounded results.
(= (hive-episodes $time)
   (py-call (hive_helpers.around_time $time (maxEpisodeRecallLines))))
