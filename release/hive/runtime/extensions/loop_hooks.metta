; Purpose: the hive's hooks into the core loop: boot, each response's preparation with its held messages, and waits.
!(change-state! &loopBootInitialized false)
(= (maxNewInputLoops) (empty))
(= (maxWakeLoops) (empty))
(= (sleepInterval) (empty))
(= (LLM) (empty))
(= (provider) (empty))
(= (maxOutputToken) (empty))
(= (reasoningMode) (empty))
(= (wakeupInterval) (empty))
(= (spamShield) (empty))
(= (maxPersistentAtomsChars) (empty))
(= (maxAgendaAtomsChars) (empty))
(= (maxBeliefAtomsChars) (empty))
(= (maxWorldAtomsChars) (empty))
(= (maxEventAtomsChars) (empty))
(= (maxActivityAtomsChars) (empty))
(= (maxScratchAtomsChars) (empty))

!(import_prolog_function once)

(= (hive-initLoop)
   (progn (configure maxNewInputLoops 12) ;bounded restart posture; the agent can choose more with energy skills
          (configure maxWakeLoops 6) ;warm autonomous wake posture, not idle-only
          (configure spamShield False) ;the per-cycle "DO NOT RE-SEND" nag trained wind-down silence (docs/omegadots/DRIFT.md)
          (configure LLM gpt-5.4)
          (configure provider OpenAI)
          (configure sleepInterval 3) ;slower continuous loop
          (configure maxOutputToken 6000)
          (configure reasoningMode medium)
          (configure wakeupInterval 900) ;autonomous warm wake interval; messages still wake immediately
          ; Temporary survival bounds from the current architecture.
          ; Keep these until full ECAN/attention-driven pruning can replace
          ; automatic char-pressure removal with reasoned graph maintenance.
          (configure maxPersistentAtomsChars 10000)
          (configure maxAgendaAtomsChars 20000)
          (configure maxBeliefAtomsChars 50000)
          (configure maxWorldAtomsChars 50000)
          (configure maxEventAtomsChars 50000)
          (configure maxActivityAtomsChars 60000)
          (configure maxScratchAtomsChars 20000)
          (change-state! &error ())
          (change-state! &prevmsg "")
          (change-state! &lastresults "")
          (change-state! &lastResponseMsgNew false)
          (change-state! &lastResponseSexpr ())
          (change-state! &maxNewInputLoops (maxNewInputLoops))
          (change-state! &maxWakeLoops (maxWakeLoops))
          (change-state! &sleepInterval (sleepInterval))
          (change-state! &wakeupInterval (wakeupInterval))
          (change-state! &maxPersistentAtomsChars (maxPersistentAtomsChars))
          (change-state! &maxAgendaAtomsChars (maxAgendaAtomsChars))
          (change-state! &maxBeliefAtomsChars (maxBeliefAtomsChars))
          (change-state! &maxWorldAtomsChars (maxWorldAtomsChars))
          (change-state! &maxEventAtomsChars (maxEventAtomsChars))
          (change-state! &maxActivityAtomsChars (maxActivityAtomsChars))
          (change-state! &maxScratchAtomsChars (maxScratchAtomsChars))
          ; Neutral boot posture: enough attention to orient, then the agent can choose.
          (change-state! &energyMode "warm")
          (change-state! &cycle 1)
          (change-state! &practiceStartCycle 1)
          (change-state! &practiceLabel "none")
          (change-state! &nextWakeAt (+ (get_time) (get-state &wakeupInterval)))
          ; Clean boot should initialize memory/channels, then listen.
          ; Human input and scheduled wakeups grant LLM turns explicitly.
          (change-state! &formatRetries 0)
          (change-state! &lastResponseKind normal)
          (change-state! &restCheckDue false)
          (change-state! &lastReplyKind normal)
          (change-state! &lastReplyHold clear)
          (change-state! &loops 0)))

(= (initRuntimeOrgans)
   (let $started (collapse (match &self (RuntimeOrgan $name $call)
                                  (if (runtime-organ-trusted $name)
                                      (RuntimeOrganStarted $name (eval $call))
                                      (RuntimeOrganRejected $name untrusted))))
        (if (== $started ()) RuntimeOrgansNone $started)))

; On a hive the SKILLS line names only what this mind's policy lets it use or ask for (discovery always stays).
(= (skills-context)
   (if (== (commchannel) hive)
       (py-call (hive_commons.skill_hints (hive-skill-hints)))
       (hive-skill-hints)))

(= (hive-context)
   (hive-context "" "" ""))

(= (hive-context $inputctx)
   (hive-context $inputctx "" ""))

(= (hive-context $inputctx $skillctx)
   (hive-context $inputctx $skillctx ""))

(= (hive-context $inputctx $skillctx $currentinput)
   (string-safe (py-str ("PROMPT: " (getPrompt)
                         " SKILLS: " (skills-context)
                         " BACKGROUND_PROMOTED_MEMORY_HINTS: " (promoted-memory-hints)
                         " RELEVANT_INPUT_RECALL: " $inputctx
                         " SKILL_RECALL: " $skillctx
                         " RECENT_HISTORY: " (hive-history)
                         " LAST_SKILL_USE_RESULTS: " (py-call (hive_helpers.context_last_results (get-state &lastresults) (maxLastResultsContext)))
                         " CURRENT_INPUT: " $currentinput
                         " CURRENT_FRAME: " (py-call (hive_helpers.context_current_frame $currentinput (get-state &lastresults)))
                         " SPIN_COUNTER: " (eval (spin-counter-context))
                         " TIME: " (get_time_as_string)
                         " OUTPUT_FORMAT: Call hive-run-response with text containing up to 5 command lines. Do not wrap quotes around args or use variables:" (newline)
                         " toolName1 arg1" (newline)
                         " toolName2 arg2" (newline)
                         " toolName3 arg3" (newline)
                         " toolName4 arg4" (newline)
                         " toolName5 arg5" (newline)))))

(= (hive-error $msg $cmd $sexpr)
   (case $sexpr (((Error $a $b) (let $new (append (get-state &error) (($msg $cmd)))
                                          (change-state! &error $new)))
                 ($else $sexpr))))

; Before a command runs, a hive decides whether it may (policy rules and human
; approvals; see hive/core/policy.py): True, or the text recorded instead of a
; result.  Off the hive every command is allowed.
(= (command-gate $cmd)
   (if (== (commchannel) hive)
       (py-call (hive_commons.authorize (repr $cmd)))
       True))

; What a memory write or a message with nothing in it runs as (hive_services.empty_call_refusal): its refusal's text,
; given back as the command's result.
(= (hive-refused $text) $text)

(= (command-results $items)
   (if (== $items ())
       ()
       (let* (($cmd (car-atom $items))
              ($rest (cdr-atom $items))
              ($exec (sread (py-call (hive_services.checked_command_expr (repr $cmd)))))
              ($gate (command-gate $cmd))
              ($result (if (== $gate True)
                           (hive-error SINGLE_COMMAND_FORMAT_ERROR_NOTHING_WAS_DONE_PLEASE_FIX_AND_RETRY
                                        $cmd
                                        (catch (let $R (once (reduce $exec))
                                                    (py-call (helper.normalize_string $R)))))
                           $gate)))
             (cons (COMMAND_RETURN: ($cmd $result))
                   (command-results $rest)))))

; A chosen wait uses the existing wake schedule. Runtime format failures may retry after2s at most three times
; across wake cycles; the fourth and later failures rest until the normal wake. A successful response or new input
; starts a fresh stretch. Model-authored marker text has ordinary wait semantics, never the runtime's retry credit.
; A rest past the retries is reported like a chosen wait (hive-complete's restCheckDue).
(= (honor-chosen-wait $sexpr)
   (honor-chosen-wait $sexpr normal))

(= (honor-chosen-wait $sexpr $retryKind)
   (let* (($_ (change-state! &lastReplyKind $retryKind))
          ($attempts (py-call (hive_helpers.next_format_retry_count $retryKind (get-state &formatRetries))))
          ($_ (change-state! &formatRetries $attempts))
          ($seconds (py-call (hive_helpers.chosen_wait_seconds (repr $sexpr) $retryKind $attempts))))
         (if (< $seconds 0)
             wait-not-chosen
             (progn (change-state! &loops 0)
                    (if (> $seconds 0) (change-state! &nextWakeAt (+ (get_time) $seconds)) _)
                    (wait-chosen $seconds)))))


; Forward declaration: upstream supplies this implementation below the hooks.
(= (messagesClear) (empty))



(= (hive-boot)
   (progn (py-call (hive_services.initialize (command-line)))
          (initLogger)
          (hive-initLoop)
          (messagesClear)
          (hive-initMemory)
          (initHiveChannels)
          (py-call (hive_services.start_provider (provider) (LLM)))
          (initRuntimeOrgans)
          (change-state! &lastResponseText "")
          (change-state! &lastResponseResults ())
          (change-state! &hiveJustBooted true)
          (change-state! &loopBootInitialized true)))

(= (hive-cycle $k)
   (progn (if (== (get-state &hiveJustBooted) true) _ (progn (heartbeat $k) (run-runtime-hooks cycle)))
          (renew-held-turns)
          (change-state! &hiveJustBooted false)
          (change-state! &cycle $k)))

; A mind holding a claimed goal keeps its turns: once its own reply has spent them, the cycle sets its wake to now, so
; the core loop's wake check grants 2 + maxWakeLoops on this cycle and the calls go on from the next. A reply the
; runtime failed (&lastReplyKind format or provider, set by honor-chosen-wait) keeps its back-off and its rest
; (hive_helpers.renews_turns says when, and when not). py-call hands its answer back as a symbol, as it does the
; reply kinds hive-complete reads, so it compares with renew, never "renew".
(= (renew-held-turns)
   (if (== (py-call (hive_helpers.renews_turns (get-state &loops) (get-state &lastReplyKind))) renew)
       (change-state! &nextWakeAt 0)
       _))

; Keep the original provider/gateway path, including model, reasoning and energy
; accounting. Adapt only its response envelope to the upstream core protocol.


; The runtime's own failure provenance (hive_services.last_response_kind: format, provider or normal) travels beside
; the model text, never inside it, so model-authored marker text cannot earn the runtime's short retry.
; &lastReplyHold is held when the mind's last reply held a message (hive_helpers.hold_messages_after_commands), and
; then this reply's messages all go out, so no message is held twice in a row.
(= (hive-run-response $text)
   (let* (($prepared (py-call (hive_helpers.prepare_model_response $text (py-call (hive_services.last_response_kind))
                                                                   (get-state &lastReplyHold))))
          ($response (py-call (hive_helpers.prepared_response_commands $prepared)))
          ($_ (change-state! &lastResponseKind (py-call (hive_helpers.prepared_response_kind $prepared))))
          ($_ (change-state! &lastReplyHold (py-call (hive_helpers.prepared_response_hold $prepared
                                                                                         (get-state &lastReplyHold)))))
          ($sexpr (catch (sread $response)))
          ($_ (hive-error MULTI_COMMAND_FAILURE_NOTHING_WAS_DONE_PLEASE_CORRECT_PARENTHESES_AND_USE_QUOTES_AND_RETRY $response $sexpr))
          ($results (RESULTS: (command-results $sexpr))))
         (progn (println! (RESPONSE: $sexpr))
                (println! $results)
                (change-state! &lastResponseSexpr $sexpr)
                (change-state! &lastResponseText $response)
                (change-state! &lastResponseResults $results)
                $results)))

; A runtime failure (format or provider) ran nothing, so LAST_SKILL_USE_RESULTS keeps the mind's last real step (its
; history still records the failure). Before, the failure's own wait replaced them: the Code helper lost the file it
; had just read and read it again before every retry, two calls per failure against its $0.25 cap.
(= (hive-complete $msg $msgnew)
   (let* (($sexpr (get-state &lastResponseSexpr))
          ($response (get-state &lastResponseText))
          ($results (get-state &lastResponseResults))
          ($kind (get-state &lastResponseKind)))
         (progn (run-runtime-hooks response)
                (if $msgnew (change-state! &formatRetries 0) _)
                (honor-chosen-wait $sexpr (get-state &lastResponseKind))
                (change-state! &lastResponseKind normal)
                ; a runtime retry whose next turn comes by itself is no rest; a format failure past its retries is one,
                ; and honor-chosen-wait has just counted it in &formatRetries (hive_helpers.runtime_retry_due)
                (change-state! &restCheckDue
                               (if (== (py-call (hive_helpers.runtime_retry_due $kind (get-state &formatRetries))) True)
                                   false
                                   true))
                (if (or $msgnew (not (== $sexpr ())))
                    (hive-add-history $msg $response $sexpr $msgnew $results) _)
                ; py-call hands the kind back as a symbol, so it compares with format and provider, never "format"
                (if (or (== $kind format) (== $kind provider)) _
                    (change-state! &lastresults (string-safe (repr $results)))))))

(= (hive-cycle-end)
   (progn (bound-runtime-spaces-by-role memory)
          (save-runtime-spaces-by-role memory)
          (hive-rest-check)))

; A mind rests when it stops calling the model: its turns ran out (&loops spent with no new input) or it chose a wait
; (honor-chosen-wait). Either way it tells the hive once, after its last response's own commands ran, so a person it
; still owes an answer gets one or is told (hive_commons.rest_check, hive/core/replies.py). The runtime's own retries
; (a provider back-off, a format failure within its three retries) are not the mind resting: their next turn comes by
; itself. A format failure past them rests the mind until new input or its wake, and is reported like a chosen wait.
(= (hive-rest-check)
   (if (and (== (get-state &restCheckDue) true) (<= (get-state &loops) 0))
       (progn (change-state! &restCheckDue false)
              (if (== (commchannel) hive) (py-call (hive_commons.rest_check)) _))
       _))

; The upstream loop expects this utility; Hive's existing utility module
; supplies atomic_list_concat but does not define this convenience function.

